/*
 * tsig.c - TSIG (Transaction Signatures) implementation
 * Date: 2025-11-26
 *
 * Implements RFC 2845 - Secret Key Transaction Authentication for DNS (TSIG)
 */

#include "tsig.h"
#include "mydnsutil.h"
#include <openssl/bio.h>
#include <openssl/buffer.h>
#include <openssl/evp.h>
#include <string.h>
#include <time.h>

/* Algorithm name mappings */
static const char *tsig_algorithm_names[] = {
    "hmac-md5.sig-alg.reg.int.",
    "hmac-sha1.",
    "hmac-sha224.",
    "hmac-sha256.",
    "hmac-sha384.",
    "hmac-sha512."
};

/**
 * Initialize TSIG module
 */
int tsig_init(void) {
    OpenSSL_add_all_algorithms();
    return 0;
}

/**
 * Cleanup TSIG module
 */
void tsig_cleanup(void) {
    EVP_cleanup();
}

/**
 * Get algorithm from name
 */
int tsig_algorithm_from_name(const char *name) {
    if (!name) return -1;

    if (strstr(name, "hmac-md5") || strstr(name, "HMAC-MD5"))
        return TSIG_ALG_HMAC_MD5;
    if (strstr(name, "hmac-sha1") || strstr(name, "HMAC-SHA1"))
        return TSIG_ALG_HMAC_SHA1;
    if (strstr(name, "hmac-sha224") || strstr(name, "HMAC-SHA224"))
        return TSIG_ALG_HMAC_SHA224;
    if (strstr(name, "hmac-sha256") || strstr(name, "HMAC-SHA256"))
        return TSIG_ALG_HMAC_SHA256;
    if (strstr(name, "hmac-sha384") || strstr(name, "HMAC-SHA384"))
        return TSIG_ALG_HMAC_SHA384;
    if (strstr(name, "hmac-sha512") || strstr(name, "HMAC-SHA512"))
        return TSIG_ALG_HMAC_SHA512;

    return -1;
}

/**
 * Get algorithm name
 */
const char *tsig_algorithm_name(tsig_algorithm_t alg) {
    if (alg >= 0 && alg <= TSIG_ALG_HMAC_SHA512) {
        return tsig_algorithm_names[alg];
    }
    return NULL;
}

/**
 * Get EVP digest for algorithm
 */
static const EVP_MD *tsig_get_evp_md(tsig_algorithm_t alg) {
    switch (alg) {
        case TSIG_ALG_HMAC_MD5:    return EVP_md5();
        case TSIG_ALG_HMAC_SHA1:   return EVP_sha1();
        case TSIG_ALG_HMAC_SHA224: return EVP_sha224();
        case TSIG_ALG_HMAC_SHA256: return EVP_sha256();
        case TSIG_ALG_HMAC_SHA384: return EVP_sha384();
        case TSIG_ALG_HMAC_SHA512: return EVP_sha512();
        default: return NULL;
    }
}

/**
 * Base64 decode
 */
int tsig_base64_decode(const char *input, unsigned char **output, size_t *output_len) {
    BIO *bio, *b64;
    size_t input_len = strlen(input);
    size_t decode_len = (input_len * 3) / 4 + 1;

    *output = malloc(decode_len);
    if (!*output) return -1;

    bio = BIO_new_mem_buf((void*)input, input_len);
    b64 = BIO_new(BIO_f_base64());
    bio = BIO_push(b64, bio);
    BIO_set_flags(bio, BIO_FLAGS_BASE64_NO_NL);

    *output_len = BIO_read(bio, *output, decode_len);
    BIO_free_all(bio);

    if (*output_len <= 0) {
        free(*output);
        *output = NULL;
        return -1;
    }

    return 0;
}

/**
 * Base64 encode
 */
int tsig_base64_encode(const unsigned char *input, size_t input_len, char **output) {
    BIO *bio, *b64;
    BUF_MEM *bufferPtr;

    b64 = BIO_new(BIO_f_base64());
    bio = BIO_new(BIO_s_mem());
    bio = BIO_push(b64, bio);
    BIO_set_flags(bio, BIO_FLAGS_BASE64_NO_NL);

    BIO_write(bio, input, input_len);
    BIO_flush(bio);
    BIO_get_mem_ptr(bio, &bufferPtr);

    *output = malloc(bufferPtr->length + 1);
    if (!*output) {
        BIO_free_all(bio);
        return -1;
    }

    memcpy(*output, bufferPtr->data, bufferPtr->length);
    (*output)[bufferPtr->length] = '\0';

    BIO_free_all(bio);
    return 0;
}

/**
 * Create TSIG key
 */
tsig_key_t *tsig_key_create(const char *name, const char *algorithm, const char *secret_b64) {
    tsig_key_t *key;
    int alg;

    if (!name || !algorithm || !secret_b64) {
        return NULL;
    }

    alg = tsig_algorithm_from_name(algorithm);
    if (alg < 0) {
        Warnx(_("Unknown TSIG algorithm: %s"), algorithm);
        return NULL;
    }

    key = (tsig_key_t *)malloc(sizeof(tsig_key_t));
    if (!key) return NULL;

    memset(key, 0, sizeof(tsig_key_t));
    key->name = strdup(name);
    key->algorithm = alg;

    if (tsig_base64_decode(secret_b64, &key->secret, &key->secret_len) < 0) {
        Warnx(_("Failed to decode TSIG secret for key: %s"), name);
        free(key->name);
        free(key);
        return NULL;
    }

    Notice(_("Created TSIG key: %s (algorithm=%s, secret_len=%zu)"),
           key->name, tsig_algorithm_name(key->algorithm), key->secret_len);

    return key;
}

/**
 * Free TSIG key
 */
void tsig_key_free(tsig_key_t *key) {
    if (!key) return;
    if (key->name) free(key->name);
    if (key->secret) {
        memset(key->secret, 0, key->secret_len);  /* Clear sensitive data */
        free(key->secret);
    }
    free(key);
}

/**
 * Compute HMAC
 */
int tsig_hmac(const unsigned char *data, size_t data_len,
              tsig_key_t *key, unsigned char *output, size_t *output_len) {
    const EVP_MD *md;
    unsigned int len;

    if (!data || !key || !output || !output_len) {
        return -1;
    }

    md = tsig_get_evp_md(key->algorithm);
    if (!md) {
        return -1;
    }

    if (!HMAC(md, key->secret, key->secret_len, data, data_len, output, &len)) {
        return -1;
    }

    *output_len = len;
    return 0;
}

/**
 * Encode DNS name to wire format
 */
static int encode_name(const char *name, unsigned char *buf, size_t bufsize) {
    const char *label_start = name;
    const char *p = name;
    size_t pos = 0;

    while (*p) {
        if (*p == '.') {
            size_t label_len = p - label_start;
            if (label_len > 63 || pos + label_len + 1 > bufsize) {
                return -1;
            }
            if (label_len > 0) {
                buf[pos++] = label_len;
                memcpy(buf + pos, label_start, label_len);
                pos += label_len;
            }
            label_start = p + 1;
        }
        p++;
    }

    /* Last label */
    size_t label_len = p - label_start;
    if (label_len > 0) {
        if (label_len > 63 || pos + label_len + 2 > bufsize) {
            return -1;
        }
        buf[pos++] = label_len;
        memcpy(buf + pos, label_start, label_len);
        pos += label_len;
    }

    /* Terminating zero */
    if (pos + 1 > bufsize) {
        return -1;
    }
    buf[pos++] = 0;

    return pos;
}

/**
 * Sign DNS message with TSIG
 */
int tsig_sign(unsigned char *message, size_t message_len, size_t buffer_size,
              tsig_key_t *key, const unsigned char *request_mac, size_t request_mac_len,
              size_t *output_len) {
    unsigned char tsig_data[4096];
    size_t tsig_pos = 0;
    unsigned char mac[EVP_MAX_MD_SIZE];
    size_t mac_len;
    time_t now = time(NULL);
    uint16_t arcount;
    const char *alg_name;
    int alg_name_len;

    if (!message || !key || !output_len) {
        return -1;
    }

    /* Build TSIG signing data */
    /* If this is a response, include request MAC */
    if (request_mac && request_mac_len > 0) {
        if (tsig_pos + 2 + request_mac_len > sizeof(tsig_data)) {
            return -1;
        }
        tsig_data[tsig_pos++] = (request_mac_len >> 8) & 0xFF;
        tsig_data[tsig_pos++] = request_mac_len & 0xFF;
        memcpy(tsig_data + tsig_pos, request_mac, request_mac_len);
        tsig_pos += request_mac_len;
    }

    /* Add original message (without TSIG) */
    if (tsig_pos + message_len > sizeof(tsig_data)) {
        return -1;
    }
    memcpy(tsig_data + tsig_pos, message, message_len);
    tsig_pos += message_len;

    /* Add TSIG variables for signing */
    /* Key name */
    int name_len = encode_name(key->name, tsig_data + tsig_pos, sizeof(tsig_data) - tsig_pos);
    if (name_len < 0) return -1;
    tsig_pos += name_len;

    /* Class = ANY (255) */
    tsig_data[tsig_pos++] = 0x00;
    tsig_data[tsig_pos++] = 0xFF;

    /* TTL = 0 */
    tsig_data[tsig_pos++] = 0x00;
    tsig_data[tsig_pos++] = 0x00;
    tsig_data[tsig_pos++] = 0x00;
    tsig_data[tsig_pos++] = 0x00;

    /* Algorithm name */
    alg_name = tsig_algorithm_name(key->algorithm);
    alg_name_len = encode_name(alg_name, tsig_data + tsig_pos, sizeof(tsig_data) - tsig_pos);
    if (alg_name_len < 0) return -1;
    tsig_pos += alg_name_len;

    /* Time signed (48-bit) */
    uint64_t time_48 = (uint64_t)now & 0xFFFFFFFFFFFFULL;
    tsig_data[tsig_pos++] = (time_48 >> 40) & 0xFF;
    tsig_data[tsig_pos++] = (time_48 >> 32) & 0xFF;
    tsig_data[tsig_pos++] = (time_48 >> 24) & 0xFF;
    tsig_data[tsig_pos++] = (time_48 >> 16) & 0xFF;
    tsig_data[tsig_pos++] = (time_48 >> 8) & 0xFF;
    tsig_data[tsig_pos++] = time_48 & 0xFF;

    /* Fudge = 300 seconds */
    tsig_data[tsig_pos++] = 0x01;
    tsig_data[tsig_pos++] = 0x2C;

    /* Error = 0 */
    tsig_data[tsig_pos++] = 0x00;
    tsig_data[tsig_pos++] = 0x00;

    /* Other len = 0 */
    tsig_data[tsig_pos++] = 0x00;
    tsig_data[tsig_pos++] = 0x00;

    /* Compute HMAC */
    if (tsig_hmac(tsig_data, tsig_pos, key, mac, &mac_len) < 0) {
        return -1;
    }

    /* Now append TSIG RR to message */
    size_t new_len = message_len;

    /* Calculate offset to key name in tsig_data */
    size_t key_name_offset = (request_mac && request_mac_len > 0) ? (2 + request_mac_len) : 0;
    key_name_offset += message_len;

    /* Check buffer space */
    size_t tsig_rr_len = name_len + 10 + alg_name_len + 16 + mac_len;
    if (new_len + tsig_rr_len > buffer_size) {
        return -1;
    }

    /* Increment ARCOUNT in DNS header */
    arcount = (message[10] << 8) | message[11];
    arcount++;
    message[10] = (arcount >> 8) & 0xFF;
    message[11] = arcount & 0xFF;

    /* Append TSIG RR */
    /* Name */
    memcpy(message + new_len, tsig_data + key_name_offset, name_len);
    new_len += name_len;

    /* Type = TSIG (250) */
    message[new_len++] = 0x00;
    message[new_len++] = 0xFA;

    /* Class = ANY (255) */
    message[new_len++] = 0x00;
    message[new_len++] = 0xFF;

    /* TTL = 0 */
    message[new_len++] = 0x00;
    message[new_len++] = 0x00;
    message[new_len++] = 0x00;
    message[new_len++] = 0x00;

    /* RDLENGTH: alg_name + time(6) + fudge(2) + mac_size(2) + mac + orig_id(2) + error(2) + other_len(2) */
    uint16_t rdlength = alg_name_len + 16 + mac_len;
    message[new_len++] = (rdlength >> 8) & 0xFF;
    message[new_len++] = rdlength & 0xFF;

    /* RDATA */
    /* Algorithm name */
    memcpy(message + new_len, tsig_data + key_name_offset + name_len + 6, alg_name_len);
    new_len += alg_name_len;

    /* Time signed (48-bit) */
    message[new_len++] = (time_48 >> 40) & 0xFF;
    message[new_len++] = (time_48 >> 32) & 0xFF;
    message[new_len++] = (time_48 >> 24) & 0xFF;
    message[new_len++] = (time_48 >> 16) & 0xFF;
    message[new_len++] = (time_48 >> 8) & 0xFF;
    message[new_len++] = time_48 & 0xFF;

    /* Fudge */
    message[new_len++] = 0x01;
    message[new_len++] = 0x2C;

    /* MAC size */
    message[new_len++] = (mac_len >> 8) & 0xFF;
    message[new_len++] = mac_len & 0xFF;

    /* MAC */
    memcpy(message + new_len, mac, mac_len);
    new_len += mac_len;

    /* Original ID (from message) */
    message[new_len++] = message[0];
    message[new_len++] = message[1];

    /* Error = 0 */
    message[new_len++] = 0x00;
    message[new_len++] = 0x00;

    /* Other len = 0 */
    message[new_len++] = 0x00;
    message[new_len++] = 0x00;

    *output_len = new_len;
    return 0;
}

/**
 * Verify TSIG signature (simplified)
 */
int tsig_verify(const unsigned char *message, size_t message_len,
                tsig_key_t *key, const unsigned char *request_mac, size_t request_mac_len,
                tsig_rr_t *tsig_out) {
    unsigned char tsig_data[4096];
    size_t tsig_pos = 0;
    unsigned char computed_mac[EVP_MAX_MD_SIZE];
    size_t computed_mac_len;
    uint16_t arcount;
    size_t offset;
    int i;

    if (!message || message_len < 12 || !key) {
        return TSIG_ERR_BADKEY;
    }

    /* Get ARCOUNT from DNS header */
    arcount = (message[10] << 8) | message[11];
    if (arcount == 0) {
        Warnx(_("TSIG verification: no additional records"));
        return TSIG_ERR_BADSIG;
    }

    /* Find TSIG record in additional section (always last) */
    offset = 12;  /* Skip DNS header */

    /* Skip Question section */
    uint16_t qdcount = (message[4] << 8) | message[5];
    for (i = 0; i < qdcount && offset < message_len; i++) {
        /* Skip NAME */
        while (offset < message_len) {
            if (message[offset] == 0) {
                offset++;
                break;
            }
            if ((message[offset] & 0xC0) == 0xC0) {
                offset += 2;
                break;
            }
            offset += message[offset] + 1;
        }
        offset += 4;  /* Skip TYPE + CLASS */
    }

    /* Skip Answer section */
    uint16_t ancount = (message[6] << 8) | message[7];
    for (i = 0; i < ancount && offset < message_len; i++) {
        while (offset < message_len) {
            if (message[offset] == 0) {
                offset++;
                break;
            }
            if ((message[offset] & 0xC0) == 0xC0) {
                offset += 2;
                break;
            }
            offset += message[offset] + 1;
        }
        if (offset + 10 > message_len) return TSIG_ERR_BADSIG;
        uint16_t rdlength = (message[offset + 8] << 8) | message[offset + 9];
        offset += 10 + rdlength;
    }

    /* Skip Authority section */
    uint16_t nscount = (message[8] << 8) | message[9];
    for (i = 0; i < nscount && offset < message_len; i++) {
        while (offset < message_len) {
            if (message[offset] == 0) {
                offset++;
                break;
            }
            if ((message[offset] & 0xC0) == 0xC0) {
                offset += 2;
                break;
            }
            offset += message[offset] + 1;
        }
        if (offset + 10 > message_len) return TSIG_ERR_BADSIG;
        uint16_t rdlength = (message[offset + 8] << 8) | message[offset + 9];
        offset += 10 + rdlength;
    }

    /* Find TSIG record in Additional section (should be last) */
    size_t tsig_start = 0;
    size_t tsig_mac_offset = 0;
    size_t tsig_mac_len = 0;
    uint64_t time_signed = 0;
    uint16_t fudge = 300;

    for (i = 0; i < arcount && offset < message_len; i++) {
        size_t record_start = offset;

        /* Skip NAME */
        while (offset < message_len) {
            if (message[offset] == 0) {
                offset++;
                break;
            }
            if ((message[offset] & 0xC0) == 0xC0) {
                offset += 2;
                break;
            }
            offset += message[offset] + 1;
        }

        if (offset + 10 > message_len) return TSIG_ERR_BADSIG;

        uint16_t rtype = (message[offset] << 8) | message[offset + 1];
        uint16_t rdlength = (message[offset + 8] << 8) | message[offset + 9];

        if (rtype == 250) {  /* TSIG */
            tsig_start = record_start;
            offset += 10;  /* Skip to RDATA */

            /* Skip algorithm name */
            while (offset < message_len && message[offset] != 0) {
                if ((message[offset] & 0xC0) == 0xC0) {
                    offset += 2;
                    break;
                }
                offset += message[offset] + 1;
            }
            if (offset < message_len && message[offset] == 0) offset++;

            /* Parse time signed (48-bit) */
            if (offset + 10 > message_len) return TSIG_ERR_BADSIG;
            for (int j = 0; j < 6; j++) {
                time_signed = (time_signed << 8) | message[offset++];
            }

            /* Parse fudge */
            fudge = (message[offset] << 8) | message[offset + 1];
            offset += 2;

            /* Parse MAC */
            tsig_mac_len = (message[offset] << 8) | message[offset + 1];
            offset += 2;
            tsig_mac_offset = offset;

            break;  /* Found TSIG */
        } else {
            offset += 10 + rdlength;
        }
    }

    if (tsig_start == 0) {
        Warnx(_("TSIG verification: TSIG record not found"));
        return TSIG_ERR_BADSIG;
    }

    /* Check time window */
    time_t now = time(NULL);
    int64_t time_diff = (int64_t)now - (int64_t)time_signed;
    if (time_diff < 0) time_diff = -time_diff;
    if (time_diff > fudge) {
        Warnx(_("TSIG verification: time check failed (diff=%ld, fudge=%u)"),
              (long)time_diff, fudge);
        return TSIG_ERR_BADTIME;
    }

    /* Build TSIG signing data */
    /* Include request MAC if this is a response */
    if (request_mac && request_mac_len > 0) {
        if (tsig_pos + 2 + request_mac_len > sizeof(tsig_data)) {
            return TSIG_ERR_BADSIG;
        }
        tsig_data[tsig_pos++] = (request_mac_len >> 8) & 0xFF;
        tsig_data[tsig_pos++] = request_mac_len & 0xFF;
        memcpy(tsig_data + tsig_pos, request_mac, request_mac_len);
        tsig_pos += request_mac_len;
    }

    /* Add message up to TSIG record (without TSIG) */
    /* Adjust ARCOUNT to exclude TSIG */
    if (tsig_pos + tsig_start > sizeof(tsig_data)) {
        return TSIG_ERR_BADSIG;
    }
    memcpy(tsig_data + tsig_pos, message, tsig_start);

    /* Decrement ARCOUNT in copy */
    uint16_t adjusted_arcount = arcount - 1;
    tsig_data[tsig_pos + 10] = (adjusted_arcount >> 8) & 0xFF;
    tsig_data[tsig_pos + 11] = adjusted_arcount & 0xFF;

    tsig_pos += tsig_start;

    /* Add TSIG variables manually: NAME + CLASS + TTL + Alg + Time + Fudge + Error + Other */
    /* Find NAME length */
    size_t name_offset = tsig_start;
    while (name_offset < message_len && message[name_offset] != 0) {
        if ((message[name_offset] & 0xC0) == 0xC0) {
            name_offset += 2;
            break;
        }
        name_offset += message[name_offset] + 1;
    }
    if (message[name_offset] == 0) name_offset++;
    size_t name_len = name_offset - tsig_start;

    /* Copy NAME */
    memcpy(tsig_data + tsig_pos, message + tsig_start, name_len);
    tsig_pos += name_len;

    /* Skip TYPE (2 bytes), copy CLASS (2) + TTL (4) = 6 bytes */
    memcpy(tsig_data + tsig_pos, message + tsig_start + name_len + 2, 6);
    tsig_pos += 6;

    /* Skip RDLENGTH (2 bytes), then copy Algorithm Name + Time + Fudge */
    size_t rdata_start = tsig_start + name_len + 10;
    size_t rdata_offset = rdata_start;

    /* Find Algorithm Name length */
    while (rdata_offset < message_len && message[rdata_offset] != 0) {
        if ((message[rdata_offset] & 0xC0) == 0xC0) {
            rdata_offset += 2;
            break;
        }
        rdata_offset += message[rdata_offset] + 1;
    }
    if (message[rdata_offset] == 0) rdata_offset++;
    size_t alg_len = rdata_offset - rdata_start;

    /* Copy Algorithm Name + Time Signed (6) + Fudge (2) = alg_len + 8 */
    memcpy(tsig_data + tsig_pos, message + rdata_start, alg_len + 8);
    tsig_pos += alg_len + 8;

    /* Skip MAC Size (2) + MAC (tsig_mac_len) + Original ID (2), then copy Error (2) + Other Len (2) */
    size_t after_mac = tsig_mac_offset + tsig_mac_len + 2;  /* Skip MAC and Original ID */
    memcpy(tsig_data + tsig_pos, message + after_mac, 4);  /* Error + Other Len */
    tsig_pos += 4;

    /* Compute HMAC */
    if (tsig_hmac(tsig_data, tsig_pos, key, computed_mac, &computed_mac_len) < 0) {
        Warnx(_("TSIG verification: HMAC computation failed"));
        return TSIG_ERR_BADSIG;
    }

    /* Compare MACs */
    if (tsig_mac_len != computed_mac_len ||
        memcmp(message + tsig_mac_offset, computed_mac, tsig_mac_len) != 0) {
        Warnx(_("TSIG verification: MAC mismatch"));
        return TSIG_ERR_BADSIG;
    }

    Notice(_("TSIG verification successful for key: %s"), key->name);
    return 0;  /* Success */
}

/**
 * Free TSIG RR
 */
void tsig_rr_free(tsig_rr_t *tsig) {
    if (!tsig) return;
    if (tsig->algorithm_name) free(tsig->algorithm_name);
    if (tsig->mac) free(tsig->mac);
    if (tsig->other_data) free(tsig->other_data);
    memset(tsig, 0, sizeof(tsig_rr_t));
}

/**
 * Load TSIG keys from database
 */
int tsig_load_keys_from_db(SQL *db, tsig_key_t ***keys, int *count) {
    SQL_RES *res;
    SQL_ROW row;
    char query[1024];
    int n = 0;
    tsig_key_t **key_array = NULL;

    if (!db || !keys || !count) {
        return -1;
    }

    /* Query tsig_keys table */
    snprintf(query, sizeof(query),
        "SELECT name, algorithm, secret FROM tsig_keys WHERE enabled = TRUE");

    res = sql_query(db, query, strlen(query));
    if (!res) {
        return -1;
    }

    *count = sql_num_rows(res);
    if (*count == 0) {
        sql_free(res);
        *keys = NULL;
        return 0;
    }

    key_array = (tsig_key_t **)malloc(sizeof(tsig_key_t *) * (*count));
    if (!key_array) {
        sql_free(res);
        return -1;
    }

    while ((row = sql_getrow(res, NULL)) != NULL) {
        const char *name = row[0];
        const char *algorithm = row[1];
        const char *secret = row[2];

        key_array[n] = tsig_key_create(name, algorithm, secret);
        if (key_array[n]) {
            n++;
        }
    }

    sql_free(res);

    *keys = key_array;
    *count = n;

    Notice(_("Loaded %d TSIG keys from database"), n);
    return 0;
}

/**
 * Find TSIG key by name
 */
tsig_key_t *tsig_find_key(tsig_key_t **keys, int count, const char *name) {
    int i;

    if (!keys || !name) {
        return NULL;
    }

    for (i = 0; i < count; i++) {
        if (keys[i] && keys[i]->name && strcasecmp(keys[i]->name, name) == 0) {
            return keys[i];
        }
    }

    return NULL;
}
