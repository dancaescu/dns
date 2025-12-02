/**************************************************************************************************
	DoH (DNS over HTTPS) - RFC 8484 Implementation

	Copyright (C) 2025 Dan Caescu <dan.caescu@multitel.net>

	This program is free software; you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation; either version 2 of the License, or
	(at your option) any later version.
**************************************************************************************************/

#ifndef _MYDNS_DOH_H
#define _MYDNS_DOH_H

#include "mydns.h"
#include <pthread.h>
#include <openssl/ssl.h>
#include <openssl/err.h>

/* Default configuration */
#define DOH_DEFAULT_PORT          443
#define DOH_DEFAULT_PATH          "/dns-query"
#define DOH_MAX_REQUEST_SIZE      4096
#define DOH_MAX_RESPONSE_SIZE     65535
#define DOH_BUFFER_SIZE           8192
#define DOH_MAX_CONNECTIONS       100
#define DOH_TIMEOUT_SEC           5

/* DoH Methods */
typedef enum {
    DOH_METHOD_GET,
    DOH_METHOD_POST,
    DOH_METHOD_UNKNOWN
} doh_method_t;

/* DoH Configuration */
typedef struct {
    int enabled;                          /* Enable DoH server */
    int port;                             /* HTTPS port (default 443) */
    char path[256];                       /* URL path (default /dns-query) */
    char cert_file[512];                  /* TLS certificate file */
    char key_file[512];                   /* TLS private key file */
    int max_connections;                  /* Max concurrent connections */
    int timeout_sec;                      /* Request timeout */
    int require_content_type;             /* Require application/dns-message */
} doh_config_t;

/* DoH Request */
typedef struct {
    doh_method_t method;                  /* GET or POST */
    char path[256];                       /* Request path */
    unsigned char dns_query[DOH_MAX_REQUEST_SIZE]; /* DNS query wire format */
    size_t dns_query_len;                 /* Length of DNS query */
    char client_ip[INET6_ADDRSTRLEN];     /* Client IP address */
    int http_status;                      /* HTTP status code */
} doh_request_t;

/* DoH Response */
typedef struct {
    unsigned char dns_response[DOH_MAX_RESPONSE_SIZE]; /* DNS response wire format */
    size_t dns_response_len;              /* Length of DNS response */
    int http_status;                      /* HTTP status code */
    char content_type[64];                /* Content-Type header */
} doh_response_t;

/* DoH Statistics */
typedef struct {
    uint64_t total_requests;              /* Total requests received */
    uint64_t get_requests;                /* GET method requests */
    uint64_t post_requests;               /* POST method requests */
    uint64_t successful_queries;          /* Successful DNS queries */
    uint64_t failed_queries;              /* Failed DNS queries */
    uint64_t invalid_requests;            /* Invalid HTTP requests */
    uint64_t acl_denials;                 /* Denied by ACL */
    uint64_t bytes_sent;                  /* Total bytes sent */
    uint64_t bytes_received;              /* Total bytes received */
    time_t started;                       /* Server start time */
} doh_stats_t;

/* DoH Server Context */
typedef struct {
    doh_config_t config;                  /* Configuration */
    doh_stats_t stats;                    /* Statistics */
    int listen_fd;                        /* Listening socket */
    SSL_CTX *ssl_ctx;                     /* OpenSSL context */
    pthread_t thread;                     /* Server thread */
    int running;                          /* Server running flag */
    pthread_mutex_t lock;                 /* Statistics lock */
} doh_ctx_t;

/* Function prototypes */

/**
 * Initialize DoH server
 *
 * @param db Database connection for loading config
 * @param conf_enabled Config file enabled flag (-1 = not set)
 * @param conf_port Config file port (0 = not set)
 * @param conf_path Config file path (NULL = not set)
 * @param conf_cert Config file cert path (NULL = not set)
 * @param conf_key Config file key path (NULL = not set)
 * @return DoH context on success, NULL on error
 */
doh_ctx_t *doh_init(SQL *db, int conf_enabled, int conf_port,
                     const char *conf_path, const char *conf_cert, const char *conf_key);

/**
 * Start DoH server (spawns thread)
 *
 * @param ctx DoH context
 * @return 0 on success, -1 on error
 */
int doh_start(doh_ctx_t *ctx);

/**
 * Stop DoH server
 *
 * @param ctx DoH context
 */
void doh_stop(doh_ctx_t *ctx);

/**
 * Free DoH server resources
 *
 * @param ctx DoH context
 */
void doh_free(doh_ctx_t *ctx);

/**
 * Handle DoH request (internal)
 *
 * @param ctx DoH context
 * @param ssl SSL connection
 * @param client_addr Client address
 * @return 0 on success, -1 on error
 */
int doh_handle_request(doh_ctx_t *ctx, SSL *ssl, struct sockaddr_storage *client_addr);

/**
 * Parse DoH GET request
 *
 * @param request Request structure
 * @param query_string URL query string
 * @return 0 on success, -1 on error
 */
int doh_parse_get_request(doh_request_t *request, const char *query_string);

/**
 * Parse DoH POST request
 *
 * @param request Request structure
 * @param body Request body
 * @param body_len Body length
 * @return 0 on success, -1 on error
 */
int doh_parse_post_request(doh_request_t *request, const unsigned char *body, size_t body_len);

/**
 * Process DNS query and generate response
 *
 * @param ctx DoH context
 * @param request DoH request
 * @param response DoH response (output)
 * @return 0 on success, -1 on error
 */
int doh_process_query(doh_ctx_t *ctx, doh_request_t *request, doh_response_t *response);

/**
 * Send HTTP response
 *
 * @param ssl SSL connection
 * @param status HTTP status code
 * @param content_type Content-Type header
 * @param body Response body
 * @param body_len Body length
 * @return 0 on success, -1 on error
 */
int doh_send_response(SSL *ssl, int status, const char *content_type,
                      const unsigned char *body, size_t body_len);

/**
 * Get DoH statistics
 *
 * @param ctx DoH context
 * @return Pointer to statistics structure
 */
const doh_stats_t *doh_get_stats(doh_ctx_t *ctx);

/**
 * Load configuration from database
 *
 * @param ctx DoH context
 * @param db Database connection
 * @return 0 on success, -1 on error
 */
int doh_load_config(doh_ctx_t *ctx, SQL *db);

/**
 * Base64url decode (for GET requests)
 *
 * @param input Base64url encoded string
 * @param output Output buffer
 * @param output_len Output buffer size (updated with decoded length)
 * @return 0 on success, -1 on error
 */
int doh_base64url_decode(const char *input, unsigned char *output, size_t *output_len);

/**
 * Initialize OpenSSL context
 *
 * @param cert_file Certificate file path
 * @param key_file Private key file path
 * @return SSL context on success, NULL on error
 */
SSL_CTX *doh_init_ssl(const char *cert_file, const char *key_file);

#endif /* _MYDNS_DOH_H */
