/*
 * dnssec.h - DNSSEC (DNS Security Extensions) implementation
 * Date: 2025-11-28
 *
 * Implements RFC 4033, 4034, 4035 - DNSSEC
 * RFC 5155 - NSEC3
 * RFC 6781 - DNSSEC Operational Practices
 */

#ifndef _MYDNS_DNSSEC_H
#define _MYDNS_DNSSEC_H

#include "mydnsutil.h"
#include <openssl/evp.h>
#include <openssl/rsa.h>
#include <openssl/ec.h>
#include <openssl/bn.h>

/* DNSSEC Algorithm Numbers (RFC 8624) */
typedef enum {
    DNSSEC_ALG_RSAMD5           = 1,   /* NOT RECOMMENDED */
    DNSSEC_ALG_DH               = 2,   /* NOT RECOMMENDED */
    DNSSEC_ALG_DSA              = 3,   /* NOT RECOMMENDED */
    DNSSEC_ALG_RSASHA1          = 5,   /* NOT RECOMMENDED */
    DNSSEC_ALG_DSA_NSEC3_SHA1   = 6,   /* NOT RECOMMENDED */
    DNSSEC_ALG_RSASHA1_NSEC3_SHA1 = 7, /* NOT RECOMMENDED */
    DNSSEC_ALG_RSASHA256        = 8,   /* MUST IMPLEMENT */
    DNSSEC_ALG_RSASHA512        = 10,  /* RECOMMENDED */
    DNSSEC_ALG_ECC_GOST         = 12,  /* OPTIONAL */
    DNSSEC_ALG_ECDSAP256SHA256  = 13,  /* MUST IMPLEMENT (recommended) */
    DNSSEC_ALG_ECDSAP384SHA384  = 14,  /* RECOMMENDED */
    DNSSEC_ALG_ED25519          = 15,  /* RECOMMENDED */
    DNSSEC_ALG_ED448            = 16,  /* OPTIONAL */
} dnssec_algorithm_t;

/* DNSSEC Key Flags (RFC 4034 Section 2.1.1) */
#define DNSSEC_FLAG_ZONE_KEY    0x0100  /* Bit 7: Zone Key flag */
#define DNSSEC_FLAG_SEP         0x0001  /* Bit 15: Secure Entry Point (KSK) */
#define DNSSEC_FLAG_REVOKE      0x0080  /* Bit 8: Revoke (RFC 5011) */

/* Standard key flags */
#define DNSSEC_FLAGS_ZSK        256     /* 0x0100: Zone Signing Key */
#define DNSSEC_FLAGS_KSK        257     /* 0x0101: Key Signing Key (ZSK + SEP) */

/* NSEC3 Hash Algorithms (RFC 5155) */
#define DNSSEC_NSEC3_HASH_SHA1  1

/* DNSSEC Key Structure */
typedef struct {
    uint32_t zone_id;
    uint16_t key_tag;
    uint16_t flags;
    uint8_t protocol;       /* Always 3 */
    uint8_t algorithm;

    /* Public key data */
    unsigned char *public_key;
    size_t public_key_len;

    /* Private key (loaded from file or DB) */
    EVP_PKEY *private_key;

    /* Key metadata */
    char *key_type;         /* "KSK", "ZSK", or "CSK" */
    char *status;           /* "active", "published", "retired", "revoked" */

    time_t created_at;
    time_t activate_at;
    time_t retire_at;
} dnssec_key_t;

/* DNSSEC Zone Configuration */
typedef struct {
    uint32_t zone_id;
    int dnssec_enabled;
    int auto_sign;
    int auto_nsec;

    /* Signing policy */
    int nsec_mode;          /* 0=NSEC, 1=NSEC3 */
    uint32_t nsec3_iterations;
    uint32_t nsec3_salt_length;
    unsigned char *nsec3_salt;

    /* Signature parameters */
    uint32_t signature_validity;    /* Seconds */
    uint32_t signature_refresh;     /* Seconds before expiry to re-sign */
    uint32_t signature_jitter;      /* Random jitter */

    uint8_t preferred_algorithm;
} dnssec_config_t;

/* RRSIG Record (RFC 4034 Section 3) */
typedef struct {
    uint16_t type_covered;
    uint8_t algorithm;
    uint8_t labels;
    uint32_t original_ttl;
    uint32_t signature_expiration;
    uint32_t signature_inception;
    uint16_t key_tag;
    char *signer_name;
    unsigned char *signature;
    size_t signature_len;
} dnssec_rrsig_t;

/* DNSKEY Record (RFC 4034 Section 2) */
typedef struct {
    uint16_t flags;
    uint8_t protocol;
    uint8_t algorithm;
    unsigned char *public_key;
    size_t public_key_len;
} dnssec_dnskey_t;

/* DS Record (RFC 4034 Section 5) */
typedef struct {
    uint16_t key_tag;
    uint8_t algorithm;
    uint8_t digest_type;
    unsigned char *digest;
    size_t digest_len;
} dnssec_ds_t;

/* NSEC Record (RFC 4034 Section 4) */
typedef struct {
    char *next_domain;
    unsigned char *type_bitmap;
    size_t type_bitmap_len;
} dnssec_nsec_t;

/* NSEC3 Record (RFC 5155 Section 3) */
typedef struct {
    uint8_t hash_algorithm;
    uint8_t flags;
    uint16_t iterations;
    unsigned char *salt;
    size_t salt_len;
    unsigned char *next_hash;
    size_t next_hash_len;
    unsigned char *type_bitmap;
    size_t type_bitmap_len;
} dnssec_nsec3_t;

/* NSEC3PARAM Record (RFC 5155 Section 4) */
typedef struct {
    uint8_t hash_algorithm;
    uint8_t flags;
    uint16_t iterations;
    unsigned char *salt;
    size_t salt_len;
} dnssec_nsec3param_t;

/* RRset for signing */
typedef struct {
    char *name;
    uint16_t type;
    uint16_t class;
    uint32_t ttl;

    /* Array of RDATA */
    unsigned char **rdata;
    size_t *rdata_len;
    size_t rdata_count;
} dnssec_rrset_t;

/*
 * Initialization and cleanup
 */
int dnssec_init(void);
void dnssec_cleanup(void);

/*
 * Key management functions
 */
dnssec_key_t *dnssec_key_load(SQL *db, uint32_t zone_id, uint16_t key_tag);
dnssec_key_t *dnssec_key_load_active_zsk(SQL *db, uint32_t zone_id);
dnssec_key_t *dnssec_key_load_active_ksk(SQL *db, uint32_t zone_id);
int dnssec_key_generate(SQL *db, uint32_t zone_id, dnssec_algorithm_t algorithm,
                        int key_size, int is_ksk, dnssec_key_t **key_out);
uint16_t dnssec_key_calculate_tag(const unsigned char *key_data, size_t key_len);
void dnssec_key_free(dnssec_key_t *key);

/*
 * Configuration functions
 */
dnssec_config_t *dnssec_config_load(SQL *db, uint32_t zone_id);
void dnssec_config_free(dnssec_config_t *config);

/*
 * Signing functions
 */
int dnssec_sign_rrset(SQL *db, dnssec_key_t *key, const dnssec_rrset_t *rrset,
                      const char *zone_name, dnssec_config_t *config,
                      dnssec_rrsig_t **rrsig_out);
int dnssec_sign_zone(SQL *db, uint32_t zone_id);
int dnssec_sign_zone_incremental(SQL *db, uint32_t zone_id, const char *rrset_name,
                                 uint16_t rrset_type);

/*
 * NSEC/NSEC3 functions
 */
int dnssec_generate_nsec_chain(SQL *db, uint32_t zone_id, const char *zone_name);
int dnssec_generate_nsec3_chain(SQL *db, uint32_t zone_id, const char *zone_name,
                                dnssec_config_t *config);
int dnssec_nsec3_hash(const unsigned char *salt, size_t salt_len, uint16_t iterations,
                     const char *name, unsigned char *hash_out, size_t *hash_len);

/*
 * Verification functions
 */
int dnssec_verify_rrsig(const dnssec_rrsig_t *rrsig, const dnssec_dnskey_t *dnskey,
                       const dnssec_rrset_t *rrset, const char *zone_name);

/*
 * Wire format encoding/decoding
 */
int dnssec_encode_rrsig(const dnssec_rrsig_t *rrsig, unsigned char *buf, size_t buf_len,
                       size_t *encoded_len);
int dnssec_decode_rrsig(const unsigned char *buf, size_t buf_len, dnssec_rrsig_t **rrsig_out);

int dnssec_encode_dnskey(const dnssec_dnskey_t *dnskey, unsigned char *buf, size_t buf_len,
                        size_t *encoded_len);
int dnssec_decode_dnskey(const unsigned char *buf, size_t buf_len, dnssec_dnskey_t **dnskey_out);

int dnssec_encode_ds(const dnssec_ds_t *ds, unsigned char *buf, size_t buf_len,
                    size_t *encoded_len);
int dnssec_decode_ds(const unsigned char *buf, size_t buf_len, dnssec_ds_t **ds_out);

int dnssec_encode_nsec(const dnssec_nsec_t *nsec, unsigned char *buf, size_t buf_len,
                      size_t *encoded_len);
int dnssec_decode_nsec(const unsigned char *buf, size_t buf_len, dnssec_nsec_t **nsec_out);

int dnssec_encode_nsec3(const dnssec_nsec3_t *nsec3, unsigned char *buf, size_t buf_len,
                       size_t *encoded_len);
int dnssec_decode_nsec3(const unsigned char *buf, size_t buf_len, dnssec_nsec3_t **nsec3_out);

/*
 * Utility functions
 */
int dnssec_encode_name(const char *name, unsigned char *buf, size_t buf_len, size_t *encoded_len);
int dnssec_canonical_sort(unsigned char **rdata_array, size_t *len_array, size_t count);
int dnssec_create_type_bitmap(const uint16_t *types, size_t type_count,
                              unsigned char **bitmap_out, size_t *bitmap_len);
const char *dnssec_algorithm_name(dnssec_algorithm_t alg);

/*
 * Database helper functions
 */
int dnssec_db_save_signature(SQL *db, uint32_t zone_id, const char *rrset_name,
                             uint16_t rrset_type, const dnssec_rrsig_t *rrsig,
                             const unsigned char *rrset_hash);
int dnssec_db_load_signature(SQL *db, uint32_t zone_id, const char *rrset_name,
                             uint16_t rrset_type, dnssec_rrsig_t **rrsig_out);
int dnssec_db_queue_signing(SQL *db, uint32_t zone_id, const char *rrset_name,
                            uint16_t rrset_type, const char *reason, int priority);
int dnssec_db_log_operation(SQL *db, uint32_t zone_id, const char *operation,
                            int success, const char *details);

/*
 * RRset management
 */
dnssec_rrset_t *dnssec_rrset_create(const char *name, uint16_t type, uint16_t class, uint32_t ttl);
int dnssec_rrset_add_rdata(dnssec_rrset_t *rrset, const unsigned char *rdata, size_t rdata_len);
void dnssec_rrset_free(dnssec_rrset_t *rrset);
dnssec_rrset_t *dnssec_rrset_load_from_db(SQL *db, uint32_t zone_id, const char *name, uint16_t type);

/*
 * Free functions for DNSSEC structures
 */
void dnssec_rrsig_free(dnssec_rrsig_t *rrsig);
void dnssec_dnskey_free(dnssec_dnskey_t *dnskey);
void dnssec_ds_free(dnssec_ds_t *ds);
void dnssec_nsec_free(dnssec_nsec_t *nsec);
void dnssec_nsec3_free(dnssec_nsec3_t *nsec3);
void dnssec_nsec3param_free(dnssec_nsec3param_t *nsec3param);

#endif /* _MYDNS_DNSSEC_H */
