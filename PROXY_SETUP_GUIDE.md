# Setup Guide: Automated USA Proxy Management

## TL;DR - What You Need

1. **Create API Key** (one-time setup)
2. **Run setup script** 
3. **Proxies auto-sync every 2 hours**

## Step-by-Step Setup

### 1. Create Management API Key

The automation needs an API key with 'manage' scope to sync and activate proxies.

**Create the key:**
```bash
# Open OmniRoute Dashboard
http://localhost:3000/dashboard

# Navigate to: Settings → API Keys → Create New Key
# ✅ Check the 'manage' scope checkbox
# Copy the generated key
```

### 2. Run Setup Script

```bash
cd /home/stevenleblanc62920/ai-platform/OmniRoute
./scripts/setup-auto-proxy-manager.sh
```

The script will:
- Ask for your API key
- Save it to `.env`
- Setup cron job (runs every 2 hours)
- Run initial test sync

### 3. Done!

That's it! From now on:
- ✅ Scraper collects USA proxies hourly
- ✅ Script syncs them every 2 hours
- ✅ Top 100 quality proxies (60+ score) auto-added to pool
- ✅ Globally available in OmniRoute

## What's Happening

```
Every Hour:
  proxy-scraper-checker → Scrapes & validates USA proxies → Writes to files

Every 2 Hours:
  auto-proxy-manager.sh → Reads files → Syncs to DB → Adds top 100 to active pool
```

## Monitoring

```bash
# Watch live logs
tail -f /var/log/omniroute-proxy-manager.log

# Check current proxies
curl "http://localhost:3000/api/settings/free-proxies/stats" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

## Troubleshooting

### "ERROR: OMNIROUTE_API_KEY environment variable not set"

**Solution:** Create the API key in Dashboard and run setup script again.

### "401 Unauthorized" or "403 Forbidden"

**Problem:** API key missing or lacks 'manage' scope

**Solution:**
1. Go to Dashboard → Settings → API Keys
2. Find your key
3. Ensure 'manage' scope is enabled
4. If not, create a new key with 'manage' scope

### Logs show HTML 404 page

**Problem:** OmniRoute endpoints not accessible

**Solution:**
1. Check OmniRoute is running: `curl http://localhost:3000/api/health`
2. Verify PORT in .env matches: `grep ^PORT= .env`
3. Restart OmniRoute if needed

### No proxies being synced

**Check scraper is running:**
```bash
docker ps | grep proxy-scraper
docker logs omniroute-proxy-scraper
```

**Check files exist:**
```bash
ls -lah proxy_scraper_data/proxies/
cat proxy_scraper_data/proxies/http.txt | head -5
```

## Manual Testing

Before setting up automation, test manually:

```bash
# 1. Export API key
export OMNIROUTE_API_KEY="your-key-here"

# 2. Run sync
./scripts/auto-proxy-manager.sh

# 3. Check results
curl "http://localhost:3000/api/settings/free-proxies/stats" \
  -H "Authorization: Bearer $OMNIROUTE_API_KEY"
```

## Configuration

### Change Frequency

```bash
# Edit crontab
crontab -e

# Examples:
# Every hour:     0 * * * *
# Every 30 min:   */30 * * * *
# Every 4 hours:  0 */4 * * *
# Daily at 3 AM:  0 3 * * *
```

### Change Quality/Quantity

Edit `scripts/auto-proxy-manager.sh`:

```bash
MIN_QUALITY=70      # Only high-quality proxies
MAX_PROXIES=200     # Add more to pool
```

Or set environment variables:

```bash
MIN_QUALITY=70 MAX_PROXIES=200 ./scripts/auto-proxy-manager.sh
```

## FAQ

### Q: Are the proxies filtered for USA only?

**A:** Yes! The scraper is configured with `--countries US` flag. Only USA proxies are collected and added.

### Q: Do proxies automatically apply globally?

**A:** Yes, once added to the active pool, they're available to all providers that support proxy usage in OmniRoute.

### Q: How many proxies will I have?

**A:** The scraper collects hundreds of USA proxies. The automation adds the top 100 (by default) to your active pool, refreshing every 2 hours.

### Q: What if a proxy stops working?

**A:** OmniRoute has built-in health checking. Bad proxies are automatically removed or rotated out.

### Q: Can I use this in production?

**A:** Yes! Just ensure:
1. Run scraper on dedicated infrastructure (not same server as OmniRoute)
2. Monitor logs for errors
3. Adjust quality threshold (70+ for production recommended)
4. Consider running scraper more frequently

## Architecture

```
┌─────────────────────────────────────────┐
│  proxy-scraper-checker (Docker)         │
│  • Runs every hour                      │
│  • Scrapes 50+ sources                  │
│  • Filters for USA proxies              │
│  • Validates connectivity               │
└──────────────┬──────────────────────────┘
               │ writes
               ↓
┌─────────────────────────────────────────┐
│  proxy_scraper_data/proxies/*.txt       │
│  • http.txt                             │
│  • socks4.txt                           │
│  • socks5.txt                           │
└──────────────┬──────────────────────────┘
               │ reads
               ↓
┌─────────────────────────────────────────┐
│  auto-proxy-manager.sh (Cron)           │
│  • Runs every 2 hours                   │
│  • Syncs to OmniRoute database          │
│  • Filters by quality (60+)             │
│  • Adds top 100 to active pool          │
│  • Uses API key authentication          │
└──────────────┬──────────────────────────┘
               │ activates
               ↓
┌─────────────────────────────────────────┐
│  Active Proxy Pool (OmniRoute)          │
│  • Globally available                   │
│  • Health monitored                     │
│  • Auto-rotated                         │
│  • USA proxies only                     │
└──────────────┬──────────────────────────┘
               │ used by
               ↓
┌─────────────────────────────────────────┐
│  AI API Requests                        │
│  • Automatic proxy selection            │
│  • Failover on errors                   │
│  • IP masking for providers             │
└─────────────────────────────────────────┘
```

## Summary

✅ **One-time setup** - Create API key, run setup script  
✅ **Fully automated** - No manual intervention needed  
✅ **USA proxies only** - Geographic filtering applied  
✅ **Quality filtered** - Only validated, working proxies  
✅ **Globally available** - Used by all providers automatically  
✅ **Self-healing** - Bad proxies replaced automatically

Just create the API key and run the setup script once. Everything else is automatic!
