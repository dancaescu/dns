#!/usr/bin/env python3
"""
Enhanced Cloudflare Sync Script with Multi-User Support

This script syncs Cloudflare zones/records from multiple credential sources:
1. /etc/mydns/cloudflare.ini (global/admin credentials)
2. dnsmanager_cloudflare_credentials table (per-user credentials)

Each credential source is processed independently, allowing multiple users
to sync their own Cloudflare accounts.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import traceback
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple
import crypto
from Crypto.Cipher import AES
from Crypto.Random import get_random_bytes
import base64

# Import the original sync script functions
sys.path.insert(0, os.path.dirname(__file__))
from sync_cloudflare_records import (
    DatabaseConfig,
    DatabaseConnectionManager,
    CloudflareClient,
    CloudflareConfig,
    CloudflareError,
    ConfigError,
    load_db_config,
    load_cloudflare_config,
    parse_simple_config,
    DEFAULT_CF_CONFIG,
    DEFAULT_MYDNS_CONFIG,
    DEFAULT_CF_API,
)

# Encryption key (should match the one in TypeScript)
ENCRYPTION_KEY = os.environ.get("CF_ENCRYPTION_KEY", "CHANGE_THIS_TO_SECURE_KEY_32_CHARS_LONG!!!")[:32]


def decrypt_api_key(encrypted_data: str) -> str:
    """
    Decrypt a Cloudflare API key from database
    Format: iv:authTag:encrypted (hex encoded)
    """
    try:
        parts = encrypted_data.split(":")
        if len(parts) != 3:
            raise ValueError("Invalid encrypted data format")

        iv = bytes.fromhex(parts[0])
        auth_tag = bytes.fromhex(parts[1])
        encrypted = bytes.fromhex(parts[2])

        cipher = AES.new(ENCRYPTION_KEY.encode()[:32], AES.MODE_GCM, nonce=iv)
        decrypted = cipher.decrypt_and_verify(encrypted, auth_tag)
        return decrypted.decode("utf-8")
    except Exception as e:
        logging.error(f"Failed to decrypt API key: {e}")
        raise


@dataclass
class UserCloudflareCredential:
    """Represents a user's Cloudflare credential from database"""
    id: int
    user_id: int
    account_id: int
    cf_email: str
    cf_api_key: str  # Encrypted
    cf_account_id: str
    cf_domain: Optional[str]
    cf_api_url: str
    enabled: bool
    auto_sync: bool


def load_user_credentials(db_conn) -> List[UserCloudflareCredential]:
    """
    Load all enabled user Cloudflare credentials from database
    """
    credentials: List[UserCloudflareCredential] = []

    try:
        with db_conn.cursor() as cursor:
            cursor.execute("""
                SELECT
                    id, user_id, account_id, cf_email, cf_api_key,
                    cf_account_id, cf_domain, cf_api_url, enabled, auto_sync
                FROM dnsmanager_cloudflare_credentials
                WHERE enabled = 1 AND auto_sync = 1
            """)

            for row in cursor.fetchall():
                try:
                    decrypted_api_key = decrypt_api_key(row[4])

                    cred = UserCloudflareCredential(
                        id=row[0],
                        user_id=row[1],
                        account_id=row[2],
                        cf_email=row[3],
                        cf_api_key=decrypted_api_key,
                        cf_account_id=row[5],
                        cf_domain=row[6],
                        cf_api_url=row[7] or DEFAULT_CF_API,
                        enabled=bool(row[8]),
                        auto_sync=bool(row[9]),
                    )
                    credentials.append(cred)
                    logging.info(
                        f"Loaded credential {cred.id} for user {cred.user_id}, "
                        f"CF account {cred.cf_account_id}"
                    )
                except Exception as e:
                    logging.error(f"Failed to load credential {row[0]}: {e}")
                    continue

    except Exception as e:
        logging.error(f"Failed to load user credentials: {e}")

    return credentials


def update_credential_sync_status(
    db_conn, credential_id: int, status: str, error: Optional[str] = None
):
    """
    Update the sync status for a user credential
    """
    try:
        with db_conn.cursor() as cursor:
            cursor.execute("""
                UPDATE dnsmanager_cloudflare_credentials
                SET last_sync_at = NOW(),
                    last_sync_status = %s,
                    last_sync_error = %s
                WHERE id = %s
            """, (status, error, credential_id))
        db_conn.commit()
    except Exception as e:
        logging.error(f"Failed to update sync status for credential {credential_id}: {e}")


def sync_cloudflare_account(
    db_conn,
    cf_client: CloudflareClient,
    cf_account_id: str,
    cf_domain: Optional[str],
    credential_id: Optional[int],
    user_id: Optional[int],
) -> Tuple[int, int, int]:
    """
    Sync a single Cloudflare account
    Returns: (zones_synced, records_synced, errors)
    """
    zones_synced = 0
    records_synced = 0
    errors = 0

    try:
        # Get or create cloudflare_accounts entry
        with db_conn.cursor() as cursor:
            cursor.execute(
                "SELECT id FROM cloudflare_accounts WHERE cf_account_id = %s",
                (cf_account_id,)
            )
            row = cursor.fetchone()

            if row:
                account_db_id = row[0]
            else:
                cursor.execute(
                    "INSERT INTO cloudflare_accounts (cf_account_id, name) VALUES (%s, %s)",
                    (cf_account_id, f"Account {cf_account_id[:8]}")
                )
                account_db_id = cursor.lastrowid
                db_conn.commit()

        # List zones from Cloudflare
        zones = cf_client.list_zones(cf_account_id)
        logging.info(f"Found {len(zones)} zones for account {cf_account_id}")

        for zone in zones:
            # Filter by domain if specified
            if cf_domain and zone.get("name") != cf_domain:
                continue

            try:
                zone_id = zone.get("id")
                zone_name = zone.get("name")

                if not zone_id or not zone_name:
                    logging.warning(f"Skipping zone with missing id or name: {zone}")
                    errors += 1
                    continue

                # Sync zone to database
                with db_conn.cursor() as cursor:
                    cursor.execute(
                        """
                        INSERT INTO cloudflare_zones
                            (cf_zone_id, cf_account_id, name, status, created_at, updated_at)
                        VALUES (%s, %s, %s, %s, NOW(), NOW())
                        ON DUPLICATE KEY UPDATE
                            name = VALUES(name),
                            status = VALUES(status),
                            updated_at = NOW()
                        """,
                        (zone_id, account_db_id, zone_name, zone.get("status", "active"))
                    )
                db_conn.commit()
                zones_synced += 1

                # Sync records for this zone
                records = cf_client.list_records(zone_id)
                logging.info(f"Found {len(records)} records for zone {zone_name}")

                for record in records:
                    try:
                        record_id = record.get("id")
                        record_name = record.get("name")
                        record_type = record.get("type")
                        record_content = record.get("content")

                        if not all([record_id, record_name, record_type, record_content]):
                            logging.warning(f"Skipping incomplete record: {record}")
                            errors += 1
                            continue

                        # Get zone DB ID
                        with db_conn.cursor() as cursor:
                            cursor.execute(
                                "SELECT id FROM cloudflare_zones WHERE cf_zone_id = %s",
                                (zone_id,)
                            )
                            zone_db_row = cursor.fetchone()
                            if not zone_db_row:
                                logging.error(f"Zone {zone_id} not found in database")
                                errors += 1
                                continue
                            zone_db_id = zone_db_row[0]

                        # Sync record to database
                        with db_conn.cursor() as cursor:
                            cursor.execute(
                                """
                                INSERT INTO cloudflare_records
                                    (cf_record_id, cf_zone_id, name, type, content, ttl, proxied, priority, created_at, updated_at)
                                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, NOW(), NOW())
                                ON DUPLICATE KEY UPDATE
                                    name = VALUES(name),
                                    type = VALUES(type),
                                    content = VALUES(content),
                                    ttl = VALUES(ttl),
                                    proxied = VALUES(proxied),
                                    priority = VALUES(priority),
                                    updated_at = NOW()
                                """,
                                (
                                    record_id,
                                    zone_db_id,
                                    record_name,
                                    record_type,
                                    record_content,
                                    record.get("ttl", 1),
                                    record.get("proxied", False),
                                    record.get("priority", 0),
                                )
                            )
                        db_conn.commit()
                        records_synced += 1

                    except Exception as e:
                        logging.error(f"Failed to sync record {record.get('id')}: {e}")
                        errors += 1

            except Exception as e:
                logging.error(f"Failed to sync zone {zone.get('name')}: {e}")
                logging.error(traceback.format_exc())
                errors += 1

    except CloudflareError as e:
        logging.error(f"Cloudflare API error: {e}")
        errors += 1
        if credential_id:
            update_credential_sync_status(db_conn, credential_id, "failed", str(e))
        raise

    except Exception as e:
        logging.error(f"Failed to sync account {cf_account_id}: {e}")
        logging.error(traceback.format_exc())
        errors += 1
        if credential_id:
            update_credential_sync_status(db_conn, credential_id, "failed", str(e))
        raise

    return zones_synced, records_synced, errors


def main():
    parser = argparse.ArgumentParser(description="Sync Cloudflare zones and records (multi-user)")
    parser.add_argument("--cf-config", default=DEFAULT_CF_CONFIG, help="Cloudflare config file")
    parser.add_argument("--mydns-config", default=DEFAULT_MYDNS_CONFIG, help="MyDNS config file")
    parser.add_argument("--verbose", "-v", action="store_true", help="Enable verbose logging")
    parser.add_argument("--skip-global", action="store_true", help="Skip global config file")
    parser.add_argument("--skip-users", action="store_true", help="Skip user credentials from database")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
    )

    total_zones = 0
    total_records = 0
    total_errors = 0

    try:
        # Load database configuration
        logging.info(f"Loading database config from {args.mydns_config}")
        db_config = load_db_config(args.mydns_config)

        # Connect to database
        db_mgr = DatabaseConnectionManager(db_config)
        db_conn = db_mgr.connect()

        # Sync global credentials from config file
        if not args.skip_global and os.path.isfile(args.cf_config):
            logging.info(f"Syncing global credentials from {args.cf_config}")
            try:
                cf_config = load_cloudflare_config(args.cf_config)
                cf_client = CloudflareClient(cf_config)

                for cf_account_id in cf_config.account_ids:
                    logging.info(f"Syncing global account: {cf_account_id}")
                    zones, records, errors = sync_cloudflare_account(
                        db_conn,
                        cf_client,
                        cf_account_id,
                        cf_domain=None,
                        credential_id=None,
                        user_id=None,
                    )
                    total_zones += zones
                    total_records += records
                    total_errors += errors
                    logging.info(
                        f"Global account {cf_account_id}: "
                        f"{zones} zones, {records} records, {errors} errors"
                    )

            except (ConfigError, CloudflareError) as e:
                logging.error(f"Failed to sync global credentials: {e}")
                total_errors += 1

        # Sync user credentials from database
        if not args.skip_users:
            logging.info("Loading user credentials from database")
            user_creds = load_user_credentials(db_conn)
            logging.info(f"Found {len(user_creds)} enabled user credentials")

            for cred in user_creds:
                logging.info(
                    f"Syncing user {cred.user_id} credential {cred.id}: "
                    f"CF account {cred.cf_account_id}"
                )
                try:
                    # Create CloudflareConfig from user credential
                    cf_config = CloudflareConfig(
                        base_url=cred.cf_api_url,
                        email=cred.cf_email,
                        api_key=cred.cf_api_key,
                        api_token=None,
                        account_ids=[cred.cf_account_id],
                    )
                    cf_client = CloudflareClient(cf_config)

                    zones, records, errors = sync_cloudflare_account(
                        db_conn,
                        cf_client,
                        cred.cf_account_id,
                        cf_domain=cred.cf_domain,
                        credential_id=cred.id,
                        user_id=cred.user_id,
                    )
                    total_zones += zones
                    total_records += records
                    total_errors += errors

                    # Update sync status
                    status = "success" if errors == 0 else "partial"
                    update_credential_sync_status(db_conn, cred.id, status, None)

                    logging.info(
                        f"User {cred.user_id} credential {cred.id}: "
                        f"{zones} zones, {records} records, {errors} errors"
                    )

                except Exception as e:
                    logging.error(
                        f"Failed to sync user {cred.user_id} credential {cred.id}: {e}"
                    )
                    logging.error(traceback.format_exc())
                    update_credential_sync_status(db_conn, cred.id, "failed", str(e))
                    total_errors += 1

        # Close database connection
        db_conn.close()

        logging.info(
            f"Sync complete: {total_zones} zones, {total_records} records, {total_errors} errors"
        )

        return 0 if total_errors == 0 else 1

    except Exception as e:
        logging.error(f"Sync failed: {e}")
        logging.error(traceback.format_exc())
        return 1


if __name__ == "__main__":
    sys.exit(main())
