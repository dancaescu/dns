#!/bin/bash
#
# DNS Monitor Log Rotation Script
# 
# Date: 2025-11-25
#
# Rotates DNS monitoring logs to keep only recent data
# Designed for high-volume DNS query logging
#
# Usage: Run via cron every hour:
#   0 * * * * /path/to/dns-log-rotate.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_BASE="/var/log/dns-monitor"
RETENTION_HOURS=24        # Keep logs for 24 hours
RETENTION_MINUTES=1440    # 24 hours in minutes

# Log files to manage
QUERY_LOG="${LOG_BASE}/queries.log"
ALERT_LOG="${LOG_BASE}/alerts.log"
STATS_LOG="${LOG_BASE}/stats.log"

# Ensure log directory exists
mkdir -p "$LOG_BASE"

# Function to rotate a log file
rotate_log() {
    local LOGFILE="$1"
    local RETENTION="$2"  # in minutes

    if [ ! -f "$LOGFILE" ]; then
        return 0
    fi

    local FILESIZE=$(stat -f%z "$LOGFILE" 2>/dev/null || stat -c%s "$LOGFILE" 2>/dev/null || echo 0)
    local TIMESTAMP=$(date +%Y%m%d-%H%M%S)

    # Rotate if file is larger than 100MB or older than 1 hour
    if [ "$FILESIZE" -gt 104857600 ]; then
        echo "[$(date)] Rotating $LOGFILE (size: ${FILESIZE} bytes)"

        # Compress and archive current log
        gzip -c "$LOGFILE" > "${LOGFILE}.${TIMESTAMP}.gz"

        # Truncate current log
        > "$LOGFILE"

        echo "[$(date)] Created ${LOGFILE}.${TIMESTAMP}.gz"
    fi

    # Delete old compressed logs
    find "$(dirname "$LOGFILE")" -name "$(basename "$LOGFILE").*.gz" \
        -mmin +${RETENTION} -delete -print | \
        while read deleted; do
            echo "[$(date)] Deleted old log: $deleted"
        done
}

# Function to generate statistics before rotation
generate_stats() {
    local QUERY_LOG="$1"
    local STATS_LOG="$2"

    if [ ! -f "$QUERY_LOG" ]; then
        return 0
    fi

    echo "=== DNS Query Statistics $(date) ===" >> "$STATS_LOG"

    # Total queries in last hour
    QUERIES_1H=$(find "$QUERY_LOG" -mmin -60 -exec wc -l {} \; 2>/dev/null | awk '{sum+=$1} END {print sum}')
    echo "Queries (last hour): ${QUERIES_1H:-0}" >> "$STATS_LOG"

    # Top queried domains
    if [ -f "$QUERY_LOG" ]; then
        echo "Top 10 queried domains:" >> "$STATS_LOG"
        tail -n 10000 "$QUERY_LOG" | awk '{print $3}' | sort | uniq -c | sort -rn | head -10 >> "$STATS_LOG"

        echo "Top 10 source IPs:" >> "$STATS_LOG"
        tail -n 10000 "$QUERY_LOG" | awk '{print $2}' | sort | uniq -c | sort -rn | head -10 >> "$STATS_LOG"
    fi

    echo "" >> "$STATS_LOG"
}

# Main rotation logic
echo "=== DNS Log Rotation Started: $(date) ==="

# Generate stats before rotation
generate_stats "$QUERY_LOG" "$STATS_LOG"

# Rotate logs
rotate_log "$QUERY_LOG" "$RETENTION_MINUTES"
rotate_log "$ALERT_LOG" "$RETENTION_MINUTES"

# Keep stats log for 7 days (longer retention)
rotate_log "$STATS_LOG" 10080

# Cleanup any logs older than retention period
find "$LOG_BASE" -name "*.log.*.gz" -mmin +${RETENTION_MINUTES} -delete

# Print summary
echo "=== Disk Usage ==="
du -sh "$LOG_BASE"
echo ""
echo "=== Current Logs ==="
ls -lh "$LOG_BASE"/*.log 2>/dev/null || echo "No active log files"
echo ""
echo "=== Archived Logs ==="
ls -lh "$LOG_BASE"/*.gz 2>/dev/null || echo "No archived logs"

echo "=== DNS Log Rotation Completed: $(date) ==="
