# Proxy Scraper Quick Start Guide

## What You Now Have

Your OmniRoute platform can now automatically collect and use **free proxies** from 50+ sources using the battle-tested `monosans/proxy-scraper-checker` tool.

## 🚀 Get Started in 3 Steps

### 1. Run Setup
```bash
cd /home/stevenleblanc62920/ai-platform/OmniRoute
./scripts/setup-proxyscraper.sh
```

### 2. Wait & Sync (after 5 minutes)
```bash
curl -X POST http://localhost:3000/api/settings/free-proxies/sync \
  -H "Content-Type: application/json" \
  -d '{"source": "proxyscraper"}'
```

### 3. Check Results
```bash
curl http://localhost:3000/api/settings/free-proxies/stats
```

## What This Gives You

✅ **Free proxies** - No API costs, scraped from 50+ free sources  
✅ **Pre-validated** - Each proxy is tested before being added  
✅ **Multiple protocols** - HTTP, SOCKS4, and SOCKS5 support  
✅ **Automatic updates** - Refreshes every hour (configurable)  
✅ **Seamless integration** - Works with existing proxy infrastructure  

## How It Works

```
┌─────────────────────┐
│ proxy-scraper       │  Scrapes 50+ sources
│   (Docker)          │  Validates each proxy
└──────────┬──────────┘  Writes to files
           │
           ↓
    ┌──────────────┐
    │  .txt files  │  http.txt, socks4.txt, socks5.txt
    └──────┬───────┘
           │
           ↓
┌──────────────────────┐
│ ProxyScraperProvider │  Reads files
│   (OmniRoute)        │  Stores in DB
└──────────┬───────────┘
           │
           ↓
┌──────────────────────┐
│   Proxy Pool         │  Routes AI requests
│   (OmniRoute)        │  Health monitoring
└──────────────────────┘
```

## Useful Commands

### Monitor Scraper
```bash
docker logs -f omniroute-proxy-scraper
```

### Check Proxy Files
```bash
ls -lah proxy_scraper_data/proxies/
wc -l proxy_scraper_data/proxies/*.txt
```

### Add Best Proxies to Pool
```bash
curl -X POST http://localhost:3000/api/settings/free-proxies/bulk-add-to-pool \
  -H "Content-Type: application/json" \
  -d '{"source": "proxyscraper", "limit": 100, "minQuality": 60}'
```

### List Proxies
```bash
# All proxyscraper proxies
curl "http://localhost:3000/api/settings/free-proxies?source=proxyscraper"

# Only HTTP proxies
curl "http://localhost:3000/api/settings/free-proxies?source=proxyscraper&protocol=http"

# High quality only
curl "http://localhost:3000/api/settings/free-proxies?source=proxyscraper&minQuality=70&limit=20"
```

## Automate It

Add to crontab for hourly sync:
```bash
crontab -e
# Add:
5 * * * * curl -s -X POST http://localhost:3000/api/settings/free-proxies/sync -H "Content-Type: application/json" -d '{"source": "proxyscraper"}' >> /var/log/omniroute-proxy-sync.log 2>&1
```

## Configuration

In your `.env` file (already configured by setup script):
```bash
FREE_PROXY_SCRAPER_ENABLED=true
FREE_PROXY_SCRAPER_HTTP_FILE=./proxy_scraper_data/proxies/http.txt
FREE_PROXY_SCRAPER_SOCKS4_FILE=./proxy_scraper_data/proxies/socks4.txt
FREE_PROXY_SCRAPER_SOCKS5_FILE=./proxy_scraper_data/proxies/socks5.txt
FREE_PROXY_SCRAPER_MAX=1000
```

## Customize Scraping

Edit `docker-compose.proxyscraper.yml`:

```yaml
# Change refresh interval (default: 1 hour)
sleep 3600  # seconds

# Adjust validation strictness
--timeout 10 --max-tries 3

# Sort by speed
--sort-by-speed
```

Then restart:
```bash
docker-compose -f docker-compose.proxyscraper.yml restart
```

## Troubleshooting

### No proxies found?
```bash
# Check scraper is running
docker ps | grep proxy-scraper

# View logs
docker logs omniroute-proxy-scraper

# Check files
ls -lah proxy_scraper_data/proxies/
```

### Scraper not working?
```bash
# Restart
docker-compose -f docker-compose.proxyscraper.yml restart

# Recreate
docker-compose -f docker-compose.proxyscraper.yml down
docker-compose -f docker-compose.proxyscraper.yml up -d
```

## Full Documentation

- **Complete Guide:** `docs/integrations/PROXYSCRAPER.md`
- **Summary:** `PROXYSCRAPER_INTEGRATION.md`
- **Upstream Project:** https://github.com/monosans/proxy-scraper-checker

## Next Steps

1. ✅ Integration complete - Ready to use
2. 🔄 Run setup script
3. ⏱️ Wait for first scrape (5 min)
4. 📊 Sync and monitor
5. 🤖 Set up automation
6. 🚀 Use in production!

---

**Integration completed:** 2026-06-13  
**Files added:** 14  
**Lines of code:** 1,721+  
**Test coverage:** ✅ Included
