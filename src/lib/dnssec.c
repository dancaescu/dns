/*
 * dnssec.c - DNSSEC (DNS Security Extensions) implementation
 * Date: 2025-11-28
 *
 * Implements RFC 4033, 4034, 4035 - DNSSEC
 * RFC 5155 - NSEC3
 * RFC 6781 - DNSSEC Operational Practices
 */

#include "mydnsutil.h"
#include "mydns.h"
#include "dnssec.h"
#include <openssl/evp.h>
#include <openssl/rsa.h>
#include <openssl/ec.h>
#include <openssl/bn.h>
#include <openssl/sha.h>
#include <openssl/rand.h>
#include <openssl/pem.h>
#include <openssl/err.h>
#include <string.h>
#include <stdlib.h>
#include <time.h>
#include <ctype.h>

/* Base32hex alphabet for NSEC3 (RFC 4648) */
static const char base32hex[] = "0123456789ABCDEFGHIJKLMNOPQRSTUV";

/*
 * Initialize DNSSEC module
 */
int dnssec_init(void) {
    OpenSSL_add_all_algorithms();
    ERR_load_crypto_strings();
    return 0;
}

/*
 * Cleanup DNSSEC module
 */
void dnssec_cleanup(void) {
    EVP_cleanup();
    ERR_free_strings();
}

/*
 * Calculate DNSSEC key tag (RFC 4034 Appendix B)
 */
uint16_t dnssec_key_calculate_tag(const unsigned char *key_data, size_t key_len) {
    uint32_t ac = 0;
    size_t i;

    for (i = 0; i < key_len; i++) {
        ac += (i & 1) ? key_data[i] : (key_data[i] << 8);
    }
    ac += (ac >> 16) & 0xFFFF;
    return (uint16_t)(ac & 0xFFFF);
}

/*
 * Get algorithm name
 */
const char *dnssec_algorithm_name(dnssec_algorithm_t alg) {
    switch (alg) {
        case DNSSEC_ALG_RSASHA256:       return "RSASHA256";
        case DNSSEC_ALG_RSASHA512:       return "RSASHA512";
        case DNSSEC_ALG_ECDSAP256SHA256: return "ECDSAP256SHA256";
        case DNSSEC_ALG_ECDSAP384SHA384: return "ECDSAP384SHA384";
        case DNSSEC_ALG_ED25519:         return "ED25519";
        case DNSSEC_ALG_ED448:           return "ED448";
        default:                         return "UNKNOWN";
    }
}

/*
 * Encode domain name in DNS wire format
 */
int dnssec_encode_name(const char *name, unsigned char *buf, size_t buf_len, size_t *encoded_len) {
    const char *label = name;
    unsigned char *p = buf;
    size_t remaining = buf_len;
    size_t len = 0;

    /* Handle root zone */
    if (strcmp(name, ".") == 0) {
        if (remaining < 1) return -1;
        *p = 0;
        *encoded_len = 1;
        return 0;
    }

    while (*label) {
        const char *dot = strchr(label, '.');
        size_t label_len = dot ? (size_t)(dot - label) : strlen(label);

        if (label_len == 0) break;
        if (label_len > 63) return -1;  /* Label too long */
        if (remaining < label_len + 1) return -1;  /* Buffer too small */

        *p++ = (unsigned char)label_len;
        memcpy(p, label, label_len);
        p += label_len;
        remaining -= (label_len + 1);
        len += (label_len + 1);

        if (!dot) break;
        label = dot + 1;
    }

    /* Add root label */
    if (remaining < 1) return -1;
    *p = 0;
    len++;

    *encoded_len = len;
    return 0;
}

/*
 * Convert to lowercase for canonical form (RFC 4034 Section 6.2)
 */
static void dnssec_canonical_lowercase(char *name) {
    while (*name) {
        *name = tolower((unsigned char)*name);
        name++;
    }
}

/*
 * Create type bitmap for NSEC/NSEC3 (RFC 4034 Section 4.1.2)
 */
int dnssec_create_type_bitmap(const uint16_t *types, size_t type_count,
                              unsigned char **bitmap_out, size_t *bitmap_len) {
    unsigned char bitmap[8192 / 8] = {0};  /* Max 8192 types */
    size_t i, max_type = 0;
    unsigned char *result;
    size_t result_len;

    /* Set bits for each type */
    for (i = 0; i < type_count; i++) {
        uint16_t type = types[i];
        if (type < 8192) {
            bitmap[type / 8] |= (0x80 >> (type % 8));
            if (type > max_type) max_type = type;
        }
    }

    /* Calculate result length */
    result_len = (max_type / 8) + 1;
    result = malloc(result_len);
    if (!result) return -1;

    memcpy(result, bitmap, result_len);
    *bitmap_out = result;
    *bitmap_len = result_len;

    return 0;
}

/*
 * Base32hex encoding for NSEC3 (RFC 4648 Section 7)
 */
static int base32hex_encode(const unsigned char *input, size_t input_len,
                            char *output, size_t output_size) {
    size_t i, j;
    uint32_t bits = 0;
    int bit_count = 0;

    j = 0;
    for (i = 0; i < input_len; i++) {
        bits = (bits << 8) | input[i];
        bit_count += 8;

        while (bit_count >= 5) {
            if (j >= output_size - 1) return -1;
            output[j++] = base32hex[(bits >> (bit_count - 5)) & 0x1F];
            bit_count -= 5;
        }
    }

    /* Handle remaining bits */
    if (bit_count > 0) {
        if (j >= output_size - 1) return -1;
        output[j++] = base32hex[(bits << (5 - bit_count)) & 0x1F];
    }

    output[j] = '\0';
    return j;
}

/*
 * NSEC3 hash function (RFC 5155 Section 5)
 */
int dnssec_nsec3_hash(const unsigned char *salt, size_t salt_len, uint16_t iterations,
                     const char *name, unsigned char *hash_out, size_t *hash_len) {
    unsigned char wire_name[256];
    size_t wire_name_len;
    unsigned char hash[SHA_DIGEST_LENGTH];
    unsigned char input[256 + 256];  /* name + salt */
    size_t input_len;
    SHA_CTX ctx;
    uint16_t i;

    /* Convert name to wire format */
    char *canonical_name = strdup(name);
    if (!canonical_name) return -1;
    dnssec_canonical_lowercase(canonical_name);

    if (dnssec_encode_name(canonical_name, wire_name, sizeof(wire_name), &wire_name_len) != 0) {
        free(canonical_name);
        return -1;
    }
    free(canonical_name);

    /* Initial hash: H(owner name | salt) */
    input_len = 0;
    memcpy(input + input_len, wire_name, wire_name_len);
    input_len += wire_name_len;
    if (salt && salt_len > 0) {
        memcpy(input + input_len, salt, salt_len);
        input_len += salt_len;
    }

    SHA1_Init(&ctx);
    SHA1_Update(&ctx, input, input_len);
    SHA1_Final(hash, &ctx);

    /* Iterate */
    for (i = 0; i < iterations; i++) {
        input_len = 0;
        memcpy(input + input_len, hash, SHA_DIGEST_LENGTH);
        input_len += SHA_DIGEST_LENGTH;
        if (salt && salt_len > 0) {
            memcpy(input + input_len, salt, salt_len);
            input_len += salt_len;
        }

        SHA1_Init(&ctx);
        SHA1_Update(&ctx, input, input_len);
        SHA1_Final(hash, &ctx);
    }

    memcpy(hash_out, hash, SHA_DIGEST_LENGTH);
    *hash_len = SHA_DIGEST_LENGTH;

    return 0;
}

/*
 * Load DNSSEC configuration from database
 */
dnssec_config_t *dnssec_config_load(SQL *db, uint32_t zone_id) {
    char query[512];
    SQL_RES *res;
    SQL_ROW row;
    dnssec_config_t *config;

    snprintf(query, sizeof(query),
             "SELECT dnssec_enabled, nsec_mode, preferred_algorithm, "
             "signature_validity, signature_refresh, signature_jitter, "
             "auto_sign, auto_nsec, nsec3_iterations, nsec3_salt_length, nsec3_salt "
             "FROM dnssec_config WHERE zone_id = %u", zone_id);

    if (!(res = sql_query(db, query, NULL))) {
        return NULL;
    }

    if (!(row = sql_getrow(res, NULL))) {
        sql_free(res);
        return NULL;
    }

    config = calloc(1, sizeof(dnssec_config_t));
    if (!config) {
        sql_free(res);
        return NULL;
    }

    config->zone_id = zone_id;
    config->dnssec_enabled = atoi(row[0]);
    config->nsec_mode = strcmp(row[1], "NSEC3") == 0 ? 1 : 0;
    config->preferred_algorithm = atoi(row[2]);
    config->signature_validity = atoi(row[3]);
    config->signature_refresh = atoi(row[4]);
    config->signature_jitter = atoi(row[5]);
    config->auto_sign = atoi(row[6]);
    config->auto_nsec = atoi(row[7]);
    config->nsec3_iterations = atoi(row[8]);
    config->nsec3_salt_length = atoi(row[9]);

    /* Load NSEC3 salt if present */
    if (row[10] && strlen(row[10]) > 0) {
        size_t salt_len = strlen(row[10]) / 2;
        config->nsec3_salt = malloc(salt_len);
        if (config->nsec3_salt) {
            /* Convert hex string to bytes */
            size_t i;
            for (i = 0; i < salt_len; i++) {
                sscanf(row[10] + (i * 2), "%2hhx", &config->nsec3_salt[i]);
            }
        }
    }

    sql_free(res);
    return config;
}

/*
 * Free DNSSEC configuration
 */
void dnssec_config_free(dnssec_config_t *config) {
    if (!config) return;
    if (config->nsec3_salt) free(config->nsec3_salt);
    free(config);
}

/*
 * Load DNSSEC key from database
 */
dnssec_key_t *dnssec_key_load(SQL *db, uint32_t zone_id, uint16_t key_tag) {
    char query[512];
    SQL_RES *res;
    SQL_ROW row;
    dnssec_key_t *key;

    snprintf(query, sizeof(query),
             "SELECT zone_id, key_tag, flags, protocol, algorithm, "
             "public_key, key_type, status, UNIX_TIMESTAMP(created_at), "
             "UNIX_TIMESTAMP(activate_at), UNIX_TIMESTAMP(retire_at) "
             "FROM dnssec_keys WHERE zone_id = %u AND key_tag = %u AND status = 'active'",
             zone_id, key_tag);

    if (!(res = sql_query(db, query, NULL))) {
        return NULL;
    }

    if (!(row = sql_getrow(res, NULL))) {
        sql_free(res);
        return NULL;
    }

    key = calloc(1, sizeof(dnssec_key_t));
    if (!key) {
        sql_free(res);
        return NULL;
    }

    key->zone_id = zone_id;
    key->key_tag = key_tag;
    key->flags = atoi(row[2]);
    key->protocol = atoi(row[3]);
    key->algorithm = atoi(row[4]);

    /* Decode base64 public key */
    if (row[5]) {
        /* TODO: Implement base64 decode - reuse tsig_base64_decode */
        /* For now, store as-is */
        key->public_key = (unsigned char *)strdup(row[5]);
        key->public_key_len = strlen(row[5]);
    }

    key->key_type = row[6] ? strdup(row[6]) : NULL;
    key->status = row[7] ? strdup(row[7]) : NULL;
    key->created_at = row[8] ? atol(row[8]) : 0;
    key->activate_at = row[9] ? atol(row[9]) : 0;
    key->retire_at = row[10] ? atol(row[10]) : 0;

    sql_free(res);
    return key;
}

/*
 * Load active ZSK for zone
 */
dnssec_key_t *dnssec_key_load_active_zsk(SQL *db, uint32_t zone_id) {
    char query[512];
    SQL_RES *res;
    SQL_ROW row;
    uint16_t key_tag;

    snprintf(query, sizeof(query),
             "SELECT key_tag FROM dnssec_keys "
             "WHERE zone_id = %u AND key_type IN ('ZSK', 'CSK') AND status = 'active' "
             "ORDER BY created_at DESC LIMIT 1",
             zone_id);

    if (!(res = sql_query(db, query, NULL))) {
        return NULL;
    }

    if (!(row = sql_getrow(res, NULL))) {
        sql_free(res);
        return NULL;
    }

    key_tag = atoi(row[0]);
    sql_free(res);

    return dnssec_key_load(db, zone_id, key_tag);
}

/*
 * Load active KSK for zone
 */
dnssec_key_t *dnssec_key_load_active_ksk(SQL *db, uint32_t zone_id) {
    char query[512];
    SQL_RES *res;
    SQL_ROW row;
    uint16_t key_tag;

    snprintf(query, sizeof(query),
             "SELECT key_tag FROM dnssec_keys "
             "WHERE zone_id = %u AND key_type IN ('KSK', 'CSK') AND status = 'active' "
             "ORDER BY created_at DESC LIMIT 1",
             zone_id);

    if (!(res = sql_query(db, query, NULL))) {
        return NULL;
    }

    if (!(row = sql_getrow(res, NULL))) {
        sql_free(res);
        return NULL;
    }

    key_tag = atoi(row[0]);
    sql_free(res);

    return dnssec_key_load(db, zone_id, key_tag);
}

/*
 * Free DNSSEC key
 */
void dnssec_key_free(dnssec_key_t *key) {
    if (!key) return;
    if (key->public_key) free(key->public_key);
    if (key->private_key) EVP_PKEY_free(key->private_key);
    if (key->key_type) free(key->key_type);
    if (key->status) free(key->status);
    free(key);
}

/*
 * Generate DNSSEC key pair
 */
int dnssec_key_generate(SQL *db, uint32_t zone_id, dnssec_algorithm_t algorithm,
                        int key_size, int is_ksk, dnssec_key_t **key_out) {
    EVP_PKEY *pkey = NULL;
    EVP_PKEY_CTX *pctx = NULL;
    unsigned char *pubkey_buf = NULL;
    int pubkey_len;
    uint16_t key_tag;
    uint16_t flags;
    char query[2048];
    dnssec_key_t *key = NULL;
    int ret = -1;

    /* Generate key based on algorithm */
    switch (algorithm) {
        case DNSSEC_ALG_RSASHA256:
        case DNSSEC_ALG_RSASHA512:
            pctx = EVP_PKEY_CTX_new_id(EVP_PKEY_RSA, NULL);
            if (!pctx) goto cleanup;
            if (EVP_PKEY_keygen_init(pctx) <= 0) goto cleanup;
            if (EVP_PKEY_CTX_set_rsa_keygen_bits(pctx, key_size) <= 0) goto cleanup;
            if (EVP_PKEY_keygen(pctx, &pkey) <= 0) goto cleanup;
            break;

        case DNSSEC_ALG_ECDSAP256SHA256:
            pctx = EVP_PKEY_CTX_new_id(EVP_PKEY_EC, NULL);
            if (!pctx) goto cleanup;
            if (EVP_PKEY_keygen_init(pctx) <= 0) goto cleanup;
            if (EVP_PKEY_CTX_set_ec_paramgen_curve_nid(pctx, NID_X9_62_prime256v1) <= 0) goto cleanup;
            if (EVP_PKEY_keygen(pctx, &pkey) <= 0) goto cleanup;
            break;

        case DNSSEC_ALG_ECDSAP384SHA384:
            pctx = EVP_PKEY_CTX_new_id(EVP_PKEY_EC, NULL);
            if (!pctx) goto cleanup;
            if (EVP_PKEY_keygen_init(pctx) <= 0) goto cleanup;
            if (EVP_PKEY_CTX_set_ec_paramgen_curve_nid(pctx, NID_secp384r1) <= 0) goto cleanup;
            if (EVP_PKEY_keygen(pctx, &pkey) <= 0) goto cleanup;
            break;

        default:
            goto cleanup;
    }

    /* Get public key in DER format */
    pubkey_len = i2d_PUBKEY(pkey, &pubkey_buf);
    if (pubkey_len < 0) goto cleanup;

    /* Calculate key tag */
    flags = is_ksk ? DNSSEC_FLAGS_KSK : DNSSEC_FLAGS_ZSK;
    unsigned char tag_input[4];
    tag_input[0] = (flags >> 8) & 0xFF;
    tag_input[1] = flags & 0xFF;
    tag_input[2] = 3;  /* protocol */
    tag_input[3] = algorithm;
    /* Simplified key tag - should include full key data */
    key_tag = dnssec_key_calculate_tag(pubkey_buf, pubkey_len);

    /* Store in database */
    /* TODO: Base64 encode public key, handle private key storage */
    snprintf(query, sizeof(query),
             "INSERT INTO dnssec_keys (zone_id, key_tag, flags, protocol, algorithm, "
             "public_key, key_type, status) VALUES (%u, %u, %u, 3, %u, '%s', '%s', 'active')",
             zone_id, key_tag, flags, algorithm, "TODO_BASE64_PUBKEY",
             is_ksk ? "KSK" : "ZSK");

    /* Execute query */
    SQL_RES *res = sql_query(db, query, NULL);
    if (!res) goto cleanup;
    sql_free(res);

    /* Create key structure */
    key = calloc(1, sizeof(dnssec_key_t));
    if (!key) goto cleanup;

    key->zone_id = zone_id;
    key->key_tag = key_tag;
    key->flags = flags;
    key->protocol = 3;
    key->algorithm = algorithm;
    key->public_key = pubkey_buf;
    key->public_key_len = pubkey_len;
    key->private_key = pkey;
    key->key_type = strdup(is_ksk ? "KSK" : "ZSK");
    key->status = strdup("active");
    key->created_at = time(NULL);

    pubkey_buf = NULL;  /* Ownership transferred */
    pkey = NULL;  /* Ownership transferred */

    *key_out = key;
    ret = 0;

cleanup:
    if (pctx) EVP_PKEY_CTX_free(pctx);
    if (pkey) EVP_PKEY_free(pkey);
    if (pubkey_buf) OPENSSL_free(pubkey_buf);
    return ret;
}

/*
 * Create RRset structure
 */
dnssec_rrset_t *dnssec_rrset_create(const char *name, uint16_t type, uint16_t class, uint32_t ttl) {
    dnssec_rrset_t *rrset = calloc(1, sizeof(dnssec_rrset_t));
    if (!rrset) return NULL;

    rrset->name = strdup(name);
    rrset->type = type;
    rrset->class = class;
    rrset->ttl = ttl;
    rrset->rdata_count = 0;
    rrset->rdata = NULL;
    rrset->rdata_len = NULL;

    return rrset;
}

/*
 * Add RDATA to RRset
 */
int dnssec_rrset_add_rdata(dnssec_rrset_t *rrset, const unsigned char *rdata, size_t rdata_len) {
    unsigned char **new_rdata = realloc(rrset->rdata, (rrset->rdata_count + 1) * sizeof(unsigned char *));
    size_t *new_rdata_len = realloc(rrset->rdata_len, (rrset->rdata_count + 1) * sizeof(size_t));

    if (!new_rdata || !new_rdata_len) return -1;

    rrset->rdata = new_rdata;
    rrset->rdata_len = new_rdata_len;

    rrset->rdata[rrset->rdata_count] = malloc(rdata_len);
    if (!rrset->rdata[rrset->rdata_count]) return -1;

    memcpy(rrset->rdata[rrset->rdata_count], rdata, rdata_len);
    rrset->rdata_len[rrset->rdata_count] = rdata_len;
    rrset->rdata_count++;

    return 0;
}

/*
 * Free RRset
 */
void dnssec_rrset_free(dnssec_rrset_t *rrset) {
    size_t i;
    if (!rrset) return;
    if (rrset->name) free(rrset->name);
    if (rrset->rdata) {
        for (i = 0; i < rrset->rdata_count; i++) {
            if (rrset->rdata[i]) free(rrset->rdata[i]);
        }
        free(rrset->rdata);
    }
    if (rrset->rdata_len) free(rrset->rdata_len);
    free(rrset);
}

/*
 * Sign RRset and generate RRSIG (RFC 4034 Section 3)
 * This is a simplified implementation - full version needs:
 * - Canonical ordering of RDATA
 * - Proper wire format construction
 * - Complete signature generation
 */
int dnssec_sign_rrset(SQL *db, dnssec_key_t *key, const dnssec_rrset_t *rrset,
                      const char *zone_name, dnssec_config_t *config,
                      dnssec_rrsig_t **rrsig_out) {
    dnssec_rrsig_t *rrsig = NULL;
    EVP_MD_CTX *md_ctx = NULL;
    const EVP_MD *md = NULL;
    unsigned char *sig_buf = NULL;
    size_t sig_len;
    int ret = -1;

    /* Create RRSIG structure */
    rrsig = calloc(1, sizeof(dnssec_rrsig_t));
    if (!rrsig) return -1;

    rrsig->type_covered = rrset->type;
    rrsig->algorithm = key->algorithm;
    rrsig->labels = 0;  /* TODO: Count labels in name */
    rrsig->original_ttl = rrset->ttl;
    rrsig->signature_inception = time(NULL);
    rrsig->signature_expiration = rrsig->signature_inception + config->signature_validity;
    rrsig->key_tag = key->key_tag;
    rrsig->signer_name = strdup(zone_name);

    /* Select hash algorithm */
    switch (key->algorithm) {
        case DNSSEC_ALG_RSASHA256:
        case DNSSEC_ALG_ECDSAP256SHA256:
            md = EVP_sha256();
            break;
        case DNSSEC_ALG_RSASHA512:
            md = EVP_sha512();
            break;
        case DNSSEC_ALG_ECDSAP384SHA384:
            md = EVP_sha384();
            break;
        default:
            goto cleanup;
    }

    /* Create signature context */
    md_ctx = EVP_MD_CTX_new();
    if (!md_ctx) goto cleanup;

    if (EVP_DigestSignInit(md_ctx, NULL, md, NULL, key->private_key) <= 0) {
        goto cleanup;
    }

    /* TODO: Build canonical data to sign (RFC 4034 Section 3.1.8.1):
     * 1. RRSIG RDATA (excluding signature)
     * 2. Canonical RR(i) = owner | type | class | TTL | RDATA length | RDATA
     * For now, this is a placeholder
     */
    unsigned char data_to_sign[4096];  /* Placeholder */
    size_t data_len = 0;  /* TODO: Build actual data */

    /* Sign the data */
    if (EVP_DigestSign(md_ctx, NULL, &sig_len, data_to_sign, data_len) <= 0) {
        goto cleanup;
    }

    sig_buf = malloc(sig_len);
    if (!sig_buf) goto cleanup;

    if (EVP_DigestSign(md_ctx, sig_buf, &sig_len, data_to_sign, data_len) <= 0) {
        goto cleanup;
    }

    rrsig->signature = sig_buf;
    rrsig->signature_len = sig_len;
    sig_buf = NULL;  /* Ownership transferred */

    *rrsig_out = rrsig;
    ret = 0;

cleanup:
    if (md_ctx) EVP_MD_CTX_free(md_ctx);
    if (sig_buf) free(sig_buf);
    if (ret != 0 && rrsig) {
        dnssec_rrsig_free(rrsig);
    }
    return ret;
}

/*
 * Free RRSIG
 */
void dnssec_rrsig_free(dnssec_rrsig_t *rrsig) {
    if (!rrsig) return;
    if (rrsig->signer_name) free(rrsig->signer_name);
    if (rrsig->signature) free(rrsig->signature);
    free(rrsig);
}

/*
 * Database helper: Queue zone for signing
 */
int dnssec_db_queue_signing(SQL *db, uint32_t zone_id, const char *rrset_name,
                            uint16_t rrset_type, const char *reason, int priority) {
    char query[1024];
    SQL_RES *res;

    snprintf(query, sizeof(query),
             "INSERT INTO dnssec_signing_queue (zone_id, rrset_name, rrset_type, reason, priority) "
             "VALUES (%u, %s%s%s, %s%u%s, '%s', %d) "
             "ON DUPLICATE KEY UPDATE priority = LEAST(priority, %d), status = 'pending'",
             zone_id,
             rrset_name ? "'" : "NULL", rrset_name ? rrset_name : "", rrset_name ? "'" : "",
             rrset_type ? "'" : "NULL", rrset_type, rrset_type ? "'" : "",
             reason, priority, priority);

    res = sql_query(db, query, NULL);
    if (!res) return -1;

    sql_free(res);
    return 0;
}

/*
 * Database helper: Log DNSSEC operation
 */
int dnssec_db_log_operation(SQL *db, uint32_t zone_id, const char *operation,
                            int success, const char *details) {
    char query[2048];
    char escaped_details[1024] = "";
    SQL_RES *res;

    if (details) {
        /* TODO: Proper SQL escaping */
        strncpy(escaped_details, details, sizeof(escaped_details) - 1);
    }

    snprintf(query, sizeof(query),
             "INSERT INTO dnssec_log (zone_id, operation, success, details) "
             "VALUES (%u, '%s', %d, '%s')",
             zone_id, operation, success, escaped_details);

    res = sql_query(db, query, NULL);
    if (!res) return -1;

    sql_free(res);
    return 0;
}

/* Placeholder implementations for remaining functions */
void dnssec_dnskey_free(dnssec_dnskey_t *dnskey) {
    if (!dnskey) return;
    if (dnskey->public_key) free(dnskey->public_key);
    free(dnskey);
}

void dnssec_ds_free(dnssec_ds_t *ds) {
    if (!ds) return;
    if (ds->digest) free(ds->digest);
    free(ds);
}

void dnssec_nsec_free(dnssec_nsec_t *nsec) {
    if (!nsec) return;
    if (nsec->next_domain) free(nsec->next_domain);
    if (nsec->type_bitmap) free(nsec->type_bitmap);
    free(nsec);
}

void dnssec_nsec3_free(dnssec_nsec3_t *nsec3) {
    if (!nsec3) return;
    if (nsec3->salt) free(nsec3->salt);
    if (nsec3->next_hash) free(nsec3->next_hash);
    if (nsec3->type_bitmap) free(nsec3->type_bitmap);
    free(nsec3);
}

void dnssec_nsec3param_free(dnssec_nsec3param_t *nsec3param) {
    if (!nsec3param) return;
    if (nsec3param->salt) free(nsec3param->salt);
    free(nsec3param);
}
