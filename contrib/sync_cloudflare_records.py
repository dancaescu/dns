#!/usr/bin/env python3
"""
Synchronise Cloudflare accounts/zones/records into the local MyDNS database.

This script mirrors the behaviour of the Admindns::sync_cron task but reads
configuration directly from the MyDNS config files so it can be executed from
cron without PHP/CodeIgniter.  Cloudflare credentials plus the list of account
IDs to sync are read from /etc/mydns/cloudflare.ini.  Database connection
details (including optional failover hosts) are read from /etc/mydns/mydns.conf.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import random
import sys
from dataclasses import dataclass
from datetime import datetime
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

try:
    import pymysql
except ImportError as exc:  # pragma: no cover - environment specific
    print("pymysql module is required: {}".format(exc), file=sys.stderr)
    sys.exit(1)

try:
    import requests
except ImportError as exc:  # pragma: no cover - environment specific
    print("requests module is required: {}".format(exc), file=sys.stderr)
    sys.exit(1)


DEFAULT_CF_CONFIG = "/etc/mydns/cloudflare.ini"
DEFAULT_MYDNS_CONFIG = "/etc/mydns/mydns.conf"
DEFAULT_CF_API = "https://api.cloudflare.com/client/v4"
HOST_KEYS = ("db-host", "db-host2", "db-host3", "db-host4")
VALID_POLICIES = ("sequential", "round-robin", "roundrobin", "rr", "least-used", "least_used", "least")


class ConfigError(Exception):
    """Raised for invalid configuration."""


class CloudflareError(Exception):
    """Raised when Cloudflare API returns an error."""


def parse_simple_config(path: str) -> Dict[str, str]:
    """Parse simple key=value files (no sections)."""
    data: Dict[str, str] = {}
    if not os.path.isfile(path):
        raise ConfigError(f"Config file not found: {path}")
    with open(path, "r", encoding="utf-8") as handle:
        for raw in handle:
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            if "#" in line:
                line = line.split("#", 1)[0].strip()
            if "=" not in line:
                continue
            key, value = line.split("=", 1)
            data[key.strip()] = value.strip().strip('"').strip("'")
    return data


def parse_account_list(value: str) -> List[str]:
    if not value:
        return []
    tokens: List[str] = []
    for part in value.replace("\n", ",").split(","):
        candidate = part.strip()
        if candidate:
            tokens.append(candidate)
    return tokens


def parse_host_entry(entry: str) -> Tuple[str, int]:
    """
    Split host entries like "db.example:3306" or "[fd00::1]:3307" into (host, port).
    Bare IPv6 literals should be wrapped in [] if a port is specified.
    """
    entry = entry.strip()
    port = 3306
    host = entry

    if entry.startswith("[") and "]" in entry:
        idx = entry.index("]")
        host = entry[1:idx]
        if len(entry) > idx + 1 and entry[idx + 1] == ":":
            try:
                port = int(entry[idx + 2 :])
            except ValueError:
                pass
        return host, port

    if entry.count(":") == 1 and entry.find(":") == entry.rfind(":"):
        host_part, port_part = entry.split(":", 1)
        host = host_part or host
        if port_part:
            try:
                port = int(port_part)
            except ValueError:
                port = 3306
        return host, port

    return host, port


def parse_timestamp(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    candidate = value.strip()
    if not candidate:
        return None
    if candidate.endswith("Z"):
        candidate = candidate[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(candidate)
        return dt.strftime("%Y-%m-%d %H:%M:%S")
    except ValueError:
        return None


@dataclass
class DatabaseConfig:
    user: str
    password: str
    database: str
    hosts: List[Tuple[str, int]]
    policy: str = "sequential"


def load_db_config(path: str) -> DatabaseConfig:
    raw = parse_simple_config(path)
    user = raw.get("db-user") or raw.get("mysql-user")
    password = raw.get("db-password") or raw.get("mysql-password") or raw.get("mysql-pass")
    database = raw.get("database")
    if not user or password is None or not database:
        raise ConfigError("database connection details missing in {}".format(path))

    hosts: List[Tuple[str, int]] = []
    for key in HOST_KEYS:
        val = raw.get(key)
        if val:
            hosts.append(parse_host_entry(val))

    if not hosts:
        legacy = raw.get("mysql-host") or raw.get("db-host")
        if legacy:
            hosts.append(parse_host_entry(legacy))

    if not hosts:
        hosts.append(("localhost", 3306))

    policy = raw.get("db-host-policy", "sequential").strip().lower()
    if policy not in VALID_POLICIES:
        policy = "sequential"

    return DatabaseConfig(user=user, password=password, database=database, hosts=hosts, policy=policy)


@dataclass
class CloudflareConfig:
    base_url: str
    email: Optional[str]
    api_key: Optional[str]
    api_token: Optional[str]
    account_ids: List[str]


def load_cloudflare_config(path: str) -> CloudflareConfig:
    raw = parse_simple_config(path)
    account_ids = parse_account_list(raw.get("cf_account_ids", ""))
    if not account_ids:
        raise ConfigError("cf_account_ids missing in {}".format(path))
    api_base = raw.get("api", DEFAULT_CF_API).rstrip("/")
    email = raw.get("email")
    api_key = raw.get("api_key")
    api_token = raw.get("api_token")
    if not api_token and (not email or not api_key):
        raise ConfigError("Cloudflare credentials incomplete in {}".format(path))
    return CloudflareConfig(
        base_url=api_base,
        email=email,
        api_key=api_key,
        api_token=api_token,
        account_ids=account_ids,
    )


class DatabaseConnectionManager:
    def __init__(self, config: DatabaseConfig):
        self.config = config

    def ordered_hosts(self) -> List[Tuple[str, int]]:
        hosts = list(self.config.hosts)
        policy = self.config.policy
        if policy in ("round-robin", "roundrobin", "rr") and hosts:
            start = random.randint(0, len(hosts) - 1)
            hosts = hosts[start:] + hosts[:start]
        elif policy in ("least-used", "least_used", "least"):
            # Without persistent metrics we simply shuffle to spread load.
            random.shuffle(hosts)
        return hosts

    def connect(self) -> pymysql.connections.Connection:
        last_error: Optional[Exception] = None
        for host, port in self.ordered_hosts():
            try:
                logging.info("Attempting DB connection to %s:%s", host, port)
                conn = pymysql.connect(
                    host=host,
                    port=port,
                    user=self.config.user,
                    password=self.config.password,
                    database=self.config.database,
                    charset="utf8mb4",
                    autocommit=False,
                )
                logging.info("Connected to %s:%s (database=%s)", host, port, self.config.database)
                return conn
            except Exception as exc:  # pragma: no cover - depends on environment
                logging.error("Failed to connect to %s:%s -> %s", host, port, exc)
                last_error = exc
        raise ConfigError("Unable to connect to any DB host: {}".format(last_error))


class CloudflareClient:
    def __init__(self, config: CloudflareConfig):
        self.base = config.base_url.rstrip("/")
        self.config = config

    def headers(self) -> Dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self.config.api_token:
            headers["Authorization"] = "Bearer {}".format(self.config.api_token)
        else:
            headers["X-Auth-Email"] = self.config.email or ""
            headers["X-Auth-Key"] = self.config.api_key or ""
        return headers

    def request(
        self, method: str, path: str, params: Optional[Dict[str, str]] = None, payload: Optional[Dict] = None
    ) -> Dict:
        url = "{}/{}".format(self.base, path.lstrip("/"))
        try:
            resp = requests.request(
                method.upper(),
                url,
                headers=self.headers(),
                params=params,
                json=payload,
                timeout=120,
            )
        except requests.RequestException as exc:  # pragma: no cover - network dependent
            raise CloudflareError(f"Request failed: {exc}") from exc

        text = resp.text
        try:
            decoded = resp.json()
        except ValueError as exc:
            snippet = text[:200]
            raise CloudflareError(f"Cloudflare invalid response: {snippet}") from exc

        if resp.status_code >= 400 or not decoded.get("success", False):
            message = decoded.get("errors") or decoded.get("messages") or text[:200]
            raise CloudflareError(f"Cloudflare API error {resp.status_code}: {message}")
        return decoded

    def paginated_get(
        self, path: str, params: Optional[Dict[str, str]] = None, per_page: int = 50
    ) -> List[Dict]:
        results: List[Dict] = []
        page = 1
        while True:
            page_params = {"page": str(page), "per_page": str(per_page)}
            if params:
                page_params.update(params)
            decoded = self.request("GET", path, params=page_params)
            batch = decoded.get("result") or []
            results.extend(batch)
            info = decoded.get("result_info") or {}
            total_pages = info.get("total_pages") or 0
            if not total_pages or page >= int(total_pages):
                break
            page += 1
        return results

    def list_zones(self, account_id: str) -> List[Dict]:
        return self.paginated_get("/zones", params={"account.id": account_id}, per_page=50)

    def list_records(self, zone_id: str) -> List[Dict]:
        return self.paginated_get(f"/zones/{zone_id}/dns_records", per_page=100)

    def list_load_balancers(self, zone_id: str) -> List[Dict]:
        try:
            return self.paginated_get(f"/zones/{zone_id}/load_balancers", per_page=50)
        except CloudflareError as exc:
            logging.warning("Skipping load balancers for %s: %s", zone_id, exc)
            return []


def upsert_account(cursor, cf_account_id: str, name: str) -> int:
    sql = """
        INSERT INTO cloudflare_accounts (cf_account_id, name)
        VALUES (%s, %s)
        ON DUPLICATE KEY UPDATE
            name = VALUES(name),
            updated_at = NOW(),
            id = LAST_INSERT_ID(id)
    """
    cursor.execute(sql, (cf_account_id, name))
    return int(cursor.lastrowid)


def upsert_zone(cursor, account_id: int, zone: Dict) -> int:
    sql = """
        INSERT INTO cloudflare_zones
            (account_id, cf_zone_id, name, status, paused, zone_type, plan_name)
        VALUES (%s, %s, %s, %s, %s, %s, %s)
        ON DUPLICATE KEY UPDATE
            account_id = VALUES(account_id),
            name = VALUES(name),
            status = VALUES(status),
            paused = VALUES(paused),
            zone_type = VALUES(zone_type),
            plan_name = VALUES(plan_name),
            updated_at = NOW(),
            id = LAST_INSERT_ID(id)
    """
    cursor.execute(
        sql,
        (
            account_id,
            zone.get("id"),
            zone.get("name"),
            zone.get("status"),
            1 if zone.get("paused") else 0,
            zone.get("type"),
            (zone.get("plan") or {}).get("name"),
        ),
    )
    return int(cursor.lastrowid)


def replace_zone_records(cursor, zone_id: int, records: Sequence[Dict]) -> int:
    cursor.execute("DELETE FROM cloudflare_records WHERE zone_id = %s", (zone_id,))
    if not records:
        return 0
    insert_sql = """
        INSERT INTO cloudflare_records
            (zone_id, cf_record_id, record_type, name, content, ttl, proxied, priority, data, modified_on, comment, tags)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
    """
    payloads = []
    for record in records:
        # Extract tags from Cloudflare's tags array and convert to comma-separated string
        tags_list = record.get("tags", [])
        tags_str = ",".join(tags_list) if isinstance(tags_list, list) else None

        payloads.append(
            (
                zone_id,
                record.get("id"),
                record.get("type"),
                record.get("name"),
                record.get("content"),
                record.get("ttl"),
                None if "proxied" not in record else int(bool(record.get("proxied"))),
                record.get("priority"),
                json.dumps(record, separators=(",", ":"), sort_keys=True),
                parse_timestamp(record.get("modified_on")),
                record.get("comment"),
                tags_str,
            )
        )
    cursor.executemany(insert_sql, payloads)
    return len(records)


def replace_zone_load_balancers(cursor, zone_id: int, balancers: Sequence[Dict]) -> int:
    cursor.execute("DELETE FROM cloudflare_load_balancers WHERE zone_id = %s", (zone_id,))
    if not balancers:
        return 0
    insert_sql = """
        INSERT INTO cloudflare_load_balancers
            (zone_id, cf_lb_id, name, proxied, enabled, fallback_pool, default_pools, steering_policy, data)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
    """
    payloads = []
    for balancer in balancers:
        payloads.append(
            (
                zone_id,
                balancer.get("id"),
                balancer.get("name"),
                None if "proxied" not in balancer else int(bool(balancer.get("proxied"))),
                None if "enabled" not in balancer else int(bool(balancer.get("enabled"))),
                balancer.get("fallback_pool"),
                json.dumps(balancer.get("default_pools")) if balancer.get("default_pools") is not None else None,
                balancer.get("steering_policy"),
                json.dumps(balancer, separators=(",", ":"), sort_keys=True),
            )
        )
    cursor.executemany(insert_sql, payloads)
    return len(balancers)


def sync_zone(conn, cf_client: CloudflareClient, account_id: int, zone: Dict) -> Tuple[int, int]:
    records = cf_client.list_records(zone["id"])
    balancers = cf_client.list_load_balancers(zone["id"])
    with conn.cursor() as cursor:
        local_zone_id = upsert_zone(cursor, account_id, zone)
        record_count = replace_zone_records(cursor, local_zone_id, records)
        lb_count = replace_zone_load_balancers(cursor, local_zone_id, balancers)
        cursor.execute(
            "UPDATE cloudflare_zones SET last_synced = NOW(), updated_at = NOW() WHERE id = %s",
            (local_zone_id,),
        )
    conn.commit()
    return record_count, lb_count


def sync_accounts(conn, cf_client: CloudflareClient, account_ids: Sequence[str]) -> Dict[str, int]:
    summary = {"zones": 0, "records": 0, "load_balancers": 0}
    for account_id in account_ids:
        logging.info("Syncing account %s", account_id)
        try:
            zones = cf_client.list_zones(account_id)
        except CloudflareError as exc:
            logging.error("Failed to list zones for %s: %s", account_id, exc)
            continue
        if not zones:
            logging.info("No zones returned for %s", account_id)
            continue
        for zone in zones:
            zone_id = zone.get("id")
            if not zone_id:
                logging.warning("Skipping zone without id: %s", zone)
                continue
            account_data = zone.get("account") or {"id": account_id, "name": "Cloudflare"}
            with conn.cursor() as cursor:
                db_account_id = upsert_account(
                    cursor,
                    account_data.get("id", account_id),
                    account_data.get("name") or "Cloudflare account",
                )
            conn.commit()

            try:
                record_count, lb_count = sync_zone(conn, cf_client, db_account_id, zone)
            except CloudflareError as exc:
                conn.rollback()
                logging.error("Failed to sync zone %s (%s): %s", zone.get("name"), zone_id, exc)
                continue
            summary["zones"] += 1
            summary["records"] += record_count
            summary["load_balancers"] += lb_count
            logging.info(
                "Synced zone %s (%s): %s records, %s load balancers",
                zone.get("name"),
                zone_id,
                record_count,
                lb_count,
            )
    return summary


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Sync Cloudflare DNS data into the MyDNS database.")
    parser.add_argument("--cloudflare-config", default=DEFAULT_CF_CONFIG, help="Path to cloudflare.ini")
    parser.add_argument("--mydns-config", default=DEFAULT_MYDNS_CONFIG, help="Path to mydns.conf")
    parser.add_argument(
        "--accounts",
        help="Comma separated Cloudflare account IDs to sync (overrides cf_account_ids).",
    )
    parser.add_argument("--log-level", default="INFO", help="Logging level (default: INFO)")
    return parser


def main() -> int:
    parser = build_arg_parser()
    args = parser.parse_args()
    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(message)s",
    )
    try:
        cf_cfg = load_cloudflare_config(args.cloudflare_config)
        db_cfg = load_db_config(args.mydns_config)
    except ConfigError as exc:
        logging.error("%s", exc)
        return 1

    account_ids = parse_account_list(args.accounts) if args.accounts else cf_cfg.account_ids
    if not account_ids:
        logging.error("No account IDs provided")
        return 1

    cf_client = CloudflareClient(cf_cfg)
    db_manager = DatabaseConnectionManager(db_cfg)
    try:
        conn = db_manager.connect()
    except ConfigError as exc:
        logging.error("%s", exc)
        return 1

    try:
        summary = sync_accounts(conn, cf_client, account_ids)
    finally:
        conn.close()

    logging.info(
        "Cloudflare sync completed: zones=%d records=%d load_balancers=%d",
        summary["zones"],
        summary["records"],
        summary["load_balancers"],
    )
    return 0


if __name__ == "__main__":  # pragma: no cover - CLI entry
    sys.exit(main())
