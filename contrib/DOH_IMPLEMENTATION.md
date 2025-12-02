# DNS over HTTPS (DoH) Implementation for MyDNS

**Version:** 1.3.0
**RFC:** [RFC 8484](https://tools.ietf.org/html/rfc8484)
**Author:** Dan Caescu <dan.caescu@multitel.net>
**Date:** November 2025
**Status:** ✅ **FULLY IMPLEMENTED AND TESTED**

---

## Executive Summary

MyDNS now includes a complete, production-ready DNS over HTTPS (DoH) server implementation following RFC 8484. The DoH server runs in a separate thread alongside the standard DNS server, providing secure DNS queries over HTTPS on a configurable port (default 8443, can use 443 with proper privileges).

**Key Features:**
- ✅ RFC 8484 compliant
- ✅ Both GET and POST methods supported
- ✅ TLS 1.2+ with OpenSSL
- ✅ Base64url encoding for GET requests
- ✅ Configurable via database or config file
- ✅ Non-blocking threaded architecture
- ✅ Statistics tracking
- ✅ Standard HTTP headers and status codes
- ✅ IPv6 dual-stack support

---

## Architecture Overview

### Components

```
┌─────────────────────────────────────────────────────────────┐
│                        MyDNS Server                         │
│                                                               │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐  │
│  │  UDP Server  │    │  TCP Server  │    │  DoH Server  │  │
│  │   Port 53    │    │   Port 53    │    │  Port 8443   │  │
│  └──────────────┘    └──────────────┘    └──────────────┘  │
│         │                    │                    │          │
│         └────────────────────┴────────────────────┘          │
│                              │                                │
│                    ┌─────────▼─────────┐                     │
│                    │  Query Processing │                     │
│                    │  (resolve.c)      │                     │
│                    └─────────┬─────────┘                     │
│                              │                                │
│                    ┌─────────▼─────────┐                     │
│                    │   Database / Cache│                     │
│                    └───────────────────┘                     │
└─────────────────────────────────────────────────────────────┘
```

### Files

1. **`src/lib/doh.h`** (218 lines)
   - Type definitions
   - API declarations
   - Configuration structures

2. **`src/lib/doh.c`** (600+ lines)
   - Complete DoH server implementation
   - HTTP parsing (GET and POST)
   - Base64url decoding
   - SSL/TLS handling
   - Request/response processing

3. **`contrib/doh-schema.sql`**
   - Database schema for configuration
   - Statistics table (optional)
   - Usage instructions

---

## Installation and Configuration

### 1. Database Setup

Apply the DoH schema to your MyDNS database:

```bash
mysql -u root -p your_database < contrib/doh-schema.sql
```

This creates two tables:
- `doh_config` - Server configuration
- `doh_stats` - Statistics tracking (optional)

### 2. Generate TLS Certificates

DoH requires valid TLS certificates. For testing, generate self-signed certificates:

```bash
openssl req -x509 -newkey rsa:4096 \
  -keyout /etc/mydns/doh-key.pem \
  -out /etc/mydns/doh-cert.pem \
  -days 365 -nodes \
  -subj "/CN=dns.yourdomain.com"

# Set proper permissions
chmod 600 /etc/mydns/doh-key.pem
chmod 644 /etc/mydns/doh-cert.pem
```

For production, use certificates from Let's Encrypt or your certificate authority.

### 3. Enable DoH

**Option A: Database Configuration (Recommended)**

```sql
UPDATE doh_config SET
  enabled = 1,
  port = 8443,  -- Use 443 for production
  cert_file = '/etc/mydns/doh-cert.pem',
  key_file = '/etc/mydns/doh-key.pem'
WHERE id = 1;
```

**Option B: Config File (`/etc/mydns/mydns.conf`)**

```ini
doh-enabled = 1
doh-port = 8443
doh-path = /dns-query
doh-cert = /etc/mydns/doh-cert.pem
doh-key = /etc/mydns/doh-key.pem
```

**Configuration Priority:**
1. Database (`doh_config` table) - highest priority
2. Config file (`mydns.conf`) - medium priority
3. Hardcoded defaults - lowest priority

### 4. Restart MyDNS

```bash
systemctl restart mydns

# Verify DoH is running
journalctl -u mydns -n 20 | grep -i doh
```

Expected log messages:
```
Loaded DoH configuration from database
SSL context initialized successfully
DoH server initialized: port 8443, path /dns-query
DoH server started on port 8443, path /dns-query
DoH server thread started on port 8443
```

### 5. Verify Listening Port

```bash
netstat -tlnp | grep 8443
# Expected output:
# tcp6  0  0 :::8443  :::*  LISTEN  <pid>/mydns
```

---

## Testing

### POST Method Test

```bash
# Create a DNS query for www.example.com
echo -n "AAABAAABAAAAAAAAA3d3dwdleGFtcGxlA2NvbQAAAQAB" | base64 -d > /tmp/dns-query.bin

# Send via DoH (POST)
curl -k -H "Content-Type: application/dns-message" \
  --data-binary @/tmp/dns-query.bin \
  https://localhost:8443/dns-query | xxd

# -k flag skips certificate verification (for self-signed certs)
```

### GET Method Test

```bash
# Send via DoH (GET with base64url encoded query)
curl -k "https://localhost:8443/dns-query?dns=AAABAAABAAAAAAAAA3d3dwdleGFtcGxlA2NvbQAAAQAB"
```

### Using dig and curl

```bash
# Query using dig, convert to wire format, send via DoH
dig @localhost example.com +bufsize=512 +dnssec | \
  xxd -r -p | \
  curl -k -H "Content-Type: application/dns-message" \
       --data-binary @- \
       https://localhost:8443/dns-query | \
  xxd -p
```

### Test from Remote Client

```bash
# From another machine
curl -k -H "Content-Type: application/dns-message" \
  --data-binary @dns-query.bin \
  https://your-server-ip:8443/dns-query
```

---

## Configuration Options

### Database Table: `doh_config`

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | TINYINT(1) | 0 | Enable/disable DoH server |
| `port` | INT | 443 | HTTPS port (443 or 8443) |
| `path` | VARCHAR(255) | `/dns-query` | URL path for DNS queries |
| `cert_file` | VARCHAR(512) | `/etc/mydns/doh-cert.pem` | TLS certificate file (PEM) |
| `key_file` | VARCHAR(512) | `/etc/mydns/doh-key.pem` | TLS private key file (PEM) |
| `max_connections` | INT | 100 | Max concurrent connections |
| `timeout_sec` | INT | 5 | Request timeout in seconds |
| `require_content_type` | TINYINT(1) | 1 | Require `application/dns-message` |

### Config File Options (`mydns.conf`)

```ini
# Enable DoH server (0 = disabled, 1 = enabled)
doh-enabled = 1

# HTTPS port (default 443)
doh-port = 8443

# URL path for DNS queries (default /dns-query)
doh-path = /dns-query

# TLS certificate file (PEM format)
doh-cert = /etc/mydns/doh-cert.pem

# TLS private key file (PEM format)
doh-key = /etc/mydns/doh-key.pem
```

---

## Protocol Details

### HTTP Methods

**POST Method (Binary DNS Query)**

```http
POST /dns-query HTTP/1.1
Host: dns.example.com
Content-Type: application/dns-message
Content-Length: 33

<binary DNS query in wire format>
```

**GET Method (Base64url Encoded)**

```http
GET /dns-query?dns=AAABAAABAAAAAAAAA3d3dwdleGFtcGxlA2NvbQAAAQAB HTTP/1.1
Host: dns.example.com
```

### HTTP Response

```http
HTTP/1.1 200 OK
Content-Type: application/dns-message
Content-Length: 64
Cache-Control: max-age=300

<binary DNS response in wire format>
```

### HTTP Status Codes

| Code | Meaning | When Returned |
|------|---------|---------------|
| 200 | OK | Successful DNS query |
| 400 | Bad Request | Invalid DNS query format |
| 404 | Not Found | Wrong URL path |
| 405 | Method Not Allowed | HTTP method other than GET/POST |
| 413 | Payload Too Large | Query exceeds 4096 bytes |
| 415 | Unsupported Media Type | Wrong Content-Type header |
| 500 | Internal Server Error | Server processing error |

---

## Security Considerations

### TLS Configuration

- **Minimum TLS version:** TLS 1.2
- **Recommended:** TLS 1.3
- **Cipher suites:** Modern, secure ciphers only (configured via OpenSSL)

### Certificate Requirements

- **Production:** Use valid certificates from trusted CA (Let's Encrypt, DigiCert, etc.)
- **Testing:** Self-signed certificates work but require `-k` flag in curl
- **Key strength:** Minimum RSA 2048-bit, recommended 4096-bit
- **Certificate validity:** Monitor expiration dates

### Port Selection

- **Port 443:** Standard HTTPS port, requires root or `CAP_NET_BIND_SERVICE`
- **Port 8443:** Alternative port, no special privileges needed
- **Firewall:** Ensure the DoH port is open in your firewall

### Access Control

- DoH inherits MyDNS ACL rules
- Consider rate limiting at reverse proxy level (nginx, HAProxy)
- Monitor for abuse via statistics

---

## Performance Tuning

### Threading

DoH runs in a separate thread to avoid blocking standard DNS queries. Each client connection is handled serially within the DoH thread.

**Recommendations:**
- Monitor DoH thread CPU usage
- Consider multiple MyDNS instances behind a load balancer for high traffic
- Use `max_connections` to limit resource usage

### Timeouts

Default timeout: 5 seconds per request

```sql
UPDATE doh_config SET timeout_sec = 10 WHERE id = 1;
```

### SSL Session Caching

OpenSSL session caching is enabled by default to reduce TLS handshake overhead.

---

## Statistics and Monitoring

### In-Memory Statistics

The DoH server tracks statistics in memory:

```c
typedef struct {
    uint64_t total_requests;       // Total requests received
    uint64_t get_requests;         // GET method requests
    uint64_t post_requests;        // POST method requests
    uint64_t successful_queries;   // Successful DNS queries
    uint64_t failed_queries;       // Failed DNS queries
    uint64_t invalid_requests;     // Invalid HTTP requests
    uint64_t acl_denials;          // Denied by ACL
    uint64_t bytes_sent;           // Total bytes sent
    uint64_t bytes_received;       // Total bytes received
    time_t started;                // Server start time
} doh_stats_t;
```

### Database Statistics (Optional)

The `doh_stats` table can be populated by external monitoring tools:

```sql
-- Insert statistics snapshot
INSERT INTO doh_stats (
  total_requests, get_requests, post_requests,
  successful_queries, failed_queries, bytes_sent, bytes_received
) VALUES (1000, 400, 600, 950, 50, 524288, 131072);

-- View recent statistics
SELECT * FROM doh_stats ORDER BY timestamp DESC LIMIT 10;
```

### Monitoring Commands

```bash
# Check DoH process status
ps aux | grep mydns

# Check DoH port
netstat -tlnp | grep 8443

# Monitor DoH logs
journalctl -u mydns -f | grep -i doh

# Test DoH availability
curl -k -I https://localhost:8443/dns-query
```

---

## Troubleshooting

### DoH Server Not Starting

**Problem:** No DoH log messages in journal

**Solutions:**
1. Check `enabled` flag in database: `SELECT enabled FROM doh_config;`
2. Verify certificate files exist: `ls -l /etc/mydns/doh-*.pem`
3. Check certificate permissions: `chmod 600 /etc/mydns/doh-key.pem`
4. Verify OpenSSL installation: `openssl version`

### Port Already in Use

**Problem:** `Address already in use` error

**Solutions:**
1. Check what's using the port: `netstat -tlnp | grep 8443`
2. Change DoH port: `UPDATE doh_config SET port = 9443 WHERE id = 1;`
3. Stop conflicting service

### SSL Handshake Failures

**Problem:** TLS connection fails

**Solutions:**
1. Verify certificate validity: `openssl x509 -in /etc/mydns/doh-cert.pem -text -noout`
2. Check private key matches: `openssl rsa -in /etc/mydns/doh-key.pem -check`
3. Test with verbose curl: `curl -kv https://localhost:8443/dns-query`
4. Check OpenSSL errors: `journalctl -u mydns | grep -i ssl`

### HTTP 404 Errors

**Problem:** Wrong URL path

**Solutions:**
1. Verify path configuration: `SELECT path FROM doh_config;`
2. Use correct path: `/dns-query` (default)
3. Check curl command: `curl -k https://localhost:8443/dns-query`

### HTTP 415 Errors

**Problem:** Missing or incorrect Content-Type

**Solutions:**
1. Always include header: `-H "Content-Type: application/dns-message"`
2. For POST requests, use `--data-binary @file`, not `-d`

---

## Integration Examples

### nginx Reverse Proxy

```nginx
server {
    listen 443 ssl http2;
    server_name dns.example.com;

    ssl_certificate /etc/letsencrypt/live/dns.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/dns.example.com/privkey.pem;

    location /dns-query {
        proxy_pass https://127.0.0.1:8443;
        proxy_ssl_verify off;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_buffering off;
    }
}
```

### HAProxy Configuration

```
frontend doh_frontend
    bind *:443 ssl crt /etc/ssl/certs/dns.example.com.pem
    mode http
    default_backend doh_backend

backend doh_backend
    mode http
    server doh1 127.0.0.1:8443 ssl verify none
```

### systemd Service

MyDNS service file should include:

```ini
[Service]
# Allow binding to port 443
AmbientCapabilities=CAP_NET_BIND_SERVICE
```

---

## Production Deployment Checklist

- [ ] Valid TLS certificates from trusted CA
- [ ] DoH configured to use port 443
- [ ] Firewall rules allow port 443/tcp
- [ ] SELinux/AppArmor policies updated
- [ ] Reverse proxy configured (optional)
- [ ] Monitoring alerts set up
- [ ] Statistics collection enabled
- [ ] Certificate auto-renewal configured
- [ ] Load balancing configured (if needed)
- [ ] Rate limiting implemented
- [ ] ACL rules reviewed
- [ ] Backup configuration documented

---

## RFC 8484 Compliance

This implementation follows RFC 8484 specifications:

- ✅ Section 4.1: HTTP Methods (GET and POST)
- ✅ Section 4.2: HTTP Status Codes
- ✅ Section 5: DNS Wire Format
- ✅ Section 6: HTTP Headers
- ✅ Section 7: HTTP Caching
- ✅ Section 8: Security Considerations

**Notable deviations:** None

---

## Future Enhancements

Potential improvements for future versions:

1. **HTTP/2 Support** - Native HTTP/2 for better multiplexing
2. **Connection Pooling** - Reuse connections for better performance
3. **Advanced Caching** - DoH-specific caching layer
4. **Prometheus Metrics** - Export statistics in Prometheus format
5. **DNSSEC Integration** - Full DNSSEC validation for DoH queries
6. **Geographic Load Balancing** - GeoIP-aware DoH routing

---

## API Reference

### Initialization

```c
doh_ctx_t *doh_init(SQL *db, int conf_enabled, int conf_port,
                    const char *conf_path, const char *conf_cert,
                    const char *conf_key);
```

### Start/Stop

```c
int doh_start(doh_ctx_t *ctx);
void doh_stop(doh_ctx_t *ctx);
void doh_free(doh_ctx_t *ctx);
```

### Statistics

```c
const doh_stats_t *doh_get_stats(doh_ctx_t *ctx);
```

---

## Support and Resources

- **GitHub Repository:** MyDNS-NG Project
- **RFC 8484:** https://tools.ietf.org/html/rfc8484
- **OpenSSL Documentation:** https://www.openssl.org/docs/
- **Let's Encrypt:** https://letsencrypt.org/

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | Nov 2025 | Initial DoH implementation |
| | | - RFC 8484 compliant |
| | | - GET and POST methods |
| | | - TLS 1.2+ support |
| | | - Threaded architecture |
| | | - Database configuration |
| | | - Statistics tracking |

---

## Credits

**Implementation:** Dan Caescu <dan.caescu@multitel.net>
**MyDNS Project:** Don Moore and contributors
**RFC 8484:** P. Hoffman, P. McManus (IETF)

---

## License

This implementation is part of MyDNS and is licensed under the GNU General Public License version 2.

```
Copyright (C) 2025 Dan Caescu <dan.caescu@multitel.net>

This program is free software; you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation; either version 2 of the License, or
(at your option) any later version.
```

---

**End of Documentation**
