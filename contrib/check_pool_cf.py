#!/usr/bin/env python3
"""Check what Cloudflare returns for a pool."""

import json
import requests

# Cloudflare credentials
EMAIL = "dan.caescu@multitel.net"
API_KEY = "244cf76c99db38cad66da9cfde2abd20f4703"
ACCOUNT_ID = "cc71a8d4be2610c476f7f1462447fd8f"
POOL_ID = "0ba7a7dc5c347a602510eb3954a735c5"

headers = {
    "X-Auth-Email": EMAIL,
    "X-Auth-Key": API_KEY,
    "Content-Type": "application/json",
}

url = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/load_balancers/pools/{POOL_ID}"
resp = requests.get(url, headers=headers)

if resp.status_code == 200:
    data = resp.json()
    print(json.dumps(data.get("result"), indent=2))
else:
    print(f"Error {resp.status_code}: {resp.text}")
