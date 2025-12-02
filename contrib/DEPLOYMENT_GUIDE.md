# MyDNS 1.3.0 Comprehensive Deployment Guide

**Copyright (C) 2025 Dan Caescu <dan.caescu@multitel.net>**

This guide covers complete deployment of MyDNS 1.3.0 with all enterprise features including TSIG, DNS UPDATE, IXFR, NOTIFY, DNSSEC, DoH, DNS caching, memzone, and the modern web UI with multi-user support.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Quick Start](#quick-start)
3. [Installation Methods](#installation-methods)
4. [Database Setup](#database-setup)
5. [Configuration](#configuration)
6. [Deployment Scenarios](#deployment-scenarios)
7. [Web UI Deployment](#web-ui-deployment)
8. [Multi-User Features](#multi-user-features)
9. [Security Hardening](#security-hardening)
10. [Monitoring](#monitoring)
11. [Troubleshooting](#troubleshooting)

---

## Prerequisites

### System Requirements

**Minimum:**
- Linux server (Debian 11+, Ubuntu 20.04+, RHEL 8+)
- 2 CPU cores
- 2GB RAM (4GB+ recommended with DNS cache enabled)
- 10GB disk space

**For Production:**
- 4+ CPU cores
- 8GB+ RAM
- SSD storage
- Redundant network connections

### Software Dependencies

```bash
# Debian/Ubuntu
apt-get update
apt-get install -y \
  build-essential \
  autoconf \
  automake \
  libtool \
  libmysqlclient-dev \
  mysql-client \
  libssl-dev \
  zlib1g-dev \
  pkg-config \
  git

# Optional for web UI
apt-get install -y nodejs npm nginx

# Optional for monitoring
apt-get install -y nagios-plugins python3-pip
```

---

## Quick Start

### 1. Clone and Build

```bash
cd /scripts
git clone https://github.com/dancaescu/dns mydns-ng-master
cd mydns-ng-master

# Bootstrap build system
./bootstrap.sh

# Configure with all features enabled
./configure \
  --prefix=/usr/local \
  --sysconfdir=/etc/mydns \
  --localstatedir=/var \
  --with-mysql \
  --enable-static-build

# Build and install
make -j$(nproc)
make install
```

### 2. Database Setup

```bash
# Create database
mysql -u root -p <<EOF
CREATE DATABASE IF NOT EXISTS did CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'mydns'@'localhost' IDENTIFIED BY 'SecurePassword123!';
GRANT ALL PRIVILEGES ON did.* TO 'mydns'@'localhost';
FLUSH PRIVILEGES;
EOF

# Apply base schema
mysql -u root -p did < contrib/mydns.sql

# Apply all feature schemas
for schema in contrib/{tsig,dnsupdate,axfr-ixfr,dnssec,doh,dns-cache,user-cloudflare-acl,axfr-slave,soa-serial-trigger}-schema.sql; do
  echo "Applying $schema..."
  mysql -u root -p did < "$schema"
done
```

### 3. Basic Configuration

```bash
# Create configuration directory
mkdir -p /etc/mydns

# Create basic mydns.conf
cat > /etc/mydns/mydns.conf <<EOF
# Database connection
db-host = localhost
db-user = mydns
db-password = SecurePassword123!
database = did

# Listening
bind = 0.0.0.0

# Enable modern features
tsig-enforce-axfr = yes
allow-update = yes
use-new-update-acl = yes
tsig-required-for-update = yes

# DNS cache
dns-cache-enabled = yes
dns-cache-size = 384
dns-cache-ttl-min = 120
dns-cache-ttl-max = 7200

# DoH (requires TLS certificates)
doh-enabled = no
doh-port = 8443
doh-path = /dns-query

# Audit logging
audit-update-log = yes
audit-tsig-log = yes
EOF

chmod 600 /etc/mydns/mydns.conf
```

### 4. Start MyDNS

```bash
# Test configuration
/usr/local/sbin/mydns -c /etc/mydns/mydns.conf -D

# Start as daemon
/usr/local/sbin/mydns -c /etc/mydns/mydns.conf -b

# Or use systemd
cp contrib/mydns.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable mydns
systemctl start mydns
```

---

## Installation Methods

### Method 1: Manual Installation (Recommended for Development)

See [Quick Start](#quick-start) above.

### Method 2: Ansible Automation (Recommended for Production)

```bash
# Generate Ansible playbooks
cd /scripts/mydns-ng-master/contrib
python3 generate_ansible.py

# Configure inventory
cd ansible
cp inventory.example inventory
vi inventory  # Edit with your servers

# Deploy MyDNS server
ansible-playbook -i inventory mydns-server.yml

# Deploy Web UI
ansible-playbook -i inventory webui.yml

# Apply database schemas
ansible-playbook -i inventory database-schemas.yml

# Setup Cloudflare sync
ansible-playbook -i inventory cloudflare-sync.yml
```

### Method 3: Docker (Future)

Docker support is planned for version 1.3.1.

---

## Database Setup

### Core Schema

```bash
# Base MyDNS tables (soa, rr)
mysql -u root -p did < contrib/mydns.sql
```

### Feature-Specific Schemas

Apply schemas based on your needs:

**TSIG Authentication:**
```bash
mysql -u root -p did < contrib/tsig-schema.sql
```

**DNS UPDATE Protocol:**
```bash
mysql -u root -p did < contrib/dnsupdate-schema.sql
```

**IXFR Incremental Transfers:**
```bash
mysql -u root -p did < contrib/axfr-ixfr-schema.sql
```

**DNSSEC:**
```bash
mysql -u root -p did < contrib/dnssec-schema.sql
```

**DNS over HTTPS:**
```bash
mysql -u root -p did < contrib/doh-schema.sql
```

**DNS Caching:**
```bash
mysql -u root -p did < contrib/dns-cache-schema.sql
```

**Multi-User Features:**
```bash
mysql -u root -p did < contrib/user-cloudflare-acl-schema.sql
```

**Memzone (MySQL-free slaves):**
```bash
mysql -u root -p did < contrib/axfr-slave-schema.sql
```

**Automatic SOA Serial:**
```bash
mysql -u root -p did < contrib/soa-serial-trigger.sql
```

---

## Configuration

### Main Configuration File (`/etc/mydns/mydns.conf`)

```ini
##
## MyDNS 1.3.0 Configuration
##

### Database Connection ###
db-host = localhost
db-user = mydns
db-password = SecurePassword123!
database = did

# Optional: Multiple database hosts for failover
#db-host2 = db-replica1.example.com
#db-host3 = db-replica2.example.com
#db-host-policy = sequential  # or round-robin, least-used

### Network Settings ###
bind = 0.0.0.0              # Listen on all interfaces
#bind = ::                   # IPv6
#port = 53                   # Default DNS port

### TSIG Authentication ###
tsig-enforce-axfr = yes      # Require TSIG for zone transfers
audit-tsig-log = yes         # Log all TSIG operations

### DNS UPDATE ###
allow-update = yes
use-new-update-acl = yes     # Use update_acl table
tsig-required-for-update = yes
audit-update-log = yes       # Log all UPDATE operations

### NOTIFY ###
# NOTIFY runs on UDP port 5300 by default (hardcoded)
# Configure masters in zone_masters table

### DNS Cache ###
dns-cache-enabled = yes
dns-cache-size = 384         # MB
dns-cache-ttl-min = 120      # seconds
dns-cache-ttl-max = 7200     # seconds

### DNS over HTTPS (DoH) ###
doh-enabled = yes
doh-port = 8443
doh-path = /dns-query
doh-cert = /etc/mydns/certs/server.crt
doh-key = /etc/mydns/certs/server.key

### GeoIP ###
#geoip-database = /usr/share/GeoIP/GeoLite2-City.mmdb

### Logging ###
log = /var/log/mydns/mydns.log
#verbose = 2

### Performance ###
#cache-size = 1024           # Query response cache
#cache-expire = 60           # Cache expiration in seconds
```

### Zone Masters Configuration (`/etc/mydns/zone-masters.conf`)

For MySQL-free slave servers using memzone:

```ini
# Format: zone_name:master_ip:master_port:use_tsig:tsig_key_name
example.com:192.168.1.10:53:1:transfer-key
test.org:192.168.1.11:53:0:
another.net:192.168.1.10:53:1:transfer-key
```

### Cloudflare Configuration (`/etc/mydns/cloudflare.ini`)

For global Cloudflare sync (users can add their own via web UI):

```ini
[cloudflare]
email = admin@example.com
api_key = your-global-api-key-here
account_id = your-cloudflare-account-id

# Optional: specific domain
#domain = example.com

# API endpoint
api_url = https://api.cloudflare.com/client/v4
```

---

## Deployment Scenarios

### Scenario 1: Authoritative Master Server

**Purpose:** Primary DNS server with database backend

**Features:**
- Full database access
- TSIG authentication
- DNS UPDATE support
- DNSSEC signing
- Audit logging

**Configuration:**
```bash
# mydns.conf
db-host = localhost
tsig-enforce-axfr = yes
allow-update = yes
tsig-required-for-update = yes
audit-update-log = yes
audit-tsig-log = yes
```

**Database Setup:**
```bash
# Apply all schemas
mysql -u root -p did < contrib/tsig-schema.sql
mysql -u root -p did < contrib/dnsupdate-schema.sql
mysql -u root -p did < contrib/axfr-ixfr-schema.sql
mysql -u root -p did < contrib/dnssec-schema.sql
mysql -u root -p did < contrib/soa-serial-trigger.sql
```

### Scenario 2: MySQL-Free Slave Server

**Purpose:** Distributed slave servers without database dependency

**Features:**
- Memzone in-memory storage
- AXFR/IXFR from masters
- NOTIFY listener
- No MySQL required
- DNS caching

**Configuration:**
```bash
# Create zone-masters.conf
cat > /etc/mydns/zone-masters.conf <<EOF
example.com:192.168.1.10:53:1:transfer-key
example.org:192.168.1.10:53:1:transfer-key
EOF

# mydns.conf - NO database settings!
dns-cache-enabled = yes
dns-cache-size = 384
```

**No Database:** Zone data loaded from AXFR into shared memory.

**See:** `contrib/MYSQL_FREE_SLAVE_GUIDE.md` for complete setup.

### Scenario 3: Hybrid Master/Slave with Caching

**Purpose:** Server that's both master (for some zones) and slave (for others)

**Features:**
- Database for master zones
- Memzone for slave zones
- DNS caching for recursive queries
- Full GeoIP and ACL support from memory

**Configuration:**
```bash
# mydns.conf
db-host = localhost
db-user = mydns
db-password = password
database = did
dns-cache-enabled = yes

# zone-masters.conf for slave zones
example.com:192.168.1.10:53:1:transfer-key
```

### Scenario 4: DoH Privacy Server

**Purpose:** DNS over HTTPS for privacy-enhanced DNS

**Features:**
- TLS 1.2+ encryption
- GET and POST methods
- Separate pthread (non-blocking)
- Works alongside standard DNS

**Prerequisites:**
```bash
# Generate TLS certificate
openssl req -x509 -newkey rsa:4096 \
  -keyout /etc/mydns/certs/server.key \
  -out /etc/mydns/certs/server.crt \
  -days 365 -nodes \
  -subj "/CN=dns.example.com"

chmod 600 /etc/mydns/certs/server.key
```

**Configuration:**
```bash
# mydns.conf
doh-enabled = yes
doh-port = 443  # Requires root or CAP_NET_BIND_SERVICE
doh-path = /dns-query
doh-cert = /etc/mydns/certs/server.crt
doh-key = /etc/mydns/certs/server.key

# Database configuration for DoH stats
mysql -u root -p did < contrib/doh-schema.sql
```

**Client Usage:**
```bash
# GET method
curl "https://dns.example.com/dns-query?dns=q80BAAABAAAAAAAAA3d3dwdleGFtcGxlA2NvbQAAAQAB"

# POST method
curl -H "Content-Type: application/dns-message" \
  --data-binary @query.bin \
  https://dns.example.com/dns-query
```

### Scenario 5: Multi-User Platform

**Purpose:** Hosting platform where users manage their own zones

**Features:**
- Web UI with user authentication
- Per-user Cloudflare credentials
- Per-zone ACLs
- Role-based access control

**Components:**
1. MyDNS server with multi-user schemas
2. Node.js backend API
3. React frontend
4. nginx reverse proxy

**See:** [Web UI Deployment](#web-ui-deployment) section below.

---

## Web UI Deployment

### Backend API Setup

```bash
cd /scripts/mydns-ng-master/contrib/dnsmanager/server

# Install dependencies
npm install

# Configure environment
cat > .env <<EOF
PORT=4000
DB_HOST=localhost
DB_USER=mydns
DB_PASSWORD=SecurePassword123!
DB_NAME=did
JWT_SECRET=$(openssl rand -hex 32)
CF_ENCRYPTION_KEY=$(openssl rand -hex 32)
NODE_ENV=production
EOF

# Build TypeScript
npm run build

# Start with PM2
npm install -g pm2
pm2 start dist/index.js --name mydns-api
pm2 save
pm2 startup
```

### Frontend Setup

```bash
cd /scripts/mydns-ng-master/contrib/dnsmanager/client

# Install dependencies
npm install

# Configure environment
cat > .env.production <<EOF
VITE_API_URL=https://dns-api.example.com
EOF

# Build production bundle
npm run build

# Serve with nginx (see below)
```

### nginx Configuration

```nginx
# /etc/nginx/sites-available/mydns-webui
server {
    listen 80;
    listen [::]:80;
    server_name dns.example.com;

    # Redirect to HTTPS
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name dns.example.com;

    ssl_certificate /etc/letsencrypt/live/dns.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/dns.example.com/privkey.pem;

    # Frontend
    root /scripts/mydns-ng-master/contrib/dnsmanager/client/dist;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    # Backend API
    location /api/ {
        proxy_pass http://localhost:4000/api/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
# Enable site
ln -s /etc/nginx/sites-available/mydns-webui /etc/nginx/sites-enabled/
nginx -t
systemctl reload nginx
```

### Database Schema for Web UI

```bash
# Multi-user features
mysql -u root -p did < contrib/user-cloudflare-acl-schema.sql

# Optional: Apply other web UI schemas if needed
```

---

## Multi-User Features

### User Cloudflare Credentials

Users can add their own Cloudflare API credentials via the web UI:

**API Endpoints:**
- `GET /api/user-cloudflare/credentials` - List credentials
- `POST /api/user-cloudflare/credentials` - Add credentials
- `PUT /api/user-cloudflare/credentials/:id` - Update
- `DELETE /api/user-cloudflare/credentials/:id` - Remove
- `POST /api/user-cloudflare/credentials/:id/test` - Test connectivity
- `POST /api/user-cloudflare/credentials/:id/sync` - Manual sync

**Security:**
- API keys encrypted with AES-256-GCM
- Encryption key in `CF_ENCRYPTION_KEY` environment variable
- User ownership verified on all operations

**Sync Script:**
```bash
# Manual sync
/scripts/mydns-ng-master/contrib/sync_cloudflare_records_multi_user.py --verbose

# Cron job (every 5 minutes)
*/5 * * * * /usr/bin/python3 /scripts/mydns-ng-master/contrib/sync_cloudflare_records_multi_user.py >> /var/log/mydns/cf-sync.log 2>&1
```

### Zone ACLs

Users can define zone-specific and global ACLs:

**API Endpoints:**
- `GET /api/zone-acls` - List all ACLs
- `GET /api/zone-acls/zone/:soaId` - Zone-specific ACLs
- `POST /api/zone-acls/zone` - Create zone ACL
- `POST /api/zone-acls/global` - Create global ACL
- `GET /api/zone-acls/stats` - Statistics

**ACL Features:**
- Allow/Deny rules
- CIDR notation support (192.168.1.0/24)
- Priority-based evaluation (lower = higher priority)
- Applies to QUERY, AXFR, IXFR, UPDATE operations
- Hit statistics tracking

---

## Security Hardening

### 1. TSIG Keys

```bash
# Generate secure TSIG key
TSIG_KEY=$(openssl rand -base64 32)

# Add to database
mysql -u root -p did <<EOF
INSERT INTO tsig_keys (name, algorithm, secret, enabled, can_query, can_update, can_axfr, can_ixfr)
VALUES ('transfer-key', 'hmac-sha256', '$TSIG_KEY', 1, 1, 0, 1, 1);
EOF
```

### 2. Firewall Rules

```bash
# Allow DNS (UDP/TCP 53)
ufw allow 53/udp
ufw allow 53/tcp

# Allow NOTIFY (UDP 5300) only from masters
ufw allow from 192.168.1.10 to any port 5300 proto udp

# Allow DoH (TCP 443/8443) only from trusted networks
ufw allow from 10.0.0.0/8 to any port 8443 proto tcp

# Allow Web UI (TCP 443) from internet
ufw allow 443/tcp
```

### 3. Database Security

```bash
# Restrict database user privileges
mysql -u root -p <<EOF
REVOKE ALL PRIVILEGES ON did.* FROM 'mydns'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON did.* TO 'mydns'@'localhost';
FLUSH PRIVILEGES;
EOF

# Use strong passwords
# Enable MySQL SSL connections
# Restrict database access to localhost only
```

### 4. File Permissions

```bash
# Protect configuration files
chmod 600 /etc/mydns/mydns.conf
chmod 600 /etc/mydns/cloudflare.ini
chmod 600 /etc/mydns/zone-masters.conf

# Protect TLS certificates
chmod 600 /etc/mydns/certs/server.key
chmod 644 /etc/mydns/certs/server.crt

# Protect web UI environment
chmod 600 /scripts/mydns-ng-master/contrib/dnsmanager/server/.env
```

### 5. Regular Updates

```bash
# Update MyDNS
cd /scripts/mydns-ng-master
git pull
make clean && make && make install
systemctl restart mydns

# Update dependencies
apt-get update && apt-get upgrade

# Monitor security advisories
# Subscribe to mydns-announce mailing list (if available)
```

---

## Monitoring

### Nagios/Icinga Integration

```bash
# Install check script
cp /scripts/mydns-ng-master/contrib/check_mydns.py /usr/lib/nagios/plugins/
chmod +x /usr/lib/nagios/plugins/check_mydns.py

# Configure NRPE
cat >> /etc/nagios/nrpe.cfg <<EOF
command[check_mydns]=/usr/lib/nagios/plugins/check_mydns.py -H localhost -p 53 -d example.com
EOF

systemctl restart nagios-nrpe-server
```

### Monit Configuration

```bash
# /etc/monit/conf.d/mydns
check process mydns with pidfile /var/run/mydns.pid
    start program = "/bin/systemctl start mydns"
    stop program = "/bin/systemctl stop mydns"
    if failed host 127.0.0.1 port 53 protocol dns then restart
    if 5 restarts within 5 cycles then timeout
```

### Log Monitoring

```bash
# Monitor logs
tail -f /var/log/mydns/mydns.log

# Analyze TSIG operations
grep "TSIG" /var/log/mydns/mydns.log

# Monitor UPDATE operations
mysql -u root -p did -e "SELECT * FROM update_log ORDER BY created_at DESC LIMIT 20;"

# Check NOTIFY status
mysql -u root -p did -e "SELECT zone_name, last_notify, last_ixfr_serial FROM zone_masters;"
```

### Performance Monitoring

```bash
# DNS cache statistics
mysql -u root -p did -e "SELECT * FROM dns_cache_config;"

# DoH statistics
mysql -u root -p did -e "SELECT * FROM doh_stats ORDER BY id DESC LIMIT 10;"

# ACL hit statistics
mysql -u root -p did -e "SELECT * FROM dnsmanager_zone_acl_stats ORDER BY hit_count DESC;"
```

---

## Troubleshooting

### MyDNS Won't Start

**Check configuration:**
```bash
/usr/local/sbin/mydns -c /etc/mydns/mydns.conf -D
```

**Check database connection:**
```bash
mysql -h localhost -u mydns -p did -e "SELECT COUNT(*) FROM soa;"
```

**Check permissions:**
```bash
ls -l /etc/mydns/mydns.conf
ls -l /var/run/  # Can mydns write pidfile?
```

### TSIG Authentication Fails

**Verify key in database:**
```bash
mysql -u root -p did -e "SELECT name, algorithm, enabled FROM tsig_keys;"
```

**Check TSIG logs:**
```bash
grep "TSIG" /var/log/mydns/mydns.log
mysql -u root -p did -e "SELECT * FROM tsig_usage_log ORDER BY used_at DESC LIMIT 10;"
```

**Test with dig:**
```bash
dig @localhost -y hmac-sha256:transfer-key:BASE64KEY example.com AXFR
```

### IXFR Not Working

**Check zone_changes table:**
```bash
mysql -u root -p did -e "SELECT * FROM zone_changes WHERE zone_name='example.com' ORDER BY id DESC LIMIT 10;"
```

**Verify serial numbers:**
```bash
mysql -u root -p did -e "SELECT id, origin, serial FROM soa WHERE origin='example.com';"
```

**Test IXFR manually:**
```bash
dig @localhost example.com IXFR=2025112801
```

### Memzone Issues

**Check shared memory:**
```bash
ls -lh /dev/shm/mydns-zones
ipcs -m  # Show shared memory segments
```

**Verify zone-masters.conf:**
```bash
cat /etc/mydns/zone-masters.conf
```

**Check AXFR from master:**
```bash
dig @192.168.1.10 example.com AXFR
```

### DoH Not Working

**Check TLS certificates:**
```bash
openssl x509 -in /etc/mydns/certs/server.crt -text -noout
openssl rsa -in /etc/mydns/certs/server.key -check
```

**Test DoH endpoint:**
```bash
curl -k https://localhost:8443/dns-query
```

**Check DoH logs:**
```bash
grep "DoH" /var/log/mydns/mydns.log
```

### Web UI Issues

**Check backend API:**
```bash
pm2 logs mydns-api
curl http://localhost:4000/api/health
```

**Check nginx:**
```bash
nginx -t
systemctl status nginx
tail -f /var/log/nginx/error.log
```

**Check database connection:**
```bash
# From backend directory
node -e "const mysql = require('mysql2'); const conn = mysql.createConnection({host:'localhost',user:'mydns',password:'password',database:'did'}); conn.connect(err => console.log(err || 'Connected'));"
```

---

## Additional Resources

- **Main Repository:** https://github.com/dancaescu/dns
- **ChangeLog:** `/scripts/mydns-ng-master/ChangeLog`
- **Feature Documentation:**
  - `contrib/IMPLEMENTATION_SUMMARY.md` - TSIG, UPDATE, IXFR, NOTIFY
  - `contrib/NOTIFY_IXFR_IMPLEMENTATION.md` - NOTIFY/IXFR details
  - `contrib/DOH_IMPLEMENTATION.md` - DNS over HTTPS
  - `contrib/DNSSEC_IMPLEMENTATION_GUIDE.md` - DNSSEC setup
  - `contrib/MYSQL_FREE_SLAVE_GUIDE.md` - Memzone deployment
  - `contrib/MULTI_USER_FEATURES.md` - Multi-user web UI
  - `contrib/DNS_CACHE_CONFIG_HIERARCHY.md` - DNS caching
- **Ansible Automation:** `contrib/ansible/README.md`
- **Database Schemas:** `contrib/*-schema.sql`

---

## Support

For issues, questions, or contributions:
- Email: Dan Caescu <dan.caescu@multitel.net>
- GitHub Issues: https://github.com/dancaescu/dns/issues

---

**Last Updated:** 29-Nov-2025
**Version:** 1.3.0
