#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# filter-usa-proxies.sh — Post-scrape USA-only proxy filter
# ─────────────────────────────────────────────────────────────────────────────
# Reads the JSON output from monosans/proxy-scraper-checker and generates
# USA-only plain text proxy files for OmniRoute's fallback TXT mode.
#
# The primary integration now uses the JSON file directly (with geolocation
# filtering in ProxyScraperProvider), but this script maintains the filtered
# TXT files as a backup and for quick stats.
#
# Usage: ./filter-usa-proxies.sh [JSON_FILE] [OUTPUT_DIR] [COUNTRY_CODE]
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

JSON_FILE="${1:-./proxy_scraper_data/out/proxies.json}"
OUTPUT_DIR="${2:-./proxy_scraper_data/out}"
COUNTRY="${3:-US}"

if [ ! -f "$JSON_FILE" ]; then
    echo "[$(date)] ERROR: JSON file not found: $JSON_FILE"
    exit 1
fi

# Check if python3 is available; fall back to python
PYTHON=$(command -v python3 2>/dev/null || command -v python 2>/dev/null || echo "")
if [ -z "$PYTHON" ]; then
    echo "[$(date)] ERROR: python3/python not found"
    exit 1
fi

echo "[$(date)] Filtering proxies by country=$COUNTRY from $JSON_FILE..."

$PYTHON -c "
import json, sys, os

json_file = sys.argv[1]
output_dir = sys.argv[2]
country = sys.argv[3]

with open(json_file, 'r') as f:
    data = json.load(f)

total = len(data)
filtered = {'http': [], 'socks4': [], 'socks5': []}

for proxy in data:
    geo = proxy.get('geolocation', {})
    iso = geo.get('country', {}).get('iso_code', '')
    if iso != country:
        continue
    protocol = proxy.get('protocol', 'http').lower()
    host = proxy.get('host', '')
    port = proxy.get('port', 0)
    if not host or not port:
        continue
    key = 'socks4' if protocol == 'socks4' else 'socks5' if protocol == 'socks5' else 'http'
    filtered[key].append(f'{host}:{port}')

os.makedirs(output_dir, exist_ok=True)

for proto, proxies in filtered.items():
    out_path = os.path.join(output_dir, f'{proto}.txt')
    with open(out_path, 'w') as f:
        f.write('\n'.join(proxies) + '\n' if proxies else '')
    print(f'  {proto}: {len(proxies)} proxies -> {out_path}')

matched = sum(len(v) for v in filtered.values())
print(f'  Total: {matched}/{total} proxies matched {country}')
" "$JSON_FILE" "$OUTPUT_DIR" "$COUNTRY"

echo "[$(date)] USA proxy filter complete."
