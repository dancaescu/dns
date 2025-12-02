--
-- SOA Serial Auto-Increment Trigger
-- Automatically updates SOA serial in date-based format: YYYYMMDDNN
-- Where NN is the daily revision number (01-99)
--
-- Usage: Apply to MyDNS database to enable automatic serial management
--

DELIMITER $$

-- Drop existing triggers if they exist
DROP TRIGGER IF EXISTS auto_increment_soa_on_insert$$
DROP TRIGGER IF EXISTS auto_increment_soa_on_update$$
DROP TRIGGER IF EXISTS auto_increment_soa_on_delete$$

-- Helper stored procedure to calculate new serial
DROP PROCEDURE IF EXISTS update_soa_serial$$
CREATE PROCEDURE update_soa_serial(IN p_zone_id INT)
BEGIN
    DECLARE current_serial INT UNSIGNED;
    DECLARE new_serial INT UNSIGNED;
    DECLARE today_prefix INT UNSIGNED;
    DECLARE serial_prefix INT UNSIGNED;
    DECLARE revision INT;

    -- Get current SOA serial
    SELECT serial INTO current_serial FROM soa WHERE id = p_zone_id;

    -- Calculate today's date prefix (YYYYMMDD)
    SET today_prefix = CAST(DATE_FORMAT(NOW(), '%Y%m%d') AS UNSIGNED);

    -- Extract prefix from current serial (first 8 digits)
    SET serial_prefix = FLOOR(current_serial / 100);

    IF serial_prefix = today_prefix THEN
        -- Same day - increment revision number
        SET revision = current_serial % 100;
        IF revision >= 99 THEN
            -- Max revisions reached for today, wrap to 99
            SET new_serial = (today_prefix * 100) + 99;
        ELSE
            SET new_serial = current_serial + 1;
        END IF;
    ELSE
        -- New day or old serial - start with revision 01
        SET new_serial = (today_prefix * 100) + 1;
    END IF;

    -- Update SOA serial
    UPDATE soa SET serial = new_serial WHERE id = p_zone_id;
END$$

-- Trigger on INSERT to rr table
CREATE TRIGGER auto_increment_soa_on_insert
AFTER INSERT ON rr
FOR EACH ROW
BEGIN
    -- Only update if not a slave zone
    IF (SELECT slave_mode FROM soa WHERE id = NEW.zone) = FALSE THEN
        CALL update_soa_serial(NEW.zone);
    END IF;
END$$

-- Trigger on UPDATE to rr table
CREATE TRIGGER auto_increment_soa_on_update
AFTER UPDATE ON rr
FOR EACH ROW
BEGIN
    -- Only update if not a slave zone
    IF (SELECT slave_mode FROM soa WHERE id = NEW.zone) = FALSE THEN
        CALL update_soa_serial(NEW.zone);
    END IF;
END$$

-- Trigger on DELETE from rr table
CREATE TRIGGER auto_increment_soa_on_delete
AFTER DELETE ON rr
FOR EACH ROW
BEGIN
    -- Only update if not a slave zone
    IF (SELECT slave_mode FROM soa WHERE id = OLD.zone) = FALSE THEN
        CALL update_soa_serial(OLD.zone);
    END IF;
END$$

DELIMITER ;

-- Example usage:
--
-- 1. Apply this script:
--    mysql -u root -p did < soa-serial-trigger.sql
--
-- 2. Make changes to records:
--    INSERT INTO rr (zone, name, type, data, ttl) VALUES (123, 'newhost', 'A', '10.1.1.1', 3600);
--
-- 3. Check SOA serial (should auto-increment):
--    SELECT id, origin, serial FROM soa WHERE id = 123;
--
-- Expected results:
--    - First change today: serial = 2025112601
--    - Second change today: serial = 2025112602
--    - 99th change today: serial = 2025112699
--    - Tomorrow's first change: serial = 2025112701
--
-- Notes:
--    - Slave zones (slave_mode=TRUE) are NOT auto-incremented
--    - Serial format: YYYYMMDDNN (10 digits)
--    - Maximum 99 revisions per day
--    - Automatically handles date rollovers
