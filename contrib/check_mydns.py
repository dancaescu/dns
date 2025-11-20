#!/usr/bin/env python3
"""
NRPE/Icinga check script for MyDNS.

This script verifies that:
  * all configured db-host entries in mydns.conf are reachable via mysqladmin ping
  * the mydns daemon process is running
  * (optionally) the daemon answers a DNS query using dig

Example NRPE command:
  command[check_mydns]=/usr/local/lib/nagios/plugins/check_mydns.py \
      --config /etc/mydns/mydns.conf \
      --query-name multitel.net --query-type SOA --server 127.0.0.1
"""

import argparse
import os
import shlex
import shutil
import subprocess
import sys
from typing import Dict, List, Tuple

EXIT_OK = 0
EXIT_WARNING = 1
EXIT_CRITICAL = 2
EXIT_UNKNOWN = 3


def parse_config(path: str) -> Dict[str, str]:
    data: Dict[str, str] = {}
    try:
        with open(path, "r", encoding="utf-8") as fh:
            for raw_line in fh:
                line = raw_line.strip()
                if not line or line.startswith("#"):
                    continue
                if "#" in line:
                    line = line.split("#", 1)[0].strip()
                if "=" not in line:
                    continue
                key, value = line.split("=", 1)
                data[key.strip()] = value.strip()
    except FileNotFoundError as exc:
        raise SystemExit(f"UNKNOWN - Cannot open config {path}: {exc}")
    return data


def mysqladmin_ping(host: str, user: str, password: str, timeout: int = 5) -> Tuple[bool, str]:
    mysqladmin = shutil.which("mysqladmin")
    if not mysqladmin:
        return False, "mysqladmin command not found"

    cmd: List[str] = [
        mysqladmin,
        f"--connect-timeout={timeout}",
        "--silent",
        "--host",
        host,
        "--user",
        user,
        "ping",
    ]
    if password:
        cmd.insert(-1, f"--password={password}")

    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if proc.returncode == 0:
        return True, proc.stdout.strip() or "mysqld is alive"
    return False, proc.stderr.strip() or proc.stdout.strip() or "mysqladmin ping failed"


def check_mydns_process() -> Tuple[bool, str]:
    pgrep = shutil.which("pgrep")
    if not pgrep:
        return False, "pgrep command not found"
    proc = subprocess.run([pgrep, "-x", "mydns"], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if proc.returncode == 0:
        return True, "mydns process running"
    return False, "mydns process not found"


def dig_query(server: str, name: str, qtype: str, timeout: int = 3) -> Tuple[bool, str]:
    dig = shutil.which("dig")
    if not dig:
        return False, "dig command not found"
    cmd = [
        dig,
        f"@{server}",
        name,
        qtype,
        "+time={}".format(timeout),
        "+tries=1",
        "+noall",
        "+answer",
    ]
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if proc.returncode != 0:
        return False, proc.stderr.strip() or "dig command failed"
    if "connection timed out" in proc.stdout.lower():
        return False, "dig timed out"
    return True, proc.stdout.strip() or "dig returned empty answer"


def main() -> None:
    parser = argparse.ArgumentParser(description="Monitor MyDNS daemon and database connectivity.")
    parser.add_argument("--config", default="/etc/mydns/mydns.conf", help="Path to mydns.conf")
    parser.add_argument("--query-name", help="Hostname to query (optional)")
    parser.add_argument("--query-type", default="SOA", help="DNS record type to query")
    parser.add_argument("--server", default="127.0.0.1", help="DNS server address for the query")
    args = parser.parse_args()

    cfg = parse_config(args.config)

    db_user = cfg.get("db-user") or cfg.get("mysql-user") or "root"
    db_password = (
        cfg.get("db-password")
        or cfg.get("mysql-password")
        or cfg.get("mysql-pass")
        or ""
    )
    db_hosts = [
        cfg.get("db-host", "localhost"),
        cfg.get("db-host2", ""),
        cfg.get("db-host3", ""),
        cfg.get("db-host4", ""),
    ]
    db_hosts = [h for h in db_hosts if h]

    status = EXIT_OK
    messages: List[str] = []

    db_failures: List[str] = []
    if not db_hosts:
        messages.append("No db-host entries found")
        status = max(status, EXIT_WARNING)
    else:
        for host in db_hosts:
            ok, msg = mysqladmin_ping(host, db_user, db_password)
            if ok:
                messages.append(f"DB {host}: OK")
            else:
                messages.append(f"DB {host}: {msg}")
                db_failures.append(host)
        if db_failures:
            status = max(status, EXIT_CRITICAL)

    proc_ok, proc_msg = check_mydns_process()
    if proc_ok:
        messages.append("Process: OK")
    else:
        messages.append(f"Process: {proc_msg}")
        status = max(status, EXIT_CRITICAL)

    if args.query_name:
        query_ok, query_msg = dig_query(args.server, args.query_name, args.query_type)
        if query_ok:
            messages.append("Query: OK")
        else:
            messages.append(f"Query: {query_msg}")
            status = max(status, EXIT_CRITICAL)
    else:
        messages.append("Query: skipped (no --query-name)")

    codes = {
        EXIT_OK: "OK",
        EXIT_WARNING: "WARNING",
        EXIT_CRITICAL: "CRITICAL",
        EXIT_UNKNOWN: "UNKNOWN",
    }
    print(f"{codes.get(status, 'UNKNOWN')} - " + " | ".join(messages))
    sys.exit(status)


if __name__ == "__main__":
    main()
