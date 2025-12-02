/*
 * memzone.c - In-Memory Zone Storage for AXFR Slave Zones
 * Date: 2025-11-26
 *
 * Implements memory-only zone storage for MyDNS AXFR slave zones.
 */

#include "memzone.h"
#include "mydns.h"
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <arpa/inet.h>
#include <netinet/in.h>

/* Global memory zone context (accessible to all modules) */
static memzone_ctx_t *global_memzone = NULL;

/**
 * djb2 hash function for strings
 */
uint32_t memzone_hash_name(const char *name) {
    uint32_t hash = 5381;
    int c;

    while ((c = *name++)) {
        /* Convert to lowercase for case-insensitive DNS */
        if (c >= 'A' && c <= 'Z') {
            c = c + ('a' - 'A');
        }
        hash = ((hash << 5) + hash) + c; /* hash * 33 + c */
    }

    return hash % MEMZONE_HASH_SIZE;
}

/**
 * Initialize in-memory zone storage with shared memory
 */
memzone_ctx_t *memzone_init(int create) {
    memzone_ctx_t *ctx = NULL;
    int shm_fd;
    void *shm_base;
    int flags;

    /* If already initialized, return existing context */
    if (global_memzone != NULL) {
        return global_memzone;
    }

    /* Open or create shared memory */
    if (create) {
        shm_unlink(MEMZONE_SHM_PATH);  /* Remove old shared memory */
        flags = O_CREAT | O_RDWR;
    } else {
        flags = O_RDWR;
    }

    shm_fd = shm_open(MEMZONE_SHM_PATH, flags, 0600);
    if (shm_fd < 0) {
        Warnx(_("Failed to open shared memory: %s"), strerror(errno));
        return NULL;
    }

    /* Set size if creating */
    if (create) {
        if (ftruncate(shm_fd, MEMZONE_SHM_SIZE) < 0) {
            Warnx(_("Failed to set shared memory size: %s"), strerror(errno));
            close(shm_fd);
            return NULL;
        }
    }

    /* Map shared memory */
    shm_base = mmap(NULL, MEMZONE_SHM_SIZE, PROT_READ | PROT_WRITE, MAP_SHARED, shm_fd, 0);
    if (shm_base == MAP_FAILED) {
        Warnx(_("Failed to map shared memory: %s"), strerror(errno));
        close(shm_fd);
        return NULL;
    }

    /* If creating, initialize structure in shared memory */
    if (create) {
        memset(shm_base, 0, MEMZONE_SHM_SIZE);
        ctx = (memzone_ctx_t *)shm_base;

        ctx->shm_fd = shm_fd;
        ctx->shm_base = shm_base;
        ctx->shm_size = MEMZONE_SHM_SIZE;
        ctx->zone_count = 0;
        ctx->record_count = 0;
        ctx->queries = 0;
        ctx->hits = 0;
        ctx->misses = 0;
        ctx->created = time(NULL);

        /* Initialize pools at offsets after main structure */
        size_t offset = sizeof(memzone_ctx_t);

        /* Zone hash table */
        ctx->zone_hash = (zone_entry_t **)((char *)shm_base + offset);
        offset += sizeof(zone_entry_t *) * MEMZONE_HASH_SIZE;

        /* SOA pool */
        ctx->soa_pool = (mem_soa_t *)((char *)shm_base + offset);
        offset += sizeof(mem_soa_t) * MEMZONE_MAX_ZONES;
        ctx->soa_pool_used = 0;

        /* RR pool */
        ctx->rr_pool = (mem_rr_t *)((char *)shm_base + offset);
        offset += sizeof(mem_rr_t) * MEMZONE_MAX_RECORDS;
        ctx->rr_pool_used = 0;

        /* ACL pool */
        ctx->acl_pool = (mem_acl_t *)((char *)shm_base + offset);
        offset += sizeof(mem_acl_t) * MEMZONE_MAX_ACL_RULES;
        ctx->acl_pool_used = 0;
        ctx->acl_head = NULL;
        ctx->acl_count = 0;

        /* Initialize rwlock */
        pthread_rwlockattr_t attr;
        pthread_rwlockattr_init(&attr);
        pthread_rwlockattr_setpshared(&attr, PTHREAD_PROCESS_SHARED);
        pthread_rwlock_init(&ctx->lock, &attr);
        pthread_rwlockattr_destroy(&attr);

        Notice(_("In-memory zone storage initialized: %d zones, %d records capacity"),
               MEMZONE_MAX_ZONES, MEMZONE_MAX_RECORDS);
    } else {
        /* Attach to existing shared memory */
        ctx = (memzone_ctx_t *)shm_base;
        ctx->shm_fd = shm_fd;
        ctx->shm_base = shm_base;

        Notice(_("Attached to existing in-memory zone storage: %u zones, %u records"),
               ctx->zone_count, ctx->record_count);
    }

    global_memzone = ctx;
    return ctx;
}

/**
 * Free in-memory zone storage
 */
void memzone_free(memzone_ctx_t *ctx) {
    if (!ctx) return;

    pthread_rwlock_destroy(&ctx->lock);
    munmap(ctx->shm_base, ctx->shm_size);
    close(ctx->shm_fd);

    if (ctx == global_memzone) {
        global_memzone = NULL;
    }
}

/**
 * Locking functions
 */
void memzone_read_lock(memzone_ctx_t *ctx) {
    pthread_rwlock_rdlock(&ctx->lock);
}

void memzone_read_unlock(memzone_ctx_t *ctx) {
    pthread_rwlock_unlock(&ctx->lock);
}

void memzone_write_lock(memzone_ctx_t *ctx) {
    pthread_rwlock_wrlock(&ctx->lock);
}

void memzone_write_unlock(memzone_ctx_t *ctx) {
    pthread_rwlock_unlock(&ctx->lock);
}

/**
 * Add or update a zone in memory
 */
int memzone_add_zone(memzone_ctx_t *ctx, const mem_soa_t *soa) {
    if (!ctx || !soa) return -1;

    memzone_write_lock(ctx);

    /* Check if zone already exists */
    zone_entry_t *zone = memzone_find_zone(ctx, soa->zone_id);
    if (zone) {
        /* Update existing zone */
        memcpy(zone->soa, soa, sizeof(mem_soa_t));
        memzone_write_unlock(ctx);
        return 0;
    }

    /* Allocate new SOA from pool */
    if (ctx->soa_pool_used >= MEMZONE_MAX_ZONES) {
        Warnx(_("SOA pool exhausted"));
        memzone_write_unlock(ctx);
        return -1;
    }

    mem_soa_t *new_soa = &ctx->soa_pool[ctx->soa_pool_used++];
    memcpy(new_soa, soa, sizeof(mem_soa_t));

    /* Create zone entry */
    /* Note: We can't use malloc in shared memory, so we'll use a simpler approach */
    /* For now, store zone_entry_t in a pre-allocated array */

    uint32_t hash = memzone_hash_name(soa->origin);
    zone_entry_t *entry = (zone_entry_t *)calloc(1, sizeof(zone_entry_t));
    if (!entry) {
        memzone_write_unlock(ctx);
        return -1;
    }

    entry->soa = new_soa;
    entry->rr_hash = (mem_rr_t **)calloc(MEMZONE_HASH_SIZE, sizeof(mem_rr_t *));
    entry->record_count = 0;
    entry->next = ctx->zone_hash[hash];
    ctx->zone_hash[hash] = entry;

    ctx->zone_count++;

    memzone_write_unlock(ctx);

    Notice(_("Added zone to memory: %s (ID %u)"), soa->origin, soa->zone_id);
    return 0;
}

/**
 * Delete a zone from memory
 */
int memzone_delete_zone(memzone_ctx_t *ctx, uint32_t zone_id) {
    if (!ctx) return -1;

    memzone_write_lock(ctx);

    /* Find and remove zone from hash table */
    zone_entry_t *zone = memzone_find_zone(ctx, zone_id);
    if (!zone) {
        memzone_write_unlock(ctx);
        return -1;
    }

    /* Delete all records in zone */
    memzone_delete_all_rr(ctx, zone_id);

    /* Remove zone from hash chain */
    uint32_t hash = memzone_hash_name(zone->soa->origin);
    zone_entry_t **prev = &ctx->zone_hash[hash];
    while (*prev) {
        if (*prev == zone) {
            *prev = zone->next;
            break;
        }
        prev = &(*prev)->next;
    }

    /* Free zone structures */
    free(zone->rr_hash);
    free(zone);

    ctx->zone_count--;

    memzone_write_unlock(ctx);
    return 0;
}

/**
 * Find zone by ID
 */
zone_entry_t *memzone_find_zone(memzone_ctx_t *ctx, uint32_t zone_id) {
    if (!ctx) return NULL;

    /* Linear search through all hash buckets */
    for (int i = 0; i < MEMZONE_HASH_SIZE; i++) {
        zone_entry_t *zone = ctx->zone_hash[i];
        while (zone) {
            if (zone->soa && zone->soa->zone_id == zone_id) {
                return zone;
            }
            zone = zone->next;
        }
    }

    return NULL;
}

/**
 * Find zone by name
 */
zone_entry_t *memzone_find_zone_by_name(memzone_ctx_t *ctx, const char *origin) {
    if (!ctx || !origin) return NULL;

    uint32_t hash = memzone_hash_name(origin);
    zone_entry_t *zone = ctx->zone_hash[hash];

    while (zone) {
        if (zone->soa && strcasecmp(zone->soa->origin, origin) == 0) {
            return zone;
        }
        zone = zone->next;
    }

    return NULL;
}

/**
 * Add a resource record to a zone
 */
int memzone_add_rr(memzone_ctx_t *ctx, uint32_t zone_id, const mem_rr_t *rr) {
    if (!ctx || !rr) return -1;

    memzone_write_lock(ctx);

    /* Find zone */
    zone_entry_t *zone = memzone_find_zone(ctx, zone_id);
    if (!zone) {
        Warnx(_("Zone %u not found for adding record"), zone_id);
        memzone_write_unlock(ctx);
        return -1;
    }

    /* Allocate new RR from pool */
    if (ctx->rr_pool_used >= MEMZONE_MAX_RECORDS) {
        Warnx(_("RR pool exhausted"));
        memzone_write_unlock(ctx);
        return -1;
    }

    mem_rr_t *new_rr = &ctx->rr_pool[ctx->rr_pool_used++];
    memcpy(new_rr, rr, sizeof(mem_rr_t));
    new_rr->zone_id = zone_id;

    /* Add to zone's hash table */
    uint32_t hash = memzone_hash_name(rr->name);
    new_rr->next = zone->rr_hash[hash];
    zone->rr_hash[hash] = new_rr;

    zone->record_count++;
    ctx->record_count++;

    memzone_write_unlock(ctx);
    return 0;
}

/**
 * Delete all resource records from a zone
 */
int memzone_delete_all_rr(memzone_ctx_t *ctx, uint32_t zone_id) {
    if (!ctx) return -1;

    zone_entry_t *zone = memzone_find_zone(ctx, zone_id);
    if (!zone) return -1;

    /* Clear all hash buckets */
    for (int i = 0; i < MEMZONE_HASH_SIZE; i++) {
        mem_rr_t *rr = zone->rr_hash[i];
        while (rr) {
            mem_rr_t *next = rr->next;
            /* Mark as free in pool (simple approach: just break the chain) */
            rr = next;
        }
        zone->rr_hash[i] = NULL;
    }

    ctx->record_count -= zone->record_count;
    zone->record_count = 0;

    return 0;
}

/**
 * Query resource records for a name
 */
int memzone_query(memzone_ctx_t *ctx, uint32_t zone_id, const char *name,
                  dns_qtype_t type, mem_rr_t **results, int max_results) {
    if (!ctx || !name || !results) return -1;

    memzone_read_lock(ctx);

    ctx->queries++;

    /* Find zone */
    zone_entry_t *zone = memzone_find_zone(ctx, zone_id);
    if (!zone) {
        ctx->misses++;
        memzone_read_unlock(ctx);
        return 0;
    }

    /* Hash lookup */
    uint32_t hash = memzone_hash_name(name);
    mem_rr_t *rr = zone->rr_hash[hash];

    int count = 0;
    while (rr && count < max_results) {
        /* Check if name matches (case-insensitive) */
        if (strcasecmp(rr->name, name) == 0) {
            /* Check type (DNS_QTYPE_ANY matches all) */
            if (type == DNS_QTYPE_ANY || rr->type == type) {
                results[count++] = rr;
                ctx->hits++;
            }
        }
        rr = rr->next;
    }

    if (count == 0) {
        ctx->misses++;
    }

    memzone_read_unlock(ctx);
    return count;
}

/**
 * Get SOA record for a zone
 */
mem_soa_t *memzone_get_soa(memzone_ctx_t *ctx, uint32_t zone_id) {
    if (!ctx) return NULL;

    memzone_read_lock(ctx);

    zone_entry_t *zone = memzone_find_zone(ctx, zone_id);
    mem_soa_t *soa = zone ? zone->soa : NULL;

    memzone_read_unlock(ctx);
    return soa;
}

/**
 * Check if a zone exists in memory
 */
int memzone_zone_exists(memzone_ctx_t *ctx, uint32_t zone_id) {
    if (!ctx) return -1;

    memzone_read_lock(ctx);
    zone_entry_t *zone = memzone_find_zone(ctx, zone_id);
    int exists = (zone != NULL) ? 1 : 0;
    memzone_read_unlock(ctx);

    return exists;
}

/**
 * Get statistics
 */
void memzone_get_stats(memzone_ctx_t *ctx, uint32_t *zone_count, uint32_t *record_count,
                       uint64_t *queries, uint64_t *hits, uint64_t *misses) {
    if (!ctx) return;

    memzone_read_lock(ctx);

    if (zone_count) *zone_count = ctx->zone_count;
    if (record_count) *record_count = ctx->record_count;
    if (queries) *queries = ctx->queries;
    if (hits) *hits = ctx->hits;
    if (misses) *misses = ctx->misses;

    memzone_read_unlock(ctx);
}

/**
 * Load slave zones from database into memory
 * Called during startup to populate memory with existing slave zones
 */
int memzone_load_from_db(memzone_ctx_t *ctx, SQL *db) {
    if (!ctx || !db) return -1;

    int zones_loaded = 0;

    /* Query all slave zones from database */
    const char *query = "SELECT id, origin, ns, mbox, serial, refresh, retry, expire, "
                       "minimum, ttl, active FROM soa WHERE slave_mode = TRUE AND active = 'Y'";

    if (sql_query(db, query, strlen(query)) < 0) {
        Warnx(_("Failed to load slave zones from database"));
        return -1;
    }

    MYSQL_RES *res = sql_query(db, query, strlen(query));
    if (!res) {
        return -1;
    }

    MYSQL_ROW row;
    while ((row = sql_getrow(res, NULL))) {
        mem_soa_t soa;
        memset(&soa, 0, sizeof(soa));

        soa.zone_id = atoi(row[0]);
        strncpy(soa.origin, row[1], MEMZONE_NAME_MAX - 1);
        strncpy(soa.ns, row[2], MEMZONE_NAME_MAX - 1);
        strncpy(soa.mbox, row[3], MEMZONE_NAME_MAX - 1);
        soa.serial = atoi(row[4]);
        soa.refresh = atoi(row[5]);
        soa.retry = atoi(row[6]);
        soa.expire = atoi(row[7]);
        soa.minimum = atoi(row[8]);
        soa.ttl = atoi(row[9]);
        soa.active = (row[10][0] == 'Y') ? 1 : 0;
        soa.updated = time(NULL);

        if (memzone_add_zone(ctx, &soa) == 0) {
            zones_loaded++;

            /* Load records for this zone */
            char rr_query[512];
            snprintf(rr_query, sizeof(rr_query),
                    "SELECT id, name, type, data, aux, ttl FROM rr WHERE zone = %u",
                    soa.zone_id);

            if (sql_query(db, rr_query, strlen(rr_query)) == 0) {
                MYSQL_RES *rr_res = sql_query(db, rr_query, strlen(rr_query));
                if (rr_res) {
                    MYSQL_ROW rr_row;
                    int records = 0;
                    while ((rr_row = sql_getrow(rr_res, NULL))) {
                        mem_rr_t rr;
                        memset(&rr, 0, sizeof(rr));

                        rr.id = atoll(rr_row[0]);
                        strncpy(rr.name, rr_row[1], MEMZONE_NAME_MAX - 1);
                        rr.type = mydns_rr_get_type(rr_row[2]);
                        strncpy(rr.data, rr_row[3], MEMZONE_DATA_MAX - 1);
                        rr.aux = atoi(rr_row[4]);
                        rr.ttl = atoi(rr_row[5]);

                        if (memzone_add_rr(ctx, soa.zone_id, &rr) == 0) {
                            records++;
                        }
                    }
                    sql_free(rr_res);

                    Notice(_("Loaded %d records for zone %s"), records, soa.origin);
                }
            }
        }
    }

    sql_free(res);

    Notice(_("Loaded %d slave zones from database into memory"), zones_loaded);
    return zones_loaded;
}

/**
 * Parse IP address and optional CIDR mask
 */
int memzone_parse_ip(const char *ip_str, uint32_t *ip, uint32_t *mask) {
    if (!ip_str || !ip || !mask) return -1;

    char buf[256];
    strncpy(buf, ip_str, sizeof(buf) - 1);
    buf[sizeof(buf) - 1] = '\0';

    /* Check for CIDR notation */
    char *slash = strchr(buf, '/');
    int cidr_bits = 32;  /* Default to single IP */

    if (slash) {
        *slash = '\0';
        cidr_bits = atoi(slash + 1);
        if (cidr_bits < 0 || cidr_bits > 32) {
            return -1;
        }
    }

    /* Parse IP address */
    struct in_addr addr;
    if (inet_pton(AF_INET, buf, &addr) != 1) {
        return -1;
    }

    *ip = ntohl(addr.s_addr);
    *mask = (cidr_bits == 0) ? 0 : (~0U << (32 - cidr_bits));

    return 0;
}

/**
 * Check if IP is in network
 */
int memzone_ip_in_network(uint32_t ip, uint32_t network, uint32_t mask) {
    return ((ip & mask) == (network & mask)) ? 1 : 0;
}

/**
 * Add an access control rule
 */
int memzone_add_acl(memzone_ctx_t *ctx, const mem_acl_t *acl) {
    if (!ctx || !acl) return -1;

    memzone_write_lock(ctx);

    /* Check pool capacity */
    if (ctx->acl_pool_used >= MEMZONE_MAX_ACL_RULES) {
        Warnx(_("ACL pool exhausted"));
        memzone_write_unlock(ctx);
        return -1;
    }

    /* Allocate from pool */
    mem_acl_t *new_acl = &ctx->acl_pool[ctx->acl_pool_used++];
    memcpy(new_acl, acl, sizeof(mem_acl_t));

    /* Add to head of linked list */
    new_acl->next = ctx->acl_head;
    ctx->acl_head = new_acl;
    ctx->acl_count++;

    memzone_write_unlock(ctx);

    Notice(_("Added ACL rule: type=%d target=%d value=%s whitelist=%d"),
           acl->type, acl->target, acl->value, acl->is_whitelist);

    return 0;
}

/**
 * Delete an access control rule
 */
int memzone_delete_acl(memzone_ctx_t *ctx, uint32_t acl_id) {
    if (!ctx) return -1;

    memzone_write_lock(ctx);

    mem_acl_t **prev = &ctx->acl_head;
    mem_acl_t *curr = ctx->acl_head;

    while (curr) {
        if (curr->id == acl_id) {
            *prev = curr->next;
            ctx->acl_count--;
            memzone_write_unlock(ctx);
            return 0;
        }
        prev = &curr->next;
        curr = curr->next;
    }

    memzone_write_unlock(ctx);
    return -1;
}

/**
 * Clear all ACL rules
 */
int memzone_clear_acl(memzone_ctx_t *ctx) {
    if (!ctx) return -1;

    memzone_write_lock(ctx);

    ctx->acl_head = NULL;
    ctx->acl_count = 0;
    ctx->acl_pool_used = 0;

    memzone_write_unlock(ctx);
    return 0;
}

/**
 * Check if an IP address is allowed access
 */
int memzone_check_access(memzone_ctx_t *ctx, acl_target_t target,
                          const char *ip_str, const char *country_code, uint32_t asn) {
    if (!ctx || !ip_str) return -1;

    memzone_read_lock(ctx);

    ctx->acl_checks++;

    /* If no ACL rules, allow by default */
    if (ctx->acl_count == 0) {
        memzone_read_unlock(ctx);
        return 1;
    }

    /* Parse IP address */
    uint32_t ip, mask;
    if (memzone_parse_ip(ip_str, &ip, &mask) < 0) {
        memzone_read_unlock(ctx);
        return -1;
    }

    /* Check rules */
    int has_whitelist = 0;
    int whitelist_match = 0;
    int blacklist_match = 0;

    mem_acl_t *acl = ctx->acl_head;
    while (acl) {
        /* Skip if rule doesn't apply to this target */
        /* ACL_TARGET_SYSTEM applies to everything */
        if (acl->target != target && acl->target != ACL_TARGET_SYSTEM) {
            acl = acl->next;
            continue;
        }

        /* Skip if rule is disabled */
        if (!acl->enabled) {
            acl = acl->next;
            continue;
        }

        int match = 0;

        switch (acl->type) {
            case ACL_TYPE_IP: {
                uint32_t rule_ip, rule_mask;
                if (memzone_parse_ip(acl->value, &rule_ip, &rule_mask) == 0) {
                    match = (ip == rule_ip);
                }
                break;
            }

            case ACL_TYPE_NETWORK: {
                uint32_t rule_ip, rule_mask;
                if (memzone_parse_ip(acl->value, &rule_ip, &rule_mask) == 0) {
                    match = memzone_ip_in_network(ip, rule_ip, rule_mask);
                }
                break;
            }

            case ACL_TYPE_COUNTRY:
                if (country_code && strcasecmp(acl->value, country_code) == 0) {
                    match = 1;
                }
                break;

            case ACL_TYPE_ASN:
                if (asn > 0 && atoi(acl->value) == (int)asn) {
                    match = 1;
                }
                break;
        }

        if (match) {
            if (acl->is_whitelist) {
                whitelist_match = 1;
            } else {
                blacklist_match = 1;
            }
        }

        if (acl->is_whitelist) {
            has_whitelist = 1;
        }

        acl = acl->next;
    }

    memzone_read_unlock(ctx);

    /* Access control logic:
     * 1. If blacklist matches, deny
     * 2. If whitelist exists and matches, allow
     * 3. If whitelist exists but doesn't match, deny
     * 4. If no whitelist, allow
     */

    if (blacklist_match) {
        ctx->acl_denies++;
        return 0;  /* Denied by blacklist */
    }

    if (has_whitelist) {
        if (whitelist_match) {
            return 1;  /* Allowed by whitelist */
        } else {
            ctx->acl_denies++;
            return 0;  /* Denied (not in whitelist) */
        }
    }

    return 1;  /* Allowed (no applicable rules) */
}

/**
 * Check access with zone type awareness
 * This checks both system-wide ACLs and zone-type-specific ACLs
 */
int memzone_check_dns_access(memzone_ctx_t *ctx, acl_target_t zone_type,
                               const char *ip_str, const char *country_code, uint32_t asn) {
    if (!ctx) return -1;

    /* First check system-wide ACLs (applies to everything) */
    int system_result = memzone_check_access(ctx, ACL_TARGET_SYSTEM, ip_str, country_code, asn);
    if (system_result == 0) {
        /* Denied by system-wide ACL */
        return 0;
    }

    /* Then check zone-type-specific ACLs */
    int zone_result = memzone_check_access(ctx, zone_type, ip_str, country_code, asn);

    return zone_result;
}

/**
 * Load access control rules from database
 */
int memzone_load_acl_from_db(memzone_ctx_t *ctx, SQL *db) {
    if (!ctx || !db) return -1;

    int rules_loaded = 0;

    /* Query all ACL rules from database */
    const char *query = "SELECT id, type, target, action, value, enabled, "
                       "date_created FROM access_control WHERE enabled = 1";

    if (sql_query(db, query, strlen(query)) < 0) {
        Warnx(_("Failed to load ACL rules from database"));
        return -1;
    }

    MYSQL_RES *res = sql_query(db, query, strlen(query));
    if (!res) {
        return -1;
    }

    MYSQL_ROW row;
    while ((row = sql_getrow(res, NULL))) {
        mem_acl_t acl;
        memset(&acl, 0, sizeof(acl));

        acl.id = atoi(row[0]);

        /* Parse type ENUM: 'ip', 'network', 'country', 'asn' */
        if (strcmp(row[1], "ip") == 0) {
            acl.type = ACL_TYPE_IP;
        } else if (strcmp(row[1], "network") == 0) {
            acl.type = ACL_TYPE_NETWORK;
        } else if (strcmp(row[1], "country") == 0) {
            acl.type = ACL_TYPE_COUNTRY;
        } else if (strcmp(row[1], "asn") == 0) {
            acl.type = ACL_TYPE_ASN;
        } else {
            Warnx(_("Unknown ACL type '%s' for rule %d"), row[1], acl.id);
            continue;
        }

        /* Parse target ENUM: 'system', 'master', 'slave', 'cache', 'webui', 'doh' */
        if (strcmp(row[2], "system") == 0) {
            acl.target = ACL_TARGET_SYSTEM;
        } else if (strcmp(row[2], "master") == 0) {
            acl.target = ACL_TARGET_MASTER;
        } else if (strcmp(row[2], "slave") == 0) {
            acl.target = ACL_TARGET_SLAVE;
        } else if (strcmp(row[2], "cache") == 0) {
            acl.target = ACL_TARGET_CACHE;
        } else if (strcmp(row[2], "webui") == 0) {
            acl.target = ACL_TARGET_WEBUI;
        } else if (strcmp(row[2], "doh") == 0) {
            acl.target = ACL_TARGET_DOH;
        } else {
            Warnx(_("Unknown ACL target '%s' for rule %d"), row[2], acl.id);
            continue;
        }

        /* Parse action ENUM: 'allow' = whitelist, 'deny' = blacklist */
        if (strcmp(row[3], "allow") == 0) {
            acl.is_whitelist = 1;
        } else if (strcmp(row[3], "deny") == 0) {
            acl.is_whitelist = 0;
        } else {
            Warnx(_("Unknown ACL action '%s' for rule %d"), row[3], acl.id);
            continue;
        }

        strncpy(acl.value, row[4], MEMZONE_NAME_MAX - 1);
        acl.enabled = atoi(row[5]);

        /* Parse creation time */
        if (row[6]) {
            struct tm tm;
            strptime(row[6], "%Y-%m-%d %H:%M:%S", &tm);
            acl.created = mktime(&tm);
        }

        /* For network rules, parse and store the mask */
        if (acl.type == ACL_TYPE_NETWORK) {
            uint32_t ip;
            memzone_parse_ip(acl.value, &ip, &acl.mask);
        }

        if (memzone_add_acl(ctx, &acl) == 0) {
            rules_loaded++;
        }
    }

    sql_free(res);

    Notice(_("Loaded %d ACL rules from database into memory"), rules_loaded);
    return rules_loaded;
}
