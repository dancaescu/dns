/*
 * xfer.c - MyDNS Zone Transfer Daemon (mydns-xfer)
 * Date: 2025-11-26
 *
 * Daemon that performs zone transfers from master DNS servers,
 * allowing MyDNS to act as an AXFR slave.
 *
 * Usage:
 *   mydns-xfer [-c config] [-d] [-f] [-z zone_id]
 *
 * Options:
 *   -c config   Configuration file (default: /etc/mydns.conf)
 *   -d          Daemon mode (run continuously)
 *   -f          Foreground mode (don't daemonize)
 *   -z zone_id  Transfer only specific zone
 *   -h          Show help
 */

#include "mydns.h"
#include "mydnsutil.h"
#include "../lib/axfr.h"
#include "../lib/memzone.h"
#include <signal.h>
#include <sys/stat.h>
#include <unistd.h>

/* Global variables */
memzone_ctx_t *Memzone = NULL;  /* In-memory zone storage */
static int running = 1;
static int daemon_mode = 0;
static int foreground = 0;
static int specific_zone = 0;
static char *config_file = "/etc/mydns.conf";

/* Signal handler */
static void signal_handler(int sig) {
    if (sig == SIGTERM || sig == SIGINT) {
        Warnx(_("Received signal %d, shutting down..."), sig);
        running = 0;
    } else if (sig == SIGHUP) {
        Warnx(_("Received SIGHUP, reloading configuration..."));
        /* TODO: Reload configuration */
    }
}

/* Daemonize process */
static int daemonize(void) {
    pid_t pid;

    /* Fork parent process */
    pid = fork();
    if (pid < 0) {
        Err(_("fork() failed"));
        return -1;
    }

    /* Exit parent */
    if (pid > 0) {
        exit(0);
    }

    /* Create new session */
    if (setsid() < 0) {
        Err(_("setsid() failed"));
        return -1;
    }

    /* Fork again */
    pid = fork();
    if (pid < 0) {
        Err(_("fork() failed"));
        return -1;
    }

    /* Exit first child */
    if (pid > 0) {
        exit(0);
    }

    /* Change working directory */
    if (chdir("/") < 0) {
        Err(_("chdir() failed"));
        return -1;
    }

    /* Close standard file descriptors */
    close(STDIN_FILENO);
    close(STDOUT_FILENO);
    close(STDERR_FILENO);

    return 0;
}

/* Transfer single zone */
static int transfer_zone(SQL *db, axfr_zone_t *zone) {
    axfr_result_t result;
    int ret;

    Notice(_("Starting zone transfer: %s from %s:%d"),
           zone->zone_name, zone->master_host, zone->master_port);

    ret = axfr_transfer_zone(db, zone, &result);

    if (ret == 0 && result.status == AXFR_SUCCESS) {
        Notice(_("Zone transfer completed: %s - %d records in %ld seconds"),
               zone->zone_name, result.records_added, result.transfer_time);
    } else {
        Warnx(_("Zone transfer failed: %s - %s"),
              zone->zone_name,
              result.error_message ? result.error_message : "Unknown error");
    }

    /* Log transfer result */
    axfr_log_transfer(db, zone, &result);

    /* Update last_transfer timestamp */
    if (result.status == AXFR_SUCCESS) {
        char query[256];
        snprintf(query, sizeof(query),
            "UPDATE zone_masters SET last_transfer = NOW(), transfer_failures = 0 "
            "WHERE zone_id = %d", zone->zone_id);
        sql_query(db, query, strlen(query));
    } else {
        char query[256];
        snprintf(query, sizeof(query),
            "UPDATE zone_masters SET transfer_failures = transfer_failures + 1 "
            "WHERE zone_id = %d", zone->zone_id);
        sql_query(db, query, strlen(query));
    }

    /* Free error message */
    if (result.error_message) {
        free(result.error_message);
    }

    return ret;
}

/* Transfer all configured zones */
static int transfer_all_zones(SQL *db) {
    axfr_zone_t *zones = NULL;
    int zone_count = 0;
    int success_count = 0;
    int i;

    /* Load zone configurations */
    if (axfr_load_zones(db, specific_zone, &zones, &zone_count) < 0) {
        Warnx(_("Failed to load zone configurations"));
        return -1;
    }

    if (zone_count == 0) {
        Notice(_("No zones configured for transfer"));
        return 0;
    }

    Notice(_("Found %d zone(s) to transfer"), zone_count);

    /* Transfer each zone */
    for (i = 0; i < zone_count; i++) {
        /* Check if we should still be running */
        if (!running) {
            break;
        }

        /* Check if zone needs transfer (based on SOA serial) */
        if (axfr_check_serial(&zones[i]) < 0) {
            Warnx(_("Failed to check serial for zone: %s"), zones[i].zone_name);
            continue;
        }

        /* Perform transfer */
        if (transfer_zone(db, &zones[i]) == 0) {
            success_count++;
        }

        /* Update last_check timestamp */
        char query[256];
        snprintf(query, sizeof(query),
            "UPDATE zone_masters SET last_check = NOW() WHERE zone_id = %d",
            zones[i].zone_id);
        sql_query(db, query, strlen(query));

        /* Free zone data */
        axfr_free_zone(&zones[i]);
    }

    free(zones);

    Notice(_("Zone transfer cycle completed: %d/%d successful"), success_count, zone_count);

    return 0;
}

/* Main transfer loop */
static int transfer_loop(SQL *db) {
    int check_interval = 300;  /* 5 minutes default */

    while (running) {
        /* Perform transfers */
        transfer_all_zones(db);

        /* If not in daemon mode, exit after one cycle */
        if (!daemon_mode) {
            break;
        }

        /* Sleep between cycles */
        Notice(_("Sleeping %d seconds until next check..."), check_interval);
        for (int i = 0; i < check_interval && running; i++) {
            sleep(1);
        }
    }

    return 0;
}

/* Usage */
static void usage(void) {
    printf("Usage: mydns-xfer [OPTIONS]\n");
    printf("\n");
    printf("Options:\n");
    printf("  -c FILE     Configuration file (default: /etc/mydns.conf)\n");
    printf("  -d          Daemon mode (run continuously)\n");
    printf("  -f          Foreground mode (don't daemonize)\n");
    printf("  -z ZONE_ID  Transfer only specific zone\n");
    printf("  -h          Show this help\n");
    printf("  -v          Show version\n");
    printf("\n");
    printf("Examples:\n");
    printf("  mydns-xfer              # Transfer all zones once\n");
    printf("  mydns-xfer -d           # Run as daemon\n");
    printf("  mydns-xfer -z 123       # Transfer only zone 123\n");
    printf("\n");
}

/* Main */
int main(int argc, char **argv) {
    SQL *db = NULL;
    int opt;

    /* Parse command line options */
    while ((opt = getopt(argc, argv, "c:dfz:hv")) != -1) {
        switch (opt) {
            case 'c':
                config_file = optarg;
                break;
            case 'd':
                daemon_mode = 1;
                break;
            case 'f':
                foreground = 1;
                break;
            case 'z':
                specific_zone = atoi(optarg);
                break;
            case 'h':
                usage();
                exit(0);
            case 'v':
                printf("mydns-xfer %s\n", PACKAGE_VERSION);
                exit(0);
            default:
                usage();
                exit(1);
        }
    }

    /* Load configuration */
    if (load_config() < 0) {
        Err(_("Failed to load configuration from %s"), config_file);
    }

    /* Set up signal handlers */
    signal(SIGTERM, signal_handler);
    signal(SIGINT, signal_handler);
    signal(SIGHUP, signal_handler);

    /* Initialize AXFR module */
    if (axfr_init() < 0) {
        Err(_("Failed to initialize AXFR module"));
    }

    /* Initialize in-memory zone storage (create new shared memory) */
    Notice(_("Initializing memzone..."));
    Memzone = memzone_init(1);  /* 1 = create new shared memory */
    if (!Memzone) {
        Err(_("Failed to initialize memzone - cannot run as AXFR transfer daemon"));
    }
    Notice(_("Memzone initialized successfully"));

    /* Connect to database */
    db = sql_open(SQL_ZERO_IS_NULL);
    if (!db) {
        Err(_("Failed to connect to database"));
    }

    /* Load ACL rules from database into memzone */
    int acl_count = memzone_load_acl_from_db(Memzone, db);
    Notice(_("Loaded %d ACL rules into memzone"), acl_count);

    Notice(_("mydns-xfer starting (version %s)"), PACKAGE_VERSION);
    if (daemon_mode) {
        Notice(_("Running in daemon mode"));
    }
    if (specific_zone) {
        Notice(_("Transferring only zone %d"), specific_zone);
    }

    /* Daemonize if requested */
    if (daemon_mode && !foreground) {
        Notice(_("Daemonizing..."));
        if (daemonize() < 0) {
            Err(_("Failed to daemonize"));
        }
    }

    /* Run transfer loop */
    transfer_loop(db);

    /* Cleanup */
    Notice(_("mydns-xfer shutting down"));

    if (Memzone) {
        memzone_free(Memzone);
        Memzone = NULL;
    }

    axfr_free();
    sql_close(db);

    return 0;
}
