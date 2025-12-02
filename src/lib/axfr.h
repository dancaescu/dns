/*
 * axfr.h - AXFR (Zone Transfer) client implementation
 * Date: 2025-11-26
 *
 * This module implements AXFR client functionality, allowing MyDNS
 * to act as a slave server receiving zone transfers from master servers.
 */

#ifndef _MYDNS_AXFR_H
#define _MYDNS_AXFR_H

#include "mydns.h"
#include "memzone.h"

/* AXFR transfer status */
typedef enum {
    AXFR_SUCCESS = 0,
    AXFR_ERROR = -1,
    AXFR_NETWORK_ERROR = -2,
    AXFR_PARSE_ERROR = -3,
    AXFR_DATABASE_ERROR = -4,
    AXFR_AUTH_ERROR = -5,
    AXFR_TIMEOUT = -6,
    AXFR_NOT_AUTHORITATIVE = -7,
    AXFR_SERIAL_NOT_NEWER = -8
} axfr_status_t;

/* Zone master configuration */
typedef struct {
    int zone_id;                 /* Zone ID in soa table */
    char *zone_name;             /* Zone name (e.g., example.com) */
    char *master_host;           /* Master server hostname/IP */
    int master_port;             /* Master server port (default 53) */
    uint32_t current_serial;     /* Current SOA serial in database */
    uint32_t master_serial;      /* Master's SOA serial */
    time_t last_check;           /* Last SOA check time */
    time_t last_transfer;        /* Last successful transfer time */
    int transfer_failures;       /* Consecutive transfer failures */
    char *tsig_key_name;         /* TSIG key name (optional) */
    char *tsig_key_secret;       /* TSIG key secret (optional) */
    char *tsig_algorithm;        /* TSIG algorithm (optional) */
} axfr_zone_t;

/* AXFR transfer record */
typedef struct axfr_record {
    char *name;                  /* Record name */
    char *type;                  /* Record type (A, AAAA, MX, etc.) */
    uint32_t ttl;                /* TTL */
    char *data;                  /* Record data */
    uint16_t aux;                /* Auxiliary data (priority, weight, etc.) */
    struct axfr_record *next;    /* Next record in linked list */
} axfr_record_t;

/* AXFR transfer result */
typedef struct {
    axfr_status_t status;        /* Transfer status */
    int records_received;        /* Number of records received */
    int records_added;           /* Number of records added to database */
    int records_updated;         /* Number of records updated */
    int records_deleted;         /* Number of records deleted */
    uint32_t new_serial;         /* New SOA serial number */
    char *error_message;         /* Error message (if status != SUCCESS) */
    time_t transfer_time;        /* Transfer duration in seconds */
} axfr_result_t;

/* Function prototypes */

/**
 * Initialize AXFR module
 */
int axfr_init(void);

/**
 * Free AXFR module resources
 */
void axfr_free(void);

/**
 * Load zone master configuration from database
 *
 * @param db Database connection
 * @param zone_id Zone ID (0 for all zones)
 * @param zones Output array of zone configurations
 * @param count Output number of zones
 * @return 0 on success, -1 on error
 */
int axfr_load_zones(SQL *db, int zone_id, axfr_zone_t **zones, int *count);

/**
 * Load zone masters with priority: config file first, then database
 * This is the recommended entry point for zone loading
 *
 * Priority:
 * 1. If /etc/mydns/zone-masters.conf exists → load from config (MySQL-free)
 * 2. If config doesn't exist → load from database (traditional)
 * 3. If both fail → return error
 *
 * @param db Database connection (can be NULL if config file exists)
 * @param zone_id Zone ID (0 for all zones, specific zone filtering only works with database)
 * @param zones Output array of zone configurations
 * @param count Output number of zones
 * @return 0 on success, -1 on error
 */
int axfr_load_zones_auto(SQL *db, int zone_id, axfr_zone_t **zones, int *count);

/**
 * Free zone configuration
 */
void axfr_free_zone(axfr_zone_t *zone);

/**
 * Check SOA serial on master server
 *
 * @param zone Zone configuration
 * @return 0 on success, -1 on error
 */
int axfr_check_serial(axfr_zone_t *zone);

/**
 * Perform AXFR transfer from master server
 *
 * @param db Database connection
 * @param zone Zone configuration
 * @param result Output transfer result
 * @return 0 on success, -1 on error
 */
int axfr_transfer_zone(SQL *db, axfr_zone_t *zone, axfr_result_t *result);

/**
 * Update database with transferred zone data
 *
 * @param db Database connection
 * @param zone Zone configuration
 * @param records Linked list of records
 * @param result Output result
 * @return 0 on success, -1 on error
 */
int axfr_update_database(SQL *db, axfr_zone_t *zone, axfr_record_t *records, axfr_result_t *result);

/**
 * Update memzone with transferred zone data
 *
 * @param ctx Memzone context
 * @param zone Zone configuration
 * @param records Linked list of records
 * @param result Output result
 * @return 0 on success, -1 on error
 */
int axfr_update_memzone(memzone_ctx_t *ctx, axfr_zone_t *zone, axfr_record_t *records, axfr_result_t *result);

/**
 * Free record list
 */
void axfr_free_records(axfr_record_t *records);

/**
 * Parse AXFR response
 *
 * @param response DNS response buffer
 * @param length Response length
 * @param records Output linked list of records
 * @return Number of records parsed, -1 on error
 */
int axfr_parse_response(const unsigned char *response, size_t length, axfr_record_t **records);

/**
 * Create AXFR query packet
 *
 * @param zone_name Zone name
 * @param query_id Query ID
 * @param buffer Output buffer
 * @param buffer_size Buffer size
 * @return Query packet size, -1 on error
 */
int axfr_create_query(const char *zone_name, uint16_t query_id, unsigned char *buffer, size_t buffer_size);

/**
 * Connect to master server via TCP
 *
 * @param host Master server hostname/IP
 * @param port Master server port
 * @param timeout Connection timeout in seconds
 * @return Socket descriptor on success, -1 on error
 */
int axfr_connect_master(const char *host, int port, int timeout);

/**
 * Send AXFR query over TCP
 *
 * @param sockfd Socket descriptor
 * @param query Query packet
 * @param query_size Query packet size
 * @return 0 on success, -1 on error
 */
int axfr_send_query(int sockfd, const unsigned char *query, size_t query_size);

/**
 * Receive AXFR response over TCP
 *
 * @param sockfd Socket descriptor
 * @param response Output buffer
 * @param buffer_size Buffer size
 * @param timeout Receive timeout in seconds
 * @return Number of bytes received, -1 on error
 */
int axfr_receive_response(int sockfd, unsigned char *response, size_t buffer_size, int timeout);

/**
 * Log transfer result
 *
 * @param db Database connection
 * @param zone Zone configuration
 * @param result Transfer result
 */
void axfr_log_transfer(SQL *db, axfr_zone_t *zone, axfr_result_t *result);

/* NOTIFY protocol support (RFC 1996) */

/**
 * Create UDP socket for receiving NOTIFY messages
 *
 * @param port Port to bind to (typically 53)
 * @return Socket descriptor on success, -1 on error
 */
int axfr_notify_listen(int port);

/**
 * Parse NOTIFY message and extract zone name
 *
 * @param message NOTIFY message buffer
 * @param length Message length
 * @param zone_name Output buffer for zone name
 * @param zone_name_size Size of zone_name buffer
 * @param query_id Output query ID for response
 * @return 0 on success, -1 on error
 */
int axfr_notify_parse(const unsigned char *message, size_t length,
                      char *zone_name, size_t zone_name_size, uint16_t *query_id);

/**
 * Send NOTIFY response
 *
 * @param sockfd Socket descriptor
 * @param query_id Query ID from NOTIFY request
 * @param zone_name Zone name
 * @param addr Source address to reply to
 * @param addrlen Address length
 * @return 0 on success, -1 on error
 */
int axfr_notify_respond(int sockfd, uint16_t query_id, const char *zone_name,
                        struct sockaddr *addr, socklen_t addrlen);

/**
 * Process received NOTIFY message
 * Validates source, checks zone configuration, triggers transfer if needed
 *
 * @param db Database connection
 * @param zone_name Zone name from NOTIFY
 * @param source_ip Source IP address
 * @return 0 on success, -1 on error
 */
int axfr_notify_process(SQL *db, const char *zone_name, const char *source_ip);

/* IXFR protocol support (RFC 1995) */

/**
 * Create IXFR query packet
 *
 * @param zone_name Zone name
 * @param query_id Query ID
 * @param current_serial Current SOA serial on slave
 * @param buffer Output buffer
 * @param buffer_size Buffer size
 * @return Query packet size, -1 on error
 */
int axfr_create_ixfr_query(const char *zone_name, uint16_t query_id,
                           uint32_t current_serial, unsigned char *buffer, size_t buffer_size);

/**
 * Perform IXFR transfer from master server
 * Falls back to AXFR if master doesn't support IXFR or doesn't have history
 *
 * @param db Database connection
 * @param zone Zone configuration
 * @param result Output transfer result
 * @return 0 on success, -1 on error
 */
int axfr_ixfr_transfer_zone(SQL *db, axfr_zone_t *zone, axfr_result_t *result);

/**
 * Parse IXFR response
 * Handles both IXFR format and AXFR fallback
 *
 * @param response DNS response buffer
 * @param length Response length
 * @param current_serial Current serial on slave
 * @param records Output linked list of records
 * @param is_axfr_fallback Output flag indicating AXFR fallback
 * @return Number of records parsed, -1 on error
 */
int axfr_parse_ixfr_response(const unsigned char *response, size_t length,
                             uint32_t current_serial, axfr_record_t **records,
                             int *is_axfr_fallback);

/**
 * Apply IXFR changes to database
 * Processes delete and add sequences from IXFR response
 *
 * @param db Database connection
 * @param zone Zone configuration
 * @param records Linked list of records with change markers
 * @param result Output result
 * @return 0 on success, -1 on error
 */
int axfr_apply_ixfr_changes(SQL *db, axfr_zone_t *zone,
                            axfr_record_t *records, axfr_result_t *result);

#endif /* _MYDNS_AXFR_H */
