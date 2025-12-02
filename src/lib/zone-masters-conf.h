/*
 * zone-masters-conf.h - Zone Masters Configuration File Parser
 * Date: 2025-11-28
 *
 * Parses /etc/mydns/zone-masters.conf for MySQL-free slave configuration
 */

#ifndef _MYDNS_ZONE_MASTERS_CONF_H
#define _MYDNS_ZONE_MASTERS_CONF_H

#include "mydns.h"

/* Default configuration file path */
#define ZONE_MASTERS_CONF_PATH "/etc/mydns/zone-masters.conf"

/* Maximum limits */
#define ZM_MAX_MASTERS 100
#define ZM_MAX_ZONES_PER_MASTER 1000
#define ZM_MAX_LINE 1024
#define ZM_MAX_NAME 256
#define ZM_MAX_HOST 256
#define ZM_MAX_ZONES_TOTAL 10000

/* Zone entry in configuration */
typedef struct zm_zone {
    char name[ZM_MAX_NAME];           /* Zone name (e.g., "example.com") */
    struct zm_zone *next;             /* Linked list */
} zm_zone_t;

/* Master server configuration */
typedef struct zm_master {
    char name[ZM_MAX_NAME];           /* Master name (e.g., "bind-primary") */
    char host[ZM_MAX_HOST];           /* IP address or hostname */
    int port;                         /* Port number (default: 53) */

    /* TSIG authentication (optional) */
    char tsig_key_name[ZM_MAX_NAME];  /* TSIG key name */
    char tsig_algorithm[64];          /* TSIG algorithm (e.g., "hmac-sha256") */
    char tsig_secret[256];            /* Base64-encoded secret */
    int has_tsig;                     /* 1 if TSIG configured */

    zm_zone_t *zones;                 /* Linked list of zones */
    int zone_count;                   /* Number of zones */

    struct zm_master *next;           /* Linked list */
} zm_master_t;

/* Global transfer settings */
typedef struct zm_settings {
    int transfer_interval;            /* Check interval (seconds) */
    int transfer_timeout;             /* Transfer timeout (seconds) */
    int max_retries;                  /* Maximum retry attempts */
    int retry_delay;                  /* Delay between retries (seconds) */
} zm_settings_t;

/* Zone masters configuration context */
typedef struct zm_config {
    zm_master_t *masters;             /* Linked list of masters */
    int master_count;                 /* Number of masters */
    int total_zones;                  /* Total zones across all masters */
    zm_settings_t settings;           /* Global settings */
    char config_path[512];            /* Path to config file */
    time_t loaded;                    /* When config was loaded */
} zm_config_t;

/* Function prototypes */

/**
 * Load zone masters configuration from file
 *
 * @param config_path Path to configuration file (NULL = default)
 * @return Configuration context on success, NULL on error
 */
zm_config_t *zm_load_config(const char *config_path);

/**
 * Free zone masters configuration
 *
 * @param config Configuration context to free
 */
void zm_free_config(zm_config_t *config);

/**
 * Check if configuration file exists
 *
 * @param config_path Path to check (NULL = default)
 * @return 1 if exists and readable, 0 otherwise
 */
int zm_config_exists(const char *config_path);

/**
 * Get master by name
 *
 * @param config Configuration context
 * @param name Master name
 * @return Master pointer on success, NULL if not found
 */
zm_master_t *zm_get_master(zm_config_t *config, const char *name);

/**
 * Find master serving a specific zone
 *
 * @param config Configuration context
 * @param zone_name Zone name to find
 * @param master_name Output: master name (can be NULL)
 * @return Master pointer on success, NULL if not found
 */
zm_master_t *zm_find_zone_master(zm_config_t *config, const char *zone_name,
                                  char *master_name);

/**
 * Get list of all zones from all masters
 *
 * @param config Configuration context
 * @param zones Output array of zone names
 * @param max_zones Maximum zones to return
 * @return Number of zones found
 */
int zm_get_all_zones(zm_config_t *config, char zones[][ZM_MAX_NAME], int max_zones);

/**
 * Print configuration summary (for debugging)
 *
 * @param config Configuration context
 */
void zm_print_config(zm_config_t *config);

#endif /* _MYDNS_ZONE_MASTERS_CONF_H */
