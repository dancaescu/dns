--
-- AXFR NOTIFY Protocol Migration
-- Date: 2025-11-26
--
-- Adds NOTIFY protocol support (RFC 1996) to existing MyDNS AXFR slave installations
-- Run this script on existing MyDNS databases that already have axfr-slave-schema.sql applied
--

-- Add last_notify column to zone_masters table
ALTER TABLE zone_masters
ADD COLUMN IF NOT EXISTS last_notify TIMESTAMP NULL COMMENT 'Last NOTIFY received from master'
AFTER last_transfer;

-- Update view to include last_notify
CREATE OR REPLACE VIEW v_zone_transfer_status AS
SELECT
    s.id AS zone_id,
    s.origin AS zone_name,
    s.serial AS current_serial,
    s.slave_mode,
    zm.master_host,
    zm.enabled,
    zm.last_check,
    zm.last_transfer,
    zm.last_notify,
    zm.transfer_failures,
    TIMESTAMPDIFF(SECOND, zm.last_transfer, NOW()) AS seconds_since_last_transfer,
    TIMESTAMPDIFF(SECOND, zm.last_notify, NOW()) AS seconds_since_last_notify,
    CASE
        WHEN zm.enabled = FALSE THEN 'DISABLED'
        WHEN zm.transfer_failures >= zm.max_failures THEN 'FAILED'
        WHEN zm.last_transfer IS NULL THEN 'NEVER_TRANSFERRED'
        WHEN TIMESTAMPDIFF(SECOND, zm.last_transfer, NOW()) > zm.transfer_interval * 2 THEN 'OVERDUE'
        ELSE 'OK'
    END AS health_status
FROM soa s
JOIN zone_masters zm ON zm.zone_id = s.id
WHERE s.slave_mode = TRUE;

COMMIT;

-- Notes:
--
-- NOTIFY Protocol (RFC 1996) allows master servers to push notifications to slaves
-- when zone data changes, instead of relying solely on polling.
--
-- After applying this migration:
--
-- 1. Restart mydns-xfer daemon to enable NOTIFY listener:
--    systemctl restart mydns-xfer
--
-- 2. Configure master servers to send NOTIFY messages to slave:
--    In BIND: notify yes; also-notify { slave-ip-address; };
--    In PowerDNS: slave=yes, master=ip-address
--
-- 3. mydns-xfer listens on UDP port 5300 for NOTIFY messages
--    (Using alternate port to avoid conflicts with main DNS server)
--
-- 4. Monitor NOTIFY activity:
--    SELECT zone_name, master_host, last_notify, last_transfer
--    FROM v_zone_transfer_status
--    WHERE last_notify IS NOT NULL
--    ORDER BY last_notify DESC;
--
-- 5. View zones with recent NOTIFY activity:
--    SELECT s.origin, zm.master_host, zm.last_notify,
--           TIMESTAMPDIFF(SECOND, zm.last_notify, NOW()) AS seconds_ago
--    FROM soa s
--    JOIN zone_masters zm ON zm.zone_id = s.id
--    WHERE zm.last_notify > DATE_SUB(NOW(), INTERVAL 1 HOUR)
--    ORDER BY zm.last_notify DESC;
--
