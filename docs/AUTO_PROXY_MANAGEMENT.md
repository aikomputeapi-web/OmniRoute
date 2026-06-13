# Automated Proxy Management

## Overview

The automated proxy management system continuously:
1. ✅ Syncs new proxies from the scraper
2. ✅ Validates proxy quality
3. ✅ Adds best proxies to active pool
4. ✅ Makes them available globally in OmniRoute

## Quick Setup

```bash
# Setup automation (runs every 2 hours)
./scripts/setup-auto-proxy-manager.sh

# That's it! Proxies will now be managed automatically
```

## What Gets Automated

### Before Automation
```
Manual Process:
1. Wait for scraper to collect proxies
2. Manually sync: curl -X POST .../sync
3. Manually check quality
4. Manually add to pool: curl -X POST .../add-to-pool
5. Repeat every few hours
```

### After Automation
```
Automatic Process (Every 2 Hours):
1. ✅ Auto-sync from scraper
2. ✅ Auto-filter by quality (60+ score)
3. ✅ Auto-add top 100 to active pool
4. ✅ Proxies immediately available globally
5. ✅ Logs everything for monitoring
```

## How It Works

### Step 1: Scraper Collects Proxies
```
proxy-scraper-checker (Docker)
  ↓
Validates USA proxies
  ↓
Writes to files (every hour)
```

### Step 2: Auto-Manager Activates Them
```
auto-proxy-manager.sh (Cron - every 2 hours)
  ↓
1. Syncs from files to database
2. Filters by quality (60+)
3. Adds top 100 to active pool
  ↓
Active proxy pool (globally available)
```

### Step 3: OmniRoute Uses Them
```
AI API Request
  ↓
OmniRoute checks if provider needs proxy
  ↓
Selects working proxy from active pool
  ↓
Routes request through proxy
```

## Configuration

### Change Frequency

Edit crontab:
```bash
crontab -e
```

Examples:
```bash
# Every hour
0 * * * * /path/to/auto-proxy-manager.sh

# Every 30 minutes
*/30 * * * * /path/to/auto-proxy-manager.sh

# Every 4 hours
0 */4 * * * /path/to/auto-proxy-manager.sh

# Daily at 3 AM
0 3 * * * /path/to/auto-proxy-manager.sh
```

### Change Quality Threshold

Edit `scripts/auto-proxy-manager.sh`:
```bash
# Only add high-quality proxies
MIN_QUALITY=80

# More lenient
MIN_QUALITY=50
```

### Change Pool Size

Edit `scripts/auto-proxy-manager.sh`:
```bash
# Add more proxies to pool
MAX_PROXIES=200

# Keep it small
MAX_PROXIES=50
```

### Environment Variables

You can also set these when running:
```bash
MIN_QUALITY=70 MAX_PROXIES=150 ./scripts/auto-proxy-manager.sh
```

## Monitoring

### View Logs
```bash
# Follow live
tail -f /var/log/omniroute-proxy-manager.log

# View recent
tail -100 /var/log/omniroute-proxy-manager.log

# Search for errors
grep "ERROR\|Failed" /var/log/omniroute-proxy-manager.log
```

### Check Current Status
```bash
# How many proxies in pool?
curl http://localhost:3000/api/settings/free-proxies/stats

# List active proxies
curl "http://localhost:3000/api/settings/free-proxies?onlyInPool=true"
```

### Test Proxy Usage
```bash
# Check if proxies are being used
curl http://localhost:3000/api/usage/proxy-logs
```

## Manual Control

### Run Automation Manually
```bash
./scripts/auto-proxy-manager.sh
```

### Sync Without Adding to Pool
```bash
curl -X POST http://localhost:3000/api/settings/free-proxies/sync \
  -H "Content-Type: application/json" \
  -d '{"source": "proxyscraper"}'
```

### Add Specific Proxy to Pool
```bash
# Get proxy ID from list
curl "http://localhost:3000/api/settings/free-proxies?source=proxyscraper&limit=1"

# Add it
curl -X POST "http://localhost:3000/api/settings/free-proxies/{PROXY_ID}/add-to-pool"
```

### Remove Proxy from Pool
```bash
# List active proxies
curl "http://localhost:3000/api/settings/proxies?source=proxyscraper"

# Delete by ID
curl -X DELETE "http://localhost:3000/api/settings/proxies/{PROXY_ID}"
```

## Troubleshooting

### No Proxies Added to Pool

**Check scraper is running:**
```bash
docker ps | grep proxy-scraper
docker logs omniroute-proxy-scraper
```

**Check files exist:**
```bash
ls -lah proxy_scraper_data/proxies/
```

**Check quality threshold:**
```bash
# Lower the minimum quality
MIN_QUALITY=40 ./scripts/auto-proxy-manager.sh
```

### Proxies Not Being Used

**Enable proxy usage in OmniRoute settings:**
Check your `.env` or settings to ensure proxy usage is enabled for providers.

**Check proxy health:**
```bash
curl http://localhost:3000/api/settings/proxies/health
```

### Cron Job Not Running

**Check if cron job exists:**
```bash
crontab -l | grep proxy
```

**Check cron logs:**
```bash
# Ubuntu/Debian
grep CRON /var/log/syslog | grep proxy

# Or check script log
cat /var/log/omniroute-proxy-manager.log
```

**Test manually first:**
```bash
./scripts/auto-proxy-manager.sh
```

## Global Proxy Usage

Once proxies are in the active pool, OmniRoute can use them globally for:

### 1. Provider Requests
Enable proxy for specific providers in OmniRoute settings:
- OpenRouter
- Anthropic
- OpenAI
- etc.

### 2. Rate Limit Bypass
Rotate through proxies to avoid rate limits

### 3. Geographic Restrictions
Use USA proxies to access US-only services

### 4. Privacy
Mask OmniRoute's origin IP

## Best Practices

1. **Start Conservative**
   - Begin with quality threshold of 60+
   - Pool size of 50-100 proxies
   - Run every 2-4 hours

2. **Monitor Performance**
   - Watch logs for failures
   - Track proxy success rates
   - Adjust quality threshold based on results

3. **Balance Fresh vs Stable**
   - Too frequent: Unstable pool, many bad proxies
   - Too infrequent: Stale proxies, missing new ones
   - Sweet spot: Every 2-3 hours

4. **Scale Appropriately**
   - Light usage: 50 proxies, update every 4 hours
   - Medium usage: 100 proxies, update every 2 hours
   - Heavy usage: 200 proxies, update hourly

## Architecture

```
┌─────────────────────────────────────────┐
│  proxy-scraper-checker (Docker)         │
│  • Runs every hour                      │
│  • Collects USA proxies                 │
│  • Validates connectivity               │
└─────────────┬───────────────────────────┘
              │ writes
              ↓
┌─────────────────────────────────────────┐
│  proxy_scraper_data/proxies/*.txt       │
└─────────────┬───────────────────────────┘
              │ reads
              ↓
┌─────────────────────────────────────────┐
│  auto-proxy-manager.sh (Cron)           │
│  • Runs every 2 hours                   │
│  • Syncs to database                    │
│  • Filters by quality                   │
│  • Adds top N to active pool            │
└─────────────┬───────────────────────────┘
              │ activates
              ↓
┌─────────────────────────────────────────┐
│  Active Proxy Pool (OmniRoute)          │
│  • Globally available                   │
│  • Health monitored                     │
│  • Auto-rotated                         │
└─────────────┬───────────────────────────┘
              │ used by
              ↓
┌─────────────────────────────────────────┐
│  AI API Requests                        │
│  • Automatic proxy selection            │
│  • Failover on errors                   │
│  • Performance tracking                 │
└─────────────────────────────────────────┘
```

## Summary

After running setup:

✅ **Fully Automated** - No manual intervention needed  
✅ **Global Availability** - Proxies available to all providers  
✅ **Quality Filtered** - Only good proxies added  
✅ **USA Only** - Geographic restriction applied  
✅ **Self-Healing** - Bad proxies replaced automatically  
✅ **Monitored** - Full logging for troubleshooting  

Just run the setup script once and forget about it!
