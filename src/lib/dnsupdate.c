/*
 * dnsupdate.c - DNS UPDATE protocol implementation
 * Date: 2025-11-26
 *
 * Implements RFC 2136 - Dynamic Updates in the Domain Name System (DNS UPDATE)
 * Allows clients to dynamically add, delete, and modify DNS records.
 */

#include "mydns.h"
#include "dnsupdate.h"
#include "tsig.h"
#include <arpa/inet.h>
#include <time.h>
#include <ctype.h>

/* Global UPDATE ACL cache */
static update_acl_t **g_acls = NULL;
static int g_acl_count = 0;
static time_t g_acl_last_load = 0;

/**
 * Initialize DNS UPDATE module
 */
int dnsupdate_init(void) {
    g_acls = NULL;
    g_acl_count = 0;
    g_acl_last_load = 0;
    return 0;
}

/**
 * Cleanup DNS UPDATE module
 */
void dnsupdate_cleanup(void) {
    if (g_acls) {
        for (int i = 0; i < g_acl_count; i++) {
            if (g_acls[i]) {
                RELEASE(g_acls[i]->zone);
                RELEASE(g_acls[i]->key_name);
                RELEASE(g_acls[i]->allowed_ips);
                RELEASE(g_acls[i]->allowed_networks);
                RELEASE(g_acls[i]);
            }
        }
        RELEASE(g_acls);
        g_acls = NULL;
        g_acl_count = 0;
    }
}

/**
 * Parse DNS name from UPDATE message
 */
static int parse_dns_name(const unsigned char *message, size_t message_len,
                          size_t *offset, char *name, size_t name_size) {
    size_t pos = *offset;
    size_t name_pos = 0;
    int jumped = 0;
    size_t jump_offset = 0;

    while (pos < message_len) {
        unsigned char len = message[pos];

        /* Check for compression pointer */
        if ((len & 0xC0) == 0xC0) {
            if (pos + 1 >= message_len) return -1;

            if (!jumped) {
                jump_offset = pos + 2;
                jumped = 1;
            }

            size_t pointer = ((len & 0x3F) << 8) | message[pos + 1];
            if (pointer >= message_len) return -1;
            pos = pointer;
            continue;
        }

        /* End of name */
        if (len == 0) {
            if (name_pos > 0 && name_pos < name_size) {
                name[name_pos - 1] = '\0';  /* Remove trailing dot */
            } else if (name_pos < name_size) {
                name[name_pos] = '\0';
            }

            if (jumped) {
                *offset = jump_offset;
            } else {
                *offset = pos + 1;
            }
            return 0;
        }

        /* Check label length validity */
        if (len > 63 || pos + len >= message_len) {
            return -1;
        }

        /* Copy label */
        pos++;
        for (int i = 0; i < len && name_pos < name_size - 1; i++) {
            name[name_pos++] = message[pos++];
        }

        if (name_pos < name_size - 1) {
            name[name_pos++] = '.';
        }
    }

    return -1;  /* Malformed name */
}

/**
 * Parse UPDATE request from DNS message
 */
int dnsupdate_parse_request(const unsigned char *message, size_t message_len,
                             update_request_t *request) {
    if (!message || message_len < 12 || !request) {
        return UPDATE_FORMERR;
    }

    memset(request, 0, sizeof(update_request_t));

    /* Parse DNS header */
    request->message_id = (message[0] << 8) | message[1];
    uint16_t flags = (message[2] << 8) | message[3];
    uint16_t zocount = (message[4] << 8) | message[5];
    uint16_t prcount = (message[6] << 8) | message[7];
    uint16_t upcount = (message[8] << 8) | message[9];
    uint16_t adcount = (message[10] << 8) | message[11];

    /* Verify UPDATE opcode */
    uint8_t opcode = (flags >> 11) & 0x0F;
    if (opcode != DNS_OPCODE_UPDATE) {
        return UPDATE_FORMERR;
    }

    /* Must have exactly one zone */
    if (zocount != 1) {
        return UPDATE_FORMERR;
    }

    size_t offset = 12;

    /* Parse Zone section */
    char zone_name[256];
    if (parse_dns_name(message, message_len, &offset, zone_name, sizeof(zone_name)) != 0) {
        return UPDATE_FORMERR;
    }
    request->zone_name = STRDUP(zone_name);

    if (offset + 4 > message_len) {
        return UPDATE_FORMERR;
    }

    request->zone_type = (message[offset] << 8) | message[offset + 1];
    request->zone_class = (message[offset + 2] << 8) | message[offset + 3];
    offset += 4;

    /* Zone type should be SOA */
    if (request->zone_type != DNS_QTYPE_SOA) {
        return UPDATE_FORMERR;
    }

    /* Parse Prerequisites */
    request->prereq_count = prcount;
    update_prereq_t *prev_prereq = NULL;

    for (int i = 0; i < prcount; i++) {
        update_prereq_t *prereq = ALLOCATE(sizeof(update_prereq_t), update_prereq_t);
        memset(prereq, 0, sizeof(update_prereq_t));

        char name[256];
        if (parse_dns_name(message, message_len, &offset, name, sizeof(name)) != 0) {
            RELEASE(prereq);
            return UPDATE_FORMERR;
        }
        prereq->name = STRDUP(name);

        if (offset + 10 > message_len) {
            RELEASE(prereq->name);
            RELEASE(prereq);
            return UPDATE_FORMERR;
        }

        prereq->rtype = (message[offset] << 8) | message[offset + 1];
        prereq->rclass = (message[offset + 2] << 8) | message[offset + 3];
        prereq->ttl = ((uint32_t)message[offset + 4] << 24) |
                      ((uint32_t)message[offset + 5] << 16) |
                      ((uint32_t)message[offset + 6] << 8) |
                      message[offset + 7];
        uint16_t rdlength = (message[offset + 8] << 8) | message[offset + 9];
        offset += 10;

        /* Determine prerequisite type */
        if (prereq->rclass == DNS_CLASS_ANY) {
            if (rdlength == 0) {
                prereq->type = (prereq->rtype == DNS_QTYPE_ANY) ?
                               PREREQ_YXDOMAIN : PREREQ_YXRRSET;
            }
        } else if (prereq->rclass == DNS_CLASS_NONE) {
            prereq->type = (prereq->rtype == DNS_QTYPE_ANY) ?
                           PREREQ_NXDOMAIN : PREREQ_NXRRSET;
        } else if (prereq->rclass == DNS_CLASS_IN) {
            prereq->type = PREREQ_YXRRSET_VALUE;
        }

        /* Parse RDATA if present */
        if (rdlength > 0) {
            if (offset + rdlength > message_len) {
                RELEASE(prereq->name);
                RELEASE(prereq);
                return UPDATE_FORMERR;
            }

            prereq->rdata = ALLOCATE(rdlength + 1, char);
            memcpy(prereq->rdata, message + offset, rdlength);
            prereq->rdata[rdlength] = '\0';
            offset += rdlength;
        }

        /* Add to list */
        if (prev_prereq) {
            prev_prereq->next = prereq;
        } else {
            request->prerequisites = prereq;
        }
        prev_prereq = prereq;
    }

    /* Parse Update section */
    request->update_count = upcount;
    update_record_t *prev_update = NULL;

    for (int i = 0; i < upcount; i++) {
        update_record_t *update = ALLOCATE(sizeof(update_record_t), update_record_t);
        memset(update, 0, sizeof(update_record_t));

        char name[256];
        if (parse_dns_name(message, message_len, &offset, name, sizeof(name)) != 0) {
            RELEASE(update);
            return UPDATE_FORMERR;
        }
        update->name = STRDUP(name);

        if (offset + 10 > message_len) {
            RELEASE(update->name);
            RELEASE(update);
            return UPDATE_FORMERR;
        }

        update->rtype = (message[offset] << 8) | message[offset + 1];
        update->rclass = (message[offset + 2] << 8) | message[offset + 3];
        update->ttl = ((uint32_t)message[offset + 4] << 24) |
                      ((uint32_t)message[offset + 5] << 16) |
                      ((uint32_t)message[offset + 6] << 8) |
                      message[offset + 7];
        update->rdlength = (message[offset + 8] << 8) | message[offset + 9];
        offset += 10;

        /* Determine operation type */
        if (update->rclass == DNS_CLASS_ANY) {
            update->operation = (update->rtype == DNS_QTYPE_ANY) ?
                                UPDATE_OP_DELETE_NAME : UPDATE_OP_DELETE_ALL;
        } else if (update->rclass == DNS_CLASS_NONE) {
            update->operation = UPDATE_OP_DELETE;
        } else if (update->rclass == DNS_CLASS_IN) {
            update->operation = UPDATE_OP_ADD;
        } else {
            RELEASE(update->name);
            RELEASE(update);
            return UPDATE_FORMERR;
        }

        /* Parse RDATA */
        if (update->rdlength > 0) {
            if (offset + update->rdlength > message_len) {
                RELEASE(update->name);
                RELEASE(update);
                return UPDATE_FORMERR;
            }

            update->rdata = ALLOCATE(update->rdlength + 1, char);
            memcpy(update->rdata, message + offset, update->rdlength);
            update->rdata[update->rdlength] = '\0';
            offset += update->rdlength;
        }

        /* Add to list */
        if (prev_update) {
            prev_update->next = update;
        } else {
            request->updates = update;
        }
        prev_update = update;
    }

    /* TODO: Parse Additional section for TSIG */

    return UPDATE_NOERROR;
}

/**
 * Check UPDATE prerequisites
 */
int dnsupdate_check_prerequisites(SQL *db, uint32_t zone_id, update_prereq_t *prereqs) {
    if (!db || !prereqs) {
        return UPDATE_NOERROR;  /* No prerequisites to check */
    }

    update_prereq_t *prereq = prereqs;
    while (prereq) {
        char query[2048];
        MYSQL_RES *res;
        MYSQL_ROW row;

        switch (prereq->type) {
            case PREREQ_YXDOMAIN:
                /* Name must exist */
                snprintf(query, sizeof(query),
                    "SELECT COUNT(*) FROM rr WHERE zone = %u AND name = '%s'",
                    zone_id, prereq->name);
                res = sql_query(db, query, strlen(query));
                if (!res) return UPDATE_SERVFAIL;

                row = sql_getrow(res, NULL);
                if (!row || atoi(row[0]) == 0) {
                    sql_free(res);
                    return UPDATE_NXDOMAIN;
                }
                sql_free(res);
                break;

            case PREREQ_NXDOMAIN:
                /* Name must not exist */
                snprintf(query, sizeof(query),
                    "SELECT COUNT(*) FROM rr WHERE zone = %u AND name = '%s'",
                    zone_id, prereq->name);
                res = sql_query(db, query, strlen(query));
                if (!res) return UPDATE_SERVFAIL;

                row = sql_getrow(res, NULL);
                if (row && atoi(row[0]) > 0) {
                    sql_free(res);
                    return UPDATE_YXDOMAIN;
                }
                sql_free(res);
                break;

            case PREREQ_YXRRSET:
                /* RRset must exist */
                snprintf(query, sizeof(query),
                    "SELECT COUNT(*) FROM rr WHERE zone = %u AND name = '%s' AND type = '%s'",
                    zone_id, prereq->name, mydns_qtype_str(prereq->rtype));
                res = sql_query(db, query, strlen(query));
                if (!res) return UPDATE_SERVFAIL;

                row = sql_getrow(res, NULL);
                if (!row || atoi(row[0]) == 0) {
                    sql_free(res);
                    return UPDATE_NXRRSET;
                }
                sql_free(res);
                break;

            case PREREQ_NXRRSET:
                /* RRset must not exist */
                snprintf(query, sizeof(query),
                    "SELECT COUNT(*) FROM rr WHERE zone = %u AND name = '%s' AND type = '%s'",
                    zone_id, prereq->name, mydns_qtype_str(prereq->rtype));
                res = sql_query(db, query, strlen(query));
                if (!res) return UPDATE_SERVFAIL;

                row = sql_getrow(res, NULL);
                if (row && atoi(row[0]) > 0) {
                    sql_free(res);
                    return UPDATE_YXRRSET;
                }
                sql_free(res);
                break;

            case PREREQ_YXRRSET_VALUE:
                /* RRset with specific value must exist */
                snprintf(query, sizeof(query),
                    "SELECT COUNT(*) FROM rr WHERE zone = %u AND name = '%s' AND type = '%s' AND data = '%s'",
                    zone_id, prereq->name, mydns_qtype_str(prereq->rtype), prereq->rdata);
                res = sql_query(db, query, strlen(query));
                if (!res) return UPDATE_SERVFAIL;

                row = sql_getrow(res, NULL);
                if (!row || atoi(row[0]) == 0) {
                    sql_free(res);
                    return UPDATE_NXRRSET;
                }
                sql_free(res);
                break;

            default:
                break;
        }

        prereq = prereq->next;
    }

    return UPDATE_NOERROR;
}

/**
 * Apply UPDATE operations
 */
int dnsupdate_apply_updates(SQL *db, uint32_t zone_id, update_record_t *updates,
                             update_response_t *response) {
    if (!db || !updates || !response) {
        return UPDATE_SERVFAIL;
    }

    /* Start transaction */
    char query[4096];
    sql_query(db, "START TRANSACTION", 17);

    update_record_t *update = updates;
    while (update) {
        const char *type_str = mydns_qtype_str(update->rtype);

        switch (update->operation) {
            case UPDATE_OP_ADD:
                /* Add new record */
                if (!update->rdata || update->rdlength == 0) {
                    sql_query(db, "ROLLBACK", 8);
                    return UPDATE_FORMERR;
                }

                snprintf(query, sizeof(query),
                    "INSERT INTO rr (zone, name, type, data, aux, ttl) "
                    "VALUES (%u, '%s', '%s', '%s', 0, %u)",
                    zone_id, update->name, type_str, update->rdata, update->ttl);

                if (!sql_query(db, query, strlen(query))) {
                    sql_query(db, "ROLLBACK", 8);
                    return UPDATE_SERVFAIL;
                }
                break;

            case UPDATE_OP_DELETE:
                /* Delete specific record */
                if (!update->rdata) {
                    sql_query(db, "ROLLBACK", 8);
                    return UPDATE_FORMERR;
                }

                snprintf(query, sizeof(query),
                    "DELETE FROM rr WHERE zone = %u AND name = '%s' AND type = '%s' AND data = '%s'",
                    zone_id, update->name, type_str, update->rdata);

                if (!sql_query(db, query, strlen(query))) {
                    sql_query(db, "ROLLBACK", 8);
                    return UPDATE_SERVFAIL;
                }
                break;

            case UPDATE_OP_DELETE_ALL:
                /* Delete all records of this type */
                snprintf(query, sizeof(query),
                    "DELETE FROM rr WHERE zone = %u AND name = '%s' AND type = '%s'",
                    zone_id, update->name, type_str);

                if (!sql_query(db, query, strlen(query))) {
                    sql_query(db, "ROLLBACK", 8);
                    return UPDATE_SERVFAIL;
                }
                break;

            case UPDATE_OP_DELETE_NAME:
                /* Delete all records with this name */
                snprintf(query, sizeof(query),
                    "DELETE FROM rr WHERE zone = %u AND name = '%s'",
                    zone_id, update->name);

                if (!sql_query(db, query, strlen(query))) {
                    sql_query(db, "ROLLBACK", 8);
                    return UPDATE_SERVFAIL;
                }
                break;

            default:
                sql_query(db, "ROLLBACK", 8);
                return UPDATE_FORMERR;
        }

        update = update->next;
    }

    /* Commit transaction */
    if (!sql_query(db, "COMMIT", 6)) {
        sql_query(db, "ROLLBACK", 8);
        return UPDATE_SERVFAIL;
    }

    /* Get new serial from SOA (updated by trigger) */
    snprintf(query, sizeof(query),
        "SELECT serial FROM soa WHERE id = %u", zone_id);
    MYSQL_RES *res = sql_query(db, query, strlen(query));
    if (res) {
        MYSQL_ROW row = sql_getrow(res, NULL);
        if (row) {
            response->new_serial = atoi(row[0]);
        }
        sql_free(res);
    }

    return UPDATE_NOERROR;
}

/**
 * Check if IP is allowed by ACL
 */
int dnsupdate_check_ip_allowed(update_acl_t *acl, const char *ip) {
    if (!acl || !ip) return 0;

    /* NULL allowed_ips means any IP is allowed */
    if (!acl->allowed_ips) return 1;

    /* Check IP list */
    char *ips = STRDUP(acl->allowed_ips);
    char *token = strtok(ips, ",");

    while (token) {
        /* Trim whitespace */
        while (isspace(*token)) token++;
        char *end = token + strlen(token) - 1;
        while (end > token && isspace(*end)) *end-- = '\0';

        if (strcmp(token, ip) == 0) {
            RELEASE(ips);
            return 1;
        }

        token = strtok(NULL, ",");
    }

    RELEASE(ips);

    /* TODO: Check CIDR networks */

    return 0;
}

/**
 * Load UPDATE ACLs from database
 */
int dnsupdate_load_acls(SQL *db, update_acl_t ***acls, int *count) {
    if (!db || !acls || !count) return -1;

    /* Reload ACLs every 5 minutes */
    time_t now = time(NULL);
    if (g_acls && (now - g_acl_last_load) < 300) {
        *acls = g_acls;
        *count = g_acl_count;
        return 0;
    }

    /* Free old ACLs */
    dnsupdate_cleanup();

    /* Query ACLs from database */
    const char *query = "SELECT zone, key_name, allowed_ips, allowed_networks, "
                       "allow_add, allow_delete, allow_update FROM update_acl";

    MYSQL_RES *res = sql_query(db, query, strlen(query));
    if (!res) return -1;

    int num_rows = sql_num_rows(res);
    if (num_rows == 0) {
        sql_free(res);
        return 0;
    }

    g_acls = ALLOCATE(sizeof(update_acl_t*) * num_rows, update_acl_t*);
    g_acl_count = 0;

    MYSQL_ROW row;
    while ((row = sql_getrow(res, NULL))) {
        update_acl_t *acl = ALLOCATE(sizeof(update_acl_t), update_acl_t);
        memset(acl, 0, sizeof(update_acl_t));

        acl->zone = row[0] ? STRDUP(row[0]) : NULL;
        acl->key_name = row[1] ? STRDUP(row[1]) : NULL;
        acl->allowed_ips = row[2] ? STRDUP(row[2]) : NULL;
        acl->allowed_networks = row[3] ? STRDUP(row[3]) : NULL;
        acl->allow_add = row[4] ? atoi(row[4]) : 0;
        acl->allow_delete = row[5] ? atoi(row[5]) : 0;
        acl->allow_update = row[6] ? atoi(row[6]) : 0;

        g_acls[g_acl_count++] = acl;
    }

    sql_free(res);

    g_acl_last_load = now;
    *acls = g_acls;
    *count = g_acl_count;

    return 0;
}

/**
 * Check UPDATE authorization
 */
int dnsupdate_check_authorization(SQL *db, update_request_t *request) {
    if (!db || !request) return UPDATE_REFUSED;

    /* Load ACLs */
    update_acl_t **acls = NULL;
    int acl_count = 0;
    if (dnsupdate_load_acls(db, &acls, &acl_count) != 0) {
        return UPDATE_SERVFAIL;
    }

    /* Find matching ACL */
    update_acl_t *matching_acl = NULL;
    for (int i = 0; i < acl_count; i++) {
        if (acls[i]->zone && strcmp(acls[i]->zone, request->zone_name) == 0) {
            matching_acl = acls[i];
            break;
        }
    }

    if (!matching_acl) {
        return UPDATE_REFUSED;  /* No ACL for this zone */
    }

    /* Check IP authorization */
    if (!dnsupdate_check_ip_allowed(matching_acl, request->source_ip)) {
        return UPDATE_REFUSED;
    }

    /* Check TSIG if required */
    if (matching_acl->key_name) {
        if (!request->tsig_key ||
            strcmp(request->tsig_key->name, matching_acl->key_name) != 0) {
            return UPDATE_REFUSED;
        }
        /* TODO: Verify TSIG signature */
    }

    /* Check operation permissions */
    update_record_t *update = request->updates;
    while (update) {
        switch (update->operation) {
            case UPDATE_OP_ADD:
                if (!matching_acl->allow_add) return UPDATE_REFUSED;
                break;
            case UPDATE_OP_DELETE:
            case UPDATE_OP_DELETE_ALL:
            case UPDATE_OP_DELETE_NAME:
                if (!matching_acl->allow_delete) return UPDATE_REFUSED;
                break;
        }
        update = update->next;
    }

    return UPDATE_NOERROR;
}

/**
 * Process UPDATE request
 */
int dnsupdate_process(SQL *db, update_request_t *request, update_response_t *response) {
    if (!db || !request || !response) {
        return UPDATE_SERVFAIL;
    }

    memset(response, 0, sizeof(update_response_t));
    response->message_id = request->message_id;

    /* Find zone ID */
    char query[512];
    snprintf(query, sizeof(query),
        "SELECT id, slave_mode FROM soa WHERE origin = '%s'",
        request->zone_name);

    MYSQL_RES *res = sql_query(db, query, strlen(query));
    if (!res) {
        response->rcode = UPDATE_SERVFAIL;
        return -1;
    }

    MYSQL_ROW row = sql_getrow(res, NULL);
    if (!row) {
        sql_free(res);
        response->rcode = UPDATE_NOTAUTH;
        return -1;
    }

    uint32_t zone_id = atoi(row[0]);
    int slave_mode = atoi(row[1]);
    sql_free(res);

    /* Can't update slave zones */
    if (slave_mode) {
        response->rcode = UPDATE_NOTAUTH;
        return -1;
    }

    /* Check authorization */
    int auth_result = dnsupdate_check_authorization(db, request);
    if (auth_result != UPDATE_NOERROR) {
        response->rcode = auth_result;
        return -1;
    }

    /* Check prerequisites */
    int prereq_result = dnsupdate_check_prerequisites(db, zone_id, request->prerequisites);
    if (prereq_result != UPDATE_NOERROR) {
        response->rcode = prereq_result;
        return -1;
    }

    /* Apply updates */
    int update_result = dnsupdate_apply_updates(db, zone_id, request->updates, response);
    if (update_result != UPDATE_NOERROR) {
        response->rcode = update_result;
        return -1;
    }

    response->rcode = UPDATE_NOERROR;
    return 0;
}

/**
 * Create UPDATE response message
 */
int dnsupdate_create_response(update_request_t *request, update_response_t *response,
                               unsigned char *buffer, size_t buffer_size, size_t *output_len) {
    if (!request || !response || !buffer || buffer_size < 12) {
        return -1;
    }

    memset(buffer, 0, buffer_size);

    /* DNS header */
    buffer[0] = (response->message_id >> 8) & 0xFF;
    buffer[1] = response->message_id & 0xFF;

    /* Flags: QR=1 (response), OPCODE=5 (UPDATE), AA=1, RCODE */
    uint16_t flags = 0x8000 | (DNS_OPCODE_UPDATE << 11) | 0x0400 | (response->rcode & 0x0F);
    buffer[2] = (flags >> 8) & 0xFF;
    buffer[3] = flags & 0xFF;

    /* Counts: ZOCOUNT=1, others=0 */
    buffer[4] = 0x00;
    buffer[5] = 0x01;  /* ZOCOUNT = 1 */
    buffer[6] = 0x00;
    buffer[7] = 0x00;  /* PRCOUNT = 0 */
    buffer[8] = 0x00;
    buffer[9] = 0x00;  /* UPCOUNT = 0 */
    buffer[10] = 0x00;
    buffer[11] = 0x00;  /* ADCOUNT = 0 */

    /* Zone section */
    size_t pos = 12;
    const char *zone_name = request->zone_name;
    char *label_start = (char*)zone_name;
    char *dot;

    while ((dot = strchr(label_start, '.')) != NULL) {
        size_t label_len = dot - label_start;
        if (pos + label_len + 1 >= buffer_size) return -1;

        buffer[pos++] = label_len;
        memcpy(buffer + pos, label_start, label_len);
        pos += label_len;
        label_start = dot + 1;
    }

    /* Final label */
    size_t label_len = strlen(label_start);
    if (label_len > 0) {
        if (pos + label_len + 1 >= buffer_size) return -1;
        buffer[pos++] = label_len;
        memcpy(buffer + pos, label_start, label_len);
        pos += label_len;
    }

    /* Root label */
    if (pos >= buffer_size) return -1;
    buffer[pos++] = 0x00;

    /* QTYPE = SOA, QCLASS = IN */
    if (pos + 4 > buffer_size) return -1;
    buffer[pos++] = 0x00;
    buffer[pos++] = 0x06;  /* SOA */
    buffer[pos++] = 0x00;
    buffer[pos++] = 0x01;  /* IN */

    *output_len = pos;
    return 0;
}

/**
 * Free UPDATE request
 */
void dnsupdate_free_request(update_request_t *request) {
    if (!request) return;

    RELEASE(request->zone_name);
    RELEASE(request->source_ip);

    /* Free prerequisites */
    update_prereq_t *prereq = request->prerequisites;
    while (prereq) {
        update_prereq_t *next = prereq->next;
        RELEASE(prereq->name);
        RELEASE(prereq->rdata);
        RELEASE(prereq);
        prereq = next;
    }

    /* Free updates */
    update_record_t *update = request->updates;
    while (update) {
        update_record_t *next = update->next;
        RELEASE(update->name);
        RELEASE(update->rdata);
        RELEASE(update);
        update = next;
    }

    RELEASE(request->tsig_mac);
}

/**
 * Free UPDATE response
 */
void dnsupdate_free_response(update_response_t *response) {
    if (!response) return;
    RELEASE(response->error_message);
}

/**
 * Log UPDATE operation
 */
void dnsupdate_log(SQL *db, update_request_t *request, update_response_t *response) {
    if (!db || !request || !response) return;

    char query[2048];
    snprintf(query, sizeof(query),
        "INSERT INTO dnsmanager_logs (action, details, ip_address, created_at) "
        "VALUES ('DNS_UPDATE', 'Zone: %s, Records: %d, Result: %s', '%s', NOW())",
        request->zone_name ? request->zone_name : "unknown",
        request->update_count,
        response->rcode == UPDATE_NOERROR ? "SUCCESS" : "FAILED",
        request->source_ip ? request->source_ip : "unknown");

    sql_query(db, query, strlen(query));
}
