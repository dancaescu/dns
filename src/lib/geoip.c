/*
 * geoip.c - Geographic IP lookup and access control implementation
 * Date: 2025-11-25
 */

#include "mydns.h"
#include "mydnsutil.h"
#include "geoip.h"
#include <GeoIP.h>
#include <arpa/inet.h>
#include <string.h>

/* Global GeoIP database path */
#define GEOIP_DATABASE_PATH "/usr/share/GeoIP/GeoIP.dat"

/*
 * Initialize GeoIP context
 */
GEOIP_CTX* geoip_init(SQL *db) {
    GEOIP_CTX *ctx;

    if (!db) {
        Err(_("geoip_init: NULL database connection"));
        return NULL;
    }

    ctx = (GEOIP_CTX*)malloc(sizeof(GEOIP_CTX));
    if (!ctx) {
        Err(_("geoip_init: malloc failed"));
        return NULL;
    }

    memset(ctx, 0, sizeof(GEOIP_CTX));
    ctx->db = db;

    /* Open GeoIP database */
    ctx->gi = (void*)GeoIP_open(GEOIP_DATABASE_PATH, GEOIP_STANDARD);
    if (!ctx->gi) {
        Warnx(_("geoip_init: GeoIP database not found at %s"), GEOIP_DATABASE_PATH);
        /* Continue without GeoIP - will use default sensor */
    }

    ctx->initialized = 1;

    return ctx;
}

/*
 * Free GeoIP context
 */
void geoip_free(GEOIP_CTX *ctx) {
    if (!ctx)
        return;

    if (ctx->gi) {
        GeoIP_delete((GeoIP*)ctx->gi);
        ctx->gi = NULL;
    }

    free(ctx);
}

/*
 * Lookup country code from IP address
 */
const char* geoip_lookup_country(GEOIP_CTX *ctx, const char *ip) {
    const char *country_code;

    if (!ctx || !ctx->initialized || !ctx->gi || !ip) {
        return NULL;
    }

    /* Lookup country by IP */
    country_code = GeoIP_country_code_by_addr((GeoIP*)ctx->gi, ip);

    return country_code;
}

/*
 * Get sensor ID for a given country code
 */
int geoip_get_sensor_for_country(GEOIP_CTX *ctx, const char *country_code) {
    SQL_RES *res;
    SQL_ROW row;
    char query[512];
    int sensor_id = -1;

    if (!ctx || !ctx->db || !country_code) {
        return -1;
    }

    /* Query geo_country_mapping table */
    snprintf(query, sizeof(query),
        "SELECT sensor_id FROM geo_country_mapping WHERE country_code='%s' LIMIT 1",
        country_code);

    if (!(res = sql_query(ctx->db, query, strlen(query)))) {
        Warnx(_("geoip_get_sensor_for_country: query failed: %s"), query);
        return -1;
    }

    if ((row = sql_getrow(res, NULL))) {
        sensor_id = atoi(row[0]);
    } else {
        sensor_id = 0; /* No mapping */
    }

    sql_free(res);
    return sensor_id;
}

/*
 * Get default sensor ID
 */
int geoip_get_default_sensor(GEOIP_CTX *ctx) {
    SQL_RES *res;
    SQL_ROW row;
    char query[256];
    int sensor_id = -1;

    if (!ctx || !ctx->db) {
        return -1;
    }

    /* Query geo_sensors table for default sensor */
    snprintf(query, sizeof(query),
        "SELECT id FROM geo_sensors WHERE is_default=1 AND is_active=1 LIMIT 1");

    if (!(res = sql_query(ctx->db, query, strlen(query)))) {
        Warnx(_("geoip_get_default_sensor: query failed"));
        return -1;
    }

    if ((row = sql_getrow(res, NULL))) {
        sensor_id = atoi(row[0]);
    } else {
        Warnx(_("No default sensor configured"));
    }

    sql_free(res);
    return sensor_id;
}

/*
 * Check if a zone has GeoIP enabled
 */
int geoip_zone_enabled(GEOIP_CTX *ctx, int zone_id) {
    SQL_RES *res;
    SQL_ROW row;
    char query[256];
    int enabled = 0;

    if (!ctx || !ctx->db || zone_id <= 0) {
        return -1;
    }

    /* Query soa table */
    snprintf(query, sizeof(query),
        "SELECT use_geoip FROM soa WHERE id=%d LIMIT 1", zone_id);

    if (!(res = sql_query(ctx->db, query, strlen(query)))) {
        Warnx(_("geoip_zone_enabled: query failed"));
        return -1;
    }

    if ((row = sql_getrow(res, NULL))) {
        enabled = atoi(row[0]);
    }

    sql_free(res);
    return enabled;
}

/*
 * Get location-specific data for an RR record
 */
char* geoip_get_rr_data(GEOIP_CTX *ctx, int rr_id, int sensor_id) {
    SQL_RES *res;
    SQL_ROW row;
    char query[512];
    char *data = NULL;

    if (!ctx || !ctx->db || rr_id <= 0 || sensor_id <= 0) {
        return NULL;
    }

    /* Query geo_rr table */
    snprintf(query, sizeof(query),
        "SELECT data FROM geo_rr WHERE rr_id=%d AND sensor_id=%d AND is_active=1 LIMIT 1",
        rr_id, sensor_id);

    if (!(res = sql_query(ctx->db, query, strlen(query)))) {
        Warnx(_("geoip_get_rr_data: query failed"));
        return NULL;
    }

    if ((row = sql_getrow(res, NULL))) {
        data = strdup(row[0]);
    } else {
    }

    sql_free(res);
    return data;
}

/*
 * Check if IP matches network (CIDR notation)
 */
static int ip_in_network(const char *ip, const char *network) {
    char network_copy[64];
    char *slash;
    struct in_addr ip_addr, net_addr, mask;
    int prefix_len;

    if (!ip || !network)
        return 0;

    /* Parse network/prefix */
    strncpy(network_copy, network, sizeof(network_copy) - 1);
    network_copy[sizeof(network_copy) - 1] = '\0';

    slash = strchr(network_copy, '/');
    if (!slash)
        return 0; /* Not a CIDR notation */

    *slash = '\0';
    prefix_len = atoi(slash + 1);

    if (prefix_len < 0 || prefix_len > 32)
        return 0;

    /* Convert IP and network to binary */
    if (inet_pton(AF_INET, ip, &ip_addr) != 1)
        return 0;
    if (inet_pton(AF_INET, network_copy, &net_addr) != 1)
        return 0;

    /* Create mask */
    if (prefix_len == 0) {
        mask.s_addr = 0;
    } else {
        mask.s_addr = htonl(~((1 << (32 - prefix_len)) - 1));
    }

    /* Check if IP is in network */
    return (ip_addr.s_addr & mask.s_addr) == (net_addr.s_addr & mask.s_addr);
}

/*
 * Check access control rules
 */
ACCESS_ACTION geoip_check_access(GEOIP_CTX *ctx, const char *ip, int zone_id,
                                  ACCESS_TYPE access_type, char *rule_matched,
                                  size_t rule_matched_size) {
    SQL_RES *res;
    SQL_ROW row;
    char query[1024];
    const char *country_code = NULL;
    int has_whitelist = 0;
    int whitelist_matched = 0;
    int blacklist_matched = 0;
    ACCESS_ACTION action = ACCESS_ALLOWED;

    if (!ctx || !ctx->db || !ip) {
        return ACCESS_ERROR;
    }

    /* Clear rule_matched */
    if (rule_matched && rule_matched_size > 0) {
        rule_matched[0] = '\0';
    }

    /* Lookup country code for IP */
    country_code = geoip_lookup_country(ctx, ip);

    /* First pass: Check if any whitelist rules exist and match */
    snprintf(query, sizeof(query),
        "SELECT rule_name, rule_type, ip_address, ip_network, country_code "
        "FROM access_control_rules "
        "WHERE is_active=1 AND (zone_id IS NULL OR zone_id=%d) "
        "AND (applies_to='both' OR applies_to='%s') "
        "ORDER BY priority ASC",
        zone_id,
        access_type == ACCESS_DNS ? "dns" : "webui");

    if (!(res = sql_query(ctx->db, query, strlen(query)))) {
        Warnx(_("geoip_check_access: query failed"));
        return ACCESS_ERROR;
    }

    while ((row = sql_getrow(res, NULL))) {
        const char *rule_name = row[0];
        const char *rule_type = row[1];
        const char *rule_ip = row[2];
        const char *rule_network = row[3];
        const char *rule_country = row[4];
        int matched = 0;

        /* Check if this is a whitelist rule */
        if (strcmp(rule_type, "whitelist") == 0) {
            has_whitelist = 1;

            /* Check IP exact match */
            if (rule_ip && strcmp(ip, rule_ip) == 0) {
                matched = 1;
            }

            /* Check network match */
            if (!matched && rule_network && ip_in_network(ip, rule_network)) {
                matched = 1;
            }

            /* Check country match */
            if (!matched && rule_country && country_code &&
                strcmp(country_code, rule_country) == 0) {
                matched = 1;
            }

            if (matched) {
                whitelist_matched = 1;
                if (rule_matched && rule_matched_size > 0) {
                    strncpy(rule_matched, rule_name, rule_matched_size - 1);
                    rule_matched[rule_matched_size - 1] = '\0';
                }
                break; /* First match wins */
            }
        }

        /* Check if this is a blacklist rule */
        if (strcmp(rule_type, "blacklist") == 0) {
            /* Check IP exact match */
            if (rule_ip && strcmp(ip, rule_ip) == 0) {
                matched = 1;
            }

            /* Check network match */
            if (!matched && rule_network && ip_in_network(ip, rule_network)) {
                matched = 1;
            }

            /* Check country match */
            if (!matched && rule_country && country_code &&
                strcmp(country_code, rule_country) == 0) {
                matched = 1;
            }

            if (matched) {
                blacklist_matched = 1;
                if (rule_matched && rule_matched_size > 0) {
                    strncpy(rule_matched, rule_name, rule_matched_size - 1);
                    rule_matched[rule_matched_size - 1] = '\0';
                }
                break; /* First match wins */
            }
        }
    }

    sql_free(res);

    /* Determine final action */
    if (has_whitelist) {
        /* If whitelist rules exist, IP must match one */
        action = whitelist_matched ? ACCESS_ALLOWED : ACCESS_BLOCKED;
    } else if (blacklist_matched) {
        /* If no whitelist but blacklist matched */
        action = ACCESS_BLOCKED;
    } else {
        /* No rules matched, allow by default */
        action = ACCESS_ALLOWED;
    }

    return action;
}

/*
 * Log access control event
 */
int geoip_log_access(GEOIP_CTX *ctx, const char *ip, const char *country_code,
                     int zone_id, const char *query_name, ACCESS_TYPE access_type,
                     ACCESS_ACTION action, const char *rule_matched) {
    char query[2048];
    char *escaped_ip;
    char *escaped_country;
    char *escaped_query;
    char *escaped_rule;
    SQL_RES *res;

    if (!ctx || !ctx->db || !ip) {
        return -1;
    }

    /* Escape values */
    escaped_ip = sql_escstr(ctx->db, (char*)ip);
    escaped_country = sql_escstr(ctx->db, (char*)(country_code ? country_code : ""));
    escaped_query = sql_escstr(ctx->db, (char*)(query_name ? query_name : ""));
    escaped_rule = sql_escstr(ctx->db, (char*)(rule_matched ? rule_matched : ""));

    /* Insert log entry */
    snprintf(query, sizeof(query),
        "INSERT INTO access_control_log "
        "(source_ip, country_code, access_type, zone_id, query_name, action, rule_matched) "
        "VALUES ('%s', '%s', '%s', %d, '%s', '%s', '%s')",
        escaped_ip,
        escaped_country,
        access_type == ACCESS_DNS ? "dns" : "webui",
        zone_id > 0 ? zone_id : 0,
        escaped_query,
        action == ACCESS_ALLOWED ? "allowed" : "blocked",
        escaped_rule);

    /* Free escaped strings */
    RELEASE(escaped_ip);
    RELEASE(escaped_country);
    RELEASE(escaped_query);
    RELEASE(escaped_rule);

    /* Execute INSERT - no result expected */
    res = sql_query(ctx->db, query, strlen(query));
    if (res) {
        sql_free(res);
    }

    return 0;
}

/*
 * Get sensor information
 */
int geoip_get_sensor_info(GEOIP_CTX *ctx, int sensor_id, char *location_name,
                          size_t name_size, char *location_code, size_t code_size) {
    SQL_RES *res;
    SQL_ROW row;
    char query[256];

    if (!ctx || !ctx->db || sensor_id <= 0 || !location_name || !location_code) {
        return -1;
    }

    location_name[0] = '\0';
    location_code[0] = '\0';

    /* Query geo_sensors table */
    snprintf(query, sizeof(query),
        "SELECT location_name, location_code FROM geo_sensors WHERE id=%d LIMIT 1",
        sensor_id);

    if (!(res = sql_query(ctx->db, query, strlen(query)))) {
        Warnx(_("geoip_get_sensor_info: query failed"));
        return -1;
    }

    if ((row = sql_getrow(res, NULL))) {
        strncpy(location_name, row[0], name_size - 1);
        location_name[name_size - 1] = '\0';
        strncpy(location_code, row[1], code_size - 1);
        location_code[code_size - 1] = '\0';
    }

    sql_free(res);
    return 0;
}
