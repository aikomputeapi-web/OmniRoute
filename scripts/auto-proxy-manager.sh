#!/bin/bash
# Automated Proxy Management for OmniRoute
# Syncs, validates, and activates USA proxies automatically

set -e

OMNIROUTE_URL="${OMNIROUTE_URL:-http://localhost:3000}"
MIN_QUALITY="${MIN_QUALITY:-60}"
MAX_PROXIES="${MAX_PROXIES:-100}"
LOG_FILE="${LOG_FILE:-/var/log/omniroute-proxy-manager.log}"

# Get API key from environment or fail
if [ -z "$OMNIROUTE_API_KEY" ]; then
    echo "ERROR: OMNIROUTE_API_KEY environment variable not set"
    echo "Please create an API key with 'manage' scope in OmniRoute Dashboard:"
    echo "  1. Go to $OMNIROUTE_URL/dashboard"
    echo "  2. Settings → API Keys → Create New Key"
    echo "  3. Enable 'manage' scope"
    echo "  4. Export OMNIROUTE_API_KEY=<your-key>"
    echo "  5. Or add to .env: OMNIROUTE_API_KEY=<your-key>"
    exit 1
fi

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

log "🚀 Starting automated proxy management..."

# Step 1: Sync proxies from scraper
log "📥 Syncing proxies from scraper..."
SYNC_RESULT=$(curl -s -X POST "$OMNIROUTE_URL/api/settings/free-proxies/sync" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $OMNIROUTE_API_KEY" \
    -d '{"source": "proxyscraper"}')

if echo "$SYNC_RESULT" | grep -q '"success":true'; then
    FETCHED=$(echo "$SYNC_RESULT" | grep -o '"fetched":[0-9]*' | cut -d':' -f2 || echo "0")
    ADDED=$(echo "$SYNC_RESULT" | grep -o '"added":[0-9]*' | cut -d':' -f2 || echo "0")
    log "✅ Sync complete: Fetched $FETCHED, Added $ADDED new proxies"
else
    log "❌ Sync failed: $SYNC_RESULT"
    # Continue anyway to add existing proxies
fi

# Step 2: Get stats
log "📊 Checking proxy stats..."
STATS=$(curl -s "$OMNIROUTE_URL/api/settings/free-proxies/stats" \
    -H "Authorization: Bearer $OMNIROUTE_API_KEY")

if echo "$STATS" | grep -q '"total"'; then
    TOTAL=$(echo "$STATS" | grep -o '"total":[0-9]*' | cut -d':' -f2 || echo "0")
    IN_POOL=$(echo "$STATS" | grep -o '"inPool":[0-9]*' | cut -d':' -f2 || echo "0")
    log "📈 Current stats: $TOTAL total proxies, $IN_POOL in active pool"
else
    log "⚠️  Could not fetch stats: $STATS"
fi

# Step 3: Add best proxies to active pool
log "🎯 Adding top quality proxies to active pool..."
BULK_ADD_RESULT=$(curl -s -X POST "$OMNIROUTE_URL/api/settings/free-proxies/bulk-add-to-pool" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $OMNIROUTE_API_KEY" \
    -d "{\"source\": \"proxyscraper\", \"limit\": $MAX_PROXIES, \"minQuality\": $MIN_QUALITY}")

if echo "$BULK_ADD_RESULT" | grep -q '"success":true\|"added"'; then
    ADDED_TO_POOL=$(echo "$BULK_ADD_RESULT" | grep -o '"added":[0-9]*' | cut -d':' -f2 || echo "0")
    log "✅ Added $ADDED_TO_POOL proxies to active pool"
else
    log "⚠️  Bulk add had issues: $BULK_ADD_RESULT"
fi

# Step 4: Final stats
FINAL_STATS=$(curl -s "$OMNIROUTE_URL/api/settings/free-proxies/stats" \
    -H "Authorization: Bearer $OMNIROUTE_API_KEY")

if echo "$FINAL_STATS" | grep -q '"inPool"'; then
    FINAL_IN_POOL=$(echo "$FINAL_STATS" | grep -o '"inPool":[0-9]*' | cut -d':' -f2 || echo "0")
    log "🎉 Management complete: $FINAL_IN_POOL proxies now in active pool"
fi

log "✨ Done!"
