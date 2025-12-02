/*
 * dns-cache.c - DNS Caching/Recursive Resolver Implementation
 * Date: 2025-11-28
 */

#include "mydns.h"
#include "dns-cache.h"
#include "memzone.h"
#include <string.h>
#include <stdlib.h>
#include <time.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <netdb.h>
#include <unistd.h>
#include <errno.h>

/* Global cache context (for signal handlers, etc.) */
static dnscache_ctx_t *global_cache_ctx = NULL;

/**
 * Hash function for domain names (djb2 algorithm)
 */
uint32_t dnscache_hash_name(const char *name) {
    uint32_t hash = 5381;
    int c;
    char lower_name[DNSCACHE_NAME_MAX];

    /* Convert to lowercase for case-insensitive hashing */
    strncpy(lower_name, name, DNSCACHE_NAME_MAX - 1);
    lower_name[DNSCACHE_NAME_MAX - 1] = '\0';

    for (char *p = lower_name; *p; p++) {
        *p = tolower(*p);
    }

    const char *str = lower_name;
    while ((c = *str++)) {
        hash = ((hash << 5) + hash) + c; /* hash * 33 + c */
    }

    return hash % DNSCACHE_HASH_SIZE;
}

/**
 * Initialize DNS cache
 */
dnscache_ctx_t *dnscache_init(SQL *db, int conf_enabled, int conf_size_mb,
                               int conf_ttl_min, int conf_ttl_max,
                               const char *conf_upstream_servers) {
    dnscache_ctx_t *ctx = (dnscache_ctx_t *)calloc(1, sizeof(dnscache_ctx_t));
    if (!ctx) {
        Warnx(_("Failed to allocate cache context"));
        return NULL;
    }

    /* Initialize read-write lock */
    if (pthread_rwlock_init(&ctx->lock, NULL) != 0) {
        Warnx(_("Failed to initialize cache lock"));
        free(ctx);
        return NULL;
    }

    /* Allocate hash table */
    ctx->hash_table = (cache_record_t **)calloc(DNSCACHE_HASH_SIZE, sizeof(cache_record_t *));
    if (!ctx->hash_table) {
        Warnx(_("Failed to allocate cache hash table"));
        pthread_rwlock_destroy(&ctx->lock);
        free(ctx);
        return NULL;
    }

    /* Initialize default configuration */
    ctx->config.enabled = 1;
    ctx->config.cache_size_mb = 256;
    ctx->config.cache_ttl_min = DNSCACHE_DEFAULT_TTL_MIN;
    ctx->config.cache_ttl_max = DNSCACHE_DEFAULT_TTL_MAX;
    ctx->config.allow_recursion = 1;
    ctx->config.forward_only = 0;
    ctx->config.dnssec_validation = 0;
    ctx->config.rate_limit = 100;
    ctx->config.upstream_servers = NULL;
    ctx->config.upstream_count = 0;

    ctx->entry_count = 0;
    ctx->max_entries = DNSCACHE_MAX_ENTRIES;
    ctx->last_cleanup = time(NULL);

    /* Initialize statistics */
    memset(&ctx->stats, 0, sizeof(cache_stats_t));
    ctx->stats.started = time(NULL);

    int config_loaded = 0;

    /* Priority 1: Try loading from database if available */
    if (db) {
        if (dnscache_load_config(ctx, db) == 0) {
            config_loaded = 1;
            Notice(_("Loaded cache configuration from database"));
        }
    }

    /* Priority 2: If database failed, try config file values */
    if (!config_loaded) {
        int conf_used = 0;

        if (conf_enabled >= 0) {
            ctx->config.enabled = conf_enabled;
            conf_used = 1;
        }
        if (conf_size_mb > 0) {
            ctx->config.cache_size_mb = conf_size_mb;
            conf_used = 1;
        }
        if (conf_ttl_min > 0) {
            ctx->config.cache_ttl_min = conf_ttl_min;
            conf_used = 1;
        }
        if (conf_ttl_max > 0) {
            ctx->config.cache_ttl_max = conf_ttl_max;
            conf_used = 1;
        }
        if (conf_upstream_servers && strlen(conf_upstream_servers) > 0) {
            dnscache_parse_upstream_servers(ctx, conf_upstream_servers);
            conf_used = 1;
        }

        if (conf_used) {
            Notice(_("Loaded cache configuration from config file"));
            config_loaded = 1;
        }
    }

    /* Priority 3: Use hardcoded defaults if nothing else worked */
    if (!config_loaded) {
        Notice(_("Using default cache configuration"));
    }

    /* Set up default upstream servers if none configured */
    if (ctx->config.upstream_count == 0) {
        Notice(_("No upstream servers configured, using Google DNS and Cloudflare"));
        dnscache_add_upstream_server(ctx, "8.8.8.8", 53);
        dnscache_add_upstream_server(ctx, "8.8.4.4", 53);
        dnscache_add_upstream_server(ctx, "1.1.1.1", 53);
        dnscache_add_upstream_server(ctx, "1.0.0.1", 53);
    }

    global_cache_ctx = ctx;

    Notice(_("DNS cache initialized: %d MB, TTL range %d-%d seconds, %d upstream servers"),
           ctx->config.cache_size_mb, ctx->config.cache_ttl_min,
           ctx->config.cache_ttl_max, ctx->config.upstream_count);

    return ctx;
}

/**
 * Free DNS cache
 */
void dnscache_free(dnscache_ctx_t *ctx) {
    if (!ctx) return;

    /* Clear all entries */
    dnscache_clear(ctx);

    /* Free upstream servers */
    upstream_server_t *srv = ctx->config.upstream_servers;
    while (srv) {
        upstream_server_t *next = srv->next;
        if (srv->sockfd >= 0) {
            close(srv->sockfd);
        }
        free(srv);
        srv = next;
    }

    /* Free hash table */
    if (ctx->hash_table) {
        free(ctx->hash_table);
    }

    /* Destroy lock */
    pthread_rwlock_destroy(&ctx->lock);

    free(ctx);
    global_cache_ctx = NULL;
}

/**
 * Lookup a record in the cache
 */
int dnscache_lookup(dnscache_ctx_t *ctx, const char *name, dns_qtype_t type,
                 cache_record_t **records, int max_records) {
    if (!ctx || !name || !records) return -1;

    dnscache_read_lock(ctx);
    ctx->stats.queries++;

    uint32_t hash = dnscache_hash_name(name);
    cache_record_t *entry = ctx->hash_table[hash];
    int found = 0;
    time_t now = time(NULL);

    /* Search for matching entries */
    while (entry && found < max_records) {
        if (strcasecmp(entry->name, name) == 0 &&
            (type == DNS_QTYPE_ANY || entry->type == type)) {

            /* Check if expired */
            if (entry->expires <= now) {
                entry->state = CACHE_STATE_EXPIRED;
            }

            /* Only return valid entries */
            if (entry->state == CACHE_STATE_VALID) {
                records[found++] = entry;
            }
        }
        entry = entry->next;
    }

    if (found > 0) {
        ctx->stats.hits++;
    } else {
        ctx->stats.misses++;
    }

    dnscache_read_unlock(ctx);

    return found;
}

/**
 * Add a record to the cache
 */
int dnscache_add(dnscache_ctx_t *ctx, const char *name, dns_qtype_t type,
              const char *data, uint32_t ttl, uint32_t aux) {
    if (!ctx || !name || !data) return -1;

    /* Check if cache is full */
    if (ctx->entry_count >= ctx->max_entries) {
        /* TODO: Implement LRU eviction */
        return -1;
    }

    dnscache_write_lock(ctx);

    /* Clamp TTL to configured range */
    if (ttl < ctx->config.cache_ttl_min) ttl = ctx->config.cache_ttl_min;
    if (ttl > ctx->config.cache_ttl_max) ttl = ctx->config.cache_ttl_max;

    /* Allocate new entry */
    cache_record_t *entry = (cache_record_t *)calloc(1, sizeof(cache_record_t));
    if (!entry) {
        dnscache_write_unlock(ctx);
        return -1;
    }

    /* Fill in entry */
    strncpy(entry->name, name, DNSCACHE_NAME_MAX - 1);
    entry->type = type;
    strncpy(entry->data, data, DNSCACHE_DATA_MAX - 1);
    entry->ttl = ttl;
    entry->expires = time(NULL) + ttl;
    entry->aux = aux;
    entry->state = CACHE_STATE_VALID;

    /* Add to hash table */
    uint32_t hash = dnscache_hash_name(name);
    entry->next = ctx->hash_table[hash];
    ctx->hash_table[hash] = entry;

    ctx->entry_count++;
    ctx->stats.inserts++;

    dnscache_write_unlock(ctx);

    return 0;
}

/**
 * Add a negative cache entry (NXDOMAIN)
 */
int dnscache_add_negative(dnscache_ctx_t *ctx, const char *name, uint32_t ttl) {
    if (!ctx || !name) return -1;

    dnscache_write_lock(ctx);

    /* Clamp TTL */
    if (ttl < ctx->config.cache_ttl_min) ttl = ctx->config.cache_ttl_min;
    if (ttl > ctx->config.cache_ttl_max) ttl = ctx->config.cache_ttl_max;

    /* Allocate negative entry */
    cache_record_t *entry = (cache_record_t *)calloc(1, sizeof(cache_record_t));
    if (!entry) {
        dnscache_write_unlock(ctx);
        return -1;
    }

    strncpy(entry->name, name, DNSCACHE_NAME_MAX - 1);
    entry->type = DNS_QTYPE_ANY;
    entry->data[0] = '\0';  /* Empty data for NXDOMAIN */
    entry->ttl = ttl;
    entry->expires = time(NULL) + ttl;
    entry->state = CACHE_STATE_NEGATIVE;

    /* Add to hash table */
    uint32_t hash = dnscache_hash_name(name);
    entry->next = ctx->hash_table[hash];
    ctx->hash_table[hash] = entry;

    ctx->entry_count++;
    ctx->stats.inserts++;

    dnscache_write_unlock(ctx);

    return 0;
}

/**
 * Add upstream DNS server
 */
int dnscache_add_upstream_server(dnscache_ctx_t *ctx, const char *host, int port) {
    if (!ctx || !host) return -1;

    if (port == 0) port = 53;

    upstream_server_t *srv = (upstream_server_t *)calloc(1, sizeof(upstream_server_t));
    if (!srv) return -1;

    strncpy(srv->host, host, sizeof(srv->host) - 1);
    srv->port = port;
    srv->sockfd = -1;  /* Will be created on demand */
    srv->queries = 0;
    srv->failures = 0;

    /* Add to list */
    srv->next = ctx->config.upstream_servers;
    ctx->config.upstream_servers = srv;
    ctx->config.upstream_count++;

    Notice(_("Added upstream DNS server: %s:%d"), host, port);

    return 0;
}

/**
 * Parse comma-separated list of upstream servers
 */
int dnscache_parse_upstream_servers(dnscache_ctx_t *ctx, const char *servers) {
    if (!ctx || !servers) return -1;

    char *servers_copy = strdup(servers);
    if (!servers_copy) return -1;

    int count = 0;
    char *token = strtok(servers_copy, ",; ");

    while (token) {
        /* Remove whitespace */
        while (*token == ' ' || *token == '\t') token++;

        /* Parse host:port or just host */
        char *colon = strchr(token, ':');
        int port = 53;

        if (colon) {
            *colon = '\0';
            port = atoi(colon + 1);
        }

        if (dnscache_add_upstream_server(ctx, token, port) == 0) {
            count++;
        }

        token = strtok(NULL, ",; ");
    }

    free(servers_copy);
    return count;
}

/**
 * Get next upstream server (round-robin)
 */
upstream_server_t *dnscache_get_next_upstream(dnscache_ctx_t *ctx) {
    if (!ctx || !ctx->config.upstream_servers) return NULL;

    static int current_index = 0;
    upstream_server_t *srv = ctx->config.upstream_servers;

    /* Find server at current index */
    for (int i = 0; i < current_index && srv; i++) {
        srv = srv->next;
    }

    /* Wrap around if we reached the end */
    if (!srv) {
        srv = ctx->config.upstream_servers;
        current_index = 0;
    }

    current_index = (current_index + 1) % ctx->config.upstream_count;

    return srv;
}

/**
 * Query upstream DNS servers
 */
int dnscache_query_upstream(dnscache_ctx_t *ctx, const char *name, dns_qtype_t type,
                         unsigned char *response, size_t *response_len,
                         size_t max_response_len) {
    if (!ctx || !name || !response || !response_len) return -1;

    ctx->stats.upstream_queries++;

    /* Get next upstream server */
    upstream_server_t *srv = dnscache_get_next_upstream(ctx);
    if (!srv) {
        Warnx(_("No upstream servers available"));
        ctx->stats.upstream_failures++;
        return -1;
    }

    /* Create UDP socket */
    int sockfd = socket(AF_INET, SOCK_DGRAM, 0);
    if (sockfd < 0) {
        Warnx(_("Failed to create socket for upstream query: %s"), strerror(errno));
        ctx->stats.upstream_failures++;
        srv->failures++;
        return -1;
    }

    /* Set timeout */
    struct timeval tv;
    tv.tv_sec = 5;
    tv.tv_usec = 0;
    setsockopt(sockfd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));

    /* Resolve upstream server hostname */
    struct sockaddr_in server_addr;
    memset(&server_addr, 0, sizeof(server_addr));
    server_addr.sin_family = AF_INET;
    server_addr.sin_port = htons(srv->port);

    if (inet_pton(AF_INET, srv->host, &server_addr.sin_addr) <= 0) {
        /* Try resolving as hostname */
        struct hostent *he = gethostbyname(srv->host);
        if (!he) {
            Warnx(_("Failed to resolve upstream server: %s"), srv->host);
            close(sockfd);
            ctx->stats.upstream_failures++;
            srv->failures++;
            return -1;
        }
        memcpy(&server_addr.sin_addr, he->h_addr_list[0], he->h_length);
    }

    /* Build DNS query packet */
    unsigned char query[512];
    size_t query_len = 0;

    /* DNS header */
    uint16_t query_id = (uint16_t)random();
    query[0] = (query_id >> 8) & 0xFF;
    query[1] = query_id & 0xFF;
    query[2] = 0x01;  /* Flags: standard query, recursion desired */
    query[3] = 0x00;
    query[4] = 0x00; query[5] = 0x01;  /* QDCOUNT = 1 */
    query[6] = 0x00; query[7] = 0x00;  /* ANCOUNT = 0 */
    query[8] = 0x00; query[9] = 0x00;  /* NSCOUNT = 0 */
    query[10] = 0x00; query[11] = 0x00; /* ARCOUNT = 0 */
    query_len = 12;

    /* Encode question name */
    const char *label = name;
    while (*label) {
        const char *dot = strchr(label, '.');
        int label_len = dot ? (dot - label) : strlen(label);

        if (label_len > 63) label_len = 63;
        query[query_len++] = label_len;
        memcpy(&query[query_len], label, label_len);
        query_len += label_len;

        if (!dot) break;
        label = dot + 1;
    }
    query[query_len++] = 0;  /* Root label */

    /* QTYPE */
    query[query_len++] = (type >> 8) & 0xFF;
    query[query_len++] = type & 0xFF;

    /* QCLASS (IN) */
    query[query_len++] = 0x00;
    query[query_len++] = 0x01;

    /* Send query */
    ssize_t sent = sendto(sockfd, query, query_len, 0,
                          (struct sockaddr *)&server_addr, sizeof(server_addr));
    if (sent < 0) {
        Warnx(_("Failed to send query to upstream server: %s"), strerror(errno));
        close(sockfd);
        ctx->stats.upstream_failures++;
        srv->failures++;
        return -1;
    }

    /* Receive response */
    socklen_t addr_len = sizeof(server_addr);
    ssize_t received = recvfrom(sockfd, response, max_response_len, 0,
                                (struct sockaddr *)&server_addr, &addr_len);
    close(sockfd);

    if (received < 0) {
        Warnx(_("Failed to receive response from upstream server: %s"), strerror(errno));
        ctx->stats.upstream_failures++;
        srv->failures++;
        return -1;
    }

    *response_len = received;
    srv->queries++;

    return 0;
}

/**
 * Parse upstream DNS response and add to cache
 * (Simplified parser - parses basic A/AAAA/MX records)
 */
int dnscache_parse_response(dnscache_ctx_t *ctx, const unsigned char *response,
                         size_t response_len) {
    if (!ctx || !response || response_len < 12) return -1;

    /* Parse DNS header */
    uint8_t rcode = response[3] & 0x0F;
    uint16_t qdcount = (response[4] << 8) | response[5];
    uint16_t ancount = (response[6] << 8) | response[7];

    /* Check for NXDOMAIN */
    if (rcode == 3) {
        /* TODO: Add negative cache entry */
        return 0;
    }

    /* Check for error */
    if (rcode != 0) {
        return -1;
    }

    /* Skip question section */
    size_t pos = 12;
    for (int i = 0; i < qdcount; i++) {
        /* Skip QNAME */
        while (pos < response_len && response[pos] != 0) {
            if ((response[pos] & 0xC0) == 0xC0) {
                pos += 2;
                break;
            }
            pos += response[pos] + 1;
        }
        if (pos < response_len && response[pos] == 0) pos++;
        pos += 4;  /* Skip QTYPE and QCLASS */
    }

    int records_added = 0;

    /* Parse answer section */
    for (int i = 0; i < ancount && pos < response_len; i++) {
        char name[DNSCACHE_NAME_MAX];
        size_t name_pos = 0;

        /* Parse NAME (with compression) */
        while (pos < response_len) {
            uint8_t len = response[pos];
            if (len == 0) {
                name[name_pos] = '\0';
                pos++;
                break;
            }
            if ((len & 0xC0) == 0xC0) {
                /* Compression pointer - skip for now */
                pos += 2;
                name[name_pos] = '\0';
                break;
            }
            pos++;
            if (name_pos + len + 1 < DNSCACHE_NAME_MAX) {
                memcpy(&name[name_pos], &response[pos], len);
                name_pos += len;
                name[name_pos++] = '.';
            }
            pos += len;
        }

        if (pos + 10 > response_len) break;

        /* Parse TYPE, CLASS, TTL, RDLENGTH */
        uint16_t rr_type = (response[pos] << 8) | response[pos + 1];
        pos += 2;
        /* uint16_t rr_class = */ pos += 2;
        uint32_t ttl = (response[pos] << 24) | (response[pos + 1] << 16) |
                       (response[pos + 2] << 8) | response[pos + 3];
        pos += 4;
        uint16_t rdlength = (response[pos] << 8) | response[pos + 1];
        pos += 2;

        if (pos + rdlength > response_len) break;

        /* Parse RDATA based on type */
        char data[DNSCACHE_DATA_MAX];
        uint32_t aux = 0;

        if (rr_type == DNS_QTYPE_A && rdlength == 4) {
            /* A record */
            snprintf(data, sizeof(data), "%d.%d.%d.%d",
                    response[pos], response[pos + 1],
                    response[pos + 2], response[pos + 3]);
        } else if (rr_type == DNS_QTYPE_AAAA && rdlength == 16) {
            /* AAAA record */
            snprintf(data, sizeof(data),
                    "%02x%02x:%02x%02x:%02x%02x:%02x%02x:"
                    "%02x%02x:%02x%02x:%02x%02x:%02x%02x",
                    response[pos], response[pos + 1],
                    response[pos + 2], response[pos + 3],
                    response[pos + 4], response[pos + 5],
                    response[pos + 6], response[pos + 7],
                    response[pos + 8], response[pos + 9],
                    response[pos + 10], response[pos + 11],
                    response[pos + 12], response[pos + 13],
                    response[pos + 14], response[pos + 15]);
        } else {
            /* Skip unsupported record types for now */
            pos += rdlength;
            continue;
        }

        pos += rdlength;

        /* Add to cache */
        if (dnscache_add(ctx, name, rr_type, data, ttl, aux) == 0) {
            records_added++;
        }
    }

    return records_added;
}

/**
 * Load cache configuration from database
 */
int dnscache_load_config(dnscache_ctx_t *ctx, SQL *db) {
    if (!ctx || !db) return -1;

    const char *query = "SELECT enabled, cache_size_mb, cache_ttl_min, cache_ttl_max, "
                       "upstream_servers "
                       "FROM dns_cache_config LIMIT 1";

    SQL_RES *res = sql_query(db, query, strlen(query));
    if (!res) {
        return -1;
    }

    MYSQL_ROW row = sql_getrow(res, NULL);
    if (!row) {
        sql_free(res);
        return -1;
    }

    /* Parse configuration */
    ctx->config.enabled = atoi(row[0]);
    ctx->config.cache_size_mb = atoi(row[1]);
    ctx->config.cache_ttl_min = atoi(row[2]);
    ctx->config.cache_ttl_max = atoi(row[3]);

    /* Parse upstream servers */
    if (row[4] && strlen(row[4]) > 0) {
        dnscache_parse_upstream_servers(ctx, row[4]);
    }

    sql_free(res);

    return 0;
}

/**
 * Check if caching is allowed for a client (ACL integration)
 */
int dnscache_check_acl(memzone_ctx_t *memzone_ctx, const char *client_ip,
                    const char *country_code, uint32_t asn) {
    if (!memzone_ctx || !client_ip) return -1;

    return memzone_check_dns_access(memzone_ctx, ACL_TARGET_CACHE,
                                     client_ip, country_code, asn);
}

/**
 * Perform recursive lookup with caching
 */
int dnscache_resolve(dnscache_ctx_t *ctx, memzone_ctx_t *memzone_ctx,
                  const char *name, dns_qtype_t type,
                  const char *client_ip, const char *country_code, uint32_t asn,
                  cache_record_t **records, int max_records) {
    if (!ctx || !name || !records) return -1;

    /* Check ACL first */
    if (memzone_ctx && client_ip) {
        int acl_result = dnscache_check_acl(memzone_ctx, client_ip, country_code, asn);
        if (acl_result == 0) {
            ctx->stats.acl_denials++;
            return -2;  /* Denied by ACL */
        }
    }

    /* Check cache first */
    int found = dnscache_lookup(ctx, name, type, records, max_records);
    if (found > 0) {
        return found;  /* Cache hit */
    }

    /* Cache miss - query upstream */
    unsigned char response[4096];
    size_t response_len = 0;

    if (dnscache_query_upstream(ctx, name, type, response, &response_len, sizeof(response)) < 0) {
        return -1;  /* Upstream query failed */
    }

    /* Parse response and add to cache */
    int added = dnscache_parse_response(ctx, response, response_len);
    if (added < 0) {
        return -1;
    }

    /* Try cache lookup again */
    return dnscache_lookup(ctx, name, type, records, max_records);
}

/**
 * Cleanup expired entries
 */
int dnscache_cleanup_expired(dnscache_ctx_t *ctx) {
    if (!ctx) return -1;

    dnscache_write_lock(ctx);

    int removed = 0;
    time_t now = time(NULL);

    for (int i = 0; i < DNSCACHE_HASH_SIZE; i++) {
        cache_record_t **prev = &ctx->hash_table[i];
        cache_record_t *entry = ctx->hash_table[i];

        while (entry) {
            if (entry->expires <= now) {
                /* Remove expired entry */
                *prev = entry->next;
                cache_record_t *to_free = entry;
                entry = entry->next;
                free(to_free);
                removed++;
                ctx->entry_count--;
            } else {
                prev = &entry->next;
                entry = entry->next;
            }
        }
    }

    ctx->stats.evictions += removed;
    ctx->last_cleanup = now;

    dnscache_write_unlock(ctx);

    return removed;
}

/**
 * Clear all cache entries
 */
int dnscache_clear(dnscache_ctx_t *ctx) {
    if (!ctx) return -1;

    dnscache_write_lock(ctx);

    int removed = 0;

    for (int i = 0; i < DNSCACHE_HASH_SIZE; i++) {
        cache_record_t *entry = ctx->hash_table[i];
        while (entry) {
            cache_record_t *next = entry->next;
            free(entry);
            removed++;
            entry = next;
        }
        ctx->hash_table[i] = NULL;
    }

    ctx->entry_count = 0;

    dnscache_write_unlock(ctx);

    return removed;
}

/* Lock functions */
void dnscache_read_lock(dnscache_ctx_t *ctx) {
    pthread_rwlock_rdlock(&ctx->lock);
}

void dnscache_read_unlock(dnscache_ctx_t *ctx) {
    pthread_rwlock_unlock(&ctx->lock);
}

void dnscache_write_lock(dnscache_ctx_t *ctx) {
    pthread_rwlock_wrlock(&ctx->lock);
}

void dnscache_write_unlock(dnscache_ctx_t *ctx) {
    pthread_rwlock_unlock(&ctx->lock);
}

const cache_stats_t *dnscache_get_stats(dnscache_ctx_t *ctx) {
    return ctx ? &ctx->stats : NULL;
}

void dnscache_reset_stats(dnscache_ctx_t *ctx) {
    if (!ctx) return;

    dnscache_write_lock(ctx);
    memset(&ctx->stats, 0, sizeof(cache_stats_t));
    ctx->stats.started = time(NULL);
    dnscache_write_unlock(ctx);
}

int dnscache_save_stats(dnscache_ctx_t *ctx, SQL *db) {
    if (!ctx || !db) return -1;

    /* Save hourly statistics */
    time_t now = time(NULL);
    struct tm *tm = localtime(&now);

    char query[1024];
    snprintf(query, sizeof(query),
        "INSERT INTO dns_cache_stats (date, hour, queries_total, cache_hits, "
        "cache_misses, upstream_queries, avg_response_time_ms) "
        "VALUES (CURDATE(), %d, %lu, %lu, %lu, %lu, 0) "
        "ON DUPLICATE KEY UPDATE "
        "queries_total = queries_total + %lu, "
        "cache_hits = cache_hits + %lu, "
        "cache_misses = cache_misses + %lu, "
        "upstream_queries = upstream_queries + %lu",
        tm->tm_hour,
        ctx->stats.queries, ctx->stats.hits,
        ctx->stats.misses, ctx->stats.upstream_queries,
        ctx->stats.queries, ctx->stats.hits,
        ctx->stats.misses, ctx->stats.upstream_queries);

    if (sql_query(db, query, strlen(query)) < 0) {
        return -1;
    }

    return 0;
}
