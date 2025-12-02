/*
 * dns-cache.h - DNS Caching/Recursive Resolver for MyDNS
 * Date: 2025-11-28
 *
 * This module implements DNS caching and recursive resolution for MyDNS,
 * allowing the server to act as a caching resolver in addition to serving
 * authoritative zones.
 *
 * Features:
 * - In-memory cache with TTL management
 * - Upstream DNS forwarding (Google DNS, Cloudflare, custom)
 * - ACL integration (ACL_TARGET_CACHE)
 * - Cache statistics
 * - Works alongside master/slave zones
 */

#ifndef _MYDNS_DNS_CACHE_H
#define _MYDNS_DNS_CACHE_H

#include "mydns.h"
#include "memzone.h"
#include <time.h>

/* Cache configuration */
#define DNSCACHE_MAX_ENTRIES 100000       /* Maximum cached entries */
#define DNSCACHE_HASH_SIZE 65536          /* Hash table size */
#define DNSCACHE_DEFAULT_TTL_MIN 60       /* Minimum TTL (1 minute) */
#define DNSCACHE_DEFAULT_TTL_MAX 86400    /* Maximum TTL (24 hours) */
#define DNSCACHE_NAME_MAX 256             /* Maximum domain name length */
#define DNSCACHE_DATA_MAX 1024            /* Maximum record data length */

/* Cache entry states */
typedef enum {
    CACHE_STATE_VALID = 1,      /* Entry is valid and can be used */
    CACHE_STATE_EXPIRED = 2,    /* Entry expired, needs refresh */
    CACHE_STATE_NEGATIVE = 3    /* Negative cache (NXDOMAIN) */
} cache_state_t;

/* Cached DNS record */
typedef struct cache_record {
    char name[DNSCACHE_NAME_MAX];         /* Domain name */
    dns_qtype_t type;                     /* Record type (A, AAAA, MX, etc.) */
    char data[DNSCACHE_DATA_MAX];         /* Record data */
    uint32_t ttl;                         /* Original TTL */
    time_t expires;                       /* Expiration timestamp */
    uint32_t aux;                         /* Auxiliary data (priority, etc.) */
    cache_state_t state;                  /* Entry state */
    struct cache_record *next;            /* Hash table chaining */
} cache_record_t;

/* Cache statistics */
typedef struct cache_stats {
    uint64_t queries;                     /* Total queries */
    uint64_t hits;                        /* Cache hits */
    uint64_t misses;                      /* Cache misses */
    uint64_t inserts;                     /* Records inserted */
    uint64_t evictions;                   /* Records evicted */
    uint64_t upstream_queries;            /* Queries sent upstream */
    uint64_t upstream_failures;           /* Upstream query failures */
    uint64_t acl_denials;                 /* Denied by ACL */
    time_t started;                       /* Cache start time */
} cache_stats_t;

/* Upstream DNS server */
typedef struct upstream_server {
    char host[256];                       /* Server hostname/IP */
    int port;                             /* Server port (default 53) */
    int sockfd;                           /* Socket file descriptor */
    uint64_t queries;                     /* Queries sent to this server */
    uint64_t failures;                    /* Failed queries */
    struct upstream_server *next;         /* Next server in list */
} upstream_server_t;

/* DNS cache configuration */
typedef struct cache_config {
    int enabled;                          /* Is caching enabled? */
    uint32_t cache_size_mb;               /* Cache size in MB */
    uint32_t cache_ttl_min;               /* Minimum TTL */
    uint32_t cache_ttl_max;               /* Maximum TTL */
    int allow_recursion;                  /* Allow recursive queries? */
    int forward_only;                     /* Only forward, don't recurse */
    int dnssec_validation;                /* Validate DNSSEC? */
    uint32_t rate_limit;                  /* Queries per second per client */
    upstream_server_t *upstream_servers;  /* List of upstream servers */
    int upstream_count;                   /* Number of upstream servers */
} cache_config_t;

/* DNS cache context */
typedef struct cache_ctx {
    pthread_rwlock_t lock;                /* Reader-writer lock */
    cache_record_t **hash_table;          /* Hash table of cached records */
    uint32_t entry_count;                 /* Number of cached entries */
    uint32_t max_entries;                 /* Maximum entries allowed */
    cache_stats_t stats;                  /* Cache statistics */
    cache_config_t config;                /* Cache configuration */
    time_t last_cleanup;                  /* Last cleanup timestamp */
} dnscache_ctx_t;

/* Function prototypes */

/**
 * Initialize DNS cache
 *
 * @param db Database connection (for loading config from database, can be NULL)
 * @param conf_enabled Config file value for enabled (0 if not set)
 * @param conf_size_mb Config file value for cache size in MB (0 if not set)
 * @param conf_ttl_min Config file value for minimum TTL (0 if not set)
 * @param conf_ttl_max Config file value for maximum TTL (0 if not set)
 * @param conf_upstream_servers Config file value for upstream servers (NULL if not set)
 * @return Cache context on success, NULL on error
 */
dnscache_ctx_t *dnscache_init(SQL *db, int conf_enabled, int conf_size_mb,
                               int conf_ttl_min, int conf_ttl_max,
                               const char *conf_upstream_servers);

/**
 * Free DNS cache
 *
 * @param ctx Cache context
 */
void dnscache_free(dnscache_ctx_t *ctx);

/**
 * Lookup a record in the cache
 *
 * @param ctx Cache context
 * @param name Domain name
 * @param type Record type
 * @param records Output array of matching records
 * @param max_records Maximum number of records to return
 * @return Number of records found, 0 if not in cache, -1 on error
 */
int dnscache_lookup(dnscache_ctx_t *ctx, const char *name, dns_qtype_t type,
                 cache_record_t **records, int max_records);

/**
 * Add a record to the cache
 *
 * @param ctx Cache context
 * @param name Domain name
 * @param type Record type
 * @param data Record data
 * @param ttl TTL (will be clamped to min/max)
 * @param aux Auxiliary data
 * @return 0 on success, -1 on error
 */
int dnscache_add(dnscache_ctx_t *ctx, const char *name, dns_qtype_t type,
              const char *data, uint32_t ttl, uint32_t aux);

/**
 * Add a negative cache entry (NXDOMAIN)
 *
 * @param ctx Cache context
 * @param name Domain name
 * @param ttl TTL
 * @return 0 on success, -1 on error
 */
int dnscache_add_negative(dnscache_ctx_t *ctx, const char *name, uint32_t ttl);

/**
 * Query upstream DNS servers
 *
 * @param ctx Cache context
 * @param name Domain name
 * @param type Record type
 * @param response Output buffer for DNS response
 * @param response_len Output: length of response
 * @param max_response_len Maximum response buffer size
 * @return 0 on success, -1 on error
 */
int dnscache_query_upstream(dnscache_ctx_t *ctx, const char *name, dns_qtype_t type,
                         unsigned char *response, size_t *response_len,
                         size_t max_response_len);

/**
 * Parse upstream DNS response and add to cache
 *
 * @param ctx Cache context
 * @param response DNS response packet
 * @param response_len Response length
 * @return Number of records added to cache, -1 on error
 */
int dnscache_parse_response(dnscache_ctx_t *ctx, const unsigned char *response,
                         size_t response_len);

/**
 * Cleanup expired entries
 *
 * @param ctx Cache context
 * @return Number of entries removed
 */
int dnscache_cleanup_expired(dnscache_ctx_t *ctx);

/**
 * Get cache statistics
 *
 * @param ctx Cache context
 * @return Pointer to statistics structure
 */
const cache_stats_t *dnscache_get_stats(dnscache_ctx_t *ctx);

/**
 * Reset cache statistics
 *
 * @param ctx Cache context
 */
void dnscache_reset_stats(dnscache_ctx_t *ctx);

/**
 * Clear all cache entries
 *
 * @param ctx Cache context
 * @return Number of entries removed
 */
int dnscache_clear(dnscache_ctx_t *ctx);

/**
 * Load cache configuration from database
 *
 * @param ctx Cache context
 * @param db Database connection
 * @return 0 on success, -1 on error
 */
int dnscache_load_config(dnscache_ctx_t *ctx, SQL *db);

/**
 * Save cache statistics to database
 *
 * @param ctx Cache context
 * @param db Database connection
 * @return 0 on success, -1 on error
 */
int dnscache_save_stats(dnscache_ctx_t *ctx, SQL *db);

/**
 * Hash function for domain names
 *
 * @param name Domain name
 * @return Hash value
 */
uint32_t dnscache_hash_name(const char *name);

/**
 * Check if caching is allowed for a client
 * Integrates with ACL system (ACL_TARGET_CACHE)
 *
 * @param memzone_ctx Memory zone context (for ACL checking)
 * @param client_ip Client IP address
 * @param country_code Country code from GeoIP (can be NULL)
 * @param asn ASN number (0 if unknown)
 * @return 1 if allowed, 0 if denied, -1 on error
 */
int dnscache_check_acl(memzone_ctx_t *memzone_ctx, const char *client_ip,
                    const char *country_code, uint32_t asn);

/**
 * Perform recursive lookup with caching
 * This is the main entry point for cache queries
 *
 * @param ctx Cache context
 * @param memzone_ctx Memory zone context (for ACL)
 * @param name Domain name
 * @param type Record type
 * @param client_ip Client IP address
 * @param country_code Country code from GeoIP (can be NULL)
 * @param asn ASN number (0 if unknown)
 * @param records Output array of records
 * @param max_records Maximum number of records
 * @return Number of records found, -1 on error, -2 if denied by ACL
 */
int dnscache_resolve(dnscache_ctx_t *ctx, memzone_ctx_t *memzone_ctx,
                  const char *name, dns_qtype_t type,
                  const char *client_ip, const char *country_code, uint32_t asn,
                  cache_record_t **records, int max_records);

/**
 * Add upstream DNS server
 *
 * @param ctx Cache context
 * @param host Server hostname or IP
 * @param port Server port (0 for default 53)
 * @return 0 on success, -1 on error
 */
int dnscache_add_upstream_server(dnscache_ctx_t *ctx, const char *host, int port);

/**
 * Parse comma-separated list of upstream servers
 *
 * @param ctx Cache context
 * @param servers Comma-separated list (e.g., "8.8.8.8,8.8.4.4,1.1.1.1")
 * @return Number of servers added, -1 on error
 */
int dnscache_parse_upstream_servers(dnscache_ctx_t *ctx, const char *servers);

/**
 * Get next upstream server (round-robin)
 *
 * @param ctx Cache context
 * @return Upstream server, NULL if none available
 */
upstream_server_t *dnscache_get_next_upstream(dnscache_ctx_t *ctx);

/**
 * Acquire read lock
 */
void dnscache_read_lock(dnscache_ctx_t *ctx);

/**
 * Release read lock
 */
void dnscache_read_unlock(dnscache_ctx_t *ctx);

/**
 * Acquire write lock
 */
void dnscache_write_lock(dnscache_ctx_t *ctx);

/**
 * Release write lock
 */
void dnscache_write_unlock(dnscache_ctx_t *ctx);

#endif /* _MYDNS_DNS_CACHE_H */
