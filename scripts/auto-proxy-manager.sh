#!/bin/bash
# Automated Proxy Management for OmniRoute
# Syncs, validates, and activates USA proxies automatically

set -e

OMNIROUTE_URL="${OMNIROUTE_URL:-http://localhost:3000}"
MIN_QUALITY="${MIN_QUALITY:-60}"
MAX_PROXIES="${MAX_PROXIES:-100}"
LOG_FILE="${LOG_FILE:-/var/log/omniroute-proxy-manager.log}"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

log "🚀 Starting automated proxy management..."

# Step 1: Sync proxies from scraper
log "📥 Syncing proxies from scraper..."
SYNC_RESULT=$(curl -s -X POST "$OMNIROUTE_URL/api/settings/free-proxies/sync" \
    -H "Content-Type: application/json" \
    -d '{"source": "proxyscraper"}')

if echo "$SYNC_RESULT" | grep -q "error"; then
    log "❌ Sync failed: $SYNC_RESULT"
else
    FETCHED=$(echo "$SYNC_RESULT" | grep -o '"fetched":[0-9]*' | cut -d':' -f2)
    ADDED=$(echo "$SYNC_RESULT" | grep -o '"added":[0-9]*' | cut -d':' -f2)
    log "✅ Sync complete: Fetched $FETCHED, Added $ADDED new proxies"
fi

# Step 2: Get stats
log "📊 Checking proxy stats..."
STATS=$(curl -s "$OMNIROUTE_URL/api/settings/free-proxies/stats")
TOTAL=$(echo "$STATS" | grep -o '"total":[0-9]*' | cut -d':' -f2)
IN_POOL=$(echo "$STATS" | grep -o '"inPool":[0-9]*' | cut -d':' -f2)
log "📈 Current stats: $TOTAL total proxies, $IN_POOL in active pool"

# Step 3: Add best proxies to active pool
log "🎯 Adding top quality proxies to active pool..."
BULK_ADD_RESULT=$(curl -s -X POST "$OMNIROUTE_URL/api/settings/free-proxies/bulk-add-to-pool" \
    -H "Content-Type: application/json" \
    -d "{\"source\": \"proxyscraper\", \"limit\": $MAX_PROXIES, \"minQuality\": $MIN_QUALITY}")

if echo "$BULK_ADD_RESULT" | grep -q "error"; then
    log "⚠️  Bulk add had issues: $BULK_ADD_RESULT"
else
    ADDED_TO_POOL=$(echo "$BULK_ADD_RESULT" | grep -o '"added":[0-9]*' | cut -d':' -f2 || echo "0")
    log "✅ Added $ADDED_TO_POOL proxies to active pool"
fi

# Step 4: Final stats
FINAL_STATS=$(curl -s "$OMNIROUTE_URL/api/settings/free-proxies/stats")
FINAL_IN_POOL=$(echo "$FINAL_STATS" | grep -o '"inPool":[0-9]*' | cut -d':' -f2)
log "🎉 Management complete: $FINAL_IN_POOL proxies now in active pool"

log "✨ Done!"
