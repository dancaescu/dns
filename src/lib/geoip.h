/*
 * geoip.h - Geographic IP lookup and access control
 * Date: 2025-11-25
 *
 * Provides GeoIP functionality for MyDNS to:
 * - Lookup requester country/continent from IP address
 * - Map countries to sensor locations
 * - Check access control rules (whitelist/blacklist)
 * - Return location-specific DNS records
 */

#ifndef _MYDNS_GEOIP_H
#define _MYDNS_GEOIP_H

#include "mydns.h"

/* GeoIP context structure */
typedef struct {
    void *gi;              /* GeoIP handle (GeoIP*) */
    SQL *db;               /* Database connection */
    int initialized;       /* Initialization flag */
} GEOIP_CTX;

/* Access control action */
typedef enum {
    ACCESS_ALLOWED = 0,
    ACCESS_BLOCKED = 1,
    ACCESS_ERROR = -1
} ACCESS_ACTION;

/* Access control context */
typedef enum {
    ACCESS_DNS = 1,
    ACCESS_WEBUI = 2,
    ACCESS_BOTH = 3
} ACCESS_TYPE;

/*
 * Initialize GeoIP context
 * Returns: GEOIP_CTX* on success, NULL on failure
 */
GEOIP_CTX* geoip_init(SQL *db);

/*
 * Free GeoIP context
 */
void geoip_free(GEOIP_CTX *ctx);

/*
 * Lookup country code from IP address
 * Returns: 2-letter ISO country code (e.g., "US", "GB") or NULL on failure
 * Note: Returned string is statically allocated, copy if needed
 */
const char* geoip_lookup_country(GEOIP_CTX *ctx, const char *ip);

/*
 * Get sensor ID for a given country code
 * Returns: sensor_id on success, -1 on failure, 0 if no mapping exists
 */
int geoip_get_sensor_for_country(GEOIP_CTX *ctx, const char *country_code);

/*
 * Get default sensor ID (fallback)
 * Returns: sensor_id on success, -1 on failure
 */
int geoip_get_default_sensor(GEOIP_CTX *ctx);

/*
 * Check if a zone has GeoIP enabled
 * Returns: 1 if enabled, 0 if disabled, -1 on error
 */
int geoip_zone_enabled(GEOIP_CTX *ctx, int zone_id);

/*
 * Get location-specific data for an RR record
 * Returns: data string on success, NULL if no geo data or on failure
 * Note: Caller must free returned string with free()
 */
char* geoip_get_rr_data(GEOIP_CTX *ctx, int rr_id, int sensor_id);

/*
 * Check access control rules
 * Returns: ACCESS_ALLOWED, ACCESS_BLOCKED, or ACCESS_ERROR
 * Parameters:
 *   - ip: Client IP address
 *   - zone_id: Zone ID (0 for global rules)
 *   - access_type: ACCESS_DNS or ACCESS_WEBUI
 *   - rule_matched: Output buffer for matched rule name (optional, NULL allowed)
 *   - rule_matched_size: Size of rule_matched buffer
 */
ACCESS_ACTION geoip_check_access(GEOIP_CTX *ctx, const char *ip, int zone_id,
                                  ACCESS_TYPE access_type, char *rule_matched,
                                  size_t rule_matched_size);

/*
 * Log access control event
 * Returns: 0 on success, -1 on failure
 */
int geoip_log_access(GEOIP_CTX *ctx, const char *ip, const char *country_code,
                     int zone_id, const char *query_name, ACCESS_TYPE access_type,
                     ACCESS_ACTION action, const char *rule_matched);

/*
 * Get sensor information (for debugging/logging)
 * Returns: 0 on success, -1 on failure
 * Output: location_name and location_code buffers populated
 */
int geoip_get_sensor_info(GEOIP_CTX *ctx, int sensor_id, char *location_name,
                          size_t name_size, char *location_code, size_t code_size);

#endif /* _MYDNS_GEOIP_H */
