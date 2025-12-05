#!/bin/bash
echo "=== COMPREHENSIVE DNS FUNCTIONALITY TEST ==="
echo ""
echo "--- 1. IPv4 A Records - External Domain ---"
dig @localhost google.com A +short | head -3
echo ""
echo "--- 2. IPv6 AAAA Records - External Domain ---"
dig @localhost google.com AAAA +short | head -3
echo ""
echo "--- 3. MX Records - External Domain ---"
dig @localhost google.com MX +short | head -3
echo ""
echo "--- 4. SOA Records - External Domain ---"
dig @localhost google.com SOA +short
echo ""
echo "--- 5. NS Records - External Domain ---"
dig @localhost google.com NS +short | head -3
echo ""
echo "--- 6. CNAME Records - External Domain ---"
dig @localhost www.github.com CNAME +short
echo ""
echo "--- 7. TXT Records - External Domain ---"
dig @localhost google.com TXT +short | head -2
echo ""
echo "--- 8. Authoritative Zone SOA Record ---"
dig @localhost fwd.multitel.net SOA +short
echo ""
echo "--- 9. Authoritative Zone A Record ---"
dig @localhost fwd.multitel.net A +short
echo ""
echo "--- 10. PTR Records Reverse DNS ---"
dig @localhost -x 8.8.8.8 +short
echo ""
echo "=== CACHE PERFORMANCE TEST ==="
echo -n "First query (cold cache): "
time -p dig @localhost facebook.com A +short > /dev/null 2>&1
echo -n "Second query (warm cache): "
time -p dig @localhost facebook.com A +short > /dev/null 2>&1
echo ""
echo "=== SERVICE STATUS CHECK ==="
if systemctl is-active mydns > /dev/null 2>&1; then
  echo "✅ MyDNS service: ACTIVE"
else
  echo "❌ MyDNS service: FAILED"
fi
echo ""
echo "=== CONFIGURATION CHECK ==="
echo "Recursive servers: $(grep '^recursive' /etc/mydns/mydns.conf | cut -d'=' -f2)"
echo "Reply cache: $(grep '^reply-cache-size' /etc/mydns/mydns.conf | cut -d'=' -f2) entries"
echo "Zone cache: $(grep '^zone-cache-size' /etc/mydns/mydns.conf | cut -d'=' -f2) entries"
echo ""
echo "=== TEST COMPLETE ==="
