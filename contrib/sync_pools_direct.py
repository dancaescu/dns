#!/usr/bin/env python3
"""Direct pool sync - fetch pools from Cloudflare and sync to database."""

import json
import sys
import pymysql
import requests

# Cloudflare API
CF_API_BASE = "https://api.cloudflare.com/client/v4"


def parse_config_file(filepath):
    """Parse key=value config file."""
    config = {}
    try:
        with open(filepath, "r") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                # Remove inline comments
                if "#" in line:
                    line = line.split("#", 1)[0].strip()
                if "=" in line:
                    key, value = line.split("=", 1)
                    config[key.strip()] = value.strip().strip('"').strip("'")
    except Exception as e:
        print(f"Error reading {filepath}: {e}", file=sys.stderr)
    return config


def get_db_config():
    """Read database config from /etc/mydns/mydns.conf."""
    config = parse_config_file("/etc/mydns/mydns.conf")
    return {
        "host": config.get("db-host", "localhost").split(":")[0],
        "user": config.get("db-user", ""),
        "password": config.get("db-password", ""),
        "database": config.get("database", ""),
        "charset": "utf8mb4"
    }


def get_cf_credentials():
    """Get Cloudflare credentials from config file."""
    config = parse_config_file("/etc/mydns/cloudflare.ini")
    return config.get("email"), config.get("api_key")


def cf_request(method, path, email, api_key, params=None, payload=None):
    """Make Cloudflare API request using email + API key."""
    url = f"{CF_API_BASE}{path}"
    headers = {
        "X-Auth-Email": email,
        "X-Auth-Key": api_key,
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "MyDNS-NG/1.0"
    }

    resp = requests.request(method, url, headers=headers, params=params, json=payload, timeout=120)
    if resp.status_code >= 400:
        print(f"CF API error {resp.status_code}: {resp.text[:200]}", file=sys.stderr)
        return None

    try:
        data = resp.json()
        if not data.get("success"):
            print(f"CF API failed: {data.get('errors')}", file=sys.stderr)
            return None
        return data.get("result")
    except Exception as e:
        print(f"Failed to parse response: {e}", file=sys.stderr)
        return None


def sync_pools_for_zone(zone_id):
    """Sync all pools for a specific zone."""
    # Get CF credentials
    email, api_key = get_cf_credentials()
    if not email or not api_key:
        print("Cloudflare credentials not found in /etc/mydns/cloudflare.ini", file=sys.stderr)
        return

    # Get DB config
    db_config = get_db_config()
    conn = pymysql.connect(**db_config)

    try:
        # Get zone and account info
        with conn.cursor() as cursor:
            cursor.execute("""
                SELECT z.id, z.name, a.cf_account_id
                FROM cloudflare_zones z
                JOIN cloudflare_accounts a ON a.id = z.account_id
                WHERE z.id = %s
            """, (zone_id,))
            zone_row = cursor.fetchone()

            if not zone_row:
                print(f"Zone {zone_id} not found", file=sys.stderr)
                return

            local_zone_id, zone_name, cf_account_id = zone_row
            print(f"Syncing pools for zone {zone_name} (account: {cf_account_id})")

            # Get load balancers for this zone
            cursor.execute("""
                SELECT id, cf_lb_id, name, default_pools
                FROM cloudflare_load_balancers
                WHERE zone_id = %s
            """, (local_zone_id,))
            load_balancers = cursor.fetchall()

            if not load_balancers:
                print("No load balancers found for this zone")
                return

            # Collect unique pool IDs
            pool_ids = set()
            lb_map = {}
            for lb in load_balancers:
                lb_id, cf_lb_id, lb_name, default_pools_json = lb
                lb_map[cf_lb_id] = (lb_id, lb_name)

                if default_pools_json:
                    try:
                        pool_list = json.loads(default_pools_json) if isinstance(default_pools_json, str) else default_pools_json
                        if isinstance(pool_list, list):
                            pool_ids.update(pool_list)
                    except:
                        pass

            print(f"Found {len(pool_ids)} unique pools to sync")

            # Fetch and sync each pool
            synced_count = 0
            for cf_pool_id in pool_ids:
                print(f"Fetching pool {cf_pool_id}...")
                pool_data = cf_request("GET", f"/accounts/{cf_account_id}/load_balancers/pools/{cf_pool_id}", email, api_key)

                if not pool_data:
                    print(f"  Failed to fetch pool {cf_pool_id}")
                    continue

                # Find which LB uses this pool
                for lb_id, cf_lb_id, lb_name, default_pools_json in load_balancers:
                    if default_pools_json:
                        try:
                            pool_list = json.loads(default_pools_json) if isinstance(default_pools_json, str) else default_pools_json
                            if cf_pool_id in pool_list:
                                # Upsert pool
                                cursor.execute("""
                                    SELECT id FROM cloudflare_lb_pools WHERE lb_id = %s AND cf_pool_id = %s
                                """, (lb_id, cf_pool_id))
                                existing = cursor.fetchone()

                                # Check if notifications are enabled (Cloudflare uses notification_filter)
                                notification_enabled = 0
                                notification_filter = pool_data.get("notification_filter")
                                if notification_filter and isinstance(notification_filter, dict):
                                    if "pool" in notification_filter:
                                        notification_enabled = 1

                                if existing:
                                    cursor.execute("""
                                        UPDATE cloudflare_lb_pools SET
                                            name = %s, description = %s, enabled = %s, minimum_origins = %s,
                                            monitor = %s, origin_steering_policy = %s,
                                            notification_email = %s, notification_enabled = %s, updated_at = NOW()
                                        WHERE id = %s
                                    """, (
                                        pool_data.get("name"),
                                        pool_data.get("description"),
                                        1 if pool_data.get("enabled", True) else 0,
                                        pool_data.get("minimum_origins", 1),
                                        pool_data.get("monitor"),
                                        pool_data.get("origin_steering", {}).get("policy", "random"),
                                        pool_data.get("notification_email"),
                                        notification_enabled,
                                        existing[0]
                                    ))
                                    pool_db_id = existing[0]
                                else:
                                    cursor.execute("""
                                        INSERT INTO cloudflare_lb_pools
                                        (lb_id, cf_pool_id, name, description, enabled, minimum_origins, monitor,
                                         origin_steering_policy, notification_email, notification_enabled)
                                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                                    """, (
                                        lb_id,
                                        cf_pool_id,
                                        pool_data.get("name"),
                                        pool_data.get("description"),
                                        1 if pool_data.get("enabled", True) else 0,
                                        pool_data.get("minimum_origins", 1),
                                        pool_data.get("monitor"),
                                        pool_data.get("origin_steering", {}).get("policy", "random"),
                                        pool_data.get("notification_email"),
                                        notification_enabled
                                    ))
                                    pool_db_id = cursor.lastrowid

                                # Delete existing origins
                                cursor.execute("DELETE FROM cloudflare_lb_pool_origins WHERE pool_id = %s", (pool_db_id,))

                                # Insert origins
                                origins = pool_data.get("origins", [])
                                for origin in origins:
                                    cursor.execute("""
                                        INSERT INTO cloudflare_lb_pool_origins
                                        (pool_id, name, address, enabled, weight, port, header_host)
                                        VALUES (%s, %s, %s, %s, %s, %s, %s)
                                    """, (
                                        pool_db_id,
                                        origin.get("name"),
                                        origin.get("address"),
                                        1 if origin.get("enabled", True) else 0,
                                        origin.get("weight", 1.0),
                                        origin.get("port"),
                                        origin.get("header", {}).get("Host") if isinstance(origin.get("header"), dict) else None
                                    ))

                                print(f"  Synced pool '{pool_data.get('name')}' with {len(origins)} origins to LB '{lb_name}'")
                                synced_count += 1
                                break
                        except:
                            pass

            conn.commit()
            print(f"\nSuccessfully synced {synced_count} pools")

    finally:
        conn.close()


if __name__ == "__main__":
    zone_id = int(sys.argv[1]) if len(sys.argv) > 1 else 3645
    sync_pools_for_zone(zone_id)
