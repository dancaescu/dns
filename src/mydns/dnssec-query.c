/*
 * dnssec-query.c - DNSSEC query response integration
 * Date: 2025-11-28
 *
 * Integrates DNSSEC records into query responses:
 * - Add RRSIG records when DO bit is set
 * - Serve DNSKEY records on request
 * - Serve NSEC/NSEC3 for NXDOMAIN
 */

#include "named.h"
#include "dnssec-query.h"
#include <string.h>
#include <stdlib.h>
#include <time.h>
#include <stdint.h>

/* External references */
extern SQL *sql;  /* Global SQL connection from db.c */

/* Helper to write uint16_t in network byte order */
static inline void
write_uint16(unsigned char *buf, uint16_t val) {
    buf[0] = (val >> 8) & 0xFF;
    buf[1] = val & 0xFF;
}

/* Helper to write uint32_t in network byte order */
static inline void
write_uint32(unsigned char *buf, uint32_t val) {
    buf[0] = (val >> 24) & 0xFF;
    buf[1] = (val >> 16) & 0xFF;
    buf[2] = (val >> 8) & 0xFF;
    buf[3] = val & 0xFF;
}

/* Helper to convert DNS type string to uint16_t */
static uint16_t
dns_type_str_to_num(const char *type_str) {
    /* Map common type strings to type numbers */
    if (strcmp(type_str, "A") == 0) return 1;
    if (strcmp(type_str, "NS") == 0) return 2;
    if (strcmp(type_str, "CNAME") == 0) return 5;
    if (strcmp(type_str, "SOA") == 0) return 6;
    if (strcmp(type_str, "PTR") == 0) return 12;
    if (strcmp(type_str, "MX") == 0) return 15;
    if (strcmp(type_str, "TXT") == 0) return 16;
    if (strcmp(type_str, "AAAA") == 0) return 28;
    if (strcmp(type_str, "DNSKEY") == 0) return 48;
    return 1; /* Default to A */
}

/* Helper to decode base64 string */
static int
base64_decode(const char *input, unsigned char *output, size_t max_len) {
    static const unsigned char d[] = {
        66,66,66,66,66,66,66,66,66,66,64,66,66,66,66,66,66,66,66,66,66,66,66,66,66,
        66,66,66,66,66,66,66,66,66,66,66,66,66,66,66,66,66,66,62,66,66,66,63,52,53,
        54,55,56,57,58,59,60,61,66,66,66,65,66,66,66, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
        10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,66,66,66,66,66,66,26,27,28,
        29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,66,66,
        66,66,66,66,66,66,66,66,66,66,66,66,66,66,66,66,66,66,66,66,66,66,66,66,66,
        66,66,66,66,66,66,66,66,66,66,66,66,66,66,66,66,66,66,66,66,66,66,66,66,66,
        66,66,66,66,66,66,66,66,66,66,66,66,66,66,66,66,66,66,66,66,66,66,66,66,66,
        66,66,66,66,66,66,66,66,66,66,66,66,66,66,66,66,66,66,66,66,66,66,66,66,66,
        66,66,66,66,66,66,66,66,66,66,66,66,66,66,66,66,66,66,66,66,66,66,66,66,66,
        66,66,66,66,66,66};

    size_t in_len = strlen(input);
    size_t out_len = 0;
    unsigned char buf[4];
    int i, j;

    for (i = 0, j = 0; i < in_len && out_len < max_len;) {
        unsigned char c = input[i++];
        if (c == '=' || c == '\n' || c == '\r' || c == ' ' || c == '\t') continue;
        if (d[c] == 66 || d[c] == 64) continue; /* Invalid or padding */

        buf[j++] = d[c];
        if (j == 4) {
            if (out_len + 3 > max_len) break;
            output[out_len++] = (buf[0] << 2) | (buf[1] >> 4);
            output[out_len++] = (buf[1] << 4) | (buf[2] >> 2);
            output[out_len++] = (buf[2] << 6) | buf[3];
            j = 0;
        }
    }

    if (j >= 2 && out_len < max_len) {
        output[out_len++] = (buf[0] << 2) | (buf[1] >> 4);
        if (j >= 3 && out_len < max_len) {
            output[out_len++] = (buf[1] << 4) | (buf[2] >> 2);
        }
    }

    return out_len;
}

/* Helper to encode domain name in wire format */
static int
encode_domain_name(const char *name, unsigned char *buf, size_t max_len) {
    size_t len = strlen(name);
    size_t pos = 0;
    const char *label_start = name;
    const char *p = name;

    while (*p && pos < max_len - 1) {
        if (*p == '.') {
            size_t label_len = p - label_start;
            if (label_len > 0 && label_len <= 63 && pos + label_len + 1 < max_len) {
                buf[pos++] = label_len;
                memcpy(buf + pos, label_start, label_len);
                pos += label_len;
            }
            label_start = p + 1;
        }
        p++;
    }

    /* Handle final label if not ending with dot */
    if (label_start < p && *label_start) {
        size_t label_len = p - label_start;
        if (label_len > 0 && label_len <= 63 && pos + label_len + 1 < max_len) {
            buf[pos++] = label_len;
            memcpy(buf + pos, label_start, label_len);
            pos += label_len;
        }
    }

    /* Add root label */
    if (pos < max_len) {
        buf[pos++] = 0;
    }

    return pos;
}

/* Parse timestamp string (YYYY-MM-DD HH:MM:SS) to Unix timestamp */
static uint32_t
parse_timestamp(const char *ts_str) {
    struct tm tm;
    memset(&tm, 0, sizeof(tm));

    if (sscanf(ts_str, "%d-%d-%d %d:%d:%d",
               &tm.tm_year, &tm.tm_mon, &tm.tm_mday,
               &tm.tm_hour, &tm.tm_min, &tm.tm_sec) == 6) {
        tm.tm_year -= 1900;
        tm.tm_mon -= 1;
        return (uint32_t)mktime(&tm);
    }

    return 0;
}

/*
 * Build RRSIG RDATA in wire format (RFC 4034 Section 3)
 * Returns length of encoded data, or 0 on error
 */
static size_t
build_rrsig_rdata(unsigned char *rdata, size_t max_len, SQL_ROW row, const char *rrset_type_str) {
    /* Row format: algorithm, labels, original_ttl, signature_expiration,
                   signature_inception, key_tag, signer_name, signature */
    size_t pos = 0;
    uint16_t type_covered, key_tag;
    uint8_t algorithm, labels;
    uint32_t original_ttl, sig_exp, sig_inc;
    unsigned char sig_buf[512];
    int sig_len;

    if (!row[0] || !row[1] || !row[2] || !row[3] || !row[4] || !row[5] || !row[6] || !row[7]) {
        return 0;
    }

    /* Parse fields from database row */
    type_covered = dns_type_str_to_num(rrset_type_str);
    algorithm = atoi(row[0]);
    labels = atoi(row[1]);
    original_ttl = atoi(row[2]);
    sig_exp = parse_timestamp(row[3]);
    sig_inc = parse_timestamp(row[4]);
    key_tag = atoi(row[5]);

    /* Decode base64 signature */
    sig_len = base64_decode(row[7], sig_buf, sizeof(sig_buf));
    if (sig_len <= 0) {
        return 0;
    }

    /* Build RRSIG RDATA */
    if (pos + 18 > max_len) return 0;

    write_uint16(rdata + pos, type_covered); pos += 2;
    rdata[pos++] = algorithm;
    rdata[pos++] = labels;
    write_uint32(rdata + pos, original_ttl); pos += 4;
    write_uint32(rdata + pos, sig_exp); pos += 4;
    write_uint32(rdata + pos, sig_inc); pos += 4;
    write_uint16(rdata + pos, key_tag); pos += 2;

    /* Encode signer's name */
    int name_len = encode_domain_name(row[6], rdata + pos, max_len - pos);
    if (name_len <= 0) return 0;
    pos += name_len;

    /* Append signature */
    if (pos + sig_len > max_len) return 0;
    memcpy(rdata + pos, sig_buf, sig_len);
    pos += sig_len;

    return pos;
}

/*
 * Build DNSKEY RDATA in wire format (RFC 4034 Section 2)
 * Returns length of encoded data, or 0 on error
 */
static size_t
build_dnskey_rdata(unsigned char *rdata, size_t max_len, SQL_ROW row) {
    /* Row format: algorithm, key_tag, key_type, public_key */
    size_t pos = 0;
    uint16_t flags;
    uint8_t protocol = 3; /* Always 3 for DNSSEC */
    uint8_t algorithm;
    unsigned char key_buf[512];
    int key_len;

    if (!row[0] || !row[1] || !row[2] || !row[3]) {
        return 0;
    }

    algorithm = atoi(row[0]);
    const char *key_type = row[2];

    /* Set flags: bit 7 = Zone Key, bit 15 = Secure Entry Point (for KSK) */
    flags = 256; /* Zone Key flag */
    if (strcmp(key_type, "KSK") == 0 || strcmp(key_type, "CSK") == 0) {
        flags |= 1; /* SEP flag for KSK/CSK */
    }

    /* Decode base64 public key */
    key_len = base64_decode(row[3], key_buf, sizeof(key_buf));
    if (key_len <= 0) {
        return 0;
    }

    /* Build DNSKEY RDATA */
    if (pos + 4 + key_len > max_len) return 0;

    write_uint16(rdata + pos, flags); pos += 2;
    rdata[pos++] = protocol;
    rdata[pos++] = algorithm;
    memcpy(rdata + pos, key_buf, key_len);
    pos += key_len;

    return pos;
}

/*
 * Build NSEC3 RDATA in wire format (RFC 5155 Section 3)
 * Returns length of encoded data, or 0 on error
 */
static size_t
build_nsec3_rdata(unsigned char *rdata, size_t max_len, SQL_ROW row) {
    /* Row format: hash_algorithm, flags, iterations, salt, hash, next_hash, types */
    size_t pos = 0;
    uint8_t hash_algo, flags;
    uint16_t iterations;
    unsigned char salt_buf[128], next_hash_buf[128];
    int salt_len, next_hash_len;

    if (!row[0] || !row[1] || !row[2] || !row[3] || !row[5]) {
        return 0;
    }

    hash_algo = atoi(row[0]);
    flags = atoi(row[1]);
    iterations = atoi(row[2]);

    /* Decode hex salt */
    salt_len = 0;
    if (row[3] && strlen(row[3]) > 0 && strcmp(row[3], "-") != 0) {
        /* Simple hex decode */
        const char *hex = row[3];
        while (*hex && salt_len < sizeof(salt_buf)) {
            if (sscanf(hex, "%2hhx", &salt_buf[salt_len]) == 1) {
                salt_len++;
                hex += 2;
            } else {
                break;
            }
        }
    }

    /* Decode hex next hash */
    next_hash_len = 0;
    const char *hex = row[5];
    while (*hex && next_hash_len < sizeof(next_hash_buf)) {
        if (sscanf(hex, "%2hhx", &next_hash_buf[next_hash_len]) == 1) {
            next_hash_len++;
            hex += 2;
        } else {
            break;
        }
    }

    if (next_hash_len <= 0) return 0;

    /* Build NSEC3 RDATA */
    if (pos + 5 + salt_len + 1 + next_hash_len > max_len) return 0;

    rdata[pos++] = hash_algo;
    rdata[pos++] = flags;
    write_uint16(rdata + pos, iterations); pos += 2;
    rdata[pos++] = salt_len;
    if (salt_len > 0) {
        memcpy(rdata + pos, salt_buf, salt_len);
        pos += salt_len;
    }
    rdata[pos++] = next_hash_len;
    memcpy(rdata + pos, next_hash_buf, next_hash_len);
    pos += next_hash_len;

    /* TODO: Add type bitmap from row[6] */
    /* For now, we'll add a simple bitmap indicating A record exists */
    rdata[pos++] = 0; /* Window block 0 */
    rdata[pos++] = 1; /* Bitmap length */
    rdata[pos++] = 0x40; /* Bit 1 set (A record) */

    return pos;
}

/* Check if EDNS0 DO (DNSSEC OK) bit is set in query */
static int
query_wants_dnssec(TASK *t) {
    /* TODO: Parse EDNS0 OPT record from query to check DO bit */
    /* For now, check if dnssec is globally enabled */
    (void)t;  /* Unused for now */
    return dnssec_enabled;
}

/*
 * Add RRSIG records for an RRset to the response
 */
static int
add_rrsig_for_rrset(TASK *t, datasection_t section, const char *rrset_name,
                    dns_qtype_t rrset_type, uint32_t zone_id) {
    SQL_RES *res = NULL;
    SQL_ROW row;
    char query[1024];
    const char *type_str = mydns_qtype_str(rrset_type);
    int count = 0;

    /* Query dnssec_signatures table for matching RRSIGs */
    snprintf(query, sizeof(query),
             "SELECT algorithm, labels, original_ttl, signature_expiration, "
             "signature_inception, key_tag, signer_name, signature "
             "FROM dnssec_signatures "
             "WHERE zone_id = %u AND name = '%s' AND type = '%s' "
             "AND signature_expiration > NOW() "
             "LIMIT 10",
             zone_id, rrset_name, type_str);

    if (!(res = sql_query(sql, query, strlen(query)))) {
        Warnx("DNSSEC: Failed to query signatures for %s/%s", rrset_name, type_str);
        return 0;
    }

    /* Add each RRSIG to the response */
    while ((row = sql_getrow(res, NULL))) {
        unsigned char rdata[1024];
        size_t rdlen;
        MYDNS_RR *rr;

        /* Build RRSIG RDATA in wire format */
        rdlen = build_rrsig_rdata(rdata, sizeof(rdata), row, type_str);
        if (rdlen == 0) {
            Warnx("DNSSEC: Failed to build RRSIG RDATA for %s/%s", rrset_name, type_str);
            continue;
        }

        /* Create MYDNS_RR structure */
        rr = (MYDNS_RR *)malloc(sizeof(MYDNS_RR));
        if (!rr) {
            Warnx("DNSSEC: Failed to allocate MYDNS_RR for RRSIG");
            continue;
        }
        memset(rr, 0, sizeof(MYDNS_RR));

        /* Set RR fields */
        rr->id = 0;
        rr->zone = zone_id;
        rr->type = DNS_QTYPE_RRSIG;
        rr->class = DNS_CLASS_IN;
        rr->ttl = 3600; /* TODO: Use actual TTL from config */
        rr->aux = 0;

        /* Set name */
        rr->_name = (char *)malloc(strlen(rrset_name) + 1);
        if (!rr->_name) {
            free(rr);
            continue;
        }
        strcpy(rr->_name, rrset_name);

        /* Set RDATA */
        rr->_data.len = rdlen;
        rr->_data.value = malloc(rdlen);
        if (!rr->_data.value) {
            free(rr->_name);
            free(rr);
            continue;
        }
        memcpy(rr->_data.value, rdata, rdlen);

        /* Add to response */
        rrlist_add(t, section, DNS_RRTYPE_RR, (void *)rr, (char *)rrset_name);

        /* Free the RR (rrlist_add makes a copy) */
        free(rr->_data.value);
        free(rr->_name);
        free(rr);

        count++;
    }

    sql_free(res);

    return count;
}

/*
 * Add DNSKEY records for a zone
 */
static int
add_dnskey_records(TASK *t, datasection_t section, uint32_t zone_id, const char *zone_name) {
    SQL_RES *res = NULL;
    SQL_ROW row;
    char query[1024];
    int count = 0;

    /* Query dnssec_keys table for active keys */
    snprintf(query, sizeof(query),
             "SELECT algorithm, key_tag, key_type, public_key "
             "FROM dnssec_keys "
             "WHERE zone_id = %u AND status = 'active' "
             "ORDER BY key_type ASC "
             "LIMIT 10",
             zone_id);

    if (!(res = sql_query(sql, query, strlen(query)))) {
        Warnx("DNSSEC: Failed to query DNSKEY records for zone %u", zone_id);
        return 0;
    }

    /* Add each DNSKEY to the response */
    while ((row = sql_getrow(res, NULL))) {
        unsigned char rdata[1024];
        size_t rdlen;
        MYDNS_RR *rr;

        /* Build DNSKEY RDATA in wire format */
        rdlen = build_dnskey_rdata(rdata, sizeof(rdata), row);
        if (rdlen == 0) {
            Warnx("DNSSEC: Failed to build DNSKEY RDATA for zone %s", zone_name);
            continue;
        }

        /* Create MYDNS_RR structure */
        rr = (MYDNS_RR *)malloc(sizeof(MYDNS_RR));
        if (!rr) {
            Warnx("DNSSEC: Failed to allocate MYDNS_RR for DNSKEY");
            continue;
        }
        memset(rr, 0, sizeof(MYDNS_RR));

        /* Set RR fields */
        rr->id = 0;
        rr->zone = zone_id;
        rr->type = DNS_QTYPE_DNSKEY;
        rr->class = DNS_CLASS_IN;
        rr->ttl = 3600;
        rr->aux = 0;

        /* Set name */
        rr->_name = (char *)malloc(strlen(zone_name) + 1);
        if (!rr->_name) {
            free(rr);
            continue;
        }
        strcpy(rr->_name, zone_name);

        /* Set RDATA */
        rr->_data.len = rdlen;
        rr->_data.value = malloc(rdlen);
        if (!rr->_data.value) {
            free(rr->_name);
            free(rr);
            continue;
        }
        memcpy(rr->_data.value, rdata, rdlen);

        /* Add to response */
        rrlist_add(t, section, DNS_RRTYPE_RR, (void *)rr, (char *)zone_name);

        /* Free the RR (rrlist_add makes a copy) */
        free(rr->_data.value);
        free(rr->_name);
        free(rr);

        count++;
    }

    sql_free(res);

    return count;
}

/*
 * Add NSEC3 record for NXDOMAIN response
 */
static int
add_nsec3_for_nxdomain(TASK *t, uint32_t zone_id, const char *zone_name, const char *qname) {
    SQL_RES *res = NULL;
    SQL_ROW row;
    char query[1024];
    int count = 0;

    (void)qname; /* Unused for now - TODO: find closest encloser */

    /* Query dnssec_nsec3 table for closest encloser */
    snprintf(query, sizeof(query),
             "SELECT hash_algorithm, flags, iterations, salt, hash, next_hash, types "
             "FROM dnssec_nsec3 "
             "WHERE zone_id = %u "
             "ORDER BY hash "
             "LIMIT 3",
             zone_id);

    if (!(res = sql_query(sql, query, strlen(query)))) {
        Warnx("DNSSEC: Failed to query NSEC3 records for zone %u", zone_id);
        return 0;
    }

    /* Add NSEC3 records to the response */
    while ((row = sql_getrow(res, NULL))) {
        unsigned char rdata[1024];
        size_t rdlen;
        MYDNS_RR *rr;
        char nsec3_name[256];

        /* Build NSEC3 RDATA in wire format */
        rdlen = build_nsec3_rdata(rdata, sizeof(rdata), row);
        if (rdlen == 0) {
            Warnx("DNSSEC: Failed to build NSEC3 RDATA for zone %s", zone_name);
            continue;
        }

        /* Construct NSEC3 owner name: <hash>.zone */
        if (row[4] && strlen(row[4]) > 0) {
            snprintf(nsec3_name, sizeof(nsec3_name), "%.32s.%s", row[4], zone_name);
        } else {
            continue;
        }

        /* Create MYDNS_RR structure */
        rr = (MYDNS_RR *)malloc(sizeof(MYDNS_RR));
        if (!rr) {
            Warnx("DNSSEC: Failed to allocate MYDNS_RR for NSEC3");
            continue;
        }
        memset(rr, 0, sizeof(MYDNS_RR));

        /* Set RR fields */
        rr->id = 0;
        rr->zone = zone_id;
        rr->type = DNS_QTYPE_NSEC3;
        rr->class = DNS_CLASS_IN;
        rr->ttl = 3600;
        rr->aux = 0;

        /* Set name */
        rr->_name = (char *)malloc(strlen(nsec3_name) + 1);
        if (!rr->_name) {
            free(rr);
            continue;
        }
        strcpy(rr->_name, nsec3_name);

        /* Set RDATA */
        rr->_data.len = rdlen;
        rr->_data.value = malloc(rdlen);
        if (!rr->_data.value) {
            free(rr->_name);
            free(rr);
            continue;
        }
        memcpy(rr->_data.value, rdata, rdlen);

        /* Add to AUTHORITY section */
        rrlist_add(t, AUTHORITY, DNS_RRTYPE_RR, (void *)rr, nsec3_name);

        /* Free the RR (rrlist_add makes a copy) */
        free(rr->_data.value);
        free(rr->_name);
        free(rr);

        count++;
    }

    sql_free(res);

    return count;
}

/*
 * Check if DNSSEC is enabled for a zone
 */
static int
zone_has_dnssec(TASK *t, uint32_t zone_id) {
    SQL_RES *res = NULL;
    SQL_ROW row;
    char query[256];
    int enabled = 0;

    (void)t;  /* Unused for now */

    /* Query dnssec_config table */
    snprintf(query, sizeof(query),
             "SELECT dnssec_enabled FROM dnssec_config WHERE zone_id = %u",
             zone_id);

    if ((res = sql_query(sql, query, strlen(query)))) {
        if ((row = sql_getrow(res, NULL))) {
            enabled = (row[0] && (atoi(row[0]) == 1 || strcasecmp(row[0], "TRUE") == 0));
        }
        sql_free(res);
    }

    return enabled;
}

/*
 * Main entry point: Add DNSSEC records to response
 * Call this after adding regular records to the response
 */
void
dnssec_add_to_response(TASK *t, datasection_t section, uint32_t zone_id,
                       const char *zone_name, const char *rrset_name,
                       dns_qtype_t rrset_type) {
    /* Skip if DNSSEC not globally enabled */
    if (!dnssec_enabled) {
        return;
    }

    /* Skip if zone doesn't have DNSSEC enabled */
    if (!zone_has_dnssec(t, zone_id)) {
        return;
    }

    /* Skip if client doesn't want DNSSEC (no DO bit) */
    if (!query_wants_dnssec(t)) {
        return;
    }

    /* If this is a DNSKEY query, serve the keys */
    if (rrset_type == DNS_QTYPE_DNSKEY) {
        add_dnskey_records(t, section, zone_id, zone_name);
        /* Also add RRSIG for the DNSKEY RRset */
        add_rrsig_for_rrset(t, section, zone_name, DNS_QTYPE_DNSKEY, zone_id);
        return;
    }

    /* For other record types, add RRSIGs */
    add_rrsig_for_rrset(t, section, rrset_name, rrset_type, zone_id);
}

/*
 * Add NSEC3 for NXDOMAIN response
 */
void
dnssec_add_nxdomain_proof(TASK *t, uint32_t zone_id, const char *zone_name,
                          const char *qname) {
    /* Skip if DNSSEC not enabled */
    if (!dnssec_enabled) {
        return;
    }

    /* Skip if zone doesn't have DNSSEC enabled */
    if (!zone_has_dnssec(t, zone_id)) {
        return;
    }

    /* Skip if client doesn't want DNSSEC */
    if (!query_wants_dnssec(t)) {
        return;
    }

    /* Add NSEC3 record */
    add_nsec3_for_nxdomain(t, zone_id, zone_name, qname);

    /* Also add SOA with RRSIG for negative caching */
    add_rrsig_for_rrset(t, AUTHORITY, zone_name, DNS_QTYPE_SOA, zone_id);
}

/* vim:set ts=4 sw=4: */
