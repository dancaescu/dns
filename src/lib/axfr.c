/*
 * axfr.c - AXFR (Zone Transfer) client implementation
 * Date: 2025-11-26
 *
 * Implements DNS zone transfer (AXFR) client functionality for MyDNS,
 * allowing it to act as a slave server receiving zone data from masters.
 */

#include "mydns.h"
#include "mydnsutil.h"
#include "axfr.h"
#include "memzone.h"
#include "zone-masters-conf.h"
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <netdb.h>
#include <poll.h>
#include <errno.h>
#include <string.h>

/* Global memzone context (for zone transfer updates) */
extern memzone_ctx_t *Memzone;

/* DNS header structure */
typedef struct {
    uint16_t id;
    uint16_t flags;
    uint16_t qdcount;
    uint16_t ancount;
    uint16_t nscount;
    uint16_t arcount;
} dns_header_t;

/* DNS question structure */
typedef struct {
    char *qname;
    uint16_t qtype;
    uint16_t qclass;
} dns_question_t;

/* Maximum AXFR response size */
#define AXFR_MAX_RESPONSE_SIZE (65536 * 100)  /* 100 DNS messages max */
#define AXFR_BUFFER_SIZE 65536
#define AXFR_TIMEOUT 300  /* 5 minutes timeout */

/**
 * Initialize AXFR module
 */
int axfr_init(void) {
    return 0;
}

/**
 * Free AXFR module resources
 */
void axfr_free(void) {
    /* Nothing to free at module level */
}

/**
 * Load zone master configuration from database
 */
int axfr_load_zones(SQL *db, int zone_id, axfr_zone_t **zones, int *count) {
    SQL_RES *res;
    SQL_ROW row;
    char query[1024];
    int n = 0;
    axfr_zone_t *zone_list = NULL;

    if (!db || !zones || !count) {
        return -1;
    }

    /* Query zone_masters table */
    if (zone_id > 0) {
        snprintf(query, sizeof(query),
            "SELECT zm.id, zm.zone_id, s.origin, zm.master_host, zm.master_port, "
            "s.serial, zm.last_check, zm.last_transfer, zm.transfer_failures, "
            "zm.tsig_key_name, zm.tsig_key_secret, zm.tsig_algorithm "
            "FROM zone_masters zm "
            "JOIN soa s ON s.id = zm.zone_id "
            "WHERE zm.zone_id = %d AND zm.enabled = 1",
            zone_id);
    } else {
        snprintf(query, sizeof(query),
            "SELECT zm.id, zm.zone_id, s.origin, zm.master_host, zm.master_port, "
            "s.serial, zm.last_check, zm.last_transfer, zm.transfer_failures, "
            "zm.tsig_key_name, zm.tsig_key_secret, zm.tsig_algorithm "
            "FROM zone_masters zm "
            "JOIN soa s ON s.id = zm.zone_id "
            "WHERE zm.enabled = 1");
    }

    if (!(res = sql_query(db, query, strlen(query)))) {
        Warnx(_("axfr_load_zones: query failed: %s"), query);
        return -1;
    }

    /* Count rows */
    *count = sql_num_rows(res);
    if (*count == 0) {
        sql_free(res);
        *zones = NULL;
        return 0;
    }

    /* Allocate array */
    zone_list = (axfr_zone_t *)calloc(*count, sizeof(axfr_zone_t));
    if (!zone_list) {
        sql_free(res);
        return -1;
    }

    /* Fill array */
    while ((row = sql_getrow(res, NULL)) && n < *count) {
        zone_list[n].zone_id = atoi(row[1]);
        zone_list[n].zone_name = strdup(row[2] ? row[2] : "");
        zone_list[n].master_host = strdup(row[3] ? row[3] : "");
        zone_list[n].master_port = row[4] ? atoi(row[4]) : 53;
        zone_list[n].current_serial = row[5] ? (uint32_t)atol(row[5]) : 0;
        zone_list[n].master_serial = 0;
        zone_list[n].last_check = row[6] ? (time_t)atol(row[6]) : 0;
        zone_list[n].last_transfer = row[7] ? (time_t)atol(row[7]) : 0;
        zone_list[n].transfer_failures = row[8] ? atoi(row[8]) : 0;
        zone_list[n].tsig_key_name = row[9] ? strdup(row[9]) : NULL;
        zone_list[n].tsig_key_secret = row[10] ? strdup(row[10]) : NULL;
        zone_list[n].tsig_algorithm = row[11] ? strdup(row[11]) : NULL;
        n++;
    }

    sql_free(res);
    *zones = zone_list;
    return 0;
}

/**
 * Load zones from config file (converts zm_config to axfr_zone_t)
 */
static int axfr_load_zones_from_config(zm_config_t *zm_config, axfr_zone_t **zones, int *count) {
    if (!zm_config || !zones || !count) {
        return -1;
    }

    int total_zones = zm_config->total_zones;
    if (total_zones == 0) {
        *zones = NULL;
        *count = 0;
        return 0;
    }

    /* Allocate array */
    axfr_zone_t *zone_list = (axfr_zone_t *)calloc(total_zones, sizeof(axfr_zone_t));
    if (!zone_list) {
        return -1;
    }

    /* Convert zones from config format to axfr_zone_t format */
    int n = 0;
    zm_master_t *master = zm_config->masters;
    while (master && n < total_zones) {
        zm_zone_t *zone = master->zones;
        while (zone && n < total_zones) {
            zone_list[n].zone_id = 0;  /* No zone_id from config file */
            zone_list[n].zone_name = strdup(zone->name);
            zone_list[n].master_host = strdup(master->host);
            zone_list[n].master_port = master->port;
            zone_list[n].current_serial = 0;
            zone_list[n].master_serial = 0;
            zone_list[n].last_check = 0;
            zone_list[n].last_transfer = 0;
            zone_list[n].transfer_failures = 0;

            /* TSIG authentication */
            if (master->has_tsig) {
                zone_list[n].tsig_key_name = strdup(master->tsig_key_name);
                zone_list[n].tsig_key_secret = strdup(master->tsig_secret);
                zone_list[n].tsig_algorithm = strdup(master->tsig_algorithm);
            } else {
                zone_list[n].tsig_key_name = NULL;
                zone_list[n].tsig_key_secret = NULL;
                zone_list[n].tsig_algorithm = NULL;
            }

            n++;
            zone = zone->next;
        }
        master = master->next;
    }

    *zones = zone_list;
    *count = n;
    return 0;
}

/**
 * Load zones with priority: config file first, then database
 * This is the main entry point for zone loading
 *
 * Priority:
 * 1. If zone-masters.conf exists → load from config (100% MySQL-free)
 * 2. If config doesn't exist → load from database (traditional)
 * 3. If both fail → return error
 */
int axfr_load_zones_auto(SQL *db, int zone_id, axfr_zone_t **zones, int *count) {
    /* Try config file first */
    if (zm_config_exists(NULL)) {
        zm_config_t *zm_config = zm_load_config(NULL);
        if (zm_config) {
            Notice(_("Loading zone masters from %s (MySQL-free mode)"),
                   zm_config->config_path);

            /* If specific zone requested, filter to just that zone */
            if (zone_id > 0) {
                /* For now, load all zones - filtering by zone_id requires database */
                Notice(_("Note: Specific zone filtering not supported in config mode"));
            }

            int ret = axfr_load_zones_from_config(zm_config, zones, count);
            zm_free_config(zm_config);

            if (ret == 0) {
                Notice(_("Loaded %d zone(s) from config file"), *count);
                return 0;
            }

            Warnx(_("Failed to load zones from config file, falling back to database"));
        }
    }

    /* Fall back to database */
    if (db) {
        Notice(_("Loading zone masters from database"));
        return axfr_load_zones(db, zone_id, zones, count);
    }

    /* Both failed */
    Warnx(_("No zone configuration found (neither %s nor database)"),
          ZONE_MASTERS_CONF_PATH);
    *zones = NULL;
    *count = 0;
    return -1;
}

/**
 * Free zone configuration
 */
void axfr_free_zone(axfr_zone_t *zone) {
    if (!zone) return;

    if (zone->zone_name) free(zone->zone_name);
    if (zone->master_host) free(zone->master_host);
    if (zone->tsig_key_name) free(zone->tsig_key_name);
    if (zone->tsig_key_secret) free(zone->tsig_key_secret);
    if (zone->tsig_algorithm) free(zone->tsig_algorithm);
}

/**
 * Parse SOA record from DNS response and extract serial
 */
static uint32_t parse_soa_serial(const unsigned char *rdata, size_t rdlen) {
    const unsigned char *p = rdata;
    const unsigned char *end = rdata + rdlen;
    uint32_t serial = 0;

    /* Skip MNAME (primary nameserver) */
    while (p < end && *p) {
        int label_len = *p;
        if (label_len > 63) break;  /* Invalid label */
        p += label_len + 1;
    }
    if (p < end) p++;  /* Skip final zero */

    /* Skip RNAME (admin email) */
    while (p < end && *p) {
        int label_len = *p;
        if (label_len > 63) break;
        p += label_len + 1;
    }
    if (p < end) p++;  /* Skip final zero */

    /* Read serial (32-bit unsigned) */
    if (p + 4 <= end) {
        serial = (p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3];
    }

    return serial;
}

/**
 * Check SOA serial on master server
 * Queries master for SOA record and compares serial with local copy
 *
 * Returns:
 *   0: Transfer needed (master_serial > current_serial)
 *   1: No transfer needed (serials equal or master older)
 *  -1: Error (couldn't query master)
 */
int axfr_check_serial(axfr_zone_t *zone) {
    int sockfd = -1;
    unsigned char query[512];
    unsigned char response[4096];
    int query_size;
    ssize_t response_size;
    struct sockaddr_in server_addr;
    struct hostent *host;
    dns_header_t *header;
    const unsigned char *p;
    uint16_t qdcount, ancount;
    int ret = -1;

    if (!zone || !zone->zone_name || !zone->master_host) {
        return -1;
    }

    /* Resolve master hostname */
    host = gethostbyname(zone->master_host);
    if (!host) {
        Warnx(_("axfr_check_serial: Cannot resolve master %s"), zone->master_host);
        return -1;
    }

    /* Create UDP socket */
    sockfd = socket(AF_INET, SOCK_DGRAM, 0);
    if (sockfd < 0) {
        Warnx(_("axfr_check_serial: socket() failed"));
        return -1;
    }

    /* Set timeout */
    struct timeval tv;
    tv.tv_sec = 5;
    tv.tv_usec = 0;
    setsockopt(sockfd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));

    /* Build server address */
    memset(&server_addr, 0, sizeof(server_addr));
    server_addr.sin_family = AF_INET;
    server_addr.sin_port = htons(zone->master_port);
    memcpy(&server_addr.sin_addr, host->h_addr_list[0], host->h_length);

    /* Create DNS query for SOA */
    query_size = axfr_create_query(zone->zone_name, 0x1234, query, sizeof(query));
    if (query_size < 0) {
        Warnx(_("axfr_check_serial: Failed to create SOA query"));
        goto cleanup;
    }

    /* Change QTYPE from AXFR (252) to SOA (6) */
    /* Query format: header + qname + qtype + qclass */
    /* QTYPE is 2 bytes before QCLASS at the end */
    query[query_size - 4] = 0;
    query[query_size - 3] = 6;  /* QTYPE = SOA */

    /* Send query */
    if (sendto(sockfd, query, query_size, 0,
               (struct sockaddr *)&server_addr, sizeof(server_addr)) < 0) {
        Warnx(_("axfr_check_serial: sendto() failed for zone %s"), zone->zone_name);
        goto cleanup;
    }

    /* Receive response */
    response_size = recvfrom(sockfd, response, sizeof(response), 0, NULL, NULL);
    if (response_size < (ssize_t)sizeof(dns_header_t)) {
        Warnx(_("axfr_check_serial: No response or timeout for zone %s"), zone->zone_name);
        goto cleanup;
    }

    /* Parse response header */
    header = (dns_header_t *)response;
    qdcount = ntohs(header->qdcount);
    ancount = ntohs(header->ancount);

    if (ancount == 0) {
        Warnx(_("axfr_check_serial: No SOA record in response for zone %s"), zone->zone_name);
        goto cleanup;
    }

    /* Skip question section */
    p = response + sizeof(dns_header_t);
    for (int i = 0; i < qdcount; i++) {
        /* Skip QNAME */
        while (p < response + response_size && *p) {
            if ((*p & 0xC0) == 0xC0) {  /* Compression pointer */
                p += 2;
                break;
            }
            p += *p + 1;
        }
        if (*p == 0) p++;  /* Skip final zero */
        p += 4;  /* Skip QTYPE + QCLASS */
    }

    /* Parse first answer (should be SOA) */
    /* Skip NAME */
    while (p < response + response_size && *p) {
        if ((*p & 0xC0) == 0xC0) {  /* Compression pointer */
            p += 2;
            break;
        }
        p += *p + 1;
    }
    if (*p == 0) p++;

    /* Read TYPE, CLASS, TTL, RDLENGTH */
    if (p + 10 > response + response_size) {
        Warnx(_("axfr_check_serial: Truncated response for zone %s"), zone->zone_name);
        goto cleanup;
    }

    uint16_t rtype = (p[0] << 8) | p[1];
    p += 2;  /* Skip TYPE */
    p += 2;  /* Skip CLASS */
    p += 4;  /* Skip TTL */
    uint16_t rdlength = (p[0] << 8) | p[1];
    p += 2;

    if (rtype != 6) {  /* Not SOA */
        Warnx(_("axfr_check_serial: Response is not SOA for zone %s"), zone->zone_name);
        goto cleanup;
    }

    /* Parse SOA RDATA and extract serial */
    zone->master_serial = parse_soa_serial(p, rdlength);

    Notice(_("Zone %s: local serial=%u, master serial=%u"),
           zone->zone_name, zone->current_serial, zone->master_serial);

    /* Compare serials */
    if (zone->master_serial > zone->current_serial) {
        Notice(_("Zone %s needs transfer (master serial %u > local serial %u)"),
               zone->zone_name, zone->master_serial, zone->current_serial);
        ret = 0;  /* Transfer needed */
    } else {
        Notice(_("Zone %s is up to date (master serial %u <= local serial %u)"),
               zone->zone_name, zone->master_serial, zone->current_serial);
        ret = 1;  /* No transfer needed */
    }

cleanup:
    if (sockfd >= 0) close(sockfd);
    return ret;
}

/**
 * Connect to master server via TCP
 */
int axfr_connect_master(const char *host, int port, int timeout) {
    struct addrinfo hints, *res, *rp;
    char port_str[16];
    int sockfd = -1;
    int ret;
    struct timeval tv;

    if (!host) {
        return -1;
    }

    memset(&hints, 0, sizeof(hints));
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;
    hints.ai_protocol = IPPROTO_TCP;

    snprintf(port_str, sizeof(port_str), "%d", port);

    if ((ret = getaddrinfo(host, port_str, &hints, &res)) != 0) {
        Warnx(_("getaddrinfo failed for %s:%d: %s"), host, port, gai_strerror(ret));
        return -1;
    }

    /* Try each address */
    for (rp = res; rp != NULL; rp = rp->ai_next) {
        sockfd = socket(rp->ai_family, rp->ai_socktype, rp->ai_protocol);
        if (sockfd == -1) {
            continue;
        }

        /* Set socket timeout */
        tv.tv_sec = timeout;
        tv.tv_usec = 0;
        setsockopt(sockfd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
        setsockopt(sockfd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));

        /* Try to connect */
        if (connect(sockfd, rp->ai_addr, rp->ai_addrlen) == 0) {
            break;  /* Success */
        }

        close(sockfd);
        sockfd = -1;
    }

    freeaddrinfo(res);

    if (sockfd == -1) {
        Warnx(_("Failed to connect to master %s:%d"), host, port);
        return -1;
    }

    return sockfd;
}

/**
 * Create DNS name in wire format
 */
static int dns_name_to_wire(const char *name, unsigned char *wire, size_t max_len) {
    unsigned char *p = wire;
    const char *label = name;
    const char *dot;
    size_t label_len;

    while (*label) {
        dot = strchr(label, '.');
        label_len = dot ? (size_t)(dot - label) : strlen(label);

        if (label_len == 0) {
            break;  /* Trailing dot or root */
        }

        if (label_len > 63 || (p - wire) + label_len + 1 > max_len) {
            return -1;  /* Label too long */
        }

        *p++ = (unsigned char)label_len;
        memcpy(p, label, label_len);
        p += label_len;

        label = dot ? dot + 1 : label + label_len;
    }

    if ((p - wire) + 1 > max_len) {
        return -1;
    }

    *p++ = 0;  /* Root label */
    return (int)(p - wire);
}

/**
 * Create AXFR query packet
 */
int axfr_create_query(const char *zone_name, uint16_t query_id, unsigned char *buffer, size_t buffer_size) {
    unsigned char *p = buffer;
    dns_header_t *header;
    int name_len;

    if (!zone_name || !buffer || buffer_size < 512) {
        return -1;
    }

    memset(buffer, 0, buffer_size);

    /* DNS header */
    header = (dns_header_t *)p;
    header->id = htons(query_id);
    header->flags = htons(0x0000);  /* Standard query */
    header->qdcount = htons(1);     /* One question */
    header->ancount = 0;
    header->nscount = 0;
    header->arcount = 0;
    p += sizeof(dns_header_t);

    /* Question section */
    name_len = dns_name_to_wire(zone_name, p, buffer_size - (p - buffer));
    if (name_len < 0) {
        return -1;
    }
    p += name_len;

    /* QTYPE = AXFR (252) */
    *p++ = 0;
    *p++ = 252;

    /* QCLASS = IN (1) */
    *p++ = 0;
    *p++ = 1;

    return (int)(p - buffer);
}

/**
 * Send AXFR query over TCP
 */
int axfr_send_query(int sockfd, const unsigned char *query, size_t query_size) {
    unsigned char length_prefix[2];
    ssize_t sent;

    /* TCP DNS messages are prefixed with 2-byte length */
    length_prefix[0] = (query_size >> 8) & 0xFF;
    length_prefix[1] = query_size & 0xFF;

    /* Send length */
    sent = send(sockfd, length_prefix, 2, 0);
    if (sent != 2) {
        Warnx(_("Failed to send length prefix: %s"), strerror(errno));
        return -1;
    }

    /* Send query */
    sent = send(sockfd, query, query_size, 0);
    if (sent != (ssize_t)query_size) {
        Warnx(_("Failed to send query: %s"), strerror(errno));
        return -1;
    }

    return 0;
}

/**
 * Receive AXFR response over TCP
 */
int axfr_receive_response(int sockfd, unsigned char *response, size_t buffer_size, int timeout) {
    unsigned char length_prefix[2];
    uint16_t message_length;
    ssize_t received;
    size_t total_received = 0;
    struct pollfd pfd;

    /* Set up poll */
    pfd.fd = sockfd;
    pfd.events = POLLIN;

    while (total_received < buffer_size) {
        /* Wait for data */
        int poll_ret = poll(&pfd, 1, timeout * 1000);
        if (poll_ret < 0) {
            Warnx(_("poll() failed: %s"), strerror(errno));
            return -1;
        } else if (poll_ret == 0) {
            /* Timeout - might be end of transfer */
            break;
        }

        /* Read length prefix */
        received = recv(sockfd, length_prefix, 2, MSG_PEEK);
        if (received <= 0) {
            break;  /* Connection closed or error */
        }

        if (received < 2) {
            continue;  /* Not enough data yet */
        }

        message_length = (length_prefix[0] << 8) | length_prefix[1];

        if (total_received + message_length + 2 > buffer_size) {
            Warnx(_("AXFR response too large (> %zu bytes)"), buffer_size);
            return -1;
        }

        /* Read the actual message (including length prefix) */
        received = recv(sockfd, response + total_received, message_length + 2, 0);
        if (received != message_length + 2) {
            Warnx(_("Failed to receive complete message: %s"), strerror(errno));
            return -1;
        }

        total_received += received;
    }

    return (int)total_received;
}

/**
 * Parse DNS name from wire format
 */
static int dns_name_from_wire(const unsigned char *wire, size_t wire_len, size_t *offset, char *name, size_t name_len) {
    const unsigned char *p = wire + *offset;
    const unsigned char *end = wire + wire_len;
    char *n = name;
    size_t label_len;
    int jumped = 0;
    size_t original_offset = *offset;

    while (p < end) {
        label_len = *p;

        /* Check for compression pointer */
        if ((label_len & 0xC0) == 0xC0) {
            if (p + 1 >= end) return -1;
            size_t pointer = ((label_len & 0x3F) << 8) | *(p + 1);
            if (!jumped) {
                *offset += 2;
                jumped = 1;
            }
            p = wire + pointer;
            continue;
        }

        /* Root label */
        if (label_len == 0) {
            if (!jumped) {
                *offset = (p - wire) + 1;
            }
            *n = '\0';
            return 0;
        }

        /* Regular label */
        if (label_len > 63 || p + label_len >= end) {
            return -1;
        }

        if (n != name) {
            if ((size_t)(n - name) + 1 >= name_len) return -1;
            *n++ = '.';
        }

        if ((size_t)(n - name) + label_len >= name_len) return -1;
        memcpy(n, p + 1, label_len);
        n += label_len;
        p += label_len + 1;
    }

    return -1;
}

/**
 * Parse AXFR response
 */
int axfr_parse_response(const unsigned char *response, size_t length, axfr_record_t **records) {
    const unsigned char *p = response;
    const unsigned char *end = response + length;
    axfr_record_t *record_list = NULL;
    axfr_record_t *last_record = NULL;
    int record_count = 0;
    int soa_count = 0;

    *records = NULL;

    /* Parse multiple TCP DNS messages */
    while (p + 2 < end) {
        /* Read message length */
        uint16_t msg_len = (p[0] << 8) | p[1];
        p += 2;

        if (p + msg_len > end) {
            Warnx(_("Invalid message length in AXFR response"));
            axfr_free_records(record_list);
            return -1;
        }

        const unsigned char *msg_start = p;
        const unsigned char *msg_end = p + msg_len;

        /* Skip DNS header */
        if (msg_end - p < 12) {
            p = msg_end;
            continue;
        }

        dns_header_t *header = (dns_header_t *)p;
        uint16_t qdcount = ntohs(header->qdcount);
        uint16_t ancount = ntohs(header->ancount);
        p += 12;

        /* Skip questions */
        for (int i = 0; i < qdcount && p < msg_end; i++) {
            char qname[256];
            size_t offset = p - msg_start;
            if (dns_name_from_wire(msg_start, msg_len, &offset, qname, sizeof(qname)) < 0) {
                break;
            }
            p = msg_start + offset + 4;  /* Skip QTYPE and QCLASS */
        }

        /* Parse answer records */
        for (int i = 0; i < ancount && p < msg_end; i++) {
            axfr_record_t *rec = (axfr_record_t *)calloc(1, sizeof(axfr_record_t));
            if (!rec) {
                axfr_free_records(record_list);
                return -1;
            }

            /* Parse name */
            char name[256];
            size_t offset = p - msg_start;
            if (dns_name_from_wire(msg_start, msg_len, &offset, name, sizeof(name)) < 0) {
                free(rec);
                break;
            }
            rec->name = strdup(name);
            p = msg_start + offset;

            /* Parse TYPE, CLASS, TTL, RDLENGTH */
            if (p + 10 > msg_end) {
                axfr_free_records(record_list);
                free(rec->name);
                free(rec);
                return -1;
            }

            uint16_t rtype = (p[0] << 8) | p[1];
            uint16_t rclass = (p[2] << 8) | p[3];
            uint32_t ttl = (p[4] << 24) | (p[5] << 16) | (p[6] << 8) | p[7];
            uint16_t rdlength = (p[8] << 8) | p[9];
            p += 10;

            if (p + rdlength > msg_end) {
                axfr_free_records(record_list);
                free(rec->name);
                free(rec);
                return -1;
            }

            rec->ttl = ttl;
            rec->type = strdup(mydns_qtype_str(rtype));

            /* Count SOA records (should be 2: start and end) */
            if (rtype == DNS_QTYPE_SOA) {
                soa_count++;
            }

            /* Parse RDATA (simplified - just store as hex for now) */
            char *rdata = (char *)malloc(rdlength * 2 + 1);
            if (rdata) {
                for (int j = 0; j < rdlength; j++) {
                    sprintf(rdata + j * 2, "%02x", p[j]);
                }
                rec->data = rdata;
            }

            p += rdlength;

            /* Add to list */
            if (last_record) {
                last_record->next = rec;
            } else {
                record_list = rec;
            }
            last_record = rec;
            record_count++;
        }

        p = msg_end;
    }

    /* Validate AXFR (should have 2 SOA records) */
    if (soa_count != 2) {
        Warnx(_("Invalid AXFR response: expected 2 SOA records, got %d"), soa_count);
        axfr_free_records(record_list);
        return -1;
    }

    *records = record_list;
    return record_count;
}

/**
 * Free record list
 */
void axfr_free_records(axfr_record_t *records) {
    axfr_record_t *rec = records;
    axfr_record_t *next;

    while (rec) {
        next = rec->next;
        if (rec->name) free(rec->name);
        if (rec->type) free(rec->type);
        if (rec->data) free(rec->data);
        free(rec);
        rec = next;
    }
}

/**
 * Perform AXFR transfer from master server
 */
int axfr_transfer_zone(SQL *db, axfr_zone_t *zone, axfr_result_t *result) {
    int sockfd = -1;
    unsigned char query[512];
    unsigned char *response = NULL;
    int query_size;
    int response_size;
    axfr_record_t *records = NULL;
    int ret = -1;
    time_t start_time = time(NULL);

    if (!db || !zone || !result) {
        return -1;
    }

    memset(result, 0, sizeof(axfr_result_t));
    result->status = AXFR_ERROR;

    /* Allocate response buffer */
    response = (unsigned char *)malloc(AXFR_MAX_RESPONSE_SIZE);
    if (!response) {
        result->error_message = strdup("Out of memory");
        return -1;
    }

    /* Connect to master */
    sockfd = axfr_connect_master(zone->master_host, zone->master_port, 30);
    if (sockfd < 0) {
        result->status = AXFR_NETWORK_ERROR;
        result->error_message = strdup("Failed to connect to master");
        goto cleanup;
    }

    /* Create AXFR query */
    query_size = axfr_create_query(zone->zone_name, 1234, query, sizeof(query));
    if (query_size < 0) {
        result->status = AXFR_ERROR;
        result->error_message = strdup("Failed to create AXFR query");
        goto cleanup;
    }

    /* Send query */
    if (axfr_send_query(sockfd, query, query_size) < 0) {
        result->status = AXFR_NETWORK_ERROR;
        result->error_message = strdup("Failed to send AXFR query");
        goto cleanup;
    }

    /* Receive response */
    response_size = axfr_receive_response(sockfd, response, AXFR_MAX_RESPONSE_SIZE, AXFR_TIMEOUT);
    if (response_size < 0) {
        result->status = AXFR_TIMEOUT;
        result->error_message = strdup("Timeout receiving AXFR response");
        goto cleanup;
    }

    /* Parse response */
    result->records_received = axfr_parse_response(response, response_size, &records);
    if (result->records_received < 0) {
        result->status = AXFR_PARSE_ERROR;
        result->error_message = strdup("Failed to parse AXFR response");
        goto cleanup;
    }

    /* Update memzone (if available) */
    if (Memzone) {
        Notice(_("Updating memzone for zone %s"), zone->zone_name);
        if (axfr_update_memzone(Memzone, zone, records, result) < 0) {
            Warnx(_("Failed to update memzone for zone %s"), zone->zone_name);
            /* Continue anyway - try database update */
        }
    }

    /* Update database (if db is provided) */
    if (db) {
        Notice(_("Updating database for zone %s"), zone->zone_name);
        /* Reset records_added counter for database update */
        int memzone_records = result->records_added;
        result->records_added = 0;

        if (axfr_update_database(db, zone, records, result) < 0) {
            result->status = AXFR_DATABASE_ERROR;
            result->error_message = strdup("Failed to update database");
            goto cleanup;
        }

        /* Restore total (memzone + database) */
        result->records_added += memzone_records;
    }

    result->status = AXFR_SUCCESS;
    result->transfer_time = time(NULL) - start_time;
    ret = 0;

cleanup:
    if (sockfd >= 0) close(sockfd);
    if (response) free(response);
    if (records) axfr_free_records(records);

    return ret;
}

/**
 * Update database with transferred zone data
 */
int axfr_update_database(SQL *db, axfr_zone_t *zone, axfr_record_t *records, axfr_result_t *result) {
    axfr_record_t *rec;
    char query[4096];
    SQL_RES *res;

    if (!db || !zone || !records || !result) {
        return -1;
    }

    /* Start transaction */
    sql_query(db, "START TRANSACTION", strlen("START TRANSACTION"));

    /* Delete existing records for this zone */
    snprintf(query, sizeof(query), "DELETE FROM rr WHERE zone = %d", zone->zone_id);
    sql_query(db, query, strlen(query));

    /* Insert new records */
    for (rec = records; rec != NULL; rec = rec->next) {
        char *escaped_name = sql_escstr(db, rec->name);
        char *escaped_data = sql_escstr(db, rec->data);

        snprintf(query, sizeof(query),
            "INSERT INTO rr (zone, name, type, data, ttl, aux) VALUES (%d, '%s', '%s', '%s', %u, %u)",
            zone->zone_id, escaped_name, rec->type, escaped_data, rec->ttl, rec->aux);

        res = sql_query(db, query, strlen(query));
        if (res) {
            result->records_added++;
            sql_free(res);
        }

        RELEASE(escaped_name);
        RELEASE(escaped_data);
    }

    /* Update SOA serial */
    snprintf(query, sizeof(query),
        "UPDATE soa SET serial = %u WHERE id = %d",
        result->new_serial, zone->zone_id);
    sql_query(db, query, strlen(query));

    /* Commit transaction */
    sql_query(db, "COMMIT", strlen("COMMIT"));

    return 0;
}

/**
 * Update memzone with transferred zone data
 */
int axfr_update_memzone(memzone_ctx_t *ctx, axfr_zone_t *zone, axfr_record_t *records, axfr_result_t *result) {
    axfr_record_t *rec;

    if (!ctx || !zone || !records || !result) {
        return -1;
    }

    /* Create mem_soa_t from axfr_zone_t */
    mem_soa_t soa;
    memset(&soa, 0, sizeof(soa));

    soa.zone_id = zone->zone_id;
    strncpy(soa.origin, zone->zone_name, MEMZONE_NAME_MAX - 1);

    /* Parse SOA record from records list (first record should be SOA) */
    if (records && strcmp(records->type, "SOA") == 0) {
        /* Parse SOA data: "ns mbox serial refresh retry expire minimum" */
        char soa_data[1024];
        strncpy(soa_data, records->data, sizeof(soa_data) - 1);

        char *tok = strtok(soa_data, " ");
        if (tok) strncpy(soa.ns, tok, MEMZONE_NAME_MAX - 1);

        tok = strtok(NULL, " ");
        if (tok) strncpy(soa.mbox, tok, MEMZONE_NAME_MAX - 1);

        tok = strtok(NULL, " ");
        if (tok) soa.serial = atoi(tok);

        tok = strtok(NULL, " ");
        if (tok) soa.refresh = atoi(tok);

        tok = strtok(NULL, " ");
        if (tok) soa.retry = atoi(tok);

        tok = strtok(NULL, " ");
        if (tok) soa.expire = atoi(tok);

        tok = strtok(NULL, " ");
        if (tok) soa.minimum = atoi(tok);

        soa.ttl = records->ttl;
    }

    soa.active = 1;
    soa.updated = time(NULL);

    /* Add or update zone in memzone */
    if (memzone_add_zone(ctx, &soa) < 0) {
        Warnx(_("Failed to add zone %s to memzone"), zone->zone_name);
        return -1;
    }

    /* Delete all existing records for this zone */
    memzone_delete_all_rr(ctx, zone->zone_id);

    /* Add new records to memzone */
    for (rec = records; rec != NULL; rec = rec->next) {
        /* Skip SOA record (already processed) */
        if (strcmp(rec->type, "SOA") == 0) {
            continue;
        }

        mem_rr_t rr;
        memset(&rr, 0, sizeof(rr));

        rr.id = 0;  /* Will be assigned by memzone */
        rr.zone_id = zone->zone_id;
        strncpy(rr.name, rec->name, MEMZONE_NAME_MAX - 1);
        rr.type = mydns_rr_get_type(rec->type);
        strncpy(rr.data, rec->data, MEMZONE_DATA_MAX - 1);
        rr.aux = rec->aux;
        rr.ttl = rec->ttl;

        if (memzone_add_rr(ctx, zone->zone_id, &rr) == 0) {
            result->records_added++;
        }
    }

    Notice(_("Updated memzone for zone %s: %d records"), zone->zone_name, result->records_added);
    return 0;
}

/**
 * Log transfer result
 */
void axfr_log_transfer(SQL *db, axfr_zone_t *zone, axfr_result_t *result) {
    char query[2048];
    char *escaped_error = NULL;

    if (!db || !zone || !result) {
        return;
    }

    if (result->error_message) {
        escaped_error = sql_escstr(db, result->error_message);
    }

    snprintf(query, sizeof(query),
        "INSERT INTO zone_transfer_log "
        "(zone_id, master_host, status, records_received, records_added, "
        "records_updated, records_deleted, transfer_time, error_message) "
        "VALUES (%d, '%s', %d, %d, %d, %d, %d, %ld, %s%s%s)",
        zone->zone_id, zone->master_host, result->status,
        result->records_received, result->records_added,
        result->records_updated, result->records_deleted,
        result->transfer_time,
        escaped_error ? "'" : "NULL",
        escaped_error ? escaped_error : "",
        escaped_error ? "'" : "");

    sql_query(db, query, strlen(query));

    if (escaped_error) {
        RELEASE(escaped_error);
    }
}

/*===========================================================================
 * NOTIFY Protocol Support (RFC 1996)
 *===========================================================================*/

/**
 * Create UDP socket for receiving NOTIFY messages
 */
int axfr_notify_listen(int port) {
    int sockfd;
    struct sockaddr_in addr;
    int optval = 1;

    /* Create UDP socket */
    sockfd = socket(AF_INET, SOCK_DGRAM, 0);
    if (sockfd < 0) {
        Warnx(_("Failed to create NOTIFY socket: %s"), strerror(errno));
        return -1;
    }

    /* Set socket options */
    if (setsockopt(sockfd, SOL_SOCKET, SO_REUSEADDR, &optval, sizeof(optval)) < 0) {
        Warnx(_("Failed to set SO_REUSEADDR: %s"), strerror(errno));
        close(sockfd);
        return -1;
    }

    /* Bind to port */
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = INADDR_ANY;
    addr.sin_port = htons(port);

    if (bind(sockfd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        Warnx(_("Failed to bind NOTIFY socket to port %d: %s"), port, strerror(errno));
        close(sockfd);
        return -1;
    }

    /* Set non-blocking mode */
    int flags = fcntl(sockfd, F_GETFL, 0);
    fcntl(sockfd, F_SETFL, flags | O_NONBLOCK);

    Notice(_("NOTIFY listener created on UDP port %d"), port);
    return sockfd;
}

/**
 * Parse DNS name from wire format
 */
static int parse_dns_name(const unsigned char *buf, size_t buflen, size_t *offset,
                          char *name, size_t name_size) {
    size_t pos = *offset;
    size_t name_pos = 0;
    int compression_count = 0;
    const int MAX_COMPRESSION = 10;  /* Prevent infinite loops */

    while (pos < buflen && compression_count < MAX_COMPRESSION) {
        unsigned char len = buf[pos];

        /* End of name */
        if (len == 0) {
            pos++;
            if (name_pos > 0 && name_pos < name_size) {
                name[name_pos - 1] = '\0';  /* Remove trailing dot */
            } else if (name_pos == 0 && name_pos < name_size) {
                name[0] = '.';
                name[1] = '\0';
            }
            *offset = pos;
            return 0;
        }

        /* Compression pointer */
        if ((len & 0xC0) == 0xC0) {
            if (pos + 1 >= buflen) {
                return -1;
            }
            uint16_t ptr = ((len & 0x3F) << 8) | buf[pos + 1];
            if (ptr >= buflen) {
                return -1;
            }
            pos = ptr;
            compression_count++;
            continue;
        }

        /* Label */
        if (len > 63 || pos + len + 1 > buflen) {
            return -1;
        }

        if (name_pos + len + 1 >= name_size) {
            return -1;  /* Name too long */
        }

        pos++;
        memcpy(name + name_pos, buf + pos, len);
        name_pos += len;
        name[name_pos++] = '.';
        pos += len;
    }

    return -1;  /* Name parsing failed */
}

/**
 * Parse NOTIFY message and extract zone name
 */
int axfr_notify_parse(const unsigned char *message, size_t length,
                      char *zone_name, size_t zone_name_size, uint16_t *query_id) {
    if (!message || length < 12 || !zone_name || !query_id) {
        return -1;
    }

    /* Parse DNS header */
    *query_id = (message[0] << 8) | message[1];
    uint16_t flags = (message[2] << 8) | message[3];
    uint16_t qdcount = (message[4] << 8) | message[5];

    /* Check opcode (bits 11-14) should be 4 for NOTIFY */
    uint8_t opcode = (flags >> 11) & 0x0F;
    if (opcode != 4) {
        Warnx(_("Not a NOTIFY message (opcode=%d)"), opcode);
        return -1;
    }

    /* Check that there's exactly one question */
    if (qdcount != 1) {
        Warnx(_("Invalid NOTIFY message (qdcount=%d)"), qdcount);
        return -1;
    }

    /* Parse question section */
    size_t offset = 12;  /* Skip header */
    if (parse_dns_name(message, length, &offset, zone_name, zone_name_size) < 0) {
        Warnx(_("Failed to parse zone name from NOTIFY"));
        return -1;
    }

    /* Verify there's enough space for QTYPE and QCLASS */
    if (offset + 4 > length) {
        return -1;
    }

    uint16_t qtype = (message[offset] << 8) | message[offset + 1];
    uint16_t qclass = (message[offset + 2] << 8) | message[offset + 3];

    /* NOTIFY should have QTYPE=SOA (6) */
    if (qtype != 6) {
        Warnx(_("NOTIFY with unexpected QTYPE=%d"), qtype);
    }

    Notice(_("Received NOTIFY for zone: %s (qid=%04x)"), zone_name, *query_id);
    return 0;
}

/**
 * Encode DNS name to wire format
 */
static int encode_dns_name(const char *name, unsigned char *buf, size_t bufsize) {
    size_t pos = 0;
    const char *label_start = name;
    const char *p = name;

    while (*p) {
        if (*p == '.') {
            size_t label_len = p - label_start;
            if (label_len > 63 || pos + label_len + 1 > bufsize) {
                return -1;
            }
            buf[pos++] = label_len;
            memcpy(buf + pos, label_start, label_len);
            pos += label_len;
            label_start = p + 1;
        }
        p++;
    }

    /* Last label */
    size_t label_len = p - label_start;
    if (label_len > 0) {
        if (label_len > 63 || pos + label_len + 2 > bufsize) {
            return -1;
        }
        buf[pos++] = label_len;
        memcpy(buf + pos, label_start, label_len);
        pos += label_len;
    }

    /* Terminating zero */
    if (pos + 1 > bufsize) {
        return -1;
    }
    buf[pos++] = 0;

    return pos;
}

/**
 * Send NOTIFY response
 */
int axfr_notify_respond(int sockfd, uint16_t query_id, const char *zone_name,
                        struct sockaddr *addr, socklen_t addrlen) {
    unsigned char response[512];
    size_t pos = 0;

    if (!zone_name || !addr) {
        return -1;
    }

    /* DNS header */
    response[pos++] = (query_id >> 8) & 0xFF;
    response[pos++] = query_id & 0xFF;

    /* Flags: QR=1 (response), OPCODE=4 (NOTIFY), AA=0, TC=0, RD=0, RA=0, RCODE=0 */
    response[pos++] = 0x24;  /* 00100100 = QR=1, OPCODE=4 (NOTIFY) */
    response[pos++] = 0x00;  /* RCODE=0 (no error) */

    /* QDCOUNT = 1 */
    response[pos++] = 0x00;
    response[pos++] = 0x01;

    /* ANCOUNT = 0 */
    response[pos++] = 0x00;
    response[pos++] = 0x00;

    /* NSCOUNT = 0 */
    response[pos++] = 0x00;
    response[pos++] = 0x00;

    /* ARCOUNT = 0 */
    response[pos++] = 0x00;
    response[pos++] = 0x00;

    /* Question section */
    int name_len = encode_dns_name(zone_name, response + pos, sizeof(response) - pos);
    if (name_len < 0) {
        Warnx(_("Failed to encode zone name in NOTIFY response"));
        return -1;
    }
    pos += name_len;

    /* QTYPE = SOA (6) */
    response[pos++] = 0x00;
    response[pos++] = 0x06;

    /* QCLASS = IN (1) */
    response[pos++] = 0x00;
    response[pos++] = 0x01;

    /* Send response */
    ssize_t sent = sendto(sockfd, response, pos, 0, addr, addrlen);
    if (sent < 0) {
        Warnx(_("Failed to send NOTIFY response: %s"), strerror(errno));
        return -1;
    }

    return 0;
}

/**
 * Process received NOTIFY message
 */
int axfr_notify_process(SQL *db, const char *zone_name, const char *source_ip) {
    char query[1024];
    SQL_RES *res;
    SQL_ROW row;
    int zone_id = 0;

    if (!db || !zone_name || !source_ip) {
        return -1;
    }

    /* Find zone configuration and verify source is authorized master */
    snprintf(query, sizeof(query),
        "SELECT zm.zone_id, s.origin "
        "FROM zone_masters zm "
        "JOIN soa s ON s.id = zm.zone_id "
        "WHERE s.origin = '%s' AND zm.master_host = '%s'",
        zone_name, source_ip);

    res = sql_query(db, query, strlen(query));
    if (!res) {
        Warnx(_("Database error checking NOTIFY authorization"));
        return -1;
    }

    if (sql_num_rows(res) == 0) {
        Warnx(_("Unauthorized NOTIFY from %s for zone %s"), source_ip, zone_name);
        sql_free(res);
        return -1;
    }

    row = sql_getrow(res, NULL);
    if (row) {
        zone_id = atoi(row[0]);
    }
    sql_free(res);

    Notice(_("Authorized NOTIFY from %s for zone %s (zone_id=%d)"),
           source_ip, zone_name, zone_id);

    /* Update last_notify timestamp */
    snprintf(query, sizeof(query),
        "UPDATE zone_masters SET last_notify = NOW() WHERE zone_id = %d AND master_host = '%s'",
        zone_id, source_ip);
    sql_query(db, query, strlen(query));

    return zone_id;  /* Return zone_id to trigger immediate transfer */
}

/*===========================================================================
 * IXFR Protocol Support (RFC 1995)
 *===========================================================================*/

/**
 * Create IXFR query packet with current serial in authority section
 */
int axfr_create_ixfr_query(const char *zone_name, uint16_t query_id,
                           uint32_t current_serial, unsigned char *buffer, size_t buffer_size) {
    unsigned char *p = buffer;
    size_t remaining = buffer_size;

    if (!zone_name || !buffer || buffer_size < 512) {
        return -1;
    }

    /* DNS Header */
    /* Query ID */
    *p++ = (query_id >> 8) & 0xFF;
    *p++ = query_id & 0xFF;

    /* Flags: Standard query, RD=0 */
    *p++ = 0x00;
    *p++ = 0x00;

    /* QDCOUNT = 1 */
    *p++ = 0x00;
    *p++ = 0x01;

    /* ANCOUNT = 0 */
    *p++ = 0x00;
    *p++ = 0x00;

    /* NSCOUNT = 1 (authority section with current SOA serial) */
    *p++ = 0x00;
    *p++ = 0x01;

    /* ARCOUNT = 0 */
    *p++ = 0x00;
    *p++ = 0x00;

    /* Question section */
    const char *label_start = zone_name;
    const char *c = zone_name;

    while (*c) {
        if (*c == '.') {
            size_t label_len = c - label_start;
            if (label_len > 0 && label_len <= 63) {
                *p++ = label_len;
                memcpy(p, label_start, label_len);
                p += label_len;
            }
            label_start = c + 1;
        }
        c++;
    }

    /* Last label */
    size_t label_len = c - label_start;
    if (label_len > 0 && label_len <= 63) {
        *p++ = label_len;
        memcpy(p, label_start, label_len);
        p += label_len;
    }

    /* Terminating zero */
    *p++ = 0x00;

    /* QTYPE = IXFR (251) */
    *p++ = 0x00;
    *p++ = 0xFB;  /* 251 = IXFR */

    /* QCLASS = IN (1) */
    *p++ = 0x00;
    *p++ = 0x01;

    /* Authority section - SOA with current serial */
    /* Name (compression pointer to question) */
    *p++ = 0xC0;
    *p++ = 0x0C;

    /* TYPE = SOA (6) */
    *p++ = 0x00;
    *p++ = 0x06;

    /* CLASS = IN (1) */
    *p++ = 0x00;
    *p++ = 0x01;

    /* TTL = 0 */
    *p++ = 0x00;
    *p++ = 0x00;
    *p++ = 0x00;
    *p++ = 0x00;

    /* RDLENGTH = 22 (minimal SOA: 1 + 1 + 20 bytes) */
    *p++ = 0x00;
    *p++ = 0x16;  /* 22 bytes */

    /* RDATA - Minimal SOA */
    /* MNAME = . (root) */
    *p++ = 0x00;

    /* RNAME = . (root) */
    *p++ = 0x00;

    /* Serial */
    *p++ = (current_serial >> 24) & 0xFF;
    *p++ = (current_serial >> 16) & 0xFF;
    *p++ = (current_serial >> 8) & 0xFF;
    *p++ = current_serial & 0xFF;

    /* Refresh, Retry, Expire, Minimum = 0 */
    memset(p, 0, 16);
    p += 16;

    return p - buffer;
}

/**
 * Perform IXFR transfer with fallback to AXFR
 */
int axfr_ixfr_transfer_zone(SQL *db, axfr_zone_t *zone, axfr_result_t *result) {
    int sockfd = -1;
    unsigned char query[512];
    unsigned char response[65536];
    int query_size;
    ssize_t response_size;
    axfr_record_t *records = NULL;
    int is_axfr_fallback = 0;
    time_t start_time, end_time;

    if (!db || !zone || !result) {
        return -1;
    }

    memset(result, 0, sizeof(axfr_result_t));
    start_time = time(NULL);

    /* Create IXFR query */
    query_size = axfr_create_ixfr_query(zone->zone_name, 0x1234, zone->current_serial, query, sizeof(query));
    if (query_size < 0) {
        result->status = AXFR_ERROR;
        result->error_message = strdup("Failed to create IXFR query");
        return -1;
    }

    /* Connect to master server */
    sockfd = axfr_connect_master(zone->master_host, zone->master_port, 10);
    if (sockfd < 0) {
        result->status = AXFR_NETWORK_ERROR;
        result->error_message = strdup("Failed to connect to master server");
        return -1;
    }

    /* Send IXFR query */
    if (axfr_send_query(sockfd, query, query_size) < 0) {
        result->status = AXFR_NETWORK_ERROR;
        result->error_message = strdup("Failed to send IXFR query");
        close(sockfd);
        return -1;
    }

    /* Receive response(s) */
    response_size = axfr_receive_response(sockfd, response, sizeof(response), 30);
    if (response_size <= 0) {
        result->status = AXFR_TIMEOUT;
        result->error_message = strdup("No response from master server");
        close(sockfd);
        return -1;
    }

    close(sockfd);

    /* Parse IXFR response */
    int record_count = axfr_parse_ixfr_response(response, response_size,
                                                 zone->current_serial, &records, &is_axfr_fallback);

    if (record_count < 0) {
        result->status = AXFR_PARSE_ERROR;
        result->error_message = strdup("Failed to parse IXFR response");
        return -1;
    }

    result->records_received = record_count;

    /* Check if master fell back to AXFR */
    if (is_axfr_fallback) {
        Notice(_("Master sent AXFR instead of IXFR for zone %s - applying full transfer"), zone->zone_name);

        /* Use regular AXFR processing */
        if (axfr_update_database(db, zone, records, result) < 0) {
            result->status = AXFR_DATABASE_ERROR;
            axfr_free_records(records);
            return -1;
        }

        /* Update memzone if available */
        if (Memzone) {
            axfr_update_memzone(Memzone, zone, records, result);
        }
    } else {
        Notice(_("Applying IXFR changes for zone %s"), zone->zone_name);

        /* Apply incremental changes */
        if (axfr_apply_ixfr_changes(db, zone, records, result) < 0) {
            result->status = AXFR_DATABASE_ERROR;
            axfr_free_records(records);
            return -1;
        }
    }

    axfr_free_records(records);

    end_time = time(NULL);
    result->transfer_time = end_time - start_time;
    result->status = AXFR_SUCCESS;

    return 0;
}

/**
 * Parse IXFR response - simplified implementation
 * Note: Full IXFR parsing is complex and requires handling multiple SOA records
 */
int axfr_parse_ixfr_response(const unsigned char *response, size_t length,
                             uint32_t current_serial, axfr_record_t **records,
                             int *is_axfr_fallback) {
    /* Check DNS header */
    if (length < 12) {
        return -1;
    }

    uint16_t flags = (response[2] << 8) | response[3];
    uint16_t ancount = (response[6] << 8) | response[7];

    /* Check if it's a response */
    if ((flags & 0x8000) == 0) {
        return -1;
    }

    /* Check response code */
    uint8_t rcode = flags & 0x0F;
    if (rcode != 0) {
        Warnx(_("IXFR query returned error code: %d"), rcode);
        return -1;
    }

    if (ancount == 0) {
        return 0;  /* No records */
    }

    /*
     * Simplified IXFR detection:
     * - If response has only one SOA record followed by other records, it's AXFR fallback
     * - If response has multiple SOA records with same serial, it's proper IXFR
     *
     * For now, we'll use axfr_parse_response and check if it's incremental
     * A full implementation would parse SOA boundaries and build change sequences
     */

    int record_count = axfr_parse_response(response, length, records);

    if (record_count < 0) {
        return -1;
    }

    /* Simple heuristic: if first record is SOA with serial > current_serial,
     * and we have more than just SOA records, treat as AXFR fallback */
    if (*records && strcmp((*records)->type, "SOA") == 0) {
        /* Extract serial from SOA data */
        char soa_copy[1024];
        strncpy(soa_copy, (*records)->data, sizeof(soa_copy) - 1);

        /* Parse: "ns mbox serial ..." */
        char *tok = strtok(soa_copy, " ");  /* ns */
        tok = strtok(NULL, " ");            /* mbox */
        tok = strtok(NULL, " ");            /* serial */

        if (tok) {
            uint32_t response_serial = atoi(tok);

            /* If single SOA at current serial followed by records, it's likely IXFR
             * If SOA has new serial and many records, it's likely AXFR fallback */
            if (response_serial > current_serial && record_count > 5) {
                *is_axfr_fallback = 1;
                Notice(_("Detected AXFR fallback (serial %u > %u, %d records)"),
                       response_serial, current_serial, record_count);
            } else {
                *is_axfr_fallback = 0;
            }
        }
    }

    return record_count;
}

/**
 * Apply IXFR changes to database - simplified implementation
 *
 * Full IXFR format has delete/add sequences marked by SOA records:
 *   SOA (new)    <- marks beginning
 *   SOA (old)    <- marks start of deletes
 *   ... deleted records ...
 *   SOA (new)    <- marks start of adds
 *   ... added records ...
 *   SOA (new)    <- marks end
 *
 * For simplicity, this implementation applies changes as updates
 */
int axfr_apply_ixfr_changes(SQL *db, axfr_zone_t *zone,
                            axfr_record_t *records, axfr_result_t *result) {
    axfr_record_t *rec;
    char query[4096];

    if (!db || !zone || !records || !result) {
        return -1;
    }

    /* Start transaction */
    sql_query(db, "BEGIN", strlen("BEGIN"));

    /* Process records */
    for (rec = records; rec != NULL; rec = rec->next) {
        /* Skip SOA records (they mark boundaries) */
        if (strcmp(rec->type, "SOA") == 0) {
            /* Update SOA serial from last SOA in response */
            char soa_copy[1024];
            strncpy(soa_copy, rec->data, sizeof(soa_copy) - 1);

            char *tok = strtok(soa_copy, " ");  /* ns */
            tok = strtok(NULL, " ");            /* mbox */
            tok = strtok(NULL, " ");            /* serial */

            if (tok) {
                result->new_serial = atoi(tok);
            }
            continue;
        }

        /* For other records, check if exists and update, or insert */
        char *escaped_name = sql_escstr(db, rec->name);
        char *escaped_data = sql_escstr(db, rec->data);

        /* Try to update existing record */
        snprintf(query, sizeof(query),
            "UPDATE rr SET data = '%s', aux = %u, ttl = %u "
            "WHERE zone = %d AND name = '%s' AND type = '%s'",
            escaped_data, rec->aux, rec->ttl,
            zone->zone_id, escaped_name, rec->type);

        SQL_RES *res = sql_query(db, query, strlen(query));

        /* Check if update succeeded - if res is NULL, try insert */
        if (!res) {
            /* Record doesn't exist, insert it */
            snprintf(query, sizeof(query),
                "INSERT INTO rr (zone, name, type, data, aux, ttl) "
                "VALUES (%d, '%s', '%s', '%s', %u, %u)",
                zone->zone_id, escaped_name, rec->type, escaped_data, rec->aux, rec->ttl);

            res = sql_query(db, query, strlen(query));
            if (res) {
                result->records_added++;
                sql_free(res);
            }
        } else {
            result->records_updated++;
            sql_free(res);
        }

        RELEASE(escaped_name);
        RELEASE(escaped_data);
    }

    /* Update SOA serial */
    if (result->new_serial > 0) {
        snprintf(query, sizeof(query),
            "UPDATE soa SET serial = %u, master_updated = NOW() WHERE id = %d",
            result->new_serial, zone->zone_id);
        sql_query(db, query, strlen(query));
    }

    /* Commit transaction */
    sql_query(db, "COMMIT", strlen("COMMIT"));

    Notice(_("Applied IXFR changes: %d added, %d updated"),
           result->records_added, result->records_updated);

    return 0;
}
