#!/bin/bash
#
# DNS Monitor Installation Script
# Installs and configures DNS attack monitoring for MyDNS
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="/var/log/dns-monitor"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo "=== DNS Monitor Installation ==="
echo ""

# Check root
if [ "$EUID" -ne 0 ]; then
    echo -e "${RED}Error: Must run as root${NC}"
    exit 1
fi

# Check dependencies
echo "Checking dependencies..."
MISSING_DEPS=""

if ! command -v tcpdump &> /dev/null; then
    MISSING_DEPS="$MISSING_DEPS tcpdump"
fi

if ! command -v iptables &> /dev/null; then
    MISSING_DEPS="$MISSING_DEPS iptables"
fi

if [ -n "$MISSING_DEPS" ]; then
    echo -e "${YELLOW}Missing dependencies:$MISSING_DEPS${NC}"
    echo "Install with: apt-get install$MISSING_DEPS"
    read -p "Install now? (y/n) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        apt-get update
        apt-get install -y$MISSING_DEPS
    else
        exit 1
    fi
fi

echo -e "${GREEN}✓ Dependencies installed${NC}"

# Create log directory
echo "Creating log directory..."
mkdir -p "$LOG_DIR"
chmod 755 "$LOG_DIR"
echo -e "${GREEN}✓ Log directory: $LOG_DIR${NC}"

# Install monitoring script
echo "Installing monitoring script..."
cp "$SCRIPT_DIR/dns-monitor.sh" /usr/local/sbin/dns-monitor
chmod 755 /usr/local/sbin/dns-monitor
echo -e "${GREEN}✓ Installed: /usr/local/sbin/dns-monitor${NC}"

# Install log rotation
echo "Installing log rotation..."
if [ -d /etc/logrotate.d ]; then
    cp "$SCRIPT_DIR/logrotate.conf" /etc/logrotate.d/dns-monitor
    chmod 644 /etc/logrotate.d/dns-monitor
    echo -e "${GREEN}✓ Installed: /etc/logrotate.d/dns-monitor${NC}"
else
    echo -e "${YELLOW}⚠ logrotate.d not found, installing manual rotation${NC}"
fi

# Install hourly log rotation script
cp "$SCRIPT_DIR/dns-log-rotate.sh" /usr/local/sbin/dns-log-rotate
chmod 755 /usr/local/sbin/dns-log-rotate
echo -e "${GREEN}✓ Installed: /usr/local/sbin/dns-log-rotate${NC}"

# Setup cron job for log rotation
echo "Setting up automatic log rotation..."
CRON_JOB="0 * * * * /usr/local/sbin/dns-log-rotate >> /var/log/dns-monitor/rotation.log 2>&1"

if ! crontab -l 2>/dev/null | grep -q "dns-log-rotate"; then
    (crontab -l 2>/dev/null; echo "$CRON_JOB") | crontab -
    echo -e "${GREEN}✓ Added hourly log rotation to crontab${NC}"
else
    echo -e "${YELLOW}⚠ Log rotation already in crontab${NC}"
fi

# Optional: Apply iptables rate limiting
echo ""
read -p "Apply iptables rate limiting? (recommended) (y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo "Applying iptables rate limiting..."

    # UDP DNS rate limiting: 30 queries/second per IP
    iptables -A INPUT -p udp --dport 53 -m state --state NEW \
      -m recent --set --name DNS_RATE_LIMIT

    iptables -A INPUT -p udp --dport 53 -m state --state NEW \
      -m recent --update --seconds 1 --hitcount 30 --name DNS_RATE_LIMIT \
      -j LOG --log-prefix "DNS_RATE_LIMIT: " --log-level 4

    iptables -A INPUT -p udp --dport 53 -m state --state NEW \
      -m recent --update --seconds 1 --hitcount 30 --name DNS_RATE_LIMIT \
      -j DROP

    # TCP DNS rate limiting: 20 queries/second per IP
    iptables -A INPUT -p tcp --dport 53 -m state --state NEW \
      -m recent --set --name DNS_RATE_LIMIT_TCP

    iptables -A INPUT -p tcp --dport 53 -m state --state NEW \
      -m recent --update --seconds 1 --hitcount 20 --name DNS_RATE_LIMIT_TCP \
      -j LOG --log-prefix "DNS_RATE_LIMIT_TCP: " --log-level 4

    iptables -A INPUT -p tcp --dport 53 -m state --state NEW \
      -m recent --update --seconds 1 --hitcount 20 --name DNS_RATE_LIMIT_TCP \
      -j DROP

    echo -e "${GREEN}✓ Rate limiting applied${NC}"

    # Save iptables rules
    if command -v iptables-save &> /dev/null; then
        if [ -d /etc/iptables ]; then
            iptables-save > /etc/iptables/rules.v4
            echo -e "${GREEN}✓ Saved iptables rules${NC}"
        fi
    fi
fi

# Optional: Start monitoring now
echo ""
read -p "Start DNS monitoring now? (y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    /usr/local/sbin/dns-monitor start
fi

# Optional: Enable at boot
echo ""
read -p "Enable monitoring at boot via systemd? (y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    cat > /etc/systemd/system/dns-monitor.service <<EOF
[Unit]
Description=DNS Attack Monitor
After=network.target mydns.service

[Service]
Type=forking
ExecStart=/usr/local/sbin/dns-monitor start
ExecStop=/usr/local/sbin/dns-monitor stop
PIDFile=/var/run/dns-monitor.pid
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

    systemctl daemon-reload
    systemctl enable dns-monitor.service
    echo -e "${GREEN}✓ Enabled dns-monitor.service${NC}"
fi

echo ""
echo "=== Installation Complete ==="
echo ""
echo "Usage:"
echo "  dns-monitor start   - Start monitoring"
echo "  dns-monitor stop    - Stop monitoring"
echo "  dns-monitor status  - Check status"
echo "  dns-monitor stats   - Show statistics"
echo ""
echo "Logs:"
echo "  Queries: $LOG_DIR/queries.log"
echo "  Alerts:  $LOG_DIR/alerts.log"
echo "  Stats:   $LOG_DIR/stats.log"
echo ""
echo "Monitor logs:"
echo "  tail -f $LOG_DIR/alerts.log"
echo ""
echo "Rate limiting logs:"
echo "  tail -f /var/log/kern.log | grep DNS_RATE_LIMIT"
echo ""
