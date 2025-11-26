/*
 * axfr.c - AXFR (Zone Transfer) client implementation
 * Date: 2025-11-26
 *
 * Implements DNS zone transfer (AXFR) client functionality for MyDNS,
 * allowing it to act as a slave server receiving zone data from masters.
 */

#include "mydns.h"
#include "mydnsutil.h"
#include "axfr.h"
#include "memzone.h"
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <netdb.h>
#include <poll.h>
#include <errno.h>
#include <string.h>

/* Global memzone context (for zone transfer updates) */
extern memzone_ctx_t *Memzone;

/* DNS header structure */
typedef struct {
    uint16_t id;
    uint16_t flags;
    uint16_t qdcount;
    uint16_t ancount;
    uint16_t nscount;
    uint16_t arcount;
} dns_header_t;

/* DNS question structure */
typedef struct {
    char *qname;
    uint16_t qtype;
    uint16_t qclass;
} dns_question_t;

/* Maximum AXFR response size */
#define AXFR_MAX_RESPONSE_SIZE (65536 * 100)  /* 100 DNS messages max */
#define AXFR_BUFFER_SIZE 65536
#define AXFR_TIMEOUT 300  /* 5 minutes timeout */

/**
 * Initialize AXFR module
 */
int axfr_init(void) {
    return 0;
}

/**
 * Free AXFR module resources
 */
void axfr_free(void) {
    /* Nothing to free at module level */
}

/**
 * Load zone master configuration from database
 */
int axfr_load_zones(SQL *db, int zone_id, axfr_zone_t **zones, int *count) {
    SQL_RES *res;
    SQL_ROW row;
    char query[1024];
    int n = 0;
    axfr_zone_t *zone_list = NULL;

    if (!db || !zones || !count) {
        return -1;
    }

    /* Query zone_masters table */
    if (zone_id > 0) {
        snprintf(query, sizeof(query),
            "SELECT zm.id, zm.zone_id, s.origin, zm.master_host, zm.master_port, "
            "s.serial, zm.last_check, zm.last_transfer, zm.transfer_failures, "
            "zm.tsig_key_name, zm.tsig_key_secret, zm.tsig_algorithm "
            "FROM zone_masters zm "
            "JOIN soa s ON s.id = zm.zone_id "
            "WHERE zm.zone_id = %d AND zm.enabled = 1",
            zone_id);
    } else {
        snprintf(query, sizeof(query),
            "SELECT zm.id, zm.zone_id, s.origin, zm.master_host, zm.master_port, "
            "s.serial, zm.last_check, zm.last_transfer, zm.transfer_failures, "
            "zm.tsig_key_name, zm.tsig_key_secret, zm.tsig_algorithm "
            "FROM zone_masters zm "
            "JOIN soa s ON s.id = zm.zone_id "
            "WHERE zm.enabled = 1");
    }

    if (!(res = sql_query(db, query, strlen(query)))) {
        Warnx(_("axfr_load_zones: query failed: %s"), query);
        return -1;
    }

    /* Count rows */
    *count = sql_num_rows(res);
    if (*count == 0) {
        sql_free(res);
        *zones = NULL;
        return 0;
    }

    /* Allocate array */
    zone_list = (axfr_zone_t *)calloc(*count, sizeof(axfr_zone_t));
    if (!zone_list) {
        sql_free(res);
        return -1;
    }

    /* Fill array */
    while ((row = sql_getrow(res, NULL)) && n < *count) {
        zone_list[n].zone_id = atoi(row[1]);
        zone_list[n].zone_name = strdup(row[2] ? row[2] : "");
        zone_list[n].master_host = strdup(row[3] ? row[3] : "");
        zone_list[n].master_port = row[4] ? atoi(row[4]) : 53;
        zone_list[n].current_serial = row[5] ? (uint32_t)atol(row[5]) : 0;
        zone_list[n].master_serial = 0;
        zone_list[n].last_check = row[6] ? (time_t)atol(row[6]) : 0;
        zone_list[n].last_transfer = row[7] ? (time_t)atol(row[7]) : 0;
        zone_list[n].transfer_failures = row[8] ? atoi(row[8]) : 0;
        zone_list[n].tsig_key_name = row[9] ? strdup(row[9]) : NULL;
        zone_list[n].tsig_key_secret = row[10] ? strdup(row[10]) : NULL;
        zone_list[n].tsig_algorithm = row[11] ? strdup(row[11]) : NULL;
        n++;
    }

    sql_free(res);
    *zones = zone_list;
    return 0;
}

/**
 * Free zone configuration
 */
void axfr_free_zone(axfr_zone_t *zone) {
    if (!zone) return;

    if (zone->zone_name) free(zone->zone_name);
    if (zone->master_host) free(zone->master_host);
    if (zone->tsig_key_name) free(zone->tsig_key_name);
    if (zone->tsig_key_secret) free(zone->tsig_key_secret);
    if (zone->tsig_algorithm) free(zone->tsig_algorithm);
}

/**
 * Connect to master server via TCP
 */
int axfr_connect_master(const char *host, int port, int timeout) {
    struct addrinfo hints, *res, *rp;
    char port_str[16];
    int sockfd = -1;
    int ret;
    struct timeval tv;

    if (!host) {
        return -1;
    }

    memset(&hints, 0, sizeof(hints));
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;
    hints.ai_protocol = IPPROTO_TCP;

    snprintf(port_str, sizeof(port_str), "%d", port);

    if ((ret = getaddrinfo(host, port_str, &hints, &res)) != 0) {
        Warnx(_("getaddrinfo failed for %s:%d: %s"), host, port, gai_strerror(ret));
        return -1;
    }

    /* Try each address */
    for (rp = res; rp != NULL; rp = rp->ai_next) {
        sockfd = socket(rp->ai_family, rp->ai_socktype, rp->ai_protocol);
        if (sockfd == -1) {
            continue;
        }

        /* Set socket timeout */
        tv.tv_sec = timeout;
        tv.tv_usec = 0;
        setsockopt(sockfd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
        setsockopt(sockfd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));

        /* Try to connect */
        if (connect(sockfd, rp->ai_addr, rp->ai_addrlen) == 0) {
            break;  /* Success */
        }

        close(sockfd);
        sockfd = -1;
    }

    freeaddrinfo(res);

    if (sockfd == -1) {
        Warnx(_("Failed to connect to master %s:%d"), host, port);
        return -1;
    }

    return sockfd;
}

/**
 * Create DNS name in wire format
 */
static int dns_name_to_wire(const char *name, unsigned char *wire, size_t max_len) {
    unsigned char *p = wire;
    const char *label = name;
    const char *dot;
    size_t label_len;

    while (*label) {
        dot = strchr(label, '.');
        label_len = dot ? (size_t)(dot - label) : strlen(label);

        if (label_len == 0) {
            break;  /* Trailing dot or root */
        }

        if (label_len > 63 || (p - wire) + label_len + 1 > max_len) {
            return -1;  /* Label too long */
        }

        *p++ = (unsigned char)label_len;
        memcpy(p, label, label_len);
        p += label_len;

        label = dot ? dot + 1 : label + label_len;
    }

    if ((p - wire) + 1 > max_len) {
        return -1;
    }

    *p++ = 0;  /* Root label */
    return (int)(p - wire);
}

/**
 * Create AXFR query packet
 */
int axfr_create_query(const char *zone_name, uint16_t query_id, unsigned char *buffer, size_t buffer_size) {
    unsigned char *p = buffer;
    dns_header_t *header;
    int name_len;

    if (!zone_name || !buffer || buffer_size < 512) {
        return -1;
    }

    memset(buffer, 0, buffer_size);

    /* DNS header */
    header = (dns_header_t *)p;
    header->id = htons(query_id);
    header->flags = htons(0x0000);  /* Standard query */
    header->qdcount = htons(1);     /* One question */
    header->ancount = 0;
    header->nscount = 0;
    header->arcount = 0;
    p += sizeof(dns_header_t);

    /* Question section */
    name_len = dns_name_to_wire(zone_name, p, buffer_size - (p - buffer));
    if (name_len < 0) {
        return -1;
    }
    p += name_len;

    /* QTYPE = AXFR (252) */
    *p++ = 0;
    *p++ = 252;

    /* QCLASS = IN (1) */
    *p++ = 0;
    *p++ = 1;

    return (int)(p - buffer);
}

/**
 * Send AXFR query over TCP
 */
int axfr_send_query(int sockfd, const unsigned char *query, size_t query_size) {
    unsigned char length_prefix[2];
    ssize_t sent;

    /* TCP DNS messages are prefixed with 2-byte length */
    length_prefix[0] = (query_size >> 8) & 0xFF;
    length_prefix[1] = query_size & 0xFF;

    /* Send length */
    sent = send(sockfd, length_prefix, 2, 0);
    if (sent != 2) {
        Warnx(_("Failed to send length prefix: %s"), strerror(errno));
        return -1;
    }

    /* Send query */
    sent = send(sockfd, query, query_size, 0);
    if (sent != (ssize_t)query_size) {
        Warnx(_("Failed to send query: %s"), strerror(errno));
        return -1;
    }

    return 0;
}

/**
 * Receive AXFR response over TCP
 */
int axfr_receive_response(int sockfd, unsigned char *response, size_t buffer_size, int timeout) {
    unsigned char length_prefix[2];
    uint16_t message_length;
    ssize_t received;
    size_t total_received = 0;
    struct pollfd pfd;

    /* Set up poll */
    pfd.fd = sockfd;
    pfd.events = POLLIN;

    while (total_received < buffer_size) {
        /* Wait for data */
        int poll_ret = poll(&pfd, 1, timeout * 1000);
        if (poll_ret < 0) {
            Warnx(_("poll() failed: %s"), strerror(errno));
            return -1;
        } else if (poll_ret == 0) {
            /* Timeout - might be end of transfer */
            break;
        }

        /* Read length prefix */
        received = recv(sockfd, length_prefix, 2, MSG_PEEK);
        if (received <= 0) {
            break;  /* Connection closed or error */
        }

        if (received < 2) {
            continue;  /* Not enough data yet */
        }

        message_length = (length_prefix[0] << 8) | length_prefix[1];

        if (total_received + message_length + 2 > buffer_size) {
            Warnx(_("AXFR response too large (> %zu bytes)"), buffer_size);
            return -1;
        }

        /* Read the actual message (including length prefix) */
        received = recv(sockfd, response + total_received, message_length + 2, 0);
        if (received != message_length + 2) {
            Warnx(_("Failed to receive complete message: %s"), strerror(errno));
            return -1;
        }

        total_received += received;
    }

    return (int)total_received;
}

/**
 * Parse DNS name from wire format
 */
static int dns_name_from_wire(const unsigned char *wire, size_t wire_len, size_t *offset, char *name, size_t name_len) {
    const unsigned char *p = wire + *offset;
    const unsigned char *end = wire + wire_len;
    char *n = name;
    size_t label_len;
    int jumped = 0;
    size_t original_offset = *offset;

    while (p < end) {
        label_len = *p;

        /* Check for compression pointer */
        if ((label_len & 0xC0) == 0xC0) {
            if (p + 1 >= end) return -1;
            size_t pointer = ((label_len & 0x3F) << 8) | *(p + 1);
            if (!jumped) {
                *offset += 2;
                jumped = 1;
            }
            p = wire + pointer;
            continue;
        }

        /* Root label */
        if (label_len == 0) {
            if (!jumped) {
                *offset = (p - wire) + 1;
            }
            *n = '\0';
            return 0;
        }

        /* Regular label */
        if (label_len > 63 || p + label_len >= end) {
            return -1;
        }

        if (n != name) {
            if ((size_t)(n - name) + 1 >= name_len) return -1;
            *n++ = '.';
        }

        if ((size_t)(n - name) + label_len >= name_len) return -1;
        memcpy(n, p + 1, label_len);
        n += label_len;
        p += label_len + 1;
    }

    return -1;
}

/**
 * Parse AXFR response
 */
int axfr_parse_response(const unsigned char *response, size_t length, axfr_record_t **records) {
    const unsigned char *p = response;
    const unsigned char *end = response + length;
    axfr_record_t *record_list = NULL;
    axfr_record_t *last_record = NULL;
    int record_count = 0;
    int soa_count = 0;

    *records = NULL;

    /* Parse multiple TCP DNS messages */
    while (p + 2 < end) {
        /* Read message length */
        uint16_t msg_len = (p[0] << 8) | p[1];
        p += 2;

        if (p + msg_len > end) {
            Warnx(_("Invalid message length in AXFR response"));
            axfr_free_records(record_list);
            return -1;
        }

        const unsigned char *msg_start = p;
        const unsigned char *msg_end = p + msg_len;

        /* Skip DNS header */
        if (msg_end - p < 12) {
            p = msg_end;
            continue;
        }

        dns_header_t *header = (dns_header_t *)p;
        uint16_t qdcount = ntohs(header->qdcount);
        uint16_t ancount = ntohs(header->ancount);
        p += 12;

        /* Skip questions */
        for (int i = 0; i < qdcount && p < msg_end; i++) {
            char qname[256];
            size_t offset = p - msg_start;
            if (dns_name_from_wire(msg_start, msg_len, &offset, qname, sizeof(qname)) < 0) {
                break;
            }
            p = msg_start + offset + 4;  /* Skip QTYPE and QCLASS */
        }

        /* Parse answer records */
        for (int i = 0; i < ancount && p < msg_end; i++) {
            axfr_record_t *rec = (axfr_record_t *)calloc(1, sizeof(axfr_record_t));
            if (!rec) {
                axfr_free_records(record_list);
                return -1;
            }

            /* Parse name */
            char name[256];
            size_t offset = p - msg_start;
            if (dns_name_from_wire(msg_start, msg_len, &offset, name, sizeof(name)) < 0) {
                free(rec);
                break;
            }
            rec->name = strdup(name);
            p = msg_start + offset;

            /* Parse TYPE, CLASS, TTL, RDLENGTH */
            if (p + 10 > msg_end) {
                axfr_free_records(record_list);
                free(rec->name);
                free(rec);
                return -1;
            }

            uint16_t rtype = (p[0] << 8) | p[1];
            uint16_t rclass = (p[2] << 8) | p[3];
            uint32_t ttl = (p[4] << 24) | (p[5] << 16) | (p[6] << 8) | p[7];
            uint16_t rdlength = (p[8] << 8) | p[9];
            p += 10;

            if (p + rdlength > msg_end) {
                axfr_free_records(record_list);
                free(rec->name);
                free(rec);
                return -1;
            }

            rec->ttl = ttl;
            rec->type = strdup(mydns_qtype_str(rtype));

            /* Count SOA records (should be 2: start and end) */
            if (rtype == DNS_QTYPE_SOA) {
                soa_count++;
            }

            /* Parse RDATA (simplified - just store as hex for now) */
            char *rdata = (char *)malloc(rdlength * 2 + 1);
            if (rdata) {
                for (int j = 0; j < rdlength; j++) {
                    sprintf(rdata + j * 2, "%02x", p[j]);
                }
                rec->data = rdata;
            }

            p += rdlength;

            /* Add to list */
            if (last_record) {
                last_record->next = rec;
            } else {
                record_list = rec;
            }
            last_record = rec;
            record_count++;
        }

        p = msg_end;
    }

    /* Validate AXFR (should have 2 SOA records) */
    if (soa_count != 2) {
        Warnx(_("Invalid AXFR response: expected 2 SOA records, got %d"), soa_count);
        axfr_free_records(record_list);
        return -1;
    }

    *records = record_list;
    return record_count;
}

/**
 * Free record list
 */
void axfr_free_records(axfr_record_t *records) {
    axfr_record_t *rec = records;
    axfr_record_t *next;

    while (rec) {
        next = rec->next;
        if (rec->name) free(rec->name);
        if (rec->type) free(rec->type);
        if (rec->data) free(rec->data);
        free(rec);
        rec = next;
    }
}

/**
 * Check SOA serial on master server
 */
int axfr_check_serial(axfr_zone_t *zone) {
    /* TODO: Implement SOA query to check serial */
    /* For now, always return "needs transfer" */
    return 0;
}

/**
 * Perform AXFR transfer from master server
 */
int axfr_transfer_zone(SQL *db, axfr_zone_t *zone, axfr_result_t *result) {
    int sockfd = -1;
    unsigned char query[512];
    unsigned char *response = NULL;
    int query_size;
    int response_size;
    axfr_record_t *records = NULL;
    int ret = -1;
    time_t start_time = time(NULL);

    if (!db || !zone || !result) {
        return -1;
    }

    memset(result, 0, sizeof(axfr_result_t));
    result->status = AXFR_ERROR;

    /* Allocate response buffer */
    response = (unsigned char *)malloc(AXFR_MAX_RESPONSE_SIZE);
    if (!response) {
        result->error_message = strdup("Out of memory");
        return -1;
    }

    /* Connect to master */
    sockfd = axfr_connect_master(zone->master_host, zone->master_port, 30);
    if (sockfd < 0) {
        result->status = AXFR_NETWORK_ERROR;
        result->error_message = strdup("Failed to connect to master");
        goto cleanup;
    }

    /* Create AXFR query */
    query_size = axfr_create_query(zone->zone_name, 1234, query, sizeof(query));
    if (query_size < 0) {
        result->status = AXFR_ERROR;
        result->error_message = strdup("Failed to create AXFR query");
        goto cleanup;
    }

    /* Send query */
    if (axfr_send_query(sockfd, query, query_size) < 0) {
        result->status = AXFR_NETWORK_ERROR;
        result->error_message = strdup("Failed to send AXFR query");
        goto cleanup;
    }

    /* Receive response */
    response_size = axfr_receive_response(sockfd, response, AXFR_MAX_RESPONSE_SIZE, AXFR_TIMEOUT);
    if (response_size < 0) {
        result->status = AXFR_TIMEOUT;
        result->error_message = strdup("Timeout receiving AXFR response");
        goto cleanup;
    }

    /* Parse response */
    result->records_received = axfr_parse_response(response, response_size, &records);
    if (result->records_received < 0) {
        result->status = AXFR_PARSE_ERROR;
        result->error_message = strdup("Failed to parse AXFR response");
        goto cleanup;
    }

    /* Update memzone (if available) */
    if (Memzone) {
        Notice(_("Updating memzone for zone %s"), zone->zone_name);
        if (axfr_update_memzone(Memzone, zone, records, result) < 0) {
            Warnx(_("Failed to update memzone for zone %s"), zone->zone_name);
            /* Continue anyway - try database update */
        }
    }

    /* Update database (if db is provided) */
    if (db) {
        Notice(_("Updating database for zone %s"), zone->zone_name);
        /* Reset records_added counter for database update */
        int memzone_records = result->records_added;
        result->records_added = 0;

        if (axfr_update_database(db, zone, records, result) < 0) {
            result->status = AXFR_DATABASE_ERROR;
            result->error_message = strdup("Failed to update database");
            goto cleanup;
        }

        /* Restore total (memzone + database) */
        result->records_added += memzone_records;
    }

    result->status = AXFR_SUCCESS;
    result->transfer_time = time(NULL) - start_time;
    ret = 0;

cleanup:
    if (sockfd >= 0) close(sockfd);
    if (response) free(response);
    if (records) axfr_free_records(records);

    return ret;
}

/**
 * Update database with transferred zone data
 */
int axfr_update_database(SQL *db, axfr_zone_t *zone, axfr_record_t *records, axfr_result_t *result) {
    axfr_record_t *rec;
    char query[4096];
    SQL_RES *res;

    if (!db || !zone || !records || !result) {
        return -1;
    }

    /* Start transaction */
    sql_query(db, "START TRANSACTION", strlen("START TRANSACTION"));

    /* Delete existing records for this zone */
    snprintf(query, sizeof(query), "DELETE FROM rr WHERE zone = %d", zone->zone_id);
    sql_query(db, query, strlen(query));

    /* Insert new records */
    for (rec = records; rec != NULL; rec = rec->next) {
        char *escaped_name = sql_escstr(db, rec->name);
        char *escaped_data = sql_escstr(db, rec->data);

        snprintf(query, sizeof(query),
            "INSERT INTO rr (zone, name, type, data, ttl, aux) VALUES (%d, '%s', '%s', '%s', %u, %u)",
            zone->zone_id, escaped_name, rec->type, escaped_data, rec->ttl, rec->aux);

        res = sql_query(db, query, strlen(query));
        if (res) {
            result->records_added++;
            sql_free(res);
        }

        RELEASE(escaped_name);
        RELEASE(escaped_data);
    }

    /* Update SOA serial */
    snprintf(query, sizeof(query),
        "UPDATE soa SET serial = %u WHERE id = %d",
        result->new_serial, zone->zone_id);
    sql_query(db, query, strlen(query));

    /* Commit transaction */
    sql_query(db, "COMMIT", strlen("COMMIT"));

    return 0;
}

/**
 * Update memzone with transferred zone data
 */
int axfr_update_memzone(memzone_ctx_t *ctx, axfr_zone_t *zone, axfr_record_t *records, axfr_result_t *result) {
    axfr_record_t *rec;

    if (!ctx || !zone || !records || !result) {
        return -1;
    }

    /* Create mem_soa_t from axfr_zone_t */
    mem_soa_t soa;
    memset(&soa, 0, sizeof(soa));

    soa.zone_id = zone->zone_id;
    strncpy(soa.origin, zone->zone_name, MEMZONE_NAME_MAX - 1);

    /* Parse SOA record from records list (first record should be SOA) */
    if (records && strcmp(records->type, "SOA") == 0) {
        /* Parse SOA data: "ns mbox serial refresh retry expire minimum" */
        char soa_data[1024];
        strncpy(soa_data, records->data, sizeof(soa_data) - 1);

        char *tok = strtok(soa_data, " ");
        if (tok) strncpy(soa.ns, tok, MEMZONE_NAME_MAX - 1);

        tok = strtok(NULL, " ");
        if (tok) strncpy(soa.mbox, tok, MEMZONE_NAME_MAX - 1);

        tok = strtok(NULL, " ");
        if (tok) soa.serial = atoi(tok);

        tok = strtok(NULL, " ");
        if (tok) soa.refresh = atoi(tok);

        tok = strtok(NULL, " ");
        if (tok) soa.retry = atoi(tok);

        tok = strtok(NULL, " ");
        if (tok) soa.expire = atoi(tok);

        tok = strtok(NULL, " ");
        if (tok) soa.minimum = atoi(tok);

        soa.ttl = records->ttl;
    }

    soa.active = 1;
    soa.updated = time(NULL);

    /* Add or update zone in memzone */
    if (memzone_add_zone(ctx, &soa) < 0) {
        Warnx(_("Failed to add zone %s to memzone"), zone->zone_name);
        return -1;
    }

    /* Delete all existing records for this zone */
    memzone_delete_all_rr(ctx, zone->zone_id);

    /* Add new records to memzone */
    for (rec = records; rec != NULL; rec = rec->next) {
        /* Skip SOA record (already processed) */
        if (strcmp(rec->type, "SOA") == 0) {
            continue;
        }

        mem_rr_t rr;
        memset(&rr, 0, sizeof(rr));

        rr.id = 0;  /* Will be assigned by memzone */
        rr.zone_id = zone->zone_id;
        strncpy(rr.name, rec->name, MEMZONE_NAME_MAX - 1);
        rr.type = mydns_rr_get_type(rec->type);
        strncpy(rr.data, rec->data, MEMZONE_DATA_MAX - 1);
        rr.aux = rec->aux;
        rr.ttl = rec->ttl;

        if (memzone_add_rr(ctx, zone->zone_id, &rr) == 0) {
            result->records_added++;
        }
    }

    Notice(_("Updated memzone for zone %s: %d records"), zone->zone_name, result->records_added);
    return 0;
}

/**
 * Log transfer result
 */
void axfr_log_transfer(SQL *db, axfr_zone_t *zone, axfr_result_t *result) {
    char query[2048];
    char *escaped_error = NULL;

    if (!db || !zone || !result) {
        return;
    }

    if (result->error_message) {
        escaped_error = sql_escstr(db, result->error_message);
    }

    snprintf(query, sizeof(query),
        "INSERT INTO zone_transfer_log "
        "(zone_id, master_host, status, records_received, records_added, "
        "records_updated, records_deleted, transfer_time, error_message) "
        "VALUES (%d, '%s', %d, %d, %d, %d, %d, %ld, %s%s%s)",
        zone->zone_id, zone->master_host, result->status,
        result->records_received, result->records_added,
        result->records_updated, result->records_deleted,
        result->transfer_time,
        escaped_error ? "'" : "NULL",
        escaped_error ? escaped_error : "",
        escaped_error ? "'" : "");

    sql_query(db, query, strlen(query));

    if (escaped_error) {
        RELEASE(escaped_error);
    }
}
