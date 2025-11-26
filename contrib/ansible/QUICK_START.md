# Ansible Quick Start Guide

Get MyDNS and DNS Manager up and running in minutes.

## Prerequisites

- Ansible 2.9+ installed on control machine
- SSH access to target servers
- MySQL server already deployed (not included in these playbooks)

## Installation

### 1. Install Ansible

```bash
# Debian/Ubuntu
sudo apt update && sudo apt install ansible

# macOS
brew install ansible

# Verify
ansible --version
```

### 2. Clone Repository

```bash
cd /scripts
git clone https://github.com/yourusername/mydns-ng-master.git
cd mydns-ng-master/contrib/ansible
```

### 3. Configure

```bash
# Copy example files
cp inventory.example inventory
cp group_vars/all.yml.example group_vars/all.yml

# Edit inventory with your server IPs
nano inventory

# Edit variables with your configuration
nano group_vars/all.yml
```

### 4. Test Connectivity

```bash
ansible all -i inventory -m ping
```

## Quick Deploy (Development/Testing)

Deploy everything to a single server for testing:

```bash
# All-in-one inventory
cat > inventory << 'EOF'
[all]
testserver ansible_host=192.168.1.100 ansible_user=root

[mydns_servers]
testserver

[sensor_servers]
testserver sensor_location=na

[webui_servers]
testserver
EOF

# Deploy everything
ansible-playbook -i inventory mydns-server.yml
ansible-playbook -i inventory sensor.yml -e "api_token=YOUR_TOKEN"
ansible-playbook -i inventory webui.yml
```

## Production Deploy

### Step 1: Deploy MyDNS Servers

```bash
ansible-playbook -i inventory mydns-server.yml

# Verify
dig @ns1.example.com example.com
```

### Step 2: Deploy Web UI

```bash
ansible-playbook -i inventory webui.yml

# Access: https://dns.example.com
```

### Step 3: Create API Token

1. Log in to DNS Manager
2. Go to **API Tokens**
3. Create token with `sensors:read`, `sensors:write`, `zones:read` scopes
4. Copy token

### Step 4: Deploy Sensors

```bash
# Update api_token in group_vars/all.yml
ansible-playbook -i inventory sensor.yml
```

## Common Tasks

### Update MyDNS

```bash
cd /scripts/mydns-ng-master
git pull
ansible-playbook -i inventory mydns-server.yml --tags build,service
```

### Update Web UI

```bash
cd /scripts/mydns-ng-master/contrib/dnsmanager
git pull
ansible-playbook -i inventory webui.yml --tags deploy,build
pm2 restart dnsmanager-server
```

### Restart Services

```bash
# MyDNS
ansible mydns_servers -i inventory -a "systemctl restart mydns" -b

# Web UI
ansible webui_servers -i inventory -a "pm2 restart dnsmanager-server" -b

# Sensors
ansible sensor_servers -i inventory -a "systemctl restart sensor-api.service" -b
```

### Check Status

```bash
# All services
ansible all -i inventory -m shell -a "systemctl status mydns sensor-api.timer"

# Web UI
ansible webui_servers -i inventory -m shell -a "pm2 status"
```

### View Logs

```bash
# MyDNS
ansible mydns_servers -i inventory -a "journalctl -u mydns -n 50" -b

# Sensor
ansible sensor_servers -i inventory -a "journalctl -u sensor-api -n 50" -b

# Web UI
ansible webui_servers -i inventory -a "pm2 logs dnsmanager-server --lines 50"
```

## Troubleshooting

### MyDNS won't start

```bash
# Check configuration
ansible mydns_servers -i inventory -a "mydns -D" -b

# Check MySQL connection
ansible mydns_servers -i inventory -m shell \
  -a "mysql -h {{ mysql_host }} -u {{ mysql_user }} -p{{ mysql_password }} {{ mysql_database }} -e 'SELECT 1'"
```

### Sensor failing

```bash
# Test API connectivity
ansible sensor_servers -i inventory -m uri \
  -a "url={{ api_url }}/api/sensors/script/version"

# Run manually
ansible sensor_servers -i inventory -m shell \
  -a "/opt/sensor/sensor-api.py --location na --api-url {{ api_url }} --api-key {{ api_token }}" \
  -b --become-user sensor
```

### Web UI not accessible

```bash
# Check PM2
ansible webui_servers -i inventory -a "pm2 status"

# Check nginx
ansible webui_servers -i inventory -a "systemctl status nginx" -b

# Test API
ansible webui_servers -i inventory -m uri \
  -a "url=http://localhost:4000/api/health"
```

## Advanced Usage

### Deploy to Specific Hosts

```bash
# Only primary DNS server
ansible-playbook -i inventory mydns-server.yml --limit ns1.example.com

# Only EU sensor
ansible-playbook -i inventory sensor.yml --limit sensor-eu.example.com
```

### Run Specific Tags

```bash
# Only install dependencies
ansible-playbook -i inventory mydns-server.yml --tags dependencies

# Only update configuration
ansible-playbook -i inventory webui.yml --tags config
```

### Dry Run (Check Mode)

```bash
# Preview changes without applying
ansible-playbook -i inventory mydns-server.yml --check
```

### Use Ansible Vault

```bash
# Create encrypted file
ansible-vault create group_vars/all/vault.yml

# Run with vault password
ansible-playbook -i inventory webui.yml --ask-vault-pass
```

### Rolling Updates (Zero Downtime)

```bash
# Update one MyDNS server at a time
ansible-playbook -i inventory mydns-server.yml --serial 1
```

## Directory Structure

```
ansible/
├── README.md                 # Full documentation
├── QUICK_START.md           # This file
├── DEPLOYMENT_GUIDE.md      # Production deployment guide
├── inventory.example        # Inventory template
├── group_vars/
│   └── all.yml.example     # Variables template
├── templates/              # Jinja2 templates
│   ├── mydns.conf.j2
│   ├── mydns.service.j2
│   ├── sensor-*.j2
│   ├── dnsmanager.env.j2
│   ├── ecosystem.config.js.j2
│   └── nginx-dnsmanager.conf.j2
├── mydns-server.yml        # MyDNS playbook
├── sensor.yml              # Sensor playbook
└── webui.yml               # Web UI playbook
```

## Tags Reference

### mydns-server.yml
- `dependencies` - Install system packages
- `geoip` - Install GeoIP library
- `build` - Build MyDNS from source
- `config` - Configure MyDNS
- `service` - Set up systemd service

### sensor.yml
- `dependencies` - Install Python and libraries
- `deploy` - Deploy sensor script
- `schedule` - Set up systemd timer

### webui.yml
- `nodejs` - Install Node.js
- `pm2` - Install PM2
- `deploy` - Deploy application
- `build` - Build frontend
- `config` - Configure backend
- `nginx` - Configure nginx
- `service` - Start services

## Important Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `mysql_host` | MySQL server hostname | `db.example.com` |
| `mysql_password` | MySQL password | `secretpass` |
| `api_url` | DNS Manager API URL | `https://dns.example.com` |
| `api_token` | API authentication token | `abcd1234...` |
| `jwt_secret` | JWT signing secret | Generate with `openssl rand -base64 32` |
| `domain_name` | Web UI domain | `dns.example.com` |
| `sensor_location` | Sensor region code | `na`, `eu`, `apac` |

## Next Steps

1. Read [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md) for production deployment
2. Read [README.md](README.md) for detailed documentation
3. Check [../dnsmanager/CHANGELOG.md](../dnsmanager/CHANGELOG.md) for features

## Support

- Issues: https://github.com/yourusername/mydns-ng/issues
- Documentation: `/contrib/ansible/README.md`
- Changelog: `/contrib/dnsmanager/CHANGELOG.md`
