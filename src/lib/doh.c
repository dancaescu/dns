/**************************************************************************************************
	DoH (DNS over HTTPS) - RFC 8484 Implementation

	Copyright (C) 2025 Dan Caescu <dan.caescu@multitel.net>

	This program is free software; you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation; either version 2 of the License, or
	(at your option) any later version.
**************************************************************************************************/

#include "mydns.h"
#include "doh.h"
#include "memzone.h"
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>

/* Global DoH context (for signal handlers) */
static doh_ctx_t *global_doh_ctx = NULL;

/* Base64url decoding table */
static const char base64url_chars[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * Base64url decode (RFC 4648 Section 5)
 */
int doh_base64url_decode(const char *input, unsigned char *output, size_t *output_len) {
    if (!input || !output || !output_len) return -1;

    size_t input_len = strlen(input);
    size_t i, j;
    unsigned char *decode_table = (unsigned char *)calloc(256, 1);
    if (!decode_table) return -1;

    /* Build decode table */
    for (i = 0; i < 64; i++) {
        decode_table[(unsigned char)base64url_chars[i]] = i;
    }

    /* Decode */
    j = 0;
    for (i = 0; i < input_len; i += 4) {
        unsigned char b[4] = {0};
        int valid = 0;

        for (int k = 0; k < 4 && i + k < input_len; k++) {
            unsigned char c = input[i + k];
            if (c == '=' || c == '\0') break;
            b[k] = decode_table[c];
            valid++;
        }

        if (valid >= 2) {
            output[j++] = (b[0] << 2) | (b[1] >> 4);
        }
        if (valid >= 3) {
            output[j++] = (b[1] << 4) | (b[2] >> 2);
        }
        if (valid >= 4) {
            output[j++] = (b[2] << 6) | b[3];
        }
    }

    *output_len = j;
    free(decode_table);
    return 0;
}

/**
 * Initialize OpenSSL context
 */
SSL_CTX *doh_init_ssl(const char *cert_file, const char *key_file) {
    SSL_CTX *ctx;

    SSL_library_init();
    SSL_load_error_strings();
    OpenSSL_add_all_algorithms();

    ctx = SSL_CTX_new(TLS_server_method());
    if (!ctx) {
        Warnx(_("Failed to create SSL context"));
        return NULL;
    }

    /* Load certificate */
    if (SSL_CTX_use_certificate_file(ctx, cert_file, SSL_FILETYPE_PEM) <= 0) {
        Warnx(_("Failed to load certificate from %s"), cert_file);
        SSL_CTX_free(ctx);
        return NULL;
    }

    /* Load private key */
    if (SSL_CTX_use_PrivateKey_file(ctx, key_file, SSL_FILETYPE_PEM) <= 0) {
        Warnx(_("Failed to load private key from %s"), key_file);
        SSL_CTX_free(ctx);
        return NULL;
    }

    /* Verify key matches certificate */
    if (!SSL_CTX_check_private_key(ctx)) {
        Warnx(_("Private key does not match certificate"));
        SSL_CTX_free(ctx);
        return NULL;
    }

    /* Set minimum TLS version */
    SSL_CTX_set_min_proto_version(ctx, TLS1_2_VERSION);

    Notice(_("SSL context initialized successfully"));
    return ctx;
}

/**
 * Load configuration from database
 */
int doh_load_config(doh_ctx_t *ctx, SQL *db) {
    if (!ctx || !db) return -1;

    const char *query = "SELECT enabled, port, path, cert_file, key_file, "
                       "max_connections, timeout_sec "
                       "FROM doh_config LIMIT 1";

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
    ctx->config.port = atoi(row[1]);
    strncpy(ctx->config.path, row[2], sizeof(ctx->config.path) - 1);
    strncpy(ctx->config.cert_file, row[3], sizeof(ctx->config.cert_file) - 1);
    strncpy(ctx->config.key_file, row[4], sizeof(ctx->config.key_file) - 1);
    ctx->config.max_connections = atoi(row[5]);
    ctx->config.timeout_sec = atoi(row[6]);

    sql_free(res);
    return 0;
}

/**
 * Parse DoH GET request
 */
int doh_parse_get_request(doh_request_t *request, const char *query_string) {
    if (!request || !query_string) return -1;

    /* Extract dns= parameter */
    const char *dns_param = strstr(query_string, "dns=");
    if (!dns_param) {
        return -1;
    }

    dns_param += 4; /* Skip "dns=" */

    /* Find end of parameter */
    const char *end = strchr(dns_param, '&');
    size_t param_len = end ? (size_t)(end - dns_param) : strlen(dns_param);

    /* Copy parameter for decoding */
    char *encoded = (char *)malloc(param_len + 1);
    if (!encoded) return -1;

    strncpy(encoded, dns_param, param_len);
    encoded[param_len] = '\0';

    /* Base64url decode */
    size_t decoded_len = DOH_MAX_REQUEST_SIZE;
    int result = doh_base64url_decode(encoded, request->dns_query, &decoded_len);
    free(encoded);

    if (result < 0 || decoded_len < 12) { /* Minimum DNS header size */
        return -1;
    }

    request->dns_query_len = decoded_len;
    request->method = DOH_METHOD_GET;
    return 0;
}

/**
 * Parse DoH POST request
 */
int doh_parse_post_request(doh_request_t *request, const unsigned char *body, size_t body_len) {
    if (!request || !body || body_len < 12 || body_len > DOH_MAX_REQUEST_SIZE) {
        return -1;
    }

    memcpy(request->dns_query, body, body_len);
    request->dns_query_len = body_len;
    request->method = DOH_METHOD_POST;
    return 0;
}

/**
 * Send HTTP response
 */
int doh_send_response(SSL *ssl, int status, const char *content_type,
                      const unsigned char *body, size_t body_len) {
    char header[1024];
    const char *status_text;

    switch (status) {
        case 200: status_text = "OK"; break;
        case 400: status_text = "Bad Request"; break;
        case 403: status_text = "Forbidden"; break;
        case 404: status_text = "Not Found"; break;
        case 405: status_text = "Method Not Allowed"; break;
        case 500: status_text = "Internal Server Error"; break;
        default: status_text = "Unknown"; break;
    }

    /* Build HTTP header */
    int header_len = snprintf(header, sizeof(header),
        "HTTP/1.1 %d %s\r\n"
        "Content-Type: %s\r\n"
        "Content-Length: %zu\r\n"
        "Cache-Control: no-cache\r\n"
        "Connection: close\r\n"
        "\r\n",
        status, status_text, content_type, body_len);

    /* Send header */
    if (SSL_write(ssl, header, header_len) <= 0) {
        return -1;
    }

    /* Send body if present */
    if (body && body_len > 0) {
        if (SSL_write(ssl, body, body_len) <= 0) {
            return -1;
        }
    }

    return 0;
}

/**
 * Process DNS query (simplified - integrates with existing MyDNS)
 */
int doh_process_query(doh_ctx_t *ctx, doh_request_t *request, doh_response_t *response) {
    if (!ctx || !request || !response) return -1;

    /* For now, return a simple error response */
    /* TODO: Integrate with MyDNS query processing pipeline */

    /* Build minimal DNS response (SERVFAIL) */
    if (request->dns_query_len < 12) return -1;

    memcpy(response->dns_response, request->dns_query, 12);
    response->dns_response[2] = 0x81; /* QR=1, OPCODE=0, AA=0, TC=0, RD=1 */
    response->dns_response[3] = 0x82; /* RA=1, Z=0, RCODE=SERVFAIL */
    response->dns_response_len = 12;
    response->http_status = 200;
    strcpy(response->content_type, "application/dns-message");

    return 0;
}

/**
 * Handle DoH request
 */
int doh_handle_request(doh_ctx_t *ctx, SSL *ssl, struct sockaddr_storage *client_addr) {
    char buffer[DOH_BUFFER_SIZE];
    int bytes_read;
    doh_request_t request;
    doh_response_t response;

    memset(&request, 0, sizeof(request));
    memset(&response, 0, sizeof(response));

    /* Get client IP */
    if (client_addr->ss_family == AF_INET) {
        struct sockaddr_in *addr = (struct sockaddr_in *)client_addr;
        inet_ntop(AF_INET, &addr->sin_addr, request.client_ip, sizeof(request.client_ip));
    } else {
        struct sockaddr_in6 *addr = (struct sockaddr_in6 *)client_addr;
        inet_ntop(AF_INET6, &addr->sin6_addr, request.client_ip, sizeof(request.client_ip));
    }

    /* Read HTTP request */
    bytes_read = SSL_read(ssl, buffer, sizeof(buffer) - 1);
    if (bytes_read <= 0) {
        pthread_mutex_lock(&ctx->lock);
        ctx->stats.invalid_requests++;
        pthread_mutex_unlock(&ctx->lock);
        return -1;
    }
    buffer[bytes_read] = '\0';

    /* Parse HTTP method and path */
    char method[16], path[256], version[16];
    if (sscanf(buffer, "%15s %255s %15s", method, path, version) != 3) {
        doh_send_response(ssl, 400, "text/plain", (unsigned char *)"Bad Request", 11);
        pthread_mutex_lock(&ctx->lock);
        ctx->stats.invalid_requests++;
        pthread_mutex_unlock(&ctx->lock);
        return -1;
    }

    strncpy(request.path, path, sizeof(request.path) - 1);

    /* Check path matches configured path */
    if (strncmp(path, ctx->config.path, strlen(ctx->config.path)) != 0) {
        doh_send_response(ssl, 404, "text/plain", (unsigned char *)"Not Found", 9);
        pthread_mutex_lock(&ctx->lock);
        ctx->stats.invalid_requests++;
        pthread_mutex_unlock(&ctx->lock);
        return -1;
    }

    /* Handle GET request */
    if (strcmp(method, "GET") == 0) {
        const char *query_start = strchr(path, '?');
        if (!query_start || doh_parse_get_request(&request, query_start + 1) < 0) {
            doh_send_response(ssl, 400, "text/plain", (unsigned char *)"Invalid DNS query", 17);
            pthread_mutex_lock(&ctx->lock);
            ctx->stats.invalid_requests++;
            pthread_mutex_unlock(&ctx->lock);
            return -1;
        }

        pthread_mutex_lock(&ctx->lock);
        ctx->stats.get_requests++;
        pthread_mutex_unlock(&ctx->lock);
    }
    /* Handle POST request */
    else if (strcmp(method, "POST") == 0) {
        /* Find body after headers */
        const char *body_start = strstr(buffer, "\r\n\r\n");
        if (!body_start) {
            doh_send_response(ssl, 400, "text/plain", (unsigned char *)"Missing body", 12);
            pthread_mutex_lock(&ctx->lock);
            ctx->stats.invalid_requests++;
            pthread_mutex_unlock(&ctx->lock);
            return -1;
        }
        body_start += 4;

        size_t body_len = bytes_read - (body_start - buffer);
        if (doh_parse_post_request(&request, (unsigned char *)body_start, body_len) < 0) {
            doh_send_response(ssl, 400, "text/plain", (unsigned char *)"Invalid DNS query", 17);
            pthread_mutex_lock(&ctx->lock);
            ctx->stats.invalid_requests++;
            pthread_mutex_unlock(&ctx->lock);
            return -1;
        }

        pthread_mutex_lock(&ctx->lock);
        ctx->stats.post_requests++;
        pthread_mutex_unlock(&ctx->lock);
    }
    /* Unsupported method */
    else {
        doh_send_response(ssl, 405, "text/plain", (unsigned char *)"Method Not Allowed", 18);
        pthread_mutex_lock(&ctx->lock);
        ctx->stats.invalid_requests++;
        pthread_mutex_unlock(&ctx->lock);
        return -1;
    }

    /* Process DNS query */
    if (doh_process_query(ctx, &request, &response) < 0) {
        doh_send_response(ssl, 500, "text/plain", (unsigned char *)"Query processing failed", 23);
        pthread_mutex_lock(&ctx->lock);
        ctx->stats.failed_queries++;
        pthread_mutex_unlock(&ctx->lock);
        return -1;
    }

    /* Send DNS response */
    if (doh_send_response(ssl, response.http_status, response.content_type,
                          response.dns_response, response.dns_response_len) < 0) {
        pthread_mutex_lock(&ctx->lock);
        ctx->stats.failed_queries++;
        pthread_mutex_unlock(&ctx->lock);
        return -1;
    }

    pthread_mutex_lock(&ctx->lock);
    ctx->stats.total_requests++;
    ctx->stats.successful_queries++;
    ctx->stats.bytes_sent += response.dns_response_len;
    ctx->stats.bytes_received += request.dns_query_len;
    pthread_mutex_unlock(&ctx->lock);

    return 0;
}

/**
 * DoH server thread
 */
static void *doh_server_thread(void *arg) {
    doh_ctx_t *ctx = (doh_ctx_t *)arg;
    struct sockaddr_storage client_addr;
    socklen_t client_len;
    int client_fd;
    SSL *ssl;

    Notice(_("DoH server thread started on port %d"), ctx->config.port);

    while (ctx->running) {
        client_len = sizeof(client_addr);
        client_fd = accept(ctx->listen_fd, (struct sockaddr *)&client_addr, &client_len);

        if (client_fd < 0) {
            if (ctx->running) {
                Warnx(_("DoH accept failed: %s"), strerror(errno));
            }
            continue;
        }

        /* Create SSL connection */
        ssl = SSL_new(ctx->ssl_ctx);
        if (!ssl) {
            close(client_fd);
            continue;
        }

        SSL_set_fd(ssl, client_fd);

        if (SSL_accept(ssl) <= 0) {
            SSL_free(ssl);
            close(client_fd);
            continue;
        }

        /* Handle request */
        doh_handle_request(ctx, ssl, &client_addr);

        /* Cleanup */
        SSL_shutdown(ssl);
        SSL_free(ssl);
        close(client_fd);
    }

    Notice(_("DoH server thread stopped"));
    return NULL;
}

/**
 * Initialize DoH server
 */
doh_ctx_t *doh_init(SQL *db, int conf_enabled, int conf_port,
                     const char *conf_path, const char *conf_cert, const char *conf_key) {
    doh_ctx_t *ctx = (doh_ctx_t *)calloc(1, sizeof(doh_ctx_t));
    if (!ctx) {
        Warnx(_("Failed to allocate DoH context"));
        return NULL;
    }

    /* Initialize defaults */
    ctx->config.enabled = 0;
    ctx->config.port = DOH_DEFAULT_PORT;
    strncpy(ctx->config.path, DOH_DEFAULT_PATH, sizeof(ctx->config.path) - 1);
    ctx->config.max_connections = DOH_MAX_CONNECTIONS;
    ctx->config.timeout_sec = DOH_TIMEOUT_SEC;
    ctx->config.require_content_type = 1;

    pthread_mutex_init(&ctx->lock, NULL);

    int config_loaded = 0;

    /* Priority 1: Try database */
    if (db) {
        if (doh_load_config(ctx, db) == 0) {
            config_loaded = 1;
            Notice(_("Loaded DoH configuration from database"));
        }
    }

    /* Priority 2: Try config file */
    if (!config_loaded) {
        int conf_used = 0;

        if (conf_enabled >= 0) {
            ctx->config.enabled = conf_enabled;
            conf_used = 1;
        }
        if (conf_port > 0) {
            ctx->config.port = conf_port;
            conf_used = 1;
        }
        if (conf_path) {
            strncpy(ctx->config.path, conf_path, sizeof(ctx->config.path) - 1);
            conf_used = 1;
        }
        if (conf_cert) {
            strncpy(ctx->config.cert_file, conf_cert, sizeof(ctx->config.cert_file) - 1);
            conf_used = 1;
        }
        if (conf_key) {
            strncpy(ctx->config.key_file, conf_key, sizeof(ctx->config.key_file) - 1);
            conf_used = 1;
        }

        if (conf_used) {
            Notice(_("Loaded DoH configuration from config file"));
            config_loaded = 1;
        }
    }

    /* Check if enabled */
    if (!ctx->config.enabled) {
        Notice(_("DoH server disabled"));
        doh_free(ctx);
        return NULL;
    }

    /* Validate certificate files */
    if (strlen(ctx->config.cert_file) == 0 || strlen(ctx->config.key_file) == 0) {
        Warnx(_("DoH certificate or key file not configured"));
        doh_free(ctx);
        return NULL;
    }

    /* Initialize SSL */
    ctx->ssl_ctx = doh_init_ssl(ctx->config.cert_file, ctx->config.key_file);
    if (!ctx->ssl_ctx) {
        Warnx(_("Failed to initialize SSL context"));
        doh_free(ctx);
        return NULL;
    }

    /* Initialize statistics */
    memset(&ctx->stats, 0, sizeof(doh_stats_t));
    ctx->stats.started = time(NULL);

    global_doh_ctx = ctx;

    Notice(_("DoH server initialized: port %d, path %s"),
           ctx->config.port, ctx->config.path);

    return ctx;
}

/**
 * Start DoH server
 */
int doh_start(doh_ctx_t *ctx) {
    if (!ctx) return -1;

    struct sockaddr_in6 addr;
    int opt = 1;

    /* Create socket */
    ctx->listen_fd = socket(AF_INET6, SOCK_STREAM, 0);
    if (ctx->listen_fd < 0) {
        Warnx(_("Failed to create DoH socket: %s"), strerror(errno));
        return -1;
    }

    /* Set socket options */
    setsockopt(ctx->listen_fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));

    /* Bind to port */
    memset(&addr, 0, sizeof(addr));
    addr.sin6_family = AF_INET6;
    addr.sin6_addr = in6addr_any;
    addr.sin6_port = htons(ctx->config.port);

    if (bind(ctx->listen_fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        Warnx(_("Failed to bind DoH socket to port %d: %s"), ctx->config.port, strerror(errno));
        close(ctx->listen_fd);
        return -1;
    }

    /* Listen */
    if (listen(ctx->listen_fd, ctx->config.max_connections) < 0) {
        Warnx(_("Failed to listen on DoH socket: %s"), strerror(errno));
        close(ctx->listen_fd);
        return -1;
    }

    /* Start server thread */
    ctx->running = 1;
    if (pthread_create(&ctx->thread, NULL, doh_server_thread, ctx) != 0) {
        Warnx(_("Failed to create DoH server thread"));
        close(ctx->listen_fd);
        return -1;
    }

    Notice(_("DoH server started on port %d"), ctx->config.port);
    return 0;
}

/**
 * Stop DoH server
 */
void doh_stop(doh_ctx_t *ctx) {
    if (!ctx) return;

    ctx->running = 0;

    if (ctx->listen_fd >= 0) {
        close(ctx->listen_fd);
        ctx->listen_fd = -1;
    }

    pthread_join(ctx->thread, NULL);

    Notice(_("DoH server stopped"));
}

/**
 * Free DoH server resources
 */
void doh_free(doh_ctx_t *ctx) {
    if (!ctx) return;

    if (ctx->running) {
        doh_stop(ctx);
    }

    if (ctx->ssl_ctx) {
        SSL_CTX_free(ctx->ssl_ctx);
    }

    pthread_mutex_destroy(&ctx->lock);

    if (global_doh_ctx == ctx) {
        global_doh_ctx = NULL;
    }

    free(ctx);
}

/**
 * Get DoH statistics
 */
const doh_stats_t *doh_get_stats(doh_ctx_t *ctx) {
    return ctx ? &ctx->stats : NULL;
}
