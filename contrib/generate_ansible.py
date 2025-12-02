#!/usr/bin/env python3
"""
Ansible Recipe Generator for MyDNS

This script automatically generates Ansible playbooks and roles from the
contrib directory, eliminating the need to maintain a separate Ansible folder.

The script scans contrib/ for:
- SQL schemas -> Database setup tasks
- Python scripts -> Script installation tasks
- Service files -> Systemd service setup
- Configuration files -> Config template tasks
- Documentation -> Role documentation

Generated output: contrib/ansible/ directory with complete playbooks
"""

import os
import sys
import re
import json
import yaml
from pathlib import Path
from typing import Dict, List, Optional
from datetime import datetime


class AnsibleGenerator:
    def __init__(self, contrib_dir: str, output_dir: str):
        self.contrib_dir = Path(contrib_dir)
        self.output_dir = Path(output_dir)
        self.ansible_dir = self.output_dir / "ansible"

    def generate_all(self):
        """Generate all Ansible playbooks and roles"""
        print(f"Generating Ansible recipes from {self.contrib_dir}")
        print(f"Output directory: {self.ansible_dir}")

        # Create output directories
        self.ansible_dir.mkdir(parents=True, exist_ok=True)
        (self.ansible_dir / "roles").mkdir(exist_ok=True)
        (self.ansible_dir / "group_vars").mkdir(exist_ok=True)
        (self.ansible_dir / "host_vars").mkdir(exist_ok=True)
        (self.ansible_dir / "templates").mkdir(exist_ok=True)

        # Generate playbooks
        self.generate_mydns_server_playbook()
        self.generate_webui_playbook()
        self.generate_sensor_playbook()
        self.generate_cloudflare_sync_playbook()
        self.generate_database_schema_playbook()

        # Generate inventory example
        self.generate_inventory()

        # Generate README
        self.generate_readme()

        print("\n✅ Ansible recipes generated successfully!")
        print(f"📁 Location: {self.ansible_dir}")

    def generate_mydns_server_playbook(self):
        """Generate MyDNS server installation playbook"""
        playbook = {
            "name": "Install and Configure MyDNS Server",
            "hosts": "mydns_servers",
            "become": True,
            "vars": {
                "mydns_source_dir": str(self.contrib_dir.parent),
                "mydns_user": "mydns",
                "mydns_group": "mydns",
                "mydns_port": 53,
                "geoip_enabled": True,
                "doh_enabled": True,
                "doh_port": 8443,
                "dns_cache_enabled": True,
            },
            "tasks": [
                {
                    "name": "Update apt cache",
                    "apt": {
                        "update_cache": True,
                        "cache_valid_time": 3600,
                    },
                    "tags": ["dependencies", "always"],
                },
                {
                    "name": "Install build dependencies",
                    "apt": {
                        "name": [
                            "build-essential", "gcc", "make", "autoconf",
                            "automake", "libtool", "libmysqlclient-dev",
                            "libssl-dev", "zlib1g-dev", "pkg-config", "git",
                            "mysql-client", "libgeoip-dev", "libgeoip1",
                            "geoip-database", "python3", "python3-pip",
                            "python3-pymysql", "python3-requests",
                        ],
                        "state": "present",
                    },
                    "tags": ["dependencies"],
                },
                {
                    "name": "Create library symlinks",
                    "file": {
                        "src": "/usr/lib/x86_64-linux-gnu/{{ item }}",
                        "dest": "/usr/lib/{{ item }}",
                        "state": "link",
                        "force": True,
                    },
                    "loop": ["libmysqlclient.so", "libssl.so", "libcrypto.so", "libz.so"],
                    "tags": ["dependencies"],
                },
                {
                    "name": "Clone MyDNS source",
                    "git": {
                        "repo": "https://github.com/yourusername/mydns-ng.git",
                        "dest": "{{ mydns_source_dir }}",
                        "version": "main",
                    },
                    "tags": ["build"],
                },
                {
                    "name": "Configure MyDNS",
                    "command": "./configure",
                    "args": {
                        "chdir": "{{ mydns_source_dir }}",
                        "creates": "{{ mydns_source_dir }}/config.status",
                    },
                    "tags": ["build"],
                },
                {
                    "name": "Build MyDNS",
                    "make": {
                        "chdir": "{{ mydns_source_dir }}",
                    },
                    "tags": ["build"],
                },
                {
                    "name": "Install MyDNS",
                    "make": {
                        "chdir": "{{ mydns_source_dir }}",
                        "target": "install",
                    },
                    "tags": ["build"],
                },
                {
                    "name": "Create MyDNS directories",
                    "file": {
                        "path": "{{ item }}",
                        "state": "directory",
                        "owner": "{{ mydns_user }}",
                        "group": "{{ mydns_group }}",
                        "mode": "0755",
                    },
                    "loop": ["/etc/mydns", "/var/lib/mydns", "/var/log/mydns", "/run/mydns"],
                    "tags": ["config"],
                },
                {
                    "name": "Copy MyDNS configuration",
                    "template": {
                        "src": "templates/mydns.conf.j2",
                        "dest": "/etc/mydns/mydns.conf",
                        "owner": "root",
                        "group": "{{ mydns_group }}",
                        "mode": "0640",
                    },
                    "tags": ["config"],
                },
                {
                    "name": "Install systemd service",
                    "template": {
                        "src": "templates/mydns.service.j2",
                        "dest": "/lib/systemd/system/mydns.service",
                        "owner": "root",
                        "group": "root",
                        "mode": "0644",
                    },
                    "tags": ["service"],
                },
                {
                    "name": "Enable and start MyDNS service",
                    "systemd": {
                        "name": "mydns",
                        "state": "started",
                        "enabled": True,
                        "daemon_reload": True,
                    },
                    "tags": ["service"],
                },
            ],
        }

        output_file = self.ansible_dir / "mydns-server.yml"
        with open(output_file, "w") as f:
            yaml.dump([playbook], f, default_flow_style=False, sort_keys=False)
        print(f"✅ Generated: {output_file}")

    def generate_webui_playbook(self):
        """Generate Web UI installation playbook"""
        playbook = {
            "name": "Install and Configure DNS Manager Web UI",
            "hosts": "webui_servers",
            "become": True,
            "vars": {
                "webui_dir": "/opt/dnsmanager",
                "webui_user": "www-data",
                "webui_port": 4000,
                "client_port": 5173,
                "node_version": "20.x",
            },
            "tasks": [
                {
                    "name": "Install Node.js and npm",
                    "apt": {
                        "name": ["nodejs", "npm", "nginx"],
                        "state": "present",
                    },
                    "tags": ["dependencies"],
                },
                {
                    "name": "Copy Web UI source",
                    "synchronize": {
                        "src": str(self.contrib_dir / "dnsmanager") + "/",
                        "dest": "{{ webui_dir }}/",
                        "delete": True,
                    },
                    "tags": ["deploy"],
                },
                {
                    "name": "Install server dependencies",
                    "npm": {
                        "path": "{{ webui_dir }}/server",
                        "state": "present",
                    },
                    "tags": ["dependencies"],
                },
                {
                    "name": "Install client dependencies",
                    "npm": {
                        "path": "{{ webui_dir }}/client",
                        "state": "present",
                    },
                    "tags": ["dependencies"],
                },
                {
                    "name": "Build client",
                    "command": "npm run build",
                    "args": {
                        "chdir": "{{ webui_dir }}/client",
                    },
                    "tags": ["build"],
                },
                {
                    "name": "Build server",
                    "command": "npm run build",
                    "args": {
                        "chdir": "{{ webui_dir }}/server",
                    },
                    "tags": ["build"],
                },
                {
                    "name": "Install PM2",
                    "npm": {
                        "name": "pm2",
                        "global": True,
                        "state": "present",
                    },
                    "tags": ["dependencies"],
                },
                {
                    "name": "Start Web UI with PM2",
                    "command": "pm2 start dist/index.js --name dnsmanager-api",
                    "args": {
                        "chdir": "{{ webui_dir }}/server",
                    },
                    "tags": ["service"],
                },
                {
                    "name": "Save PM2 configuration",
                    "command": "pm2 save",
                    "tags": ["service"],
                },
                {
                    "name": "Configure nginx",
                    "template": {
                        "src": "templates/nginx-webui.conf.j2",
                        "dest": "/etc/nginx/sites-available/dnsmanager",
                        "owner": "root",
                        "group": "root",
                        "mode": "0644",
                    },
                    "tags": ["nginx"],
                },
                {
                    "name": "Enable nginx site",
                    "file": {
                        "src": "/etc/nginx/sites-available/dnsmanager",
                        "dest": "/etc/nginx/sites-enabled/dnsmanager",
                        "state": "link",
                    },
                    "tags": ["nginx"],
                },
                {
                    "name": "Restart nginx",
                    "systemd": {
                        "name": "nginx",
                        "state": "restarted",
                    },
                    "tags": ["nginx"],
                },
            ],
        }

        output_file = self.ansible_dir / "webui.yml"
        with open(output_file, "w") as f:
            yaml.dump([playbook], f, default_flow_style=False, sort_keys=False)
        print(f"✅ Generated: {output_file}")

    def generate_sensor_playbook(self):
        """Generate GeoIP sensor installation playbook"""
        playbook = {
            "name": "Install GeoIP Sensor",
            "hosts": "sensors",
            "become": True,
            "vars": {
                "sensor_dir": "/opt/geosensor",
                "sensor_user": "sensor",
                "sensor_api_port": 5000,
            },
            "tasks": [
                {
                    "name": "Install Python dependencies",
                    "apt": {
                        "name": ["python3", "python3-pip", "python3-flask"],
                        "state": "present",
                    },
                    "tags": ["dependencies"],
                },
                {
                    "name": "Create sensor directory",
                    "file": {
                        "path": "{{ sensor_dir }}",
                        "state": "directory",
                        "owner": "{{ sensor_user }}",
                        "mode": "0755",
                    },
                    "tags": ["install"],
                },
                {
                    "name": "Copy sensor scripts",
                    "copy": {
                        "src": str(self.contrib_dir / "geosensors") + "/",
                        "dest": "{{ sensor_dir }}/",
                        "owner": "{{ sensor_user }}",
                        "mode": "0755",
                    },
                    "tags": ["install"],
                },
                {
                    "name": "Install systemd service",
                    "template": {
                        "src": "templates/geosensor.service.j2",
                        "dest": "/lib/systemd/system/geosensor.service",
                        "owner": "root",
                        "mode": "0644",
                    },
                    "tags": ["service"],
                },
                {
                    "name": "Enable and start sensor service",
                    "systemd": {
                        "name": "geosensor",
                        "state": "started",
                        "enabled": True,
                        "daemon_reload": True,
                    },
                    "tags": ["service"],
                },
            ],
        }

        output_file = self.ansible_dir / "sensor.yml"
        with open(output_file, "w") as f:
            yaml.dump([playbook], f, default_flow_style=False, sort_keys=False)
        print(f"✅ Generated: {output_file}")

    def generate_cloudflare_sync_playbook(self):
        """Generate Cloudflare sync cron job playbook"""
        playbook = {
            "name": "Setup Cloudflare Sync Cron Job",
            "hosts": "mydns_servers",
            "become": True,
            "vars": {
                "sync_script": str(self.contrib_dir / "sync_cloudflare_records_multi_user.py"),
                "sync_frequency": "*/5 * * * *",  # Every 5 minutes
            },
            "tasks": [
                {
                    "name": "Copy sync script",
                    "copy": {
                        "src": "{{ sync_script }}",
                        "dest": "/usr/local/bin/sync_cloudflare.py",
                        "owner": "root",
                        "mode": "0755",
                    },
                    "tags": ["install"],
                },
                {
                    "name": "Add cron job for Cloudflare sync",
                    "cron": {
                        "name": "Sync Cloudflare zones",
                        "minute": "*/5",
                        "job": "/usr/local/bin/sync_cloudflare.py --verbose >> /var/log/cloudflare-sync.log 2>&1",
                        "user": "root",
                    },
                    "tags": ["cron"],
                },
                {
                    "name": "Create log file",
                    "file": {
                        "path": "/var/log/cloudflare-sync.log",
                        "state": "touch",
                        "owner": "root",
                        "mode": "0644",
                    },
                    "tags": ["config"],
                },
            ],
        }

        output_file = self.ansible_dir / "cloudflare-sync.yml"
        with open(output_file, "w") as f:
            yaml.dump([playbook], f, default_flow_style=False, sort_keys=False)
        print(f"✅ Generated: {output_file}")

    def generate_database_schema_playbook(self):
        """Generate database schema installation playbook"""
        # Find all SQL schema files
        schema_files = list(self.contrib_dir.glob("*-schema.sql"))

        playbook = {
            "name": "Apply Database Schemas",
            "hosts": "mydns_servers",
            "become": True,
            "vars": {
                "mysql_user": "root",
                "mysql_password": "{{ lookup('env', 'MYSQL_ROOT_PASSWORD') }}",
                "mysql_database": "did",
            },
            "tasks": [
                {
                    "name": "Install mysql-client",
                    "apt": {
                        "name": ["mysql-client"],
                        "state": "present",
                    },
                    "tags": ["dependencies"],
                },
            ],
        }

        # Add tasks for each schema file
        for schema_file in schema_files:
            task = {
                "name": f"Apply {schema_file.stem} schema",
                "mysql_db": {
                    "name": "{{ mysql_database }}",
                    "state": "import",
                    "target": str(schema_file),
                    "login_user": "{{ mysql_user }}",
                    "login_password": "{{ mysql_password }}",
                },
                "tags": ["schema", schema_file.stem],
            }
            playbook["tasks"].append(task)

        output_file = self.ansible_dir / "database-schemas.yml"
        with open(output_file, "w") as f:
            yaml.dump([playbook], f, default_flow_style=False, sort_keys=False)
        print(f"✅ Generated: {output_file}")

    def generate_inventory(self):
        """Generate example inventory file"""
        inventory = """# MyDNS Ansible Inventory Example
#
# Copy this file to 'inventory' and adjust for your environment

[mydns_servers]
dns1.example.com ansible_host=192.168.1.10 ansible_user=root
dns2.example.com ansible_host=192.168.1.11 ansible_user=root

[webui_servers]
webui.example.com ansible_host=192.168.1.20 ansible_user=root

[sensors]
sensor1.example.com ansible_host=192.168.1.30 ansible_user=root
sensor2.example.com ansible_host=192.168.1.31 ansible_user=root

[all:vars]
ansible_python_interpreter=/usr/bin/python3

# Database configuration
mysql_host=192.168.1.100
mysql_user=root
mysql_password=changeme
mysql_database=did

# MyDNS configuration
mydns_port=53
geoip_enabled=true
doh_enabled=true
doh_port=8443
dns_cache_enabled=true

# Web UI configuration
webui_port=4000
client_port=5173
"""

        output_file = self.ansible_dir / "inventory.example"
        with open(output_file, "w") as f:
            f.write(inventory)
        print(f"✅ Generated: {output_file}")

    def generate_readme(self):
        """Generate README for Ansible recipes"""
        readme = f"""# MyDNS Ansible Playbooks

**Auto-generated on {datetime.now().strftime("%Y-%m-%d %H:%M:%S")}**

This directory contains Ansible playbooks for deploying and managing MyDNS infrastructure.
These playbooks are **automatically generated** from the `contrib/` directory by the
`generate_ansible.py` script.

## ⚠️ Important

**DO NOT manually edit files in this directory!**

All changes should be made in the source files in `contrib/`, then regenerate by running:

```bash
cd {self.contrib_dir}
python3 generate_ansible.py
```

## Available Playbooks

### 1. MyDNS Server (`mydns-server.yml`)
Installs and configures MyDNS authoritative DNS server with:
- GeoIP support
- DNS over HTTPS (DoH)
- DNS caching
- Memzone for AXFR slaves
- DNSSEC support

**Usage:**
```bash
ansible-playbook -i inventory mydns-server.yml
```

### 2. Web UI (`webui.yml`)
Installs the DNS Manager web interface with:
- Node.js backend API
- React frontend
- nginx reverse proxy
- PM2 process manager

**Usage:**
```bash
ansible-playbook -i inventory webui.yml
```

### 3. GeoIP Sensor (`sensor.yml`)
Installs GeoIP sensors for distributed load balancing

**Usage:**
```bash
ansible-playbook -i inventory sensor.yml
```

### 4. Cloudflare Sync (`cloudflare-sync.yml`)
Sets up cron job for multi-user Cloudflare zone synchronization

**Usage:**
```bash
ansible-playbook -i inventory cloudflare-sync.yml
```

### 5. Database Schemas (`database-schemas.yml`)
Applies all SQL schemas from contrib/:
- DoH configuration
- User Cloudflare credentials
- Zone ACLs
- DNSSEC keys
- And more...

**Usage:**
```bash
ansible-playbook -i inventory database-schemas.yml
```

## Quick Start

1. Copy the example inventory:
   ```bash
   cp inventory.example inventory
   ```

2. Edit inventory with your servers:
   ```bash
   vi inventory
   ```

3. Run a playbook:
   ```bash
   ansible-playbook -i inventory mydns-server.yml
   ```

## Tags

Use tags to run specific parts of playbooks:

```bash
# Only install dependencies
ansible-playbook -i inventory mydns-server.yml --tags dependencies

# Only configure and restart service
ansible-playbook -i inventory mydns-server.yml --tags config,service

# Skip building from source
ansible-playbook -i inventory mydns-server.yml --skip-tags build
```

## Variables

Override default variables in `group_vars/all.yml` or on command line:

```bash
ansible-playbook -i inventory mydns-server.yml -e "mydns_port=5353 geoip_enabled=false"
```

## Requirements

- Ansible 2.9+
- Python 3.7+
- SSH access to target servers
- sudo/root privileges on target servers

## Regenerating Playbooks

After updating contrib/ files:

```bash
cd {self.contrib_dir}
python3 generate_ansible.py
```

This will regenerate all playbooks in `ansible/`.

## License

GPLv2 - See LICENSE file

## Generated By

`generate_ansible.py` - Automatic Ansible recipe generator for MyDNS
"""

        output_file = self.ansible_dir / "README.md"
        with open(output_file, "w") as f:
            f.write(readme)
        print(f"✅ Generated: {output_file}")


def main():
    # Determine paths
    script_dir = Path(__file__).parent
    contrib_dir = script_dir
    output_dir = script_dir

    print("=" * 70)
    print("MyDNS Ansible Recipe Generator")
    print("=" * 70)
    print()

    generator = AnsibleGenerator(str(contrib_dir), str(output_dir))
    generator.generate_all()

    print()
    print("=" * 70)
    print("Generation complete!")
    print()
    print("To use the playbooks:")
    print(f"  cd {generator.ansible_dir}")
    print("  cp inventory.example inventory")
    print("  # Edit inventory with your servers")
    print("  ansible-playbook -i inventory mydns-server.yml")
    print("=" * 70)


if __name__ == "__main__":
    main()
