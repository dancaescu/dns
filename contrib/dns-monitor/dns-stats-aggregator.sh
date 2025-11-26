#!/bin/bash
#
# DNS Statistics Aggregator
# Processes DNS query logs and stores aggregate statistics in MySQL
# Date: 2025-11-25
#
# Runs hourly via cron to aggregate logs into MySQL statistics tables
# This avoids storing millions of individual queries while preserving insights
#
# Usage: 0 * * * * /path/to/dns-stats-aggregator.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="/var/log/dns-monitor"
QUERY_LOG="${LOG_DIR}/queries.log"
ALERT_LOG="${LOG_DIR}/alerts.log"

# MySQL connection settings
DB_HOST="localhost"
DB_USER="root"
DB_NAME="did"
DB_PASS=""  # Set if needed

# Date variables
STAT_DATE=$(date +%Y-%m-%d)
STAT_HOUR=$(date +%H)

# Temporary files
TMP_DIR="/tmp/dns-stats-$$"
mkdir -p "$TMP_DIR"
trap "rm -rf $TMP_DIR" EXIT

# MySQL query function
mysql_query() {
    mysql -h "$DB_HOST" -u "$DB_USER" ${DB_PASS:+-p"$DB_PASS"} "$DB_NAME" -e "$1"
}

# Log function
log_msg() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

log_msg "=== DNS Stats Aggregation Started ==="

# Check if query log exists
if [ ! -f "$QUERY_LOG" ]; then
    log_msg "No query log found at $QUERY_LOG"
    exit 0
fi

# Parse queries from last hour
log_msg "Parsing queries from last hour..."
LAST_HOUR=$(date -d '1 hour ago' '+%Y-%m-%d %H' 2>/dev/null || date -v-1H '+%Y-%m-%d %H')

awk -v cutoff="$LAST_HOUR" '$1" "$2 >= cutoff' "$QUERY_LOG" > "$TMP_DIR/recent_queries.log"

QUERY_COUNT=$(wc -l < "$TMP_DIR/recent_queries.log")
log_msg "Found $QUERY_COUNT queries in last hour"

if [ "$QUERY_COUNT" -eq 0 ]; then
    log_msg "No queries to process"
    exit 0
fi

# Extract statistics
log_msg "Calculating statistics..."

# Total queries
TOTAL_QUERIES=$QUERY_COUNT

# Unique IPs
UNIQUE_IPS=$(awk '{print $2}' "$TMP_DIR/recent_queries.log" | sort -u | wc -l)

# Query type distribution (parse from query names)
# Format: timestamp IP domain.name.type
# We need to infer types or parse from actual DNS packet captures
# For now, count based on query patterns

QUERIES_A=$(grep -c "\.in-addr\.arpa\|^[^.]*\.[^.]*\.[^.]*$" "$TMP_DIR/recent_queries.log" 2>/dev/null || echo 0)
QUERIES_MX=0  # Would need actual packet inspection
QUERIES_TXT=0
QUERIES_OTHER=$((TOTAL_QUERIES - QUERIES_A))

# Top queried domains per zone
log_msg "Aggregating top queries..."

# Extract domain queries and their counts
awk '{print $3}' "$TMP_DIR/recent_queries.log" | \
    sort | uniq -c | sort -rn | head -100 > "$TMP_DIR/top_queries.txt"

# Process top queries and map to zones
while read -r count domain; do
    # Extract base domain (last 2-3 parts)
    BASE_DOMAIN=$(echo "$domain" | awk -F. '{print $(NF-1)"."$NF}')

    # Find zone_id for this domain
    ZONE_ID=$(mysql_query "SELECT id FROM soa WHERE origin='$BASE_DOMAIN.' LIMIT 1" | tail -n 1)

    if [ -n "$ZONE_ID" ] && [ "$ZONE_ID" != "id" ]; then
        # Insert or update top query
        mysql_query "INSERT INTO dns_top_queries
            (zone_id, stat_date, record_name, record_type, query_count, unique_ips)
            VALUES ($ZONE_ID, '$STAT_DATE', '$domain', 'A', $count, 1)
            ON DUPLICATE KEY UPDATE
                query_count = query_count + $count"
    fi
done < "$TMP_DIR/top_queries.txt"

# Process security alerts
if [ -f "$ALERT_LOG" ]; then
    log_msg "Processing security alerts..."

    # Count alerts by type in last hour
    TUNNEL_ALERTS=$(grep "$LAST_HOUR" "$ALERT_LOG" | grep -c "TUNNEL" 2>/dev/null || echo 0)
    FLOOD_ALERTS=$(grep "$LAST_HOUR" "$ALERT_LOG" | grep -c "FLOOD" 2>/dev/null || echo 0)
    BLOCKED_IPS=$(grep "$LAST_HOUR" "$ALERT_LOG" | grep -c "BLOCKED" 2>/dev/null || echo 0)

    # Insert security events
    grep "$LAST_HOUR" "$ALERT_LOG" | while read -r line; do
        TIMESTAMP=$(echo "$line" | awk '{print $1" "$2}')
        EVENT_TYPE=$(echo "$line" | sed -n 's/.*\[\([^]]*\)\].*/\1/p')
        SOURCE_IP=$(echo "$line" | awk '{print $3}')
        QUERY=$(echo "$line" | awk '{print $4}')
        DETAILS=$(echo "$line" | cut -d'-' -f2-)

        # Map alert types to enum values
        case "$EVENT_TYPE" in
            TUNNEL_*) DB_EVENT_TYPE="TUNNEL_DETECTED" ;;
            *FLOOD*) DB_EVENT_TYPE="FLOOD_DETECTED" ;;
            BLOCKED) DB_EVENT_TYPE="IP_BLOCKED" ;;
            *) DB_EVENT_TYPE="RATE_LIMITED" ;;
        esac

        # Determine severity
        if [[ "$EVENT_TYPE" == *"BLOCKED"* ]]; then
            SEVERITY="HIGH"
        elif [[ "$EVENT_TYPE" == *"FLOOD"* ]]; then
            SEVERITY="HIGH"
        elif [[ "$EVENT_TYPE" == *"TUNNEL"* ]]; then
            SEVERITY="MEDIUM"
        else
            SEVERITY="LOW"
        fi

        # Insert event (escape quotes)
        DETAILS_ESC=$(echo "$DETAILS" | sed "s/'/''/g")
        mysql_query "INSERT INTO dns_security_events
            (event_type, source_ip, query_name, details, severity, date_created)
            VALUES ('$DB_EVENT_TYPE', '$SOURCE_IP', '$QUERY', '$DETAILS_ESC', '$SEVERITY', '$TIMESTAMP')"
    done
else
    TUNNEL_ALERTS=0
    FLOOD_ALERTS=0
    BLOCKED_IPS=0
fi

# Aggregate zone statistics
log_msg "Aggregating zone statistics..."

# Get all zones and aggregate queries for each
mysql_query "SELECT id, origin FROM soa WHERE active='Y'" | tail -n +2 | while read -r zone_id origin; do
    # Remove trailing dot
    origin_clean=$(echo "$origin" | sed 's/\.$//')

    # Count queries for this zone
    zone_queries=$(grep -c "$origin_clean" "$TMP_DIR/recent_queries.log" 2>/dev/null || echo 0)

    if [ "$zone_queries" -gt 0 ]; then
        # Calculate NXDOMAIN rate (would need actual DNS response codes)
        # For now, estimate based on unique random subdomains
        unique_subdomains=$(grep "$origin_clean" "$TMP_DIR/recent_queries.log" | \
                           awk '{print $3}' | cut -d. -f1 | sort -u | wc -l)

        nxdomain_rate=0
        if [ "$unique_subdomains" -gt $((zone_queries / 2)) ]; then
            nxdomain_rate=$((unique_subdomains * 100 / zone_queries))
        fi

        responses_nxdomain=$((zone_queries * nxdomain_rate / 100))
        responses_noerror=$((zone_queries - responses_nxdomain))

        # Insert or update zone stats
        mysql_query "INSERT INTO dns_zone_stats
            (zone_id, stat_date, stat_hour, total_queries, queries_a, queries_other,
             responses_noerror, responses_nxdomain, tunnel_alerts, flood_alerts, blocked_ips)
            VALUES ($zone_id, '$STAT_DATE', $STAT_HOUR, $zone_queries, $QUERIES_A, $QUERIES_OTHER,
                    $responses_noerror, $responses_nxdomain, $TUNNEL_ALERTS, $FLOOD_ALERTS, $BLOCKED_IPS)
            ON DUPLICATE KEY UPDATE
                total_queries = total_queries + VALUES(total_queries),
                queries_a = queries_a + VALUES(queries_a),
                queries_other = queries_other + VALUES(queries_other),
                responses_noerror = responses_noerror + VALUES(responses_noerror),
                responses_nxdomain = responses_nxdomain + VALUES(responses_nxdomain),
                tunnel_alerts = tunnel_alerts + VALUES(tunnel_alerts),
                flood_alerts = flood_alerts + VALUES(flood_alerts),
                blocked_ips = blocked_ips + VALUES(blocked_ips)"

        log_msg "Zone $origin_clean: $zone_queries queries"
    fi
done

# Update server-wide stats
log_msg "Updating server-wide statistics..."

# Get cache stats from MyDNS (would need to parse mydns status output)
# For now, use placeholder values
CACHE_SIZE_MB=0

# Get system stats
CPU_USAGE=$(top -bn1 | grep "Cpu(s)" | awk '{print $2}' | cut -d'%' -f1 || echo 0)
MEMORY_MB=$(free -m | awk 'NR==2{print $3}')
UPTIME_SEC=$(cat /proc/uptime | cut -d' ' -f1 | cut -d'.' -f1)

# Calculate QPS (queries per second for last hour)
QPS=$(echo "scale=2; $TOTAL_QUERIES / 3600" | bc)

mysql_query "INSERT INTO dns_server_stats
    (stat_date, stat_hour, total_queries, queries_per_second, unique_ips,
     cache_size_mb, cpu_usage, memory_usage_mb, uptime_seconds,
     total_blocked_ips, total_attacks)
    VALUES ('$STAT_DATE', $STAT_HOUR, $TOTAL_QUERIES, $QPS, $UNIQUE_IPS,
            $CACHE_SIZE_MB, $CPU_USAGE, $MEMORY_MB, $UPTIME_SEC,
            $BLOCKED_IPS, $((TUNNEL_ALERTS + FLOOD_ALERTS)))
    ON DUPLICATE KEY UPDATE
        total_queries = total_queries + VALUES(total_queries),
        unique_ips = unique_ips + VALUES(unique_ips),
        total_blocked_ips = total_blocked_ips + VALUES(total_blocked_ips),
        total_attacks = total_attacks + VALUES(total_attacks)"

# Create daily rollup (at midnight)
CURRENT_HOUR=$(date +%H)
if [ "$CURRENT_HOUR" = "00" ]; then
    log_msg "Creating daily rollup..."

    YESTERDAY=$(date -d '1 day ago' '+%Y-%m-%d' 2>/dev/null || date -v-1d '+%Y-%m-%d')

    # Rollup zone stats
    mysql_query "INSERT INTO dns_zone_stats
        (zone_id, stat_date, stat_hour, total_queries, queries_a, queries_aaaa,
         queries_mx, queries_txt, queries_other, responses_noerror, responses_nxdomain,
         tunnel_alerts, flood_alerts, blocked_ips)
        SELECT zone_id, stat_date, NULL,
               SUM(total_queries), SUM(queries_a), SUM(queries_aaaa),
               SUM(queries_mx), SUM(queries_txt), SUM(queries_other),
               SUM(responses_noerror), SUM(responses_nxdomain),
               SUM(tunnel_alerts), SUM(flood_alerts), SUM(blocked_ips)
        FROM dns_zone_stats
        WHERE stat_date = '$YESTERDAY' AND stat_hour IS NOT NULL
        GROUP BY zone_id, stat_date
        ON DUPLICATE KEY UPDATE
            total_queries = VALUES(total_queries),
            queries_a = VALUES(queries_a),
            queries_aaaa = VALUES(queries_aaaa),
            queries_mx = VALUES(queries_mx),
            queries_txt = VALUES(queries_txt),
            queries_other = VALUES(queries_other),
            responses_noerror = VALUES(responses_noerror),
            responses_nxdomain = VALUES(responses_nxdomain),
            tunnel_alerts = VALUES(tunnel_alerts),
            flood_alerts = VALUES(flood_alerts),
            blocked_ips = VALUES(blocked_ips)"

    # Rollup server stats
    mysql_query "INSERT INTO dns_server_stats
        (stat_date, stat_hour, total_queries, queries_per_second, unique_ips)
        SELECT stat_date, NULL,
               SUM(total_queries),
               AVG(queries_per_second),
               MAX(unique_ips)
        FROM dns_server_stats
        WHERE stat_date = '$YESTERDAY' AND stat_hour IS NOT NULL
        GROUP BY stat_date
        ON DUPLICATE KEY UPDATE
            total_queries = VALUES(total_queries),
            queries_per_second = VALUES(queries_per_second),
            unique_ips = VALUES(unique_ips)"
fi

# Cleanup old data (keep 30 days)
log_msg "Cleaning up old statistics..."
CUTOFF_DATE=$(date -d '30 days ago' '+%Y-%m-%d' 2>/dev/null || date -v-30d '+%Y-%m-%d')

mysql_query "DELETE FROM dns_zone_stats WHERE stat_date < '$CUTOFF_DATE' AND stat_hour IS NOT NULL"
mysql_query "DELETE FROM dns_server_stats WHERE stat_date < '$CUTOFF_DATE' AND stat_hour IS NOT NULL"
mysql_query "DELETE FROM dns_top_queries WHERE stat_date < '$CUTOFF_DATE'"
mysql_query "DELETE FROM dns_security_events WHERE date_created < '$CUTOFF_DATE 00:00:00'"

log_msg "=== DNS Stats Aggregation Completed ==="
log_msg "Processed $TOTAL_QUERIES queries, $UNIQUE_IPS unique IPs"
log_msg "Alerts: $TUNNEL_ALERTS tunneling, $FLOOD_ALERTS floods, $BLOCKED_IPS blocked"
