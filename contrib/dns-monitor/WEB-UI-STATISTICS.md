## DNS Statistics for Web UI Integration

### Overview

Instead of storing millions of individual DNS queries, aggregate statistics are stored in MySQL tables with hourly/daily counters. This provides valuable insights while keeping database size manageable.

**Storage efficiency:** ~1-2 MB per zone per day vs. ~100-500 MB for raw logs

---

## Dashboard Statistics (Main Page)

### 1. Server Overview Card

**Real-time metrics:**
```
┌─────────────────────────────────────┐
│ DNS Server Status                   │
├─────────────────────────────────────┤
│ Queries (24h): 1,234,567           │
│ Queries/sec:   34.2                │
│ Unique IPs:    12,345              │
│ Cache Hit:     92.3%               │
│ Uptime:        45 days             │
│                                     │
│ ⚠ 3 security alerts in last hour  │
│ 🔒 12 IPs blocked today           │
└─────────────────────────────────────┘
```

**SQL Query:**
```sql
SELECT
    SUM(total_queries) as queries_24h,
    AVG(queries_per_second) as avg_qps,
    MAX(unique_ips) as unique_ips,
    AVG(cache_hit_rate) as cache_hit
FROM dns_server_stats
WHERE stat_date >= CURDATE() - INTERVAL 1 DAY;
```

### 2. Query Volume Chart

**Time-series graph (last 24 hours):**
```
Queries per hour
1200 ┤                    ╭─╮
1000 ┤                ╭───╯ ╰─╮
 800 ┤             ╭──╯       ╰─╮
 600 ┤          ╭──╯            ╰─╮
 400 ┤      ╭───╯                 ╰╮
 200 ┤  ╭───╯                      ╰─
   0 ┼──╯
     0  4  8  12 16 20 24 (hours)
```

**SQL Query:**
```sql
SELECT
    stat_hour,
    SUM(total_queries) as queries
FROM dns_server_stats
WHERE stat_date = CURDATE()
GROUP BY stat_hour
ORDER BY stat_hour;
```

### 3. Top Zones by Query Volume

**Table:**
```
Zone                 Queries    % Total   Status
example.com          456,789    37.0%     ✓ Healthy
subdomain.net        234,567    19.0%     ⚠ High NXDOMAIN
test.org             123,456    10.0%     ✓ Healthy
```

**SQL Query:**
```sql
SELECT
    s.origin,
    SUM(z.total_queries) as total,
    (SUM(z.total_queries) * 100.0 / (
        SELECT SUM(total_queries) FROM dns_zone_stats WHERE stat_date >= CURDATE()
    )) as percentage,
    SUM(z.responses_nxdomain) / SUM(z.total_queries) * 100 as nxdomain_rate
FROM dns_zone_stats z
JOIN soa s ON z.zone_id = s.id
WHERE z.stat_date >= CURDATE() - INTERVAL 1 DAY
GROUP BY z.zone_id
ORDER BY total DESC
LIMIT 10;
```

---

## Zone Detail Page Statistics

### 1. Zone Performance Card

```
┌─────────────────────────────────────┐
│ example.com - Statistics            │
├─────────────────────────────────────┤
│ Today:          45,678 queries     │
│ Yesterday:      42,341 queries     │
│ This Month:     1,234,567 queries  │
│                                     │
│ Most Queried Records:              │
│  1. www          (12,345)         │
│  2. mail         (8,901)          │
│  3. api          (6,543)          │
│                                     │
│ Query Types:                       │
│  A:      78%  ████████████████    │
│  AAAA:   12%  ██████               │
│  MX:      5%  ███                  │
│  Other:   5%  ███                  │
└─────────────────────────────────────┘
```

**SQL Queries:**
```sql
-- Zone queries today
SELECT total_queries FROM dns_zone_stats
WHERE zone_id = ? AND stat_date = CURDATE() AND stat_hour IS NULL;

-- Top queried records
SELECT record_name, SUM(query_count) as total
FROM dns_top_queries
WHERE zone_id = ? AND stat_date >= CURDATE() - INTERVAL 7 DAY
GROUP BY record_name
ORDER BY total DESC
LIMIT 10;

-- Query type distribution
SELECT
    queries_a, queries_aaaa, queries_mx, queries_txt,
    queries_cname, queries_other
FROM dns_zone_stats
WHERE zone_id = ? AND stat_date >= CURDATE() - INTERVAL 7 DAY;
```

### 2. Query Trends Chart (30 days)

```
Daily Query Volume
5000 ┤     ╭╮      ╭─╮
4000 ┤   ╭─╯╰╮   ╭─╯ ╰╮    ╭╮
3000 ┤ ╭─╯   ╰─╮╭╯    ╰╮╭──╯╰─╮
2000 ┤╭╯       ╰╯      ╰╯      ╰╮
1000 ┼╯                         ╰
     0  5  10  15  20  25  30 (days)
```

**SQL Query:**
```sql
SELECT
    stat_date,
    SUM(total_queries) as daily_total
FROM dns_zone_stats
WHERE zone_id = ?
  AND stat_date >= CURDATE() - INTERVAL 30 DAY
  AND stat_hour IS NULL
GROUP BY stat_date
ORDER BY stat_date;
```

### 3. Geographic Distribution (if GeoIP enabled)

```
┌─────────────────────────────────────┐
│ Query Sources (Top 10 Countries)    │
├─────────────────────────────────────┤
│ 🇺🇸 United States    12,345  (27%)  │
│ 🇩🇪 Germany           8,901  (19%)  │
│ 🇬🇧 United Kingdom    6,543  (14%)  │
│ 🇫🇷 France            4,321  (9%)   │
│ 🇨🇦 Canada            3,210  (7%)   │
└─────────────────────────────────────┘
```

**SQL Query:**
```sql
SELECT
    country_code,
    SUM(query_count) as total
FROM dns_geo_stats
WHERE zone_id = ? AND stat_date >= CURDATE() - INTERVAL 7 DAY
GROUP BY country_code
ORDER BY total DESC
LIMIT 10;
```

---

## Security Dashboard

### 1. Security Overview

```
┌─────────────────────────────────────┐
│ Security Status                     │
├─────────────────────────────────────┤
│ Active Threats:     0               │
│ Blocked IPs:        12              │
│ Alerts (24h):       45              │
│                                      │
│ Alert Breakdown:                    │
│  Tunneling:   23  (51%)            │
│  Floods:      15  (33%)            │
│  Rate Limit:   7  (16%)            │
│                                      │
│ Status: ✓ All zones protected      │
└─────────────────────────────────────┘
```

**SQL Queries:**
```sql
-- Active alerts (last 24h)
SELECT
    event_type,
    COUNT(*) as count
FROM dns_security_events
WHERE date_created >= NOW() - INTERVAL 24 HOUR
GROUP BY event_type;

-- Blocked IPs today
SELECT COUNT(DISTINCT source_ip)
FROM dns_security_events
WHERE event_type = 'IP_BLOCKED'
  AND date_created >= CURDATE();
```

### 2. Recent Security Events Table

```
Time                IP              Type            Zone         Severity
2025-11-25 16:45   203.0.113.50    Tunnel Detect   example.com  HIGH
2025-11-25 16:42   198.51.100.20   Query Flood     test.org     MEDIUM
2025-11-25 16:40   192.0.2.100     IP Blocked      all          HIGH
```

**SQL Query:**
```sql
SELECT
    date_created,
    source_ip,
    event_type,
    s.origin as zone,
    severity,
    details
FROM dns_security_events e
LEFT JOIN soa s ON e.zone_id = s.id
ORDER BY date_created DESC
LIMIT 50;
```

### 3. Attack Timeline Chart

```
Security Events (Last 7 Days)
40 ┤          ╭╮
30 ┤     ╭╮   │╰╮   ╭╮
20 ┤   ╭─╯╰╮╭─╯ ╰╮╭─╯╰╮
10 ┤ ╭─╯   ╰╯    ╰╯   ╰╮
 0 ┼─╯                 ╰─
   Mon Tue Wed Thu Fri Sat Sun
```

**SQL Query:**
```sql
SELECT
    DATE(date_created) as event_date,
    event_type,
    COUNT(*) as count
FROM dns_security_events
WHERE date_created >= CURDATE() - INTERVAL 7 DAY
GROUP BY DATE(date_created), event_type
ORDER BY event_date;
```

---

## Settings/System Page

### 1. Cache Performance Metrics

```
┌─────────────────────────────────────┐
│ Cache Performance                   │
├─────────────────────────────────────┤
│ Hit Rate:        92.3%             │
│ Hits:            1,234,567         │
│ Misses:          98,765            │
│ Size:            45 MB / 100 MB    │
│                                     │
│ Zone Cache:      1,024 entries     │
│ Reply Cache:     8,192 entries     │
│                                     │
│ Recommendation: ✓ Optimal         │
└─────────────────────────────────────┘
```

### 2. Database Performance

```
┌─────────────────────────────────────┐
│ Database Performance                │
├─────────────────────────────────────┤
│ Queries/Hour:    12,345            │
│ Avg Response:    2.3 ms            │
│ Slow Queries:    0                 │
│                                     │
│ Connections:     8 / 20            │
│ Status:          ✓ Healthy         │
└─────────────────────────────────────┘
```

---

## API Endpoints for Statistics

### Zone Statistics
```
GET /api/stats/zones/:zoneId
GET /api/stats/zones/:zoneId/queries?period=24h|7d|30d
GET /api/stats/zones/:zoneId/top-records
GET /api/stats/zones/:zoneId/security-events
```

### Server Statistics
```
GET /api/stats/server
GET /api/stats/server/queries?period=24h|7d|30d
GET /api/stats/security/events
GET /api/stats/security/blocked-ips
```

### Response Format
```json
{
  "status": "success",
  "data": {
    "zone": "example.com",
    "period": "24h",
    "total_queries": 45678,
    "query_types": {
      "A": 35642,
      "AAAA": 5478,
      "MX": 2234,
      "TXT": 1234,
      "other": 1090
    },
    "top_records": [
      {"name": "www", "count": 12345},
      {"name": "mail", "count": 8901}
    ],
    "nxdomain_rate": 2.3,
    "cache_hit_rate": 92.5
  }
}
```

---

## UI Component Examples

### React/TypeScript Components

```tsx
// ZoneStatsCard.tsx
interface ZoneStats {
  total_queries: number;
  queries_today: number;
  queries_yesterday: number;
  nxdomain_rate: number;
  cache_hit_rate: number;
}

export const ZoneStatsCard: React.FC<{zoneId: number}> = ({zoneId}) => {
  const {data} = useQuery<ZoneStats>(`/api/stats/zones/${zoneId}`);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Zone Statistics</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-4">
          <StatItem label="Today" value={data?.queries_today} />
          <StatItem label="Yesterday" value={data?.queries_yesterday} />
          <StatItem label="NXDOMAIN" value={`${data?.nxdomain_rate}%`} />
          <StatItem label="Cache Hit" value={`${data?.cache_hit_rate}%`} />
        </div>
      </CardContent>
    </Card>
  );
};

// QueryTrendsChart.tsx
export const QueryTrendsChart: React.FC<{zoneId: number}> = ({zoneId}) => {
  const {data} = useQuery<TimeSeriesData[]>(
    `/api/stats/zones/${zoneId}/queries?period=7d`
  );

  return (
    <ResponsiveContainer width="100%" height={300}>
      <LineChart data={data}>
        <XAxis dataKey="date" />
        <YAxis />
        <Tooltip />
        <Line type="monotone" dataKey="queries" stroke="#8884d8" />
      </LineChart>
    </ResponsiveContainer>
  );
};

// SecurityAlertsTable.tsx
export const SecurityAlertsTable: React.FC = () => {
  const {data} = useQuery<SecurityEvent[]>('/api/stats/security/events');

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Time</TableHead>
          <TableHead>IP Address</TableHead>
          <TableHead>Event Type</TableHead>
          <TableHead>Severity</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {data?.map((event) => (
          <TableRow key={event.id}>
            <TableCell>{formatDate(event.date_created)}</TableCell>
            <TableCell>{event.source_ip}</TableCell>
            <TableCell>
              <Badge variant={getEventVariant(event.event_type)}>
                {event.event_type}
              </Badge>
            </TableCell>
            <TableCell>
              <SeverityBadge severity={event.severity} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
};
```

---

## Implementation Checklist

### Phase 1: Database Setup
- [ ] Run `dns-stats-schema.sql` to create tables
- [ ] Set up hourly cron for `dns-stats-aggregator.sh`
- [ ] Verify data is being collected

### Phase 2: Backend API
- [ ] Create API endpoints for zone statistics
- [ ] Create API endpoints for server statistics
- [ ] Create API endpoints for security events
- [ ] Add pagination for large datasets
- [ ] Add date range filters

### Phase 3: Frontend Components
- [ ] Dashboard overview page with server stats
- [ ] Zone detail page with per-zone statistics
- [ ] Security dashboard with alerts table
- [ ] Charts for time-series data (recharts/chart.js)
- [ ] Export functionality (CSV/PDF)

### Phase 4: Testing & Optimization
- [ ] Test with real query data
- [ ] Optimize SQL queries with EXPLAIN
- [ ] Add database indexes
- [ ] Cache frequently accessed stats
- [ ] Add error handling

---

## Performance Considerations

**Database size estimates:**
- Hourly stats: ~24 rows/zone/day × 30 days = 720 rows/zone/month
- Daily rollups: ~1 row/zone/day × 365 days = 365 rows/zone/year
- Top queries: ~100 rows/zone/day × 30 days = 3,000 rows/zone/month
- Security events: Variable, ~100-1000 rows/day

**Total per zone:** ~5,000-10,000 rows/month
**For 100 zones:** ~500,000-1,000,000 rows/month (still very manageable)

**Compare to raw logs:** 10 queries/sec × 86400 sec/day = 864,000 rows/day!

**Storage efficiency:** 99% reduction vs. storing individual queries

---

## Benefits

1. **No performance impact** - Aggregation runs hourly on logs, not live queries
2. **Minimal storage** - Counters instead of individual queries
3. **Fast queries** - Pre-aggregated data, indexed tables
4. **Historical analysis** - Trends over time
5. **Security insights** - Attack patterns visible
6. **Compliance** - Can prove query volumes without storing PII
7. **Actionable** - Shows what records are actually used

---

## Future Enhancements

- **Anomaly detection:** ML-based pattern recognition
- **Predictive alerts:** Warn before attacks escalate
- **GeoIP integration:** Query source mapping
- **Response time tracking:** Per-record performance
- **Comparison mode:** Compare zones, time periods
- **Export/reports:** PDF reports, scheduled emails
- **Alerting:** Email/Slack when thresholds exceeded
