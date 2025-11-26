# MyDNS-NG Deployment Guide

Complete guide for deploying MyDNS server and DNS Manager using Ansible.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     DNS Manager System                       │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  ┌──────────────┐      ┌──────────────┐    ┌──────────────┐│
│  │  Web Browser │──────│  Web UI      │────│  Backend API ││
│  │  (Client)    │HTTPS │  (React)     │HTTP│  (Express)   ││
│  └──────────────┘      └──────────────┘    └──────┬───────┘│
│                                                     │         │
│                                                     │MySQL    │
│                                                     │         │
│  ┌──────────────┐      ┌──────────────┐    ┌──────▼───────┐│
│  │  DNS Clients │──────│  MyDNS       │────│  MySQL DB    ││
│  │              │ UDP  │  Server      │SQL │              ││
│  └──────────────┘  53  └──────────────┘    └──────────────┘│
│                                                               │
│  ┌──────────────┐      ┌──────────────┐                     │
│  │  Sensor NA   │──────│  API Backend │ (Learns Cloudflare  │
│  │  Sensor EU   │HTTPS │              │  proxy IPs per      │
│  │  Sensor APAC │      │              │  region)            │
│  └──────────────┘      └──────────────┘                     │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

## Prerequisites

### Control Machine (Where Ansible Runs)
- Ansible 2.9 or higher
- SSH client
- SSH key for target servers

```bash
# Install Ansible on Debian/Ubuntu
sudo apt update
sudo apt install ansible

# Verify installation
ansible --version
```

### Target Servers

**1. MyDNS Servers** (2+ recommended for redundancy)
- Debian 11+ or Ubuntu 20.04+ LTS
- 1GB RAM minimum (2GB recommended)
- 2 CPU cores minimum
- 20GB disk space
- Static IP address
- Open ports: 53 (UDP/TCP)

**2. Sensor Servers** (1 per geographic region)
- Debian 11+ or Ubuntu 20.04+ LTS
- 512MB RAM minimum
- 1 CPU core
- 10GB disk space
- Must be deployed in target geographic locations (NA, EU, APAC, etc.)
- Outbound HTTPS access to DNS Manager API

**3. Web UI Server**
- Debian 11+ or Ubuntu 20.04+ LTS
- 2GB RAM minimum (4GB recommended)
- 2 CPU cores
- 40GB disk space
- Open ports: 80, 443 (if using nginx)

**4. MySQL Server** (Not installed by Ansible - separate deployment)
- MySQL 8.0+ or MariaDB 10.6+
- Must be accessible from MyDNS and Web UI servers
- Database schema already deployed

## Quick Start (All-in-One)

For testing/development, deploy everything on a single server:

```bash
cd /scripts/mydns-ng-master/contrib/ansible

# 1. Create inventory
cat > inventory << 'EOF'
[all_servers]
server.example.com ansible_host=192.168.1.100 ansible_user=root

[mydns_servers]
server.example.com

[sensor_servers]
server.example.com sensor_location=na

[webui_servers]
server.example.com
EOF

# 2. Configure variables
cp group_vars/all.yml.example group_vars/all.yml
nano group_vars/all.yml  # Edit with your settings

# 3. Test connectivity
ansible all -i inventory -m ping

# 4. Deploy everything
ansible-playbook -i inventory mydns-server.yml
ansible-playbook -i inventory sensor.yml
ansible-playbook -i inventory webui.yml
```

## Production Deployment

### Step 1: Prepare Infrastructure

#### 1.1. Deploy MySQL Server

On a dedicated database server:

```bash
# Install MySQL
sudo apt update
sudo apt install mysql-server

# Secure installation
sudo mysql_secure_installation

# Create database and user
sudo mysql -u root -p << 'EOF'
CREATE DATABASE did CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'mydns'@'%' IDENTIFIED BY 'SECURE_PASSWORD_HERE';
GRANT ALL PRIVILEGES ON did.* TO 'mydns'@'%';
FLUSH PRIVILEGES;
EOF

# Import schema
mysql -u mydns -p did < /path/to/schema.sql
```

#### 1.2. Configure Firewall

On MySQL server:
```bash
sudo ufw allow from 192.168.1.0/24 to any port 3306
```

On MyDNS servers:
```bash
sudo ufw allow 53/udp
sudo ufw allow 53/tcp
```

On Web UI server:
```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
```

### Step 2: Configure Ansible

#### 2.1. Create Inventory

```bash
cd /scripts/mydns-ng-master/contrib/ansible
nano inventory
```

```ini
# Primary and secondary DNS servers
[mydns_servers]
ns1.example.com ansible_host=192.168.1.10
ns2.example.com ansible_host=192.168.1.11

# Geographic sensors
[sensor_servers]
sensor-na.example.com ansible_host=10.0.1.100 sensor_location=na
sensor-eu.example.com ansible_host=10.0.2.100 sensor_location=eu
sensor-apac.example.com ansible_host=10.0.3.100 sensor_location=apac

# Web interface
[webui_servers]
web.example.com ansible_host=192.168.1.20

[all:vars]
ansible_user=root
ansible_python_interpreter=/usr/bin/python3
```

#### 2.2. Configure Variables

```bash
cp group_vars/all.yml.example group_vars/all.yml
nano group_vars/all.yml
```

**Critical variables to set:**

```yaml
# Database
mysql_host: "db.example.com"
mysql_database: "did"
mysql_user: "mydns"
mysql_password: "YOUR_SECURE_PASSWORD"

# API Configuration
api_url: "https://dns.example.com"
jwt_secret: "GENERATE_WITH_openssl_rand_-base64_32"

# API Token (generate in DNS Manager UI after first deployment)
api_token: "YOUR_API_TOKEN"

# Domain
domain_name: "dns.example.com"
dnsmanager_origin: "https://dns.example.com"

# SSL (if using your own certificates)
ssl_enabled: true
ssl_cert_path: "/etc/ssl/certs/dns.example.com.crt"
ssl_key_path: "/etc/ssl/private/dns.example.com.key"

# OR use Let's Encrypt
use_letsencrypt: true
letsencrypt_email: "admin@example.com"
```

#### 2.3. Use Ansible Vault for Secrets

```bash
# Create encrypted vault file
ansible-vault create group_vars/all/vault.yml
```

Add sensitive data:
```yaml
vault_mysql_password: "supersecretpassword"
vault_jwt_secret: "verysecretjwtkey"
vault_api_token: "secretapitoken"
```

Reference in `group_vars/all.yml`:
```yaml
mysql_password: "{{ vault_mysql_password }}"
jwt_secret: "{{ vault_jwt_secret }}"
api_token: "{{ vault_api_token }}"
```

### Step 3: Test Connectivity

```bash
# Test SSH connectivity to all servers
ansible all -i inventory -m ping

# Check sudo access
ansible all -i inventory -m shell -a "whoami" -b
```

### Step 4: Deploy MyDNS Servers

```bash
# Deploy to primary DNS server first
ansible-playbook -i inventory mydns-server.yml --limit ns1.example.com

# Verify it's working
dig @ns1.example.com example.com

# Deploy to secondary
ansible-playbook -i inventory mydns-server.yml --limit ns2.example.com
```

**Verification:**
```bash
# On each MyDNS server
ssh ns1.example.com
sudo systemctl status mydns
sudo journalctl -u mydns -n 50
dig @localhost example.com
```

### Step 5: Deploy Web UI

```bash
# Deploy web interface
ansible-playbook -i inventory webui.yml --ask-vault-pass

# Access: https://dns.example.com
# Login with default credentials (if first install)
```

**Verification:**
```bash
# On web server
ssh web.example.com
pm2 status
pm2 logs dnsmanager-server
curl http://localhost:4000/api/health
```

### Step 6: Create API Token for Sensors

1. Log in to DNS Manager web UI
2. Navigate to **API Tokens** page
3. Create new token with scopes:
   - `sensors:read`
   - `sensors:write`
   - `zones:read`
4. Copy the generated token

### Step 7: Deploy Sensors

```bash
# Update group_vars/all.yml with the API token
nano group_vars/all.yml
# Set: api_token: "your-token-here"

# Deploy to North America sensor
ansible-playbook -i inventory sensor.yml --limit sensor-na.example.com --ask-vault-pass

# Deploy to Europe sensor
ansible-playbook -i inventory sensor.yml --limit sensor-eu.example.com --ask-vault-pass

# Deploy to Asia-Pacific sensor
ansible-playbook -i inventory sensor.yml --limit sensor-apac.example.com --ask-vault-pass
```

**Verification:**
```bash
# On each sensor
ssh sensor-na.example.com
sudo systemctl status sensor-api.timer
sudo systemctl list-timers sensor-api.timer
sudo journalctl -u sensor-api -n 50

# Run manually
sudo -u sensor /opt/sensor/sensor-api.py --location na --api-url https://dns.example.com --api-key YOUR_TOKEN
```

### Step 8: Configure DNS Records

Add NS records for your zones pointing to MyDNS servers:

```dns
example.com.    IN  NS  ns1.example.com.
example.com.    IN  NS  ns2.example.com.

ns1.example.com.  IN  A   192.168.1.10
ns2.example.com.  IN  A   192.168.1.11
```

### Step 9: Enable GeoIP for Zones

1. Log in to DNS Manager
2. Navigate to zone settings
3. Enable **Use GeoIP** for desired zones
4. Configure location-specific IPs through the API or UI

## Updating Deployments

### Update MyDNS Server

```bash
# Pull latest changes
cd /scripts/mydns-ng-master
git pull

# Rebuild and restart (rolling update)
ansible-playbook -i inventory mydns-server.yml --serial 1 --tags build,service
```

### Update Web UI

```bash
# Pull latest changes
cd /scripts/mydns-ng-master/contrib/dnsmanager
git pull

# Rebuild and restart
ansible-playbook -i inventory webui.yml --tags deploy,build
```

### Update Sensor Script

```bash
# Copy new version
cd /scripts/mydns-ng-master/contrib/geosensors
git pull

# Redeploy to all sensors
ansible-playbook -i inventory sensor.yml --tags deploy
```

## Troubleshooting

### MyDNS Issues

**Problem:** MyDNS won't start

```bash
# Check logs
sudo journalctl -u mydns -n 100

# Test configuration
sudo mydns -D

# Verify MySQL connectivity
mysql -h $MYSQL_HOST -u $MYSQL_USER -p$MYSQL_PASSWORD $MYSQL_DATABASE -e "SELECT COUNT(*) FROM soa;"

# Check permissions
ls -la /run/mydns/
```

**Problem:** DNS queries not resolving

```bash
# Test locally
dig @localhost example.com

# Test remotely
dig @ns1.example.com example.com

# Check firewall
sudo ufw status
sudo netstat -tulpn | grep :53
```

### Sensor Issues

**Problem:** Sensor script failing

```bash
# Check service status
sudo systemctl status sensor-api.service
sudo journalctl -u sensor-api -n 100

# Test API connectivity
curl -v https://dns.example.com/api/sensors/script/version

# Run manually with debug
sudo -u sensor /opt/sensor/sensor-api.py \
  --location na \
  --api-url https://dns.example.com \
  --api-key YOUR_TOKEN \
  --debug
```

**Problem:** Timer not running

```bash
# Check timer status
sudo systemctl status sensor-api.timer
sudo systemctl list-timers

# Enable timer
sudo systemctl enable --now sensor-api.timer

# Trigger manually
sudo systemctl start sensor-api.service
```

### Web UI Issues

**Problem:** Backend API not responding

```bash
# Check PM2 status
pm2 status
pm2 logs dnsmanager-server --lines 100

# Check if port is listening
netstat -tulpn | grep :4000

# Test health endpoint
curl http://localhost:4000/api/health

# Restart
pm2 restart dnsmanager-server
```

**Problem:** Frontend not loading

```bash
# Check nginx
sudo systemctl status nginx
sudo nginx -t
sudo tail -f /var/log/nginx/dnsmanager-error.log

# Check if files exist
ls -la /opt/dnsmanager/client/dist/

# Rebuild frontend
cd /opt/dnsmanager/client
npm run build
```

**Problem:** 502 Bad Gateway

```bash
# Backend not running
pm2 restart dnsmanager-server

# Check upstream connection
curl http://localhost:4000/api/health

# Check nginx config
sudo nginx -t
```

## Backup and Restore

### Backup

```bash
# Backup MyDNS configuration
ansible mydns_servers -i inventory -m fetch \
  -a "src=/etc/mydns.conf dest=./backups/{{ inventory_hostname }}/mydns.conf flat=yes"

# Backup Web UI configuration
ansible webui_servers -i inventory -m fetch \
  -a "src=/opt/dnsmanager/.env dest=./backups/{{ inventory_hostname }}/dnsmanager.env flat=yes"

# Backup database
ssh db.example.com "mysqldump -u root -p did > /tmp/did-backup.sql"
```

### Restore

```bash
# Restore MyDNS configuration
ansible mydns_servers -i inventory -m copy \
  -a "src=./backups/ns1.example.com/mydns.conf dest=/etc/mydns.conf"

# Restore database
mysql -u root -p did < /path/to/did-backup.sql
```

## Monitoring

### Health Checks

```bash
# MyDNS health
ansible mydns_servers -i inventory -m shell -a "systemctl is-active mydns"

# Web UI health
ansible webui_servers -i inventory -m uri -a "url=http://localhost:4000/api/health"

# Sensor health
ansible sensor_servers -i inventory -m shell -a "systemctl is-active sensor-api.timer"
```

### Log Aggregation

Consider setting up centralized logging with:
- ELK Stack (Elasticsearch, Logstash, Kibana)
- Graylog
- Loki

## Security Hardening

### SSH Hardening

```bash
# Disable password authentication
# Edit /etc/ssh/sshd_config on all servers
PasswordAuthentication no
PubkeyAuthentication yes

# Restart SSH
sudo systemctl restart sshd
```

### Firewall Rules

```bash
# Ansible playbook for firewall
ansible-playbook -i inventory hardening/firewall.yml
```

### SSL/TLS Best Practices

- Use Let's Encrypt for free SSL certificates
- Enable HTTP/2
- Use strong cipher suites
- Implement HSTS headers
- Regular certificate renewal

### Database Security

- Use strong passwords
- Enable SSL for MySQL connections
- Restrict access by IP address
- Regular security updates
- Enable audit logging

## Performance Tuning

### MyDNS

```ini
# /etc/mydns.conf
cache-size = 2048      # Increase cache
cache-expire = 300     # Cache for 5 minutes
timeout = 60           # Increase timeout
```

### PM2

```javascript
// ecosystem.config.js
instances: 'max',  // Use all CPU cores
max_memory_restart: '1G',  # Restart if memory exceeds 1GB
```

### Nginx

```nginx
# /etc/nginx/nginx.conf
worker_processes auto;
worker_connections 2048;
keepalive_timeout 65;
gzip on;
```

## Support and Documentation

- Main Documentation: `/contrib/dnsmanager/README.md`
- Changelog: `/contrib/dnsmanager/CHANGELOG.md`
- Ansible README: `/contrib/ansible/README.md`
- GitHub Issues: https://github.com/yourusername/mydns-ng/issues

## License

Same as MyDNS-NG parent project.
