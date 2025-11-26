# DNS Attack Monitoring for MyDNS

Real-time monitoring and protection against DNS-based attacks including tunneling, PRSD (Pseudo-Random Subdomain) floods, and query floods.

## Features

✅ **Real-time DNS Query Monitoring**
- Captures all DNS queries via tcpdump
- Logs queries to rotating log files
- Low overhead packet capture

✅ **Attack Detection**
- DNS tunneling detection (long subdomains, base64 patterns, hex encoding)
- PRSD/random subdomain flood detection
- Query rate limiting per IP
- Entropy analysis for suspicious patterns

✅ **Automatic Protection**
- Rate limiting via iptables (30 queries/sec UDP, 20/sec TCP)
- Automatic IP blocking after repeated attacks
- Connection limits per IP

✅ **Efficient Log Management**
- Automatic log rotation (keeps only last 24 hours)
- Compressed archives for space efficiency
- Hourly statistics generation
- Minimal disk usage

## Quick Start

### Installation

```bash
cd /scripts/mydns-ng-master/contrib/dns-monitor
chmod +x install.sh
sudo ./install.sh
```

The installer will:
1. Check and install dependencies (tcpdump, iptables)
2. Create log directory `/var/log/dns-monitor`
3. Install monitoring script to `/usr/local/sbin/dns-monitor`
4. Configure automatic log rotation
5. Optionally apply iptables rate limiting
6. Optionally enable systemd service

### Manual Installation

```bash
# Install dependencies
apt-get install tcpdump iptables

# Copy scripts
cp dns-monitor.sh /usr/local/sbin/dns-monitor
cp dns-log-rotate.sh /usr/local/sbin/dns-log-rotate
cp logrotate.conf /etc/logrotate.d/dns-monitor

# Make executable
chmod 755 /usr/local/sbin/dns-monitor
chmod 755 /usr/local/sbin/dns-log-rotate

# Create log directory
mkdir -p /var/log/dns-monitor
```

## Usage

### Start Monitoring

```bash
dns-monitor start
```

### Stop Monitoring

```bash
dns-monitor stop
```

### Check Status

```bash
dns-monitor status
```

### View Statistics

```bash
dns-monitor stats
```

### Watch Live Alerts

```bash
tail -f /var/log/dns-monitor/alerts.log
```

### Watch All Queries

```bash
tail -f /var/log/dns-monitor/queries.log
```

## Attack Detection

### DNS Tunneling Detection

**What it detects:**
- Subdomains longer than 50 characters
- Base64-encoded patterns (e.g., `bG9uZ2RhdGE=.example.com`)
- Hex-encoded patterns (e.g., `deadbeef1234.example.com`)
- Low vowel ratio (high entropy/randomness)

**Alert types:**
- `[TUNNEL_LONG]` - Suspiciously long subdomain
- `[TUNNEL_BASE64]` - Base64 pattern detected
- `[TUNNEL_HEX]` - Hex pattern detected
- `[TUNNEL_ENTROPY]` - Random-looking subdomain

**Example alert:**
```
2025-11-25 16:45:23 [TUNNEL_BASE64] 192.168.1.100 bG9uZ2RhdGExMjM0NTY3ODkw.evil.com - Base64 pattern detected
```

### PRSD Attack Detection

**What it detects:**
- High query rate from single IP (>3000 queries/minute)
- Many unique random subdomains
- High NXDOMAIN rate

**Alert type:**
- `[QUERY_FLOOD]` - Excessive queries per minute

**Example alert:**
```
2025-11-25 16:45:30 [QUERY_FLOOD] 203.0.113.50 N/A - Rate: 3500 queries/minute
```

### Automatic IP Blocking

After **10 suspicious queries** from the same IP, the IP is automatically blocked via iptables.

**Blocked IP log:**
```
2025-11-25 16:45:45 BLOCKED 203.0.113.50 - 15 alerts
```

**View blocked IPs:**
```bash
cat /var/log/dns-monitor/blocked-ips.log
iptables -L INPUT -n | grep DROP
```

**Unblock an IP:**
```bash
iptables -D INPUT -s 203.0.113.50 -j DROP
```

## Log Management

### Log Files

| File | Purpose | Retention |
|------|---------|-----------|
| `queries.log` | All DNS queries | 24 hours |
| `alerts.log` | Attack alerts | 7 days |
| `stats.log` | Hourly statistics | 7 days |
| `blocked-ips.log` | Blocked IPs | 30 days |

### Log Rotation

**Automatic rotation:**
- Runs hourly via cron
- Keeps only last 24 hours of queries
- Compresses old logs with gzip
- Rotates when file exceeds 100MB

**Manual rotation:**
```bash
dns-log-rotate
```

**Force logrotate:**
```bash
logrotate -f /etc/logrotate.d/dns-monitor
```

### Disk Usage

Expected disk usage with moderate traffic (10 queries/sec):
- Active logs: ~50-200 MB
- Compressed archives: ~10-50 MB
- Total: ~100-300 MB for 24 hours

High traffic (100 queries/sec):
- Active logs: ~500 MB - 1 GB
- Compressed archives: ~100-200 MB
- Total: ~1-2 GB for 24 hours

**Check current usage:**
```bash
du -sh /var/log/dns-monitor
dns-monitor stats
```

## Rate Limiting Configuration

### Current Limits

```
UDP DNS: 30 queries/second per IP
TCP DNS: 20 queries/second per IP
Max concurrent connections: 50 per IP
```

### Adjust Rate Limits

Edit `/usr/local/sbin/dns-monitor` and change:

```bash
MAX_QUERIES_PER_MINUTE=3000    # Total queries per minute
TUNNEL_THRESHOLD=10            # Alerts before auto-block
```

### View Rate Limit Hits

```bash
tail -f /var/log/kern.log | grep DNS_RATE_LIMIT
```

### Remove Rate Limiting

```bash
# List iptables rules with line numbers
iptables -L INPUT -n --line-numbers

# Delete specific rules (replace N with line number)
iptables -D INPUT N
```

## Monitoring & Alerting

### Real-time Monitoring

```bash
# Watch alerts
watch -n 1 'tail -20 /var/log/dns-monitor/alerts.log'

# Monitor query rate
watch -n 1 'wc -l /var/log/dns-monitor/queries.log'

# Top queried domains
watch -n 5 'tail -1000 /var/log/dns-monitor/queries.log | awk "{print \$3}" | sort | uniq -c | sort -rn | head -10'
```

### Integration with Monitoring Systems

**Prometheus/Grafana:**
```bash
# Export metrics (create custom exporter)
echo "dns_queries_total $(wc -l < /var/log/dns-monitor/queries.log)" | sponge /var/lib/node_exporter/dns_metrics.prom
```

**Email Alerts:**
Add to `/usr/local/sbin/dns-monitor` in the `alert()` function:
```bash
echo "$timestamp [$alert_type] $src_ip $query - $reason" | \
  mail -s "DNS Attack Alert" admin@example.com
```

## Performance Impact

**CPU Usage:**
- tcpdump: ~1-5% CPU (depends on query rate)
- Log processing: <1% CPU
- Total: ~2-6% CPU overhead

**Memory Usage:**
- tcpdump: ~10-50 MB
- Log buffers: ~10-20 MB
- Total: ~20-70 MB RAM

**Network Impact:**
- Minimal (reads packets, doesn't generate traffic)
- No impact on DNS query latency

**For high-traffic servers (>100 qps):**
- Consider increasing log rotation frequency
- Use SSD for `/var/log/dns-monitor`
- Monitor disk I/O

## Troubleshooting

### Monitoring Not Starting

```bash
# Check if already running
dns-monitor status

# Check permissions
ls -l /usr/local/sbin/dns-monitor

# Check tcpdump
which tcpdump

# Test tcpdump manually
tcpdump -i any port 53 -c 10
```

### No Logs Being Generated

```bash
# Check log directory permissions
ls -ld /var/log/dns-monitor

# Check if tcpdump is capturing
tcpdump -i any port 53 -c 10

# Check DNS is receiving queries
dig @127.0.0.1 test.example.com
```

### High Disk Usage

```bash
# Check log sizes
du -sh /var/log/dns-monitor/*

# Force log rotation
dns-log-rotate

# Reduce retention
# Edit /etc/logrotate.d/dns-monitor
# Change: rotate 24 -> rotate 12
```

### False Positives

**Legitimate traffic being blocked:**

1. Increase thresholds in `/usr/local/sbin/dns-monitor`:
```bash
MAX_SUBDOMAIN_LENGTH=75       # Was 50
TUNNEL_THRESHOLD=20           # Was 10
```

2. Whitelist trusted IPs:
```bash
# Add to iptables (before DNS rules)
iptables -I INPUT -s TRUSTED_IP -p udp --dport 53 -j ACCEPT
```

3. Check what triggered the alert:
```bash
grep "BLOCKED_IP" /var/log/dns-monitor/alerts.log
```

## Systemd Service

### Enable at Boot

```bash
systemctl enable dns-monitor.service
systemctl start dns-monitor.service
```

### Service Commands

```bash
systemctl status dns-monitor    # Check status
systemctl start dns-monitor     # Start
systemctl stop dns-monitor      # Stop
systemctl restart dns-monitor   # Restart
journalctl -u dns-monitor -f    # View logs
```

## Security Considerations

### Limitations

⚠️ **MyDNS Limitations:**
- No native attack protection
- Limited logging capabilities
- Single-threaded (vulnerable to resource exhaustion)
- Old codebase (last updated 2006)

⚠️ **Detection Limitations:**
- Can only detect obvious patterns
- Sophisticated attackers can evade detection
- No machine learning or anomaly detection
- Pattern-based only

### Best Practices

1. **Use Cloudflare** for public-facing zones (you already do this)
2. **Keep logs for forensics** (at least 7 days of alerts)
3. **Monitor blocked IPs** regularly for false positives
4. **Review alerts weekly** to tune thresholds
5. **Consider PowerDNS migration** for better protection

### Attack Response

**If under active attack:**

1. **Identify attack type:**
```bash
dns-monitor stats
tail -100 /var/log/dns-monitor/alerts.log
```

2. **Emergency rate limiting:**
```bash
# Reduce to 10 queries/sec
iptables -I INPUT -p udp --dport 53 -m recent --set --name DNS_EMERGENCY
iptables -I INPUT -p udp --dport 53 -m recent --update --seconds 1 \
  --hitcount 10 --name DNS_EMERGENCY -j DROP
```

3. **Block entire networks if needed:**
```bash
# Block /24 subnet
iptables -I INPUT -s 203.0.113.0/24 -j DROP
```

4. **Contact upstream/ISP** if attack is severe

## Migration to Better Protection

For production environments under attack, consider:

### PowerDNS (Recommended)

**Pros:**
- Native MySQL backend
- Built-in rate limiting (`max-qps-per-ip`)
- Full DNSSEC support
- Better logging (dnstap)
- Active development

**Migration:**
```bash
apt-get install pdns-server pdns-backend-mysql
# Configure with existing MySQL database
# Schema compatible with MyDNS (with modifications)
```

### Cloudflare

**Pros:**
- Full DDoS protection
- Global anycast network
- Free tier available
- Zero configuration

**Already using for public zones** ✅

## Contributing

Found a bug or have an improvement? Issues and pull requests welcome.

## License

Same as MyDNS (GPL v2)

## Credits

Part of MyDNS-NG project (2025)

## See Also

- [DNS Manager CHANGELOG](../dnsmanager/CHANGELOG.md)
- [DNS Record Types Test Log](../RECORD_TYPES_TEST_LOG.md)
- [MyDNS Configuration](/etc/mydns/mydns.conf)
