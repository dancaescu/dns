#!/usr/bin/env python3
"""
Geographic DNS Sensor for Cloudflare Proxy IP Learning
Date: 2025-11-25

This sensor script:
1. Reads MySQL config from /etc/mydns/mydns.conf
2. Identifies Cloudflare proxied records
3. Resolves those records to learn Cloudflare's geographic IPs
4. Stores results in MySQL for geo-aware DNS responses

Usage:
    ./sensor.py --location na
    ./sensor.py --location eu --daemon
"""

import argparse
import configparser
import json
import logging
import socket
import sys
import time
from datetime import datetime
from typing import List, Dict, Optional

import dns.resolver
import mysql.connector
from mysql.connector import Error

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger('geo-sensor')


class MySQLConfig:
    """Parse MyDNS configuration file"""

    def __init__(self, config_file='/etc/mydns/mydns.conf'):
        self.config_file = config_file
        self.host = 'localhost'
        self.user = 'root'
        self.password = ''
        self.database = 'did'
        self.port = 3306

        self._parse_config()

    def _parse_config(self):
        """Parse MyDNS configuration file"""
        try:
            # MyDNS config format is key = value
            config = {}
            with open(self.config_file, 'r') as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith('#'):
                        continue
                    if '=' in line:
                        key, value = line.split('=', 1)
                        key = key.strip()
                        value = value.strip().strip('"').strip("'")
                        config[key] = value

            # Map MyDNS config keys to our properties
            self.host = config.get('db-host', 'localhost')
            self.user = config.get('db-user', 'root')
            self.password = config.get('db-password', '')
            self.database = config.get('database', 'did')

            # Handle port if specified
            if ':' in self.host:
                self.host, port_str = self.host.split(':')
                self.port = int(port_str)

            logger.info(f"Loaded MySQL config from {self.config_file}")
            logger.info(f"Database: {self.user}@{self.host}:{self.port}/{self.database}")

        except FileNotFoundError:
            logger.warning(f"Config file {self.config_file} not found, using defaults")
        except Exception as e:
            logger.error(f"Error parsing config: {e}")


class GeoSensor:
    """Geographic DNS sensor for learning Cloudflare proxy IPs"""

    def __init__(self, location_code: str, config: MySQLConfig):
        self.location_code = location_code
        self.config = config
        self.sensor_id = None
        self.db_conn = None
        self.resolver = None

        self._init_resolver()
        self._connect_db()
        self._register_sensor()

    def _init_resolver(self):
        """Initialize DNS resolver"""
        self.resolver = dns.resolver.Resolver()
        # Use public DNS servers to get Cloudflare's view
        self.resolver.nameservers = [
            '1.1.1.1',  # Cloudflare DNS
            '8.8.8.8',  # Google DNS
        ]
        self.resolver.timeout = 5
        self.resolver.lifetime = 10
        logger.info("DNS resolver initialized")

    def _connect_db(self):
        """Connect to MySQL database"""
        try:
            self.db_conn = mysql.connector.connect(
                host=self.config.host,
                port=self.config.port,
                user=self.config.user,
                password=self.config.password,
                database=self.config.database,
                autocommit=False
            )
            logger.info("Connected to MySQL database")
        except Error as e:
            logger.error(f"Failed to connect to database: {e}")
            sys.exit(1)

    def _register_sensor(self):
        """Register or update sensor in database"""
        try:
            cursor = self.db_conn.cursor(dictionary=True)

            # Get sensor ID
            cursor.execute("""
                SELECT id FROM geo_sensors
                WHERE location_code = %s
            """, (self.location_code,))

            result = cursor.fetchone()
            if result:
                self.sensor_id = result['id']
                logger.info(f"Found sensor ID: {self.sensor_id} for location: {self.location_code}")
            else:
                logger.error(f"Sensor location '{self.location_code}' not found in database")
                logger.error("Please run: INSERT INTO geo_sensors (location_code, location_name) VALUES (?, ?)")
                sys.exit(1)

            cursor.close()

        except Error as e:
            logger.error(f"Error registering sensor: {e}")
            sys.exit(1)

    def get_cloudflare_zones(self) -> List[Dict]:
        """Get all active Cloudflare zones"""
        try:
            cursor = self.db_conn.cursor(dictionary=True)

            cursor.execute("""
                SELECT
                    zone_id,
                    zone_name,
                    account_id
                FROM cloudflare_zones
                WHERE is_active = TRUE
            """)

            zones = cursor.fetchall()
            cursor.close()

            logger.info(f"Found {len(zones)} active Cloudflare zones")
            return zones

        except Error as e:
            logger.error(f"Error fetching zones: {e}")
            return []

    def get_proxied_records(self, zone_id: str) -> List[Dict]:
        """Get all proxied records for a zone"""
        try:
            cursor = self.db_conn.cursor(dictionary=True)

            cursor.execute("""
                SELECT
                    record_id,
                    record_name,
                    record_type,
                    ttl,
                    proxied
                FROM cloudflare_records
                WHERE zone_id = %s
                  AND proxied = TRUE
                  AND record_type IN ('A', 'AAAA', 'CNAME')
                  AND deleted_at IS NULL
            """, (zone_id,))

            records = cursor.fetchall()
            cursor.close()

            return records

        except Error as e:
            logger.error(f"Error fetching records for zone {zone_id}: {e}")
            return []

    def resolve_record(self, record_name: str, record_type: str) -> List[str]:
        """Resolve a DNS record and return IPs"""
        ips = []

        try:
            # Ensure FQDN
            if not record_name.endswith('.'):
                record_name += '.'

            # Resolve based on type
            if record_type == 'A':
                answers = self.resolver.resolve(record_name, 'A')
                ips = [str(rdata) for rdata in answers]

            elif record_type == 'AAAA':
                answers = self.resolver.resolve(record_name, 'AAAA')
                ips = [str(rdata) for rdata in answers]

            elif record_type == 'CNAME':
                # Follow CNAME and get final IPs
                try:
                    answers = self.resolver.resolve(record_name, 'CNAME')
                    target = str(answers[0].target)
                    # Recursively resolve target
                    try:
                        a_answers = self.resolver.resolve(target, 'A')
                        ips = [str(rdata) for rdata in a_answers]
                    except:
                        # Try AAAA if A fails
                        aaaa_answers = self.resolver.resolve(target, 'AAAA')
                        ips = [str(rdata) for rdata in aaaa_answers]
                except:
                    pass

            logger.debug(f"Resolved {record_name} ({record_type}): {ips}")

        except dns.resolver.NXDOMAIN:
            logger.debug(f"NXDOMAIN: {record_name}")
        except dns.resolver.NoAnswer:
            logger.debug(f"No answer: {record_name}")
        except dns.resolver.Timeout:
            logger.warning(f"Timeout resolving: {record_name}")
        except Exception as e:
            logger.error(f"Error resolving {record_name}: {e}")

        return ips

    def store_learned_ips(self, zone_id: str, record_id: str, record_name: str,
                          record_type: str, ttl: int, ips: List[str]):
        """Store learned IPs in database"""
        if not ips:
            return

        try:
            cursor = self.db_conn.cursor()

            # Convert IPs to JSON array
            ips_json = json.dumps(ips)

            cursor.execute("""
                INSERT INTO cloudflare_proxy_ips
                    (zone_id, record_id, record_name, record_type, sensor_id,
                     learned_ips, ttl, is_proxied, resolve_count)
                VALUES (%s, %s, %s, %s, %s, %s, %s, TRUE, 1)
                ON DUPLICATE KEY UPDATE
                    learned_ips = VALUES(learned_ips),
                    ttl = VALUES(ttl),
                    last_resolved = CURRENT_TIMESTAMP,
                    resolve_count = resolve_count + 1
            """, (zone_id, record_id, record_name, record_type, self.sensor_id,
                  ips_json, ttl))

            self.db_conn.commit()
            cursor.close()

            logger.info(f"Stored {len(ips)} IPs for {record_name} ({record_type})")

        except Error as e:
            logger.error(f"Error storing IPs for {record_name}: {e}")
            self.db_conn.rollback()

    def update_health(self, records_synced: int, errors: int):
        """Update sensor health status"""
        try:
            cursor = self.db_conn.cursor()

            cursor.execute("""
                CALL update_sensor_health(%s, TRUE, %s, %s)
            """, (self.sensor_id, records_synced, errors))

            self.db_conn.commit()
            cursor.close()

        except Error as e:
            logger.error(f"Error updating health: {e}")
            self.db_conn.rollback()

    def run_sync(self) -> Dict[str, int]:
        """Run one sync cycle"""
        stats = {
            'zones': 0,
            'records': 0,
            'ips_learned': 0,
            'errors': 0
        }

        logger.info("Starting sync cycle")
        start_time = time.time()

        # Get all Cloudflare zones
        zones = self.get_cloudflare_zones()
        stats['zones'] = len(zones)

        for zone in zones:
            zone_id = zone['zone_id']
            zone_name = zone['zone_name']

            logger.info(f"Processing zone: {zone_name}")

            # Get proxied records
            records = self.get_proxied_records(zone_id)
            logger.info(f"  Found {len(records)} proxied records")

            for record in records:
                try:
                    stats['records'] += 1

                    record_id = record['record_id']
                    record_name = record['record_name']
                    record_type = record['record_type']
                    ttl = record['ttl']

                    # Resolve record
                    ips = self.resolve_record(record_name, record_type)

                    if ips:
                        stats['ips_learned'] += len(ips)
                        # Store in database
                        self.store_learned_ips(
                            zone_id, record_id, record_name,
                            record_type, ttl, ips
                        )
                    else:
                        logger.debug(f"  No IPs for: {record_name}")

                except Exception as e:
                    logger.error(f"  Error processing {record.get('record_name')}: {e}")
                    stats['errors'] += 1

                # Small delay to avoid rate limiting
                time.sleep(0.1)

        elapsed = time.time() - start_time

        logger.info("Sync cycle completed")
        logger.info(f"  Zones: {stats['zones']}")
        logger.info(f"  Records: {stats['records']}")
        logger.info(f"  IPs learned: {stats['ips_learned']}")
        logger.info(f"  Errors: {stats['errors']}")
        logger.info(f"  Time: {elapsed:.2f}s")

        # Update health
        self.update_health(stats['records'], stats['errors'])

        return stats

    def run_daemon(self, interval: int = 3600):
        """Run sensor in daemon mode"""
        logger.info(f"Starting sensor daemon (interval: {interval}s)")

        while True:
            try:
                self.run_sync()
                logger.info(f"Sleeping for {interval} seconds...")
                time.sleep(interval)

            except KeyboardInterrupt:
                logger.info("Received interrupt, shutting down...")
                break
            except Exception as e:
                logger.error(f"Error in daemon loop: {e}")
                time.sleep(60)  # Wait a bit before retrying

    def close(self):
        """Close database connection"""
        if self.db_conn and self.db_conn.is_connected():
            self.db_conn.close()
            logger.info("Database connection closed")


def main():
    parser = argparse.ArgumentParser(
        description='Geographic DNS Sensor for Cloudflare Proxy IP Learning'
    )
    parser.add_argument(
        '--location',
        required=True,
        help='Sensor location code (e.g., na, eu, apac, sa, af, oc)'
    )
    parser.add_argument(
        '--config',
        default='/etc/mydns/mydns.conf',
        help='Path to MyDNS config file (default: /etc/mydns/mydns.conf)'
    )
    parser.add_argument(
        '--daemon',
        action='store_true',
        help='Run in daemon mode (continuous sync)'
    )
    parser.add_argument(
        '--interval',
        type=int,
        default=3600,
        help='Sync interval in seconds (default: 3600 = 1 hour)'
    )
    parser.add_argument(
        '--debug',
        action='store_true',
        help='Enable debug logging'
    )

    args = parser.parse_args()

    if args.debug:
        logger.setLevel(logging.DEBUG)

    # Load MySQL config
    config = MySQLConfig(args.config)

    # Initialize sensor
    sensor = GeoSensor(args.location, config)

    try:
        if args.daemon:
            sensor.run_daemon(args.interval)
        else:
            sensor.run_sync()

    except KeyboardInterrupt:
        logger.info("Interrupted by user")
    except Exception as e:
        logger.error(f"Fatal error: {e}")
        sys.exit(1)
    finally:
        sensor.close()


if __name__ == '__main__':
    # Check dependencies
    try:
        import dns.resolver
        import mysql.connector
    except ImportError as e:
        print(f"Missing dependency: {e}")
        print("Install with: pip3 install dnspython mysql-connector-python")
        sys.exit(1)

    main()
