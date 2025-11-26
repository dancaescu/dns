# MyDNS-NG and DNS Manager Ansible Playbooks

Automated deployment playbooks for MyDNS server and DNS Manager web UI.

## Overview

This directory contains Ansible playbooks for deploying:

1. **MyDNS Server** - Authoritative DNS server with GeoIP support
2. **GeoIP Sensor** - Geographic IP learning sensor script
3. **DNS Manager Web UI** - React/TypeScript web interface with Express API backend

## Prerequisites

- Ansible 2.9 or higher
- Target servers running Debian/Ubuntu (tested on Debian 12)
- SSH access with sudo privileges
- MySQL server (external, not installed by these playbooks)

## Quick Start

### 1. Configure Inventory

```bash
cp inventory.example inventory
```

Edit `inventory` with your server details:

```ini
[mydns_servers]
ns1.example.com ansible_host=192.168.1.10
ns2.example.com ansible_host=192.168.1.11

[sensor_servers]
sensor-na.example.com ansible_host=10.0.1.100
sensor-eu.example.com ansible_host=10.0.2.100

[webui_servers]
web.example.com ansible_host=192.168.1.20
```

### 2. Configure Variables

```bash
cp group_vars/all.yml.example group_vars/all.yml
```

Edit `group_vars/all.yml` with your configuration:

```yaml
# MySQL Database Configuration
mysql_host: "db.example.com"
mysql_database: "did"
mysql_user: "mydns"
mysql_password: "your-secure-password"

# DNS Manager API Configuration
api_url: "https://dns.example.com"
api_port: 4000
dnsmanager_origin: "https://dns.example.com"

# JWT Secret (generate with: openssl rand -base64 32)
jwt_secret: "your-jwt-secret-here"
```

### 3. Deploy MyDNS Server

Deploy MyDNS server with GeoIP support:

```bash
ansible-playbook -i inventory mydns-server.yml
```

This will:
- Install build dependencies (gcc, make, autoconf, etc.)
- Install MaxMind GeoIP library
- Build and install MyDNS from source with GeoIP support
- Configure MyDNS to connect to remote MySQL database
- Set up systemd service for MyDNS
- Start and enable MyDNS service

### 4. Deploy GeoIP Sensor

Deploy sensor script to geographic locations:

```bash
ansible-playbook -i inventory sensor.yml
```

This will:
- Install Python 3 and pip
- Install dnspython and requests libraries
- Deploy sensor-api.py script
- Create systemd timer for hourly sensor runs
- Generate API token (if not provided)

### 5. Deploy DNS Manager Web UI

Deploy the web interface and API backend:

```bash
ansible-playbook -i inventory webui.yml
```

This will:
- Install Node.js 20.x LTS
- Install PM2 process manager
- Deploy DNS Manager application
- Build React frontend
- Install backend dependencies
- Configure environment variables
- Set up PM2 service for backend API
- Optional: Configure nginx reverse proxy

## Playbook Details

### mydns-server.yml

Installs and configures MyDNS authoritative DNS server.

**Variables:**
- `mysql_host` - MySQL server hostname
- `mysql_database` - Database name (default: did)
- `mysql_user` - MySQL username
- `mysql_password` - MySQL password
- `mydns_port` - DNS server port (default: 53)
- `mydns_user` - User to run MyDNS as (default: mydns)
- `geoip_enabled` - Enable GeoIP support (default: true)

**Tags:**
- `dependencies` - Install system dependencies
- `geoip` - Install GeoIP library
- `build` - Build MyDNS from source
- `config` - Configure MyDNS
- `service` - Set up systemd service

**Example:**
```bash
# Install only dependencies
ansible-playbook -i inventory mydns-server.yml --tags dependencies

# Skip GeoIP installation
ansible-playbook -i inventory mydns-server.yml --skip-tags geoip
```

### sensor.yml

Deploys GeoIP sensor script to learn Cloudflare proxy IPs.

**Variables:**
- `api_url` - DNS Manager API URL
- `api_token` - API authentication token
- `sensor_location` - Geographic location code (na, eu, apac, sa, af, oc)
- `sensor_interval` - Run interval in minutes (default: 60)
- `sensor_user` - User to run sensor as (default: sensor)

**Tags:**
- `dependencies` - Install Python and libraries
- `deploy` - Deploy sensor script
- `schedule` - Set up systemd timer

**Example:**
```bash
# Deploy to North America sensor
ansible-playbook -i inventory sensor.yml -e "sensor_location=na"

# Deploy with custom interval (every 30 minutes)
ansible-playbook -i inventory sensor.yml -e "sensor_interval=30"
```

### webui.yml

Deploys DNS Manager web interface and API backend.

**Variables:**
- `mysql_host` - MySQL server hostname
- `mysql_database` - Database name
- `mysql_user` - MySQL username
- `mysql_password` - MySQL password
- `api_port` - Backend API port (default: 4000)
- `dnsmanager_origin` - Frontend origin URL
- `jwt_secret` - JWT signing secret
- `nodejs_version` - Node.js version (default: 20.x)
- `install_nginx` - Install and configure nginx (default: true)
- `ssl_cert_path` - SSL certificate path (for nginx)
- `ssl_key_path` - SSL key path (for nginx)
- `domain_name` - Domain name for nginx virtual host

**Tags:**
- `nodejs` - Install Node.js
- `pm2` - Install PM2
- `deploy` - Deploy application
- `build` - Build frontend
- `config` - Configure backend
- `nginx` - Configure nginx
- `service` - Start services

**Example:**
```bash
# Deploy without nginx
ansible-playbook -i inventory webui.yml -e "install_nginx=false"

# Deploy with SSL
ansible-playbook -i inventory webui.yml \
  -e "domain_name=dns.example.com" \
  -e "ssl_cert_path=/etc/ssl/certs/dns.example.com.crt" \
  -e "ssl_key_path=/etc/ssl/private/dns.example.com.key"
```

## Directory Structure

```
ansible/
├── README.md                    # This file
├── inventory.example            # Example inventory file
├── group_vars/
│   └── all.yml.example         # Example group variables
├── host_vars/                  # Host-specific variables
├── mydns-server.yml            # MyDNS server playbook
├── sensor.yml                  # GeoIP sensor playbook
├── webui.yml                   # Web UI playbook
└── roles/
    ├── mydns/                  # MyDNS server role
    │   ├── tasks/
    │   ├── templates/
    │   ├── files/
    │   └── handlers/
    ├── sensor/                 # Sensor script role
    │   ├── tasks/
    │   ├── templates/
    │   └── files/
    └── webui/                  # Web UI role
        ├── tasks/
        ├── templates/
        ├── files/
        └── handlers/
```

## Advanced Usage

### Multi-Stage Deployment

Deploy to development, staging, and production environments:

```bash
# Development
ansible-playbook -i inventory/dev webui.yml

# Staging
ansible-playbook -i inventory/staging webui.yml

# Production
ansible-playbook -i inventory/prod webui.yml
```

### Rolling Updates

Update MyDNS servers with zero downtime:

```bash
ansible-playbook -i inventory mydns-server.yml --serial 1
```

### Vault-Encrypted Secrets

Encrypt sensitive variables:

```bash
# Create encrypted variables file
ansible-vault create group_vars/all/vault.yml

# Edit encrypted file
ansible-vault edit group_vars/all/vault.yml

# Run playbook with vault password
ansible-playbook -i inventory webui.yml --ask-vault-pass
```

Example `group_vars/all/vault.yml`:
```yaml
vault_mysql_password: "supersecret"
vault_jwt_secret: "verysecretkey"
vault_api_token: "api-token-here"
```

Reference in `group_vars/all.yml`:
```yaml
mysql_password: "{{ vault_mysql_password }}"
jwt_secret: "{{ vault_jwt_secret }}"
api_token: "{{ vault_api_token }}"
```

## Security Considerations

1. **Database Access:**
   - Use strong passwords for MySQL accounts
   - Restrict MySQL access by IP address
   - Use SSL for MySQL connections

2. **API Security:**
   - Generate strong JWT secrets: `openssl rand -base64 32`
   - Use HTTPS for API connections
   - Rotate API tokens regularly

3. **Server Hardening:**
   - Configure firewall rules (ufw/iptables)
   - Enable fail2ban for SSH protection
   - Keep systems updated with security patches
   - Use SSH keys instead of passwords

4. **Ansible Security:**
   - Use Ansible Vault for sensitive data
   - Limit SSH access with bastion hosts
   - Use sudo with password prompts in production

## Troubleshooting

### MyDNS won't start

Check logs:
```bash
journalctl -u mydns -n 50
```

Verify MySQL connection:
```bash
mysql -h $MYSQL_HOST -u $MYSQL_USER -p$MYSQL_PASSWORD $MYSQL_DATABASE
```

Test DNS resolution:
```bash
dig @localhost example.com
```

### Sensor script failing

Check service status:
```bash
systemctl status sensor-api.service
journalctl -u sensor-api -n 50
```

Test API connectivity:
```bash
curl -H "Authorization: Bearer $API_TOKEN" https://api.example.com/api/sensors/script/version
```

Run sensor manually:
```bash
sudo -u sensor /opt/sensor/sensor-api.py --location na --api-url https://api.example.com --api-key $API_TOKEN
```

### Web UI not accessible

Check PM2 status:
```bash
pm2 status
pm2 logs dnsmanager-server
```

Check nginx status:
```bash
systemctl status nginx
nginx -t
```

Verify backend is running:
```bash
curl http://localhost:4000/api/health
```

## Maintenance

### Update MyDNS

```bash
# Pull latest changes
cd /scripts/mydns-ng-master
git pull

# Rebuild and restart
ansible-playbook -i inventory mydns-server.yml --tags build,service
```

### Update Web UI

```bash
# Update application
ansible-playbook -i inventory webui.yml --tags deploy,build

# Restart backend
ssh web.example.com "pm2 restart dnsmanager-server"
```

### Backup Configuration

```bash
# Backup MyDNS config
ssh ns1.example.com "tar -czf /tmp/mydns-config.tar.gz /etc/mydns /etc/systemd/system/mydns.service"

# Backup Web UI config
ssh web.example.com "tar -czf /tmp/webui-config.tar.gz /opt/dnsmanager/.env /opt/dnsmanager/ecosystem.config.js"
```

## Support

For issues and questions:
- GitHub Issues: https://github.com/yourusername/mydns-ng/issues
- Documentation: /contrib/dnsmanager/README.md
- Changelog: /contrib/dnsmanager/CHANGELOG.md

## License

Same as MyDNS-NG parent project.
