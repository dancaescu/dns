/*
 * tsig.h - TSIG (Transaction Signatures) implementation for DNS
 * Date: 2025-11-26
 *
 * Implements RFC 2845 - Secret Key Transaction Authentication for DNS (TSIG)
 * Provides cryptographic authentication for DNS messages.
 */

#ifndef _MYDNS_TSIG_H
#define _MYDNS_TSIG_H

#include "mydns.h"
#include <openssl/hmac.h>
#include <openssl/evp.h>

/* TSIG algorithms */
typedef enum {
    TSIG_ALG_HMAC_MD5    = 0,  /* hmac-md5.sig-alg.reg.int */
    TSIG_ALG_HMAC_SHA1   = 1,  /* hmac-sha1 */
    TSIG_ALG_HMAC_SHA224 = 2,  /* hmac-sha224 */
    TSIG_ALG_HMAC_SHA256 = 3,  /* hmac-sha256 */
    TSIG_ALG_HMAC_SHA384 = 4,  /* hmac-sha384 */
    TSIG_ALG_HMAC_SHA512 = 5   /* hmac-sha512 */
} tsig_algorithm_t;

/* TSIG error codes (RFC 2845) */
#define TSIG_ERR_BADSIG   16  /* TSIG signature failure */
#define TSIG_ERR_BADKEY   17  /* Key not recognized */
#define TSIG_ERR_BADTIME  18  /* Signature out of time window */
#define TSIG_ERR_BADTRUNC 22  /* Bad truncation */

/* TSIG key */
typedef struct {
    char *name;                 /* Key name (e.g., "mykey.example.com.") */
    tsig_algorithm_t algorithm; /* Algorithm */
    unsigned char *secret;      /* Base64-decoded secret key */
    size_t secret_len;          /* Secret key length */
} tsig_key_t;

/* TSIG context for signing/verification */
typedef struct {
    tsig_key_t *key;           /* TSIG key */
    uint16_t original_id;      /* Original message ID */
    time_t time_signed;        /* Time signed */
    uint16_t fudge;            /* Time fudge (typically 300 seconds) */
    uint16_t error;            /* TSIG error code */
    uint16_t other_len;        /* Length of other data */
    unsigned char *other_data; /* Other data (for errors) */
} tsig_ctx_t;

/* TSIG RR in message */
typedef struct {
    char *algorithm_name;      /* Algorithm name */
    time_t time_signed;        /* Time signed (48-bit) */
    uint16_t fudge;            /* Fudge */
    uint16_t mac_size;         /* MAC size */
    unsigned char *mac;        /* MAC data */
    uint16_t original_id;      /* Original message ID */
    uint16_t error;            /* Error code */
    uint16_t other_len;        /* Other data length */
    unsigned char *other_data; /* Other data */
} tsig_rr_t;

/* Function prototypes */

/**
 * Initialize TSIG module
 */
int tsig_init(void);

/**
 * Cleanup TSIG module
 */
void tsig_cleanup(void);

/**
 * Create TSIG key from string parameters
 *
 * @param name Key name
 * @param algorithm Algorithm name (e.g., "hmac-sha256")
 * @param secret_b64 Base64-encoded secret
 * @return TSIG key structure, NULL on error
 */
tsig_key_t *tsig_key_create(const char *name, const char *algorithm, const char *secret_b64);

/**
 * Free TSIG key
 */
void tsig_key_free(tsig_key_t *key);

/**
 * Get algorithm from name string
 *
 * @param name Algorithm name
 * @return Algorithm enum value, -1 if unknown
 */
int tsig_algorithm_from_name(const char *name);

/**
 * Get algorithm name string
 *
 * @param alg Algorithm enum
 * @return Algorithm name string
 */
const char *tsig_algorithm_name(tsig_algorithm_t alg);

/**
 * Sign DNS message with TSIG
 *
 * @param message DNS message buffer
 * @param message_len Current message length
 * @param buffer_size Total buffer size
 * @param key TSIG key
 * @param request_mac Request MAC (for responses, NULL for requests)
 * @param request_mac_len Request MAC length
 * @param output_len Output: new message length with TSIG
 * @return 0 on success, -1 on error
 */
int tsig_sign(unsigned char *message, size_t message_len, size_t buffer_size,
              tsig_key_t *key, const unsigned char *request_mac, size_t request_mac_len,
              size_t *output_len);

/**
 * Verify TSIG signature on DNS message
 *
 * @param message DNS message buffer
 * @param message_len Message length
 * @param key TSIG key
 * @param request_mac Request MAC (for responses, NULL for requests)
 * @param request_mac_len Request MAC length
 * @param tsig_out Output: Parsed TSIG RR (optional)
 * @return 0 on success, error code on failure
 */
int tsig_verify(const unsigned char *message, size_t message_len,
                tsig_key_t *key, const unsigned char *request_mac, size_t request_mac_len,
                tsig_rr_t *tsig_out);

/**
 * Extract TSIG RR from DNS message
 *
 * @param message DNS message
 * @param message_len Message length
 * @param tsig Output TSIG RR
 * @return 0 on success, -1 on error
 */
int tsig_extract(const unsigned char *message, size_t message_len, tsig_rr_t *tsig);

/**
 * Free TSIG RR structure
 */
void tsig_rr_free(tsig_rr_t *tsig);

/**
 * Compute HMAC for TSIG
 *
 * @param data Data to sign
 * @param data_len Data length
 * @param key TSIG key
 * @param output Output buffer
 * @param output_len Output length
 * @return 0 on success, -1 on error
 */
int tsig_hmac(const unsigned char *data, size_t data_len,
              tsig_key_t *key, unsigned char *output, size_t *output_len);

/**
 * Base64 decode
 *
 * @param input Base64 string
 * @param output Output buffer
 * @param output_len Output length
 * @return 0 on success, -1 on error
 */
int tsig_base64_decode(const char *input, unsigned char **output, size_t *output_len);

/**
 * Base64 encode
 *
 * @param input Input data
 * @param input_len Input length
 * @param output Output string (caller must free)
 * @return 0 on success, -1 on error
 */
int tsig_base64_encode(const unsigned char *input, size_t input_len, char **output);

/**
 * Load TSIG keys from database
 *
 * @param db Database connection
 * @param keys Output array of keys
 * @param count Output count
 * @return 0 on success, -1 on error
 */
int tsig_load_keys_from_db(SQL *db, tsig_key_t ***keys, int *count);

/**
 * Find TSIG key by name
 *
 * @param keys Array of keys
 * @param count Number of keys
 * @param name Key name to find
 * @return Key pointer or NULL
 */
tsig_key_t *tsig_find_key(tsig_key_t **keys, int count, const char *name);

#endif /* _MYDNS_TSIG_H */
