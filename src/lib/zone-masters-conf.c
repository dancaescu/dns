/*
 * zone-masters-conf.c - Zone Masters Configuration File Parser
 * Date: 2025-11-28
 *
 * Parses /etc/mydns/zone-masters.conf for MySQL-free slave configuration
 */

#include "mydns.h"
#include "zone-masters-conf.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include <sys/stat.h>

/* Trim whitespace from string */
static char *trim(char *str) {
    char *end;

    /* Trim leading space */
    while (isspace((unsigned char)*str)) str++;

    if (*str == 0) return str;

    /* Trim trailing space */
    end = str + strlen(str) - 1;
    while (end > str && isspace((unsigned char)*end)) end--;

    /* Write new null terminator */
    end[1] = '\0';

    return str;
}

/* Check if line is a comment or empty */
static int is_comment_or_empty(const char *line) {
    while (*line && isspace((unsigned char)*line)) line++;
    return (*line == '#' || *line == '\0');
}

/* Parse key-value pair */
static int parse_keyval(const char *line, char *key, char *value) {
    const char *p = line;
    char *k = key;
    char *v = value;

    /* Skip leading whitespace */
    while (*p && isspace((unsigned char)*p)) p++;

    /* Read key */
    while (*p && !isspace((unsigned char)*p) && *p != '{' && *p != '}') {
        *k++ = *p++;
    }
    *k = '\0';

    /* Skip whitespace */
    while (*p && isspace((unsigned char)*p)) p++;

    /* Read value (rest of line, minus trailing whitespace and {) */
    while (*p && *p != '{' && *p != '}' && *p != '#') {
        *v++ = *p++;
    }
    *v = '\0';

    /* Trim value */
    v = trim(value);
    memmove(value, v, strlen(v) + 1);

    return (strlen(key) > 0);
}

/**
 * Check if configuration file exists
 */
int zm_config_exists(const char *config_path) {
    struct stat st;
    const char *path = config_path ? config_path : ZONE_MASTERS_CONF_PATH;

    if (stat(path, &st) == 0 && S_ISREG(st.st_mode)) {
        /* Check if readable */
        FILE *f = fopen(path, "r");
        if (f) {
            fclose(f);
            return 1;
        }
    }

    return 0;
}

/**
 * Load zone masters configuration from file
 */
zm_config_t *zm_load_config(const char *config_path) {
    FILE *f;
    char line[ZM_MAX_LINE];
    zm_config_t *config;
    zm_master_t *current_master = NULL;
    int in_master_block = 0;
    int in_zones_block = 0;
    int line_num = 0;

    /* Use default path if not specified */
    const char *path = config_path ? config_path : ZONE_MASTERS_CONF_PATH;

    /* Open configuration file */
    f = fopen(path, "r");
    if (!f) {
        return NULL;
    }

    /* Allocate configuration context */
    config = (zm_config_t *)calloc(1, sizeof(zm_config_t));
    if (!config) {
        fclose(f);
        return NULL;
    }

    /* Set defaults */
    strncpy(config->config_path, path, sizeof(config->config_path) - 1);
    config->settings.transfer_interval = 3600;
    config->settings.transfer_timeout = 300;
    config->settings.max_retries = 3;
    config->settings.retry_delay = 300;
    config->loaded = time(NULL);

    /* Parse file line by line */
    while (fgets(line, sizeof(line), f)) {
        char key[256], value[512];
        char *trimmed;

        line_num++;
        trimmed = trim(line);

        /* Skip comments and empty lines */
        if (is_comment_or_empty(trimmed)) {
            continue;
        }

        /* Parse key-value */
        if (!parse_keyval(trimmed, key, value)) {
            continue;
        }

        /* Check for block end */
        if (strcmp(key, "}") == 0) {
            if (in_zones_block) {
                in_zones_block = 0;
            } else if (in_master_block) {
                in_master_block = 0;
                current_master = NULL;
            }
            continue;
        }

        /* Global settings */
        if (!in_master_block && !in_zones_block) {
            if (strcmp(key, "transfer_interval") == 0) {
                config->settings.transfer_interval = atoi(value);
            } else if (strcmp(key, "transfer_timeout") == 0) {
                config->settings.transfer_timeout = atoi(value);
            } else if (strcmp(key, "max_retries") == 0) {
                config->settings.max_retries = atoi(value);
            } else if (strcmp(key, "retry_delay") == 0) {
                config->settings.retry_delay = atoi(value);
            } else if (strcmp(key, "master") == 0) {
                /* Start new master block */
                zm_master_t *master = (zm_master_t *)calloc(1, sizeof(zm_master_t));
                if (master) {
                    strncpy(master->name, value, sizeof(master->name) - 1);
                    master->port = 53;  /* Default port */

                    /* Add to list */
                    master->next = config->masters;
                    config->masters = master;
                    config->master_count++;

                    current_master = master;
                    in_master_block = 1;
                }
            }
            continue;
        }

        /* Inside zones block */
        if (in_zones_block && current_master) {
            /* Each line is a zone name */
            zm_zone_t *zone = (zm_zone_t *)calloc(1, sizeof(zm_zone_t));
            if (zone) {
                strncpy(zone->name, key, sizeof(zone->name) - 1);

                /* Add dot if missing */
                size_t len = strlen(zone->name);
                if (len > 0 && zone->name[len - 1] != '.') {
                    if (len < sizeof(zone->name) - 1) {
                        zone->name[len] = '.';
                        zone->name[len + 1] = '\0';
                    }
                }

                /* Add to master's zone list */
                zone->next = current_master->zones;
                current_master->zones = zone;
                current_master->zone_count++;
                config->total_zones++;
            }
            continue;
        }

        /* Inside master block */
        if (in_master_block && current_master) {
            if (strcmp(key, "host") == 0) {
                strncpy(current_master->host, value, sizeof(current_master->host) - 1);
            } else if (strcmp(key, "port") == 0) {
                current_master->port = atoi(value);
            } else if (strcmp(key, "tsig_key") == 0) {
                /* Format: tsig_key <name> <algorithm> <secret> */
                char *name = strtok(value, " \t");
                char *algo = strtok(NULL, " \t");
                char *secret = strtok(NULL, " \t");

                if (name && algo && secret) {
                    strncpy(current_master->tsig_key_name, name,
                            sizeof(current_master->tsig_key_name) - 1);
                    strncpy(current_master->tsig_algorithm, algo,
                            sizeof(current_master->tsig_algorithm) - 1);
                    strncpy(current_master->tsig_secret, secret,
                            sizeof(current_master->tsig_secret) - 1);
                    current_master->has_tsig = 1;
                }
            } else if (strcmp(key, "zones") == 0) {
                /* Start zones block */
                in_zones_block = 1;
            }
        }
    }

    fclose(f);

    /* Validate configuration */
    if (config->master_count == 0) {
        Warnx(_("No masters defined in %s"), path);
        zm_free_config(config);
        return NULL;
    }

    Notice(_("Loaded %d masters with %d total zones from %s"),
           config->master_count, config->total_zones, path);

    return config;
}

/**
 * Free zone masters configuration
 */
void zm_free_config(zm_config_t *config) {
    if (!config) return;

    /* Free all masters and their zones */
    zm_master_t *master = config->masters;
    while (master) {
        zm_master_t *next_master = master->next;

        /* Free zones */
        zm_zone_t *zone = master->zones;
        while (zone) {
            zm_zone_t *next_zone = zone->next;
            free(zone);
            zone = next_zone;
        }

        free(master);
        master = next_master;
    }

    free(config);
}

/**
 * Get master by name
 */
zm_master_t *zm_get_master(zm_config_t *config, const char *name) {
    if (!config || !name) return NULL;

    zm_master_t *master = config->masters;
    while (master) {
        if (strcmp(master->name, name) == 0) {
            return master;
        }
        master = master->next;
    }

    return NULL;
}

/**
 * Find master serving a specific zone
 */
zm_master_t *zm_find_zone_master(zm_config_t *config, const char *zone_name,
                                  char *master_name) {
    if (!config || !zone_name) return NULL;

    zm_master_t *master = config->masters;
    while (master) {
        zm_zone_t *zone = master->zones;
        while (zone) {
            if (strcasecmp(zone->name, zone_name) == 0) {
                if (master_name) {
                    strcpy(master_name, master->name);
                }
                return master;
            }
            zone = zone->next;
        }
        master = master->next;
    }

    return NULL;
}

/**
 * Get list of all zones from all masters
 */
int zm_get_all_zones(zm_config_t *config, char zones[][ZM_MAX_NAME], int max_zones) {
    if (!config || !zones) return 0;

    int count = 0;
    zm_master_t *master = config->masters;

    while (master && count < max_zones) {
        zm_zone_t *zone = master->zones;
        while (zone && count < max_zones) {
            strncpy(zones[count], zone->name, ZM_MAX_NAME - 1);
            zones[count][ZM_MAX_NAME - 1] = '\0';
            count++;
            zone = zone->next;
        }
        master = master->next;
    }

    return count;
}

/**
 * Print configuration summary (for debugging)
 */
void zm_print_config(zm_config_t *config) {
    if (!config) return;

    Notice(_("Zone Masters Configuration:"));
    Notice(_("  Config file: %s"), config->config_path);
    Notice(_("  Masters: %d"), config->master_count);
    Notice(_("  Total zones: %d"), config->total_zones);
    Notice(_("  Transfer interval: %d seconds"), config->settings.transfer_interval);
    Notice(_("  Transfer timeout: %d seconds"), config->settings.transfer_timeout);

    zm_master_t *master = config->masters;
    while (master) {
        Notice(_("  Master '%s': %s:%d (%d zones)"),
               master->name, master->host, master->port, master->zone_count);

        if (master->has_tsig) {
            Notice(_("    TSIG: %s (%s)"),
                   master->tsig_key_name, master->tsig_algorithm);
        }

        zm_zone_t *zone = master->zones;
        int shown = 0;
        while (zone && shown < 5) {
            Notice(_("      - %s"), zone->name);
            zone = zone->next;
            shown++;
        }
        if (master->zone_count > 5) {
            Notice(_("      ... and %d more zones"), master->zone_count - 5);
        }

        master = master->next;
    }
}

/* vim:set ts=4 sw=4: */
