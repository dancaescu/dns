#!/bin/bash
#
# DNS Monitor for MyDNS
# Real-time monitoring for DNS tunneling and PRSD attacks
# 
# Date: 2025-11-25
#
# Usage:
#   ./dns-monitor.sh start   - Start monitoring
#   ./dns-monitor.sh stop    - Stop monitoring
#   ./dns-monitor.sh status  - Check status
#   ./dns-monitor.sh stats   - Show statistics

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="/var/log/dns-monitor"
PID_FILE="/var/run/dns-monitor.pid"

QUERY_LOG="${LOG_DIR}/queries.log"
ALERT_LOG="${LOG_DIR}/alerts.log"
STATS_LOG="${LOG_DIR}/stats.log"
BLOCKED_LOG="${LOG_DIR}/blocked-ips.log"

# Detection thresholds
MAX_SUBDOMAIN_LENGTH=50
MAX_QUERIES_PER_MINUTE=3000
TUNNEL_THRESHOLD=10    # Number of suspicious queries before alert

# Colors for output
RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
NC='\033[0m' # No Color

# Ensure running as root
if [ "$EUID" -ne 0 ]; then
    echo "Error: This script must be run as root"
    exit 1
fi

# Create log directory
mkdir -p "$LOG_DIR"
chmod 755 "$LOG_DIR"

# Function to check if monitoring is running
is_running() {
    if [ -f "$PID_FILE" ]; then
        PID=$(cat "$PID_FILE")
        if ps -p "$PID" > /dev/null 2>&1; then
            return 0
        fi
    fi
    return 1
}

# Function to start monitoring
start_monitor() {
    if is_running; then
        echo "DNS monitor is already running (PID: $(cat "$PID_FILE"))"
        return 1
    fi

    echo "Starting DNS monitor..."
    echo "Logs: $LOG_DIR"

    # Start tcpdump in background
    tcpdump -l -i any -nn port 53 -Q in 2>/dev/null | \
      while IFS= read -r line; do
        process_packet "$line"
      done &

    echo $! > "$PID_FILE"
    echo -e "${GREEN}DNS monitor started (PID: $!)${NC}"
    echo "View alerts: tail -f $ALERT_LOG"
    echo "View queries: tail -f $QUERY_LOG"
}

# Function to process DNS packet
process_packet() {
    local line="$1"

    # Only process DNS queries (A? means A record query)
    if ! echo "$line" | grep -q "A?"; then
        return
    fi

    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    local src_ip=$(echo "$line" | awk '{print $3}' | cut -d'.' -f1-4)
    local query=$(echo "$line" | sed -n 's/.*A? \([^ ]*\).*/\1/p')

    if [ -z "$query" ]; then
        return
    fi

    # Log query
    echo "$timestamp $src_ip $query" >> "$QUERY_LOG"

    # Extract subdomain
    local subdomain=$(echo "$query" | cut -d'.' -f1)
    local subdomain_len=${#subdomain}
    local query_len=${#query}

    # Check for tunneling indicators
    local is_suspicious=0

    # 1. Very long subdomain
    if [ $subdomain_len -gt $MAX_SUBDOMAIN_LENGTH ]; then
        alert "TUNNEL_LONG" "$src_ip" "$query" "Subdomain length: ${subdomain_len}"
        is_suspicious=1
    fi

    # 2. Base64-like pattern
    if echo "$subdomain" | grep -qE '^[A-Za-z0-9+/]{30,}={0,2}$'; then
        alert "TUNNEL_BASE64" "$src_ip" "$query" "Base64 pattern detected"
        is_suspicious=1
    fi

    # 3. High entropy (random-looking)
    if [ $subdomain_len -gt 20 ]; then
        local vowels=$(echo "$subdomain" | tr -cd 'aeiouAEIOU' | wc -c)
        local ratio=$((vowels * 100 / subdomain_len))
        if [ $ratio -lt 15 ]; then
            alert "TUNNEL_ENTROPY" "$src_ip" "$query" "Low vowel ratio: ${ratio}%"
            is_suspicious=1
        fi
    fi

    # 4. Hex-encoded pattern
    if echo "$subdomain" | grep -qE '^[0-9a-fA-F]{32,}$'; then
        alert "TUNNEL_HEX" "$src_ip" "$query" "Hex pattern detected"
        is_suspicious=1
    fi

    # Check for query flood (PRSD attack)
    check_query_rate "$src_ip"
}

# Function to send alert
alert() {
    local alert_type="$1"
    local src_ip="$2"
    local query="$3"
    local reason="$4"
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')

    echo "$timestamp [$alert_type] $src_ip $query - $reason" >> "$ALERT_LOG"
    logger -t dns-monitor "[$alert_type] $src_ip: $query - $reason"

    # Auto-block if too many alerts from same IP
    check_auto_block "$src_ip" "$alert_type"
}

# Function to check query rate
check_query_rate() {
    local src_ip="$1"
    local count=$(grep -c "$src_ip" "$QUERY_LOG" 2>/dev/null || echo 0)

    # Check last minute only
    local recent_count=$(tail -n 10000 "$QUERY_LOG" 2>/dev/null | \
                         grep "$src_ip" | \
                         awk -v cutoff="$(date -d '1 minute ago' '+%Y-%m-%d %H:%M:%S' 2>/dev/null || date -v-1M '+%Y-%m-%d %H:%M:%S')" \
                         '$1" "$2 > cutoff' | wc -l)

    if [ "$recent_count" -gt "$MAX_QUERIES_PER_MINUTE" ]; then
        alert "QUERY_FLOOD" "$src_ip" "N/A" "Rate: $recent_count queries/minute"
    fi
}

# Function to auto-block IPs
check_auto_block() {
    local src_ip="$1"
    local alert_type="$2"

    # Count recent alerts from this IP
    local alert_count=$(tail -n 1000 "$ALERT_LOG" 2>/dev/null | \
                        grep "$src_ip" | wc -l)

    if [ "$alert_count" -gt "$TUNNEL_THRESHOLD" ]; then
        # Check if already blocked
        if iptables -L INPUT -n | grep -q "$src_ip"; then
            return
        fi

        # Block the IP
        echo "$(date '+%Y-%m-%d %H:%M:%S') BLOCKED $src_ip - $alert_count alerts" >> "$BLOCKED_LOG"
        iptables -I INPUT -s "$src_ip" -j DROP
        logger -t dns-monitor "AUTO-BLOCKED $src_ip after $alert_count alerts"

        echo -e "${RED}[AUTO-BLOCK] Blocked $src_ip after $alert_count alerts${NC}" >&2
    fi
}

# Function to stop monitoring
stop_monitor() {
    if ! is_running; then
        echo "DNS monitor is not running"
        return 1
    fi

    local pid=$(cat "$PID_FILE")
    echo "Stopping DNS monitor (PID: $pid)..."

    # Kill the process and all children
    pkill -P "$pid" 2>/dev/null
    kill "$pid" 2>/dev/null

    rm -f "$PID_FILE"
    echo -e "${GREEN}DNS monitor stopped${NC}"
}

# Function to show status
show_status() {
    if is_running; then
        local pid=$(cat "$PID_FILE")
        echo -e "${GREEN}DNS monitor is running${NC} (PID: $pid)"
        echo ""
        echo "Uptime: $(ps -p $pid -o etime= | tr -d ' ')"
        echo "Log directory: $LOG_DIR"
        echo ""
        echo "Recent activity (last 10 alerts):"
        tail -n 10 "$ALERT_LOG" 2>/dev/null || echo "No alerts"
    else
        echo -e "${YELLOW}DNS monitor is not running${NC}"
    fi
}

# Function to show statistics
show_stats() {
    echo "=== DNS Monitor Statistics ==="
    echo ""

    if [ -f "$QUERY_LOG" ]; then
        echo "Query Log:"
        echo "  Total queries logged: $(wc -l < "$QUERY_LOG")"
        echo "  Log size: $(du -h "$QUERY_LOG" | cut -f1)"
        echo ""

        echo "Top 10 Queried Domains (last 1000 queries):"
        tail -n 1000 "$QUERY_LOG" | awk '{print $3}' | sort | uniq -c | sort -rn | head -10
        echo ""

        echo "Top 10 Source IPs (last 1000 queries):"
        tail -n 1000 "$QUERY_LOG" | awk '{print $2}' | sort | uniq -c | sort -rn | head -10
        echo ""
    fi

    if [ -f "$ALERT_LOG" ]; then
        echo "Alerts:"
        echo "  Total alerts: $(wc -l < "$ALERT_LOG")"
        echo ""

        echo "Alert Types:"
        awk '{print $3}' "$ALERT_LOG" | sed 's/\[//;s/\]//' | sort | uniq -c | sort -rn
        echo ""
    fi

    if [ -f "$BLOCKED_LOG" ]; then
        echo "Blocked IPs:"
        echo "  Total blocked: $(wc -l < "$BLOCKED_LOG")"
        if [ -s "$BLOCKED_LOG" ]; then
            echo ""
            tail -n 10 "$BLOCKED_LOG"
        fi
    fi

    echo ""
    echo "Disk Usage: $(du -sh "$LOG_DIR" | cut -f1)"
}

# Main command handling
case "${1:-}" in
    start)
        start_monitor
        ;;
    stop)
        stop_monitor
        ;;
    restart)
        stop_monitor
        sleep 2
        start_monitor
        ;;
    status)
        show_status
        ;;
    stats)
        show_stats
        ;;
    *)
        echo "Usage: $0 {start|stop|restart|status|stats}"
        echo ""
        echo "Commands:"
        echo "  start   - Start DNS monitoring"
        echo "  stop    - Stop DNS monitoring"
        echo "  restart - Restart monitoring"
        echo "  status  - Show monitoring status"
        echo "  stats   - Show statistics"
        exit 1
        ;;
esac
