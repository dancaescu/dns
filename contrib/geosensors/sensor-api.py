#!/usr/bin/env python3
"""
Geographic DNS Sensor for Cloudflare Proxy IP Learning (API Version)
Date: 2025-11-26
Version: 1.0.0

This sensor script:
1. Connects to dnsmanager API using API key
2. Identifies Cloudflare proxied records for authorized zones
3. Resolves those records to learn Cloudflare's geographic IPs
4. Submits results to API endpoint
5. Auto-updates itself when new versions are available

Usage:
    ./sensor-api.py --location na --api-url https://dns.example.com --api-key YOUR_KEY
    ./sensor-api.py --location eu --api-url https://dns.example.com --api-key YOUR_KEY --daemon
"""

import argparse
import json
import logging
import sys
import os
import time
import subprocess
import tempfile
from datetime import datetime
from typing import List, Dict, Optional

import dns.resolver
import requests

__version__ = '1.0.0'

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger('geo-sensor-api')


def check_for_updates(api_url: str, api_key: str) -> bool:
    """
    Check if a new version is available and update if needed
    Returns True if updated and needs restart
    """
    try:
        # Check current version against API
        response = requests.get(
            f'{api_url.rstrip("/")}/api/sensors/script/version',
            timeout=10
        )

        if response.status_code != 200:
            logger.warning("Could not check for updates")
            return False

        version_info = response.json()
        remote_version = version_info.get('version')

        if not remote_version:
            return False

        # Compare versions
        if remote_version == __version__:
            logger.info(f"Running latest version: {__version__}")
            return False

        logger.info(f"New version available: {remote_version} (current: {__version__})")
        logger.info(f"Changelog: {version_info.get('changelog', 'No changelog')}")

        # Download new version
        logger.info("Downloading new version...")
        response = requests.get(
            f'{api_url.rstrip("/")}/api/sensors/script/download',
            headers={'Authorization': f'Bearer {api_key}'},
            timeout=30
        )

        if response.status_code != 200:
            logger.error(f"Failed to download update: {response.status_code}")
            return False

        update_data = response.json()

        # Save current script location
        current_script = os.path.abspath(__file__)
        backup_script = f'{current_script}.backup'

        # Create backup
        logger.info("Creating backup of current version...")
        with open(current_script, 'r') as f:
            old_content = f.read()
        with open(backup_script, 'w') as f:
            f.write(old_content)

        # Run prerequisites if provided
        if update_data.get('prerequisites_script'):
            logger.info("Running prerequisites...")
            with tempfile.NamedTemporaryFile(mode='w', suffix='.sh', delete=False) as f:
                f.write(update_data['prerequisites_script'])
                prereq_script = f.name

            try:
                subprocess.run(['bash', prereq_script], check=True)
                os.unlink(prereq_script)
            except subprocess.CalledProcessError as e:
                logger.error(f"Prerequisites failed: {e}")
                return False

        # Write new version
        logger.info("Installing new version...")
        with open(current_script, 'w') as f:
            f.write(update_data['script_content'])

        # Make executable
        os.chmod(current_script, 0o755)

        logger.info(f"Successfully updated to version {remote_version}")
        logger.info("Restarting with new version...")

        # Restart with same arguments
        os.execv(sys.executable, [sys.executable] + sys.argv)

        return True  # Never reached due to exec

    except Exception as e:
        logger.error(f"Error during update check/install: {e}")
        # Restore backup if update failed
        if 'backup_script' in locals() and os.path.exists(backup_script):
            logger.info("Restoring backup...")
            with open(backup_script, 'r') as f:
                backup_content = f.read()
            with open(current_script, 'w') as f:
                f.write(backup_content)
        return False


class GeoSensorAPI:
    """Geographic DNS sensor using API authentication"""

    def __init__(self, location_code: str, api_url: str, api_key: str):
        self.location_code = location_code
        self.api_url = api_url.rstrip('/')
        self.api_key = api_key
        self.sensor_id = None
        self.resolver = None
        self.session = requests.Session()
        self.session.headers.update({
            'Authorization': f'Bearer {api_key}',
            'Content-Type': 'application/json'
        })

        self._init_resolver()
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

    def _register_sensor(self):
        """Register or verify sensor via API"""
        try:
            # Get sensor info from API
            response = self.session.get(
                f'{self.api_url}/api/sensors/{self.location_code}'
            )

            if response.status_code == 200:
                sensor_data = response.json()
                self.sensor_id = sensor_data['id']
                logger.info(f"Connected to sensor ID: {self.sensor_id} ({sensor_data['location_name']})")
            elif response.status_code == 404:
                logger.error(f"Sensor location '{self.location_code}' not found")
                logger.error("Available locations: na, eu, apac, sa, af, oc")
                sys.exit(1)
            else:
                logger.error(f"Failed to connect to API: {response.status_code} - {response.text}")
                sys.exit(1)

        except requests.exceptions.RequestException as e:
            logger.error(f"Error connecting to API: {e}")
            sys.exit(1)

    def get_zones_to_sync(self) -> List[Dict]:
        """Get zones that need syncing from API"""
        try:
            # API returns zones based on authentication:
            # - Superadmin: all zones with use_proxy_ips=1
            # - Account admin/user: only their zones with use_proxy_ips=1
            response = self.session.get(
                f'{self.api_url}/api/sensors/zones-to-sync'
            )

            if response.status_code == 200:
                zones = response.json()
                logger.info(f"Found {len(zones)} zones to sync")
                return zones
            else:
                logger.error(f"Failed to fetch zones: {response.status_code} - {response.text}")
                return []

        except requests.exceptions.RequestException as e:
            logger.error(f"Error fetching zones: {e}")
            return []

    def get_proxied_records(self, zone: Dict) -> List[Dict]:
        """Get proxied records for a zone from API"""
        try:
            response = self.session.get(
                f'{self.api_url}/api/sensors/zones/{zone["zone_id"]}/proxied-records'
            )

            if response.status_code == 200:
                return response.json()
            else:
                logger.warning(f"Failed to fetch records for zone {zone['zone_name']}: {response.status_code}")
                return []

        except requests.exceptions.RequestException as e:
            logger.error(f"Error fetching records for zone {zone['zone_name']}: {e}")
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

    def submit_results(self, results: List[Dict]) -> bool:
        """Submit learned IPs to API"""
        if not results:
            return True

        try:
            response = self.session.post(
                f'{self.api_url}/api/sensors/submit',
                json={
                    'sensor_id': self.sensor_id,
                    'location_code': self.location_code,
                    'results': results,
                    'timestamp': datetime.utcnow().isoformat()
                }
            )

            if response.status_code == 200:
                result = response.json()
                logger.info(f"Successfully submitted {result.get('processed', 0)} results")
                return True
            elif response.status_code == 403:
                logger.error("Permission denied: Cannot update zones not owned by this account")
                return False
            else:
                logger.error(f"Failed to submit results: {response.status_code} - {response.text}")
                return False

        except requests.exceptions.RequestException as e:
            logger.error(f"Error submitting results: {e}")
            return False

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

        # Get zones to sync (filtered by API based on authentication)
        zones = self.get_zones_to_sync()
        stats['zones'] = len(zones)

        if not zones:
            logger.warning("No zones to sync")
            return stats

        # Collect all results before submitting
        all_results = []

        for zone in zones:
            zone_id = zone['zone_id']
            zone_name = zone['zone_name']

            logger.info(f"Processing zone: {zone_name}")

            # Get proxied records
            records = self.get_proxied_records(zone)
            logger.info(f"  Found {len(records)} proxied records")

            for record in records:
                try:
                    stats['records'] += 1

                    record_id = record['record_id']
                    record_name = record['record_name']
                    record_type = record['record_type']

                    # Resolve record
                    ips = self.resolve_record(record_name, record_type)

                    if ips:
                        stats['ips_learned'] += len(ips)
                        all_results.append({
                            'zone_id': zone_id,
                            'record_id': record_id,
                            'record_name': record_name,
                            'record_type': record_type,
                            'learned_ips': ips
                        })
                    else:
                        logger.debug(f"  No IPs for: {record_name}")

                except Exception as e:
                    logger.error(f"  Error processing {record.get('record_name')}: {e}")
                    stats['errors'] += 1

                # Small delay to avoid rate limiting
                time.sleep(0.1)

        # Submit all results at once
        if all_results:
            success = self.submit_results(all_results)
            if not success:
                stats['errors'] += 1

        elapsed = time.time() - start_time

        logger.info("Sync cycle completed")
        logger.info(f"  Zones: {stats['zones']}")
        logger.info(f"  Records: {stats['records']}")
        logger.info(f"  IPs learned: {stats['ips_learned']}")
        logger.info(f"  Errors: {stats['errors']}")
        logger.info(f"  Time: {elapsed:.2f}s")

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


def main():
    parser = argparse.ArgumentParser(
        description='Geographic DNS Sensor for Cloudflare Proxy IP Learning (API Version)'
    )
    parser.add_argument(
        '--location',
        required=True,
        help='Sensor location code (e.g., na, eu, apac, sa, af, oc)'
    )
    parser.add_argument(
        '--api-url',
        required=True,
        help='DNS Manager API URL (e.g., https://dns.example.com)'
    )
    parser.add_argument(
        '--api-key',
        required=True,
        help='API key for authentication'
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

    # Check for updates before running
    logger.info(f"Sensor script version: {__version__}")
    try:
        check_for_updates(args.api_url, args.api_key)
    except Exception as e:
        logger.warning(f"Update check failed: {e}")
        # Continue anyway - don't let update check block operation

    # Initialize sensor
    sensor = GeoSensorAPI(args.location, args.api_url, args.api_key)

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


if __name__ == '__main__':
    # Check dependencies
    try:
        import dns.resolver
        import requests
    except ImportError as e:
        print(f"Missing dependency: {e}")
        print("Install with: pip3 install dnspython requests")
        sys.exit(1)

    main()
