/*
 * memzone.h - In-Memory Zone Storage for AXFR Slave Zones
 * Date: 2025-11-26
 *
 * This module implements in-memory zone storage for MyDNS AXFR slave zones,
 * eliminating the MySQL dependency for slave-only DNS servers.
 *
 * Architecture:
 * - Master zones (slave_mode=FALSE) → MySQL (existing behavior)
 * - Slave zones (slave_mode=TRUE) → Memory-only (new behavior)
 * - Shared memory for IPC between mydns-xfer and mydns server
 * - Hash table with chaining for fast lookups
 * - RW locks for concurrent read access
 */

#ifndef _MYDNS_MEMZONE_H
#define _MYDNS_MEMZONE_H

#include "mydns.h"
#include <pthread.h>
#include <time.h>

/* Maximum sizes */
#define MEMZONE_MAX_ZONES 10000        /* Maximum number of zones */
#define MEMZONE_MAX_RECORDS 1000000    /* Maximum total records across all zones */
#define MEMZONE_MAX_ACL_RULES 10000    /* Maximum access control rules */
#define MEMZONE_HASH_SIZE 65536        /* Hash table size for record lookup */
#define MEMZONE_NAME_MAX 256           /* Maximum name length */
#define MEMZONE_DATA_MAX 1024          /* Maximum record data length */

/* Shared memory file path */
#define MEMZONE_SHM_PATH "/mydns-zones"
#define MEMZONE_SHM_SIZE (256 * 1024 * 1024)  /* 256MB shared memory */

/* Memory-based SOA record */
typedef struct mem_soa {
    uint32_t zone_id;                  /* Zone ID (matches database id) */
    char origin[MEMZONE_NAME_MAX];     /* Zone name (e.g., "example.com.") */
    char ns[MEMZONE_NAME_MAX];         /* Primary nameserver */
    char mbox[MEMZONE_NAME_MAX];       /* Admin email */
    uint32_t serial;                   /* SOA serial number */
    uint32_t refresh;                  /* Refresh interval */
    uint32_t retry;                    /* Retry interval */
    uint32_t expire;                   /* Expire time */
    uint32_t minimum;                  /* Minimum TTL */
    uint32_t ttl;                      /* Default TTL */
    time_t updated;                    /* Last update timestamp */
    int active;                        /* Is zone active? */
} mem_soa_t;

/* Memory-based resource record */
typedef struct mem_rr {
    uint64_t id;                       /* Record ID (for deduplication) */
    uint32_t zone_id;                  /* Zone ID this record belongs to */
    char name[MEMZONE_NAME_MAX];       /* Record name */
    dns_qtype_t type;                  /* Record type (A, AAAA, MX, etc.) */
    char data[MEMZONE_DATA_MAX];       /* Record data */
    uint32_t aux;                      /* Auxiliary data (priority, weight, etc.) */
    uint32_t ttl;                      /* TTL */
    struct mem_rr *next;               /* Hash table chaining */
} mem_rr_t;

/* Access control rule types */
typedef enum {
    ACL_TYPE_IP = 1,                   /* Single IP address */
    ACL_TYPE_NETWORK = 2,              /* Network (CIDR) */
    ACL_TYPE_COUNTRY = 3,              /* Country code (GeoIP) */
    ACL_TYPE_ASN = 4                   /* Autonomous System Number */
} acl_type_t;

/* Access control target */
typedef enum {
    ACL_TARGET_DNS = 1,                /* DNS query access */
    ACL_TARGET_WEBUI = 2,              /* Web UI access */
    ACL_TARGET_BOTH = 3                /* Both DNS and Web UI */
} acl_target_t;

/* Memory-based access control rule */
typedef struct mem_acl {
    uint32_t id;                       /* Rule ID */
    acl_type_t type;                   /* Rule type (IP, network, country, ASN) */
    acl_target_t target;               /* Target (DNS, WebUI, both) */
    int is_whitelist;                  /* 1 = whitelist, 0 = blacklist */
    char value[MEMZONE_NAME_MAX];      /* IP, network, country code, or ASN */
    uint32_t mask;                     /* Network mask (for CIDR) */
    int enabled;                       /* Is rule enabled? */
    time_t created;                    /* Creation time */
    struct mem_acl *next;              /* Linked list */
} mem_acl_t;

/* Zone hash table entry */
typedef struct zone_entry {
    mem_soa_t *soa;                    /* Zone SOA record */
    mem_rr_t **rr_hash;                /* Hash table of RRs in this zone */
    uint32_t record_count;             /* Number of records in zone */
    struct zone_entry *next;           /* Next zone in hash chain */
} zone_entry_t;

/* Main memory zone storage structure */
typedef struct memzone_ctx {
    int shm_fd;                        /* Shared memory file descriptor */
    void *shm_base;                    /* Shared memory base address */
    size_t shm_size;                   /* Shared memory size */

    pthread_rwlock_t lock;             /* Reader-writer lock for concurrency */

    zone_entry_t **zone_hash;          /* Hash table of zones */
    uint32_t zone_count;               /* Number of zones loaded */
    uint32_t record_count;             /* Total number of records */

    /* Memory pools */
    mem_soa_t *soa_pool;               /* Pool of SOA records */
    mem_rr_t *rr_pool;                 /* Pool of RR records */
    mem_acl_t *acl_pool;               /* Pool of ACL rules */
    uint32_t soa_pool_used;            /* Number of SOAs allocated */
    uint32_t rr_pool_used;             /* Number of RRs allocated */
    uint32_t acl_pool_used;            /* Number of ACLs allocated */

    /* Access control lists */
    mem_acl_t *acl_head;               /* Head of ACL linked list */
    uint32_t acl_count;                /* Number of ACL rules */

    /* Statistics */
    uint64_t queries;                  /* Query counter */
    uint64_t hits;                     /* Cache hits */
    uint64_t misses;                   /* Cache misses */
    uint64_t acl_checks;               /* ACL check counter */
    uint64_t acl_denies;               /* ACL deny counter */
    time_t created;                    /* Creation timestamp */
} memzone_ctx_t;

/* Function prototypes */

/**
 * Initialize in-memory zone storage
 *
 * @param create If true, create new shared memory; if false, attach to existing
 * @return Context pointer on success, NULL on error
 */
memzone_ctx_t *memzone_init(int create);

/**
 * Free in-memory zone storage
 *
 * @param ctx Memory zone context
 */
void memzone_free(memzone_ctx_t *ctx);

/**
 * Add or update a zone in memory
 *
 * @param ctx Memory zone context
 * @param soa SOA record for the zone
 * @return 0 on success, -1 on error
 */
int memzone_add_zone(memzone_ctx_t *ctx, const mem_soa_t *soa);

/**
 * Delete a zone from memory
 *
 * @param ctx Memory zone context
 * @param zone_id Zone ID to delete
 * @return 0 on success, -1 on error
 */
int memzone_delete_zone(memzone_ctx_t *ctx, uint32_t zone_id);

/**
 * Find zone by ID
 *
 * @param ctx Memory zone context
 * @param zone_id Zone ID to find
 * @return Zone entry pointer on success, NULL if not found
 */
zone_entry_t *memzone_find_zone(memzone_ctx_t *ctx, uint32_t zone_id);

/**
 * Find zone by name
 *
 * @param ctx Memory zone context
 * @param origin Zone name (e.g., "example.com.")
 * @return Zone entry pointer on success, NULL if not found
 */
zone_entry_t *memzone_find_zone_by_name(memzone_ctx_t *ctx, const char *origin);

/**
 * Add a resource record to a zone
 *
 * @param ctx Memory zone context
 * @param zone_id Zone ID
 * @param rr Resource record
 * @return 0 on success, -1 on error
 */
int memzone_add_rr(memzone_ctx_t *ctx, uint32_t zone_id, const mem_rr_t *rr);

/**
 * Delete all resource records from a zone
 *
 * @param ctx Memory zone context
 * @param zone_id Zone ID
 * @return 0 on success, -1 on error
 */
int memzone_delete_all_rr(memzone_ctx_t *ctx, uint32_t zone_id);

/**
 * Query resource records for a name
 *
 * @param ctx Memory zone context
 * @param zone_id Zone ID
 * @param name Record name
 * @param type Record type (or DNS_QTYPE_ANY for all types)
 * @param results Output array of matching records
 * @param max_results Maximum number of results to return
 * @return Number of records found, -1 on error
 */
int memzone_query(memzone_ctx_t *ctx, uint32_t zone_id, const char *name,
                  dns_qtype_t type, mem_rr_t **results, int max_results);

/**
 * Get SOA record for a zone
 *
 * @param ctx Memory zone context
 * @param zone_id Zone ID
 * @return SOA record pointer on success, NULL if not found
 */
mem_soa_t *memzone_get_soa(memzone_ctx_t *ctx, uint32_t zone_id);

/**
 * Check if a zone exists in memory
 *
 * @param ctx Memory zone context
 * @param zone_id Zone ID
 * @return 1 if exists, 0 if not, -1 on error
 */
int memzone_zone_exists(memzone_ctx_t *ctx, uint32_t zone_id);

/**
 * Hash function for zone names
 */
uint32_t memzone_hash_name(const char *name);

/**
 * Acquire read lock
 */
void memzone_read_lock(memzone_ctx_t *ctx);

/**
 * Release read lock
 */
void memzone_read_unlock(memzone_ctx_t *ctx);

/**
 * Acquire write lock
 */
void memzone_write_lock(memzone_ctx_t *ctx);

/**
 * Release write lock
 */
void memzone_write_unlock(memzone_ctx_t *ctx);

/**
 * Get statistics
 *
 * @param ctx Memory zone context
 * @param zone_count Output: number of zones
 * @param record_count Output: number of records
 * @param queries Output: query count
 * @param hits Output: cache hit count
 * @param misses Output: cache miss count
 */
void memzone_get_stats(memzone_ctx_t *ctx, uint32_t *zone_count, uint32_t *record_count,
                       uint64_t *queries, uint64_t *hits, uint64_t *misses);

/**
 * Reload zones from database (for slave zones only)
 * Used during startup to load existing slave zones
 *
 * @param ctx Memory zone context
 * @param db Database connection
 * @return Number of zones loaded, -1 on error
 */
int memzone_load_from_db(memzone_ctx_t *ctx, SQL *db);

/**
 * Add an access control rule
 *
 * @param ctx Memory zone context
 * @param acl Access control rule
 * @return 0 on success, -1 on error
 */
int memzone_add_acl(memzone_ctx_t *ctx, const mem_acl_t *acl);

/**
 * Delete an access control rule
 *
 * @param ctx Memory zone context
 * @param acl_id Rule ID to delete
 * @return 0 on success, -1 on error
 */
int memzone_delete_acl(memzone_ctx_t *ctx, uint32_t acl_id);

/**
 * Check if an IP address is allowed access
 *
 * @param ctx Memory zone context
 * @param target Target type (DNS or WebUI)
 * @param ip_str IP address string
 * @param country_code Country code from GeoIP (can be NULL)
 * @param asn ASN number (0 if unknown)
 * @return 1 if allowed, 0 if denied, -1 on error
 */
int memzone_check_access(memzone_ctx_t *ctx, acl_target_t target,
                          const char *ip_str, const char *country_code, uint32_t asn);

/**
 * Parse IP address and network mask
 *
 * @param ip_str IP address or CIDR string (e.g., "192.168.1.0/24")
 * @param ip Output: IP address as uint32_t
 * @param mask Output: Network mask as uint32_t
 * @return 0 on success, -1 on error
 */
int memzone_parse_ip(const char *ip_str, uint32_t *ip, uint32_t *mask);

/**
 * Check if IP matches network (with CIDR mask)
 *
 * @param ip IP address to check
 * @param network Network address
 * @param mask Network mask
 * @return 1 if matches, 0 if not
 */
int memzone_ip_in_network(uint32_t ip, uint32_t network, uint32_t mask);

/**
 * Load access control rules from database
 *
 * @param ctx Memory zone context
 * @param db Database connection
 * @return Number of rules loaded, -1 on error
 */
int memzone_load_acl_from_db(memzone_ctx_t *ctx, SQL *db);

/**
 * Clear all access control rules
 *
 * @param ctx Memory zone context
 * @return 0 on success, -1 on error
 */
int memzone_clear_acl(memzone_ctx_t *ctx);

#endif /* _MYDNS_MEMZONE_H */
