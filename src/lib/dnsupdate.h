/*
 * dnsupdate.h - DNS UPDATE protocol implementation
 * Date: 2025-11-26
 *
 * Implements RFC 2136 - Dynamic Updates in the Domain Name System (DNS UPDATE)
 * Allows clients to dynamically add, delete, and modify DNS records.
 */

#ifndef _MYDNS_DNSUPDATE_H
#define _MYDNS_DNSUPDATE_H

#include "mydns.h"
#include "tsig.h"

/* UPDATE opcodes */
#define DNS_OPCODE_UPDATE 5

/* UPDATE response codes */
#define UPDATE_NOERROR    0  /* Success */
#define UPDATE_FORMERR    1  /* Format error */
#define UPDATE_SERVFAIL   2  /* Server failure */
#define UPDATE_NXDOMAIN   3  /* Name does not exist */
#define UPDATE_NOTIMP     4  /* Not implemented */
#define UPDATE_REFUSED    5  /* Query refused */
#define UPDATE_YXDOMAIN   6  /* Name exists when it should not */
#define UPDATE_YXRRSET    7  /* RRset exists when it should not */
#define UPDATE_NXRRSET    8  /* RRset does not exist when it should */
#define UPDATE_NOTAUTH    9  /* Server not authoritative for zone */
#define UPDATE_NOTZONE   10  /* Name not contained in zone */

/* UPDATE operations */
typedef enum {
    UPDATE_OP_ADD = 0,     /* Add RRs to RRset */
    UPDATE_OP_DELETE = 1,  /* Delete RRs from RRset */
    UPDATE_OP_DELETE_ALL = 2, /* Delete all RRsets with name */
    UPDATE_OP_DELETE_NAME = 3  /* Delete name from zone */
} update_op_t;

/* Prerequisite types */
typedef enum {
    PREREQ_NONE = 0,           /* No prerequisite */
    PREREQ_YXDOMAIN = 1,       /* Name is in use */
    PREREQ_NXDOMAIN = 2,       /* Name is not in use */
    PREREQ_YXRRSET = 3,        /* RRset exists (value independent) */
    PREREQ_NXRRSET = 4,        /* RRset does not exist */
    PREREQ_YXRRSET_VALUE = 5   /* RRset exists (value dependent) */
} prereq_type_t;

/* UPDATE prerequisite */
typedef struct update_prereq {
    prereq_type_t type;
    char *name;
    dns_qtype_t rtype;
    dns_class_t rclass;
    char *rdata;
    uint32_t ttl;
    struct update_prereq *next;
} update_prereq_t;

/* UPDATE record */
typedef struct update_record {
    update_op_t operation;
    char *name;
    dns_qtype_t rtype;
    dns_class_t rclass;
    uint32_t ttl;
    char *rdata;
    uint16_t rdlength;
    struct update_record *next;
} update_record_t;

/* UPDATE request */
typedef struct {
    /* Zone section */
    char *zone_name;
    dns_qtype_t zone_type;  /* Should be SOA */
    dns_class_t zone_class; /* Should be IN */

    /* Prerequisite section */
    update_prereq_t *prerequisites;
    int prereq_count;

    /* Update section */
    update_record_t *updates;
    int update_count;

    /* Additional section (TSIG) */
    tsig_key_t *tsig_key;
    unsigned char *tsig_mac;
    size_t tsig_mac_len;

    /* Request metadata */
    char *source_ip;
    uint16_t message_id;
} update_request_t;

/* UPDATE response */
typedef struct {
    uint16_t message_id;
    uint16_t rcode;
    char *error_message;
    uint32_t new_serial;
} update_response_t;

/* UPDATE ACL */
typedef struct {
    char *zone;
    char *key_name;          /* TSIG key required (NULL = no auth) */
    char *allowed_ips;       /* Comma-separated IPs (NULL = any) */
    char *allowed_networks;  /* Comma-separated CIDR (NULL = any) */
    int allow_add;
    int allow_delete;
    int allow_update;
} update_acl_t;

/* Function prototypes */

/**
 * Initialize DNS UPDATE module
 */
int dnsupdate_init(void);

/**
 * Cleanup DNS UPDATE module
 */
void dnsupdate_cleanup(void);

/**
 * Parse UPDATE request from DNS message
 *
 * @param message DNS message buffer
 * @param message_len Message length
 * @param request Output UPDATE request
 * @return 0 on success, error code on failure
 */
int dnsupdate_parse_request(const unsigned char *message, size_t message_len,
                             update_request_t *request);

/**
 * Process UPDATE request
 *
 * @param db Database connection
 * @param request UPDATE request
 * @param response Output response
 * @return 0 on success, error code on failure
 */
int dnsupdate_process(SQL *db, update_request_t *request, update_response_t *response);

/**
 * Check UPDATE prerequisites
 *
 * @param db Database connection
 * @param zone_id Zone ID
 * @param prereqs Prerequisites list
 * @return 0 if all pass, error code if any fail
 */
int dnsupdate_check_prerequisites(SQL *db, uint32_t zone_id, update_prereq_t *prereqs);

/**
 * Apply UPDATE operations
 *
 * @param db Database connection
 * @param zone_id Zone ID
 * @param updates Update list
 * @param response Output response
 * @return 0 on success, error code on failure
 */
int dnsupdate_apply_updates(SQL *db, uint32_t zone_id, update_record_t *updates,
                             update_response_t *response);

/**
 * Check UPDATE authorization
 *
 * @param db Database connection
 * @param request UPDATE request
 * @return 0 if authorized, error code if not
 */
int dnsupdate_check_authorization(SQL *db, update_request_t *request);

/**
 * Create UPDATE response message
 *
 * @param request Original request
 * @param response Response data
 * @param buffer Output buffer
 * @param buffer_size Buffer size
 * @param output_len Output message length
 * @return 0 on success, -1 on error
 */
int dnsupdate_create_response(update_request_t *request, update_response_t *response,
                               unsigned char *buffer, size_t buffer_size, size_t *output_len);

/**
 * Free UPDATE request
 */
void dnsupdate_free_request(update_request_t *request);

/**
 * Free UPDATE response
 */
void dnsupdate_free_response(update_response_t *response);

/**
 * Load UPDATE ACLs from database
 *
 * @param db Database connection
 * @param acls Output array of ACLs
 * @param count Output count
 * @return 0 on success, -1 on error
 */
int dnsupdate_load_acls(SQL *db, update_acl_t ***acls, int *count);

/**
 * Check if IP is allowed by ACL
 *
 * @param acl ACL entry
 * @param ip IP address
 * @return 1 if allowed, 0 if not
 */
int dnsupdate_check_ip_allowed(update_acl_t *acl, const char *ip);

/**
 * Log UPDATE operation
 *
 * @param db Database connection
 * @param request UPDATE request
 * @param response UPDATE response
 */
void dnsupdate_log(SQL *db, update_request_t *request, update_response_t *response);

#endif /* _MYDNS_DNSUPDATE_H */
