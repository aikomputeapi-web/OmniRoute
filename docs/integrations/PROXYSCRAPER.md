# proxy-scraper-checker Integration for OmniRoute

Integration of [monosans/proxy-scraper-checker](https://github.com/monosans/proxy-scraper-checker) - a powerful proxy scraper and validator that collects free proxies from multiple sources and validates them.

## Overview

**proxy-scraper-checker** automatically:
- 🔍 Scrapes proxies from 50+ free proxy sources
- ✅ Validates each proxy for connectivity and anonymity
- 📝 Outputs working proxies to text files (http.txt, socks4.txt, socks5.txt)
- 🔄 Runs continuously to keep proxy lists fresh

OmniRoute reads these validated proxy files and integrates them into its proxy pool.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Docker Container                         │
│  ┌────────────────────────────────────────────────────┐    │
│  │     monosans/proxy-scraper-checker                 │    │
│  │  • Scrapes 50+ proxy sources                        │    │
│  │  • Validates each proxy                             │    │
│  │  • Outputs to files every hour                      │    │
│  └────────────────────────────────────────────────────┘    │
│                           ↓                                 │
│                   writes to volume                          │
└─────────────────────────────────────────────────────────────┘
                            ↓
                  proxy_scraper_data/proxies/
                     • http.txt
                     • socks4.txt
                     • socks5.txt
                            ↓
┌─────────────────────────────────────────────────────────────┐
│                      OmniRoute                              │
│  ┌────────────────────────────────────────────────────┐    │
│  │        ProxyScraperProvider                         │    │
│  │  • Reads proxy files                                │    │
│  │  • Parses and validates                             │    │
│  │  • Stores in free_proxies table                     │    │
│  └────────────────────────────────────────────────────┘    │
│                           ↓                                 │
│  ┌────────────────────────────────────────────────────┐    │
│  │        OmniRoute Proxy Pool                         │    │
│  │  • Health monitoring                                │    │
│  │  • Intelligent rotation                             │    │
│  │  • Usage tracking                                   │    │
│  └────────────────────────────────────────────────────┘    │
│                           ↓                                 │
│                   AI API Requests                           │
└─────────────────────────────────────────────────────────────┘
```

## Quick Start

### 1. Run Setup Script

```bash
cd /home/stevenleblanc62920/ai-platform/OmniRoute
./scripts/setup-proxyscraper.sh
```

This will:
- Create necessary directories
- Configure environment variables
- Start the proxy-scraper-checker Docker container

### 2. Wait for First Scrape

The scraper needs ~5 minutes to complete its first scrape and validation cycle:

```bash
# Monitor the scraper
docker logs -f omniroute-proxy-scraper
```

### 3. Sync Proxies to OmniRoute

```bash
curl -X POST http://localhost:3000/api/settings/free-proxies/sync \
  -H "Content-Type: application/json" \
  -d '{"source": "proxyscraper"}'
```

### 4. Verify Integration

```bash
# Check overall stats
curl http://localhost:3000/api/settings/free-proxies/stats

# List proxyscraper proxies
curl "http://localhost:3000/api/settings/free-proxies?source=proxyscraper&limit=10"
```

## Configuration

Add these to your `.env` file:

```bash
# Enable the proxy scraper provider
FREE_PROXY_SCRAPER_ENABLED=true

# Proxy file paths (relative to OmniRoute root)
FREE_PROXY_SCRAPER_HTTP_FILE=./proxy_scraper_data/proxies/http.txt
FREE_PROXY_SCRAPER_SOCKS4_FILE=./proxy_scraper_data/proxies/socks4.txt
FREE_PROXY_SCRAPER_SOCKS5_FILE=./proxy_scraper_data/proxies/socks5.txt

# Maximum proxies to import per sync
FREE_PROXY_SCRAPER_MAX=1000
```

## Manual Setup

If you prefer manual setup instead of the script:

### 1. Create Directories

```bash
mkdir -p proxy_scraper_data/proxies
mkdir -p proxy_scraper_config
```

### 2. Start Docker Container

```bash
docker-compose -f docker-compose.proxyscraper.yml up -d
```

### 3. Add Environment Variables

Add the configuration above to your `.env` file.

### 4. Restart OmniRoute

```bash
npm run dev
# or
npm run start
```

## Usage

### Sync Proxies

```bash
# Sync from proxy scraper
curl -X POST http://localhost:3000/api/settings/free-proxies/sync \
  -H "Content-Type: application/json" \
  -d '{"source": "proxyscraper"}'
```

### View Statistics

```bash
curl http://localhost:3000/api/settings/free-proxies/stats
```

Response:
```json
{
  "total": 1523,
  "inPool": 45,
  "avgQuality": 58,
  "bySource": [
    {"source": "proxyscraper", "count": 842},
    {"source": "proxypool", "count": 681}
  ],
  "lastSyncAt": "2026-06-13T10:30:00.000Z"
}
```

### List Proxies

```bash
# All proxyscraper proxies
curl "http://localhost:3000/api/settings/free-proxies?source=proxyscraper"

# Filter by protocol
curl "http://localhost:3000/api/settings/free-proxies?source=proxyscraper&protocol=http"

# High quality only
curl "http://localhost:3000/api/settings/free-proxies?source=proxyscraper&minQuality=70"
```

### Add to Pool

```bash
# Add specific proxy
curl -X POST "http://localhost:3000/api/settings/free-proxies/{proxy-id}/add-to-pool"

# Bulk add top proxies
curl -X POST http://localhost:3000/api/settings/free-proxies/bulk-add-to-pool \
  -H "Content-Type: application/json" \
  -d '{"source": "proxyscraper", "limit": 50, "minQuality": 60}'
```

## Automation

### Automatic Sync with Cron

Add to your crontab for hourly syncs:

```bash
# Edit crontab
crontab -e

# Add this line (sync every hour at :05)
5 * * * * curl -X POST http://localhost:3000/api/settings/free-proxies/sync -H "Content-Type: application/json" -d '{"source": "proxyscraper"}' >> /var/log/omniroute-proxy-sync.log 2>&1
```

### Automatic Pool Management

Create a script (see `scripts/auto-proxy-manager.sh`):

```bash
#!/bin/bash
# Auto-refresh proxy pool

# Sync from scraper
curl -s -X POST http://localhost:3000/api/settings/free-proxies/sync \
  -H "Content-Type: application/json" \
  -d '{"source": "proxyscraper"}'

# Add top 100 to pool
curl -s -X POST http://localhost:3000/api/settings/free-proxies/bulk-add-to-pool \
  -H "Content-Type: application/json" \
  -d '{"source": "proxyscraper", "limit": 100, "minQuality": 60}'

echo "Proxy pool refreshed at $(date)"
```

## Monitoring

### Check Scraper Status

```bash
# View logs
docker logs omniroute-proxy-scraper

# Follow logs
docker logs -f omniroute-proxy-scraper

# Check if files are being updated
ls -lah proxy_scraper_data/proxies/
```

### Check Proxy Count

```bash
# Count proxies in files
wc -l proxy_scraper_data/proxies/*.txt

# Check OmniRoute stats
curl http://localhost:3000/api/settings/free-proxies/stats
```

### Health Monitoring

```bash
# Test specific proxy source
curl http://localhost:3000/api/settings/proxies/health \
  -H "Content-Type: application/json" \
  -d '{"source": "proxyscraper"}'
```

## Customization

### Adjust Scraping Frequency

Edit `docker-compose.proxyscraper.yml` and change `sleep 3600` to desired interval:

```yaml
# Every 30 minutes
sleep 1800

# Every 2 hours
sleep 7200

# Every 6 hours
sleep 21600
```

### Configure Scraper Options

Modify the command in `docker-compose.proxyscraper.yml`:

```yaml
command: >
  bash -c "
  pip install --no-cache-dir proxy-scraper-checker &&
  mkdir -p /app/data/proxies &&
  cd /app/data &&
  while true; do
    echo '[$(date)] Starting proxy scrape...' &&
    proxy-scraper-checker \
      --http \
      --socks4 \
      --socks5 \
      --timeout 10 \
      --max-tries 3 \
      --sort-by-speed &&
    echo '[$(date)] Complete. Sleeping...' &&
    sleep 3600
  done
  "
```

Available options:
- `--timeout N` - Connection timeout (default: 10s)
- `--max-tries N` - Validation attempts (default: 3)
- `--sort-by-speed` - Sort by response time
- `--min-anonymity-level LEVEL` - Filter by anonymity (transparent/anonymous/elite)

### Quality Scoring

Adjust default quality score in `src/lib/freeProxyProviders/proxyscraper.ts`:

```typescript
qualityScore: 70, // Increase since these are validated
```

## Troubleshooting

### No Proxies Found

```bash
# Check if scraper is running
docker ps | grep proxy-scraper

# Check scraper logs
docker logs omniroute-proxy-scraper

# Verify files exist
ls -lah proxy_scraper_data/proxies/
```

### Sync Errors

```bash
# Enable debug logging in OmniRoute
DEBUG=proxy:* npm run dev

# Check file permissions
ls -l proxy_scraper_data/proxies/

# Manually verify file format
head proxy_scraper_data/proxies/http.txt
```

### Low Quality Proxies

1. Increase validation strictness in scraper config
2. Increase `minQuality` filter when adding to pool
3. Enable automatic health checks in OmniRoute

## Comparison with Other Providers

| Feature | ProxyScraper | ProxyPool | 1Proxy | Proxifly |
|---------|-------------|-----------|--------|----------|
| **Sources** | 50+ | Custom | API | API |
| **Validation** | ✅ Built-in | ✅ Built-in | ❌ None | ❌ None |
| **Cost** | Free | Free | Paid API | Free API |
| **Types** | HTTP, SOCKS4/5 | HTTP | HTTP | HTTP |
| **Update Freq** | Configurable | Real-time | On-demand | On-demand |
| **Quality** | High (validated) | High | Medium | Low |

## Production Recommendations

1. **Run on Separate Server** - Proxy scraping is resource-intensive
2. **Mount Persistent Volume** - Don't lose proxy lists on restart
3. **Monitor Disk Usage** - Log files can grow large
4. **Rate Limit Sync** - Don't sync too frequently (hourly is good)
5. **Set Quality Thresholds** - Only use high-quality proxies in production
6. **Enable Health Checks** - Let OmniRoute validate proxies before use
7. **Backup Strategy** - Keep proxy lists backed up

## Benefits

✅ **Free proxies** - No API costs  
✅ **Pre-validated** - Scraper tests connectivity  
✅ **Multiple sources** - 50+ proxy sources  
✅ **Multiple protocols** - HTTP, SOCKS4, SOCKS5  
✅ **Self-hosted** - Full control over proxy validation  
✅ **Continuous updates** - Fresh proxies every hour  
✅ **Simple integration** - File-based, no API dependencies  
✅ **Battle-tested** - monosans/proxy-scraper-checker is widely used

## Files Created

- `src/lib/freeProxyProviders/proxyscraper.ts` - Provider implementation
- `docker-compose.proxyscraper.yml` - Docker service configuration
- `scripts/setup-proxyscraper.sh` - Automated setup script
- `docs/integrations/PROXYSCRAPER.md` - This documentation

## Files Modified

- `src/lib/freeProxyProviders/types.ts` - Added "proxyscraper" source type
- `src/lib/freeProxyProviders/index.ts` - Registered provider

## References

- [monosans/proxy-scraper-checker](https://github.com/monosans/proxy-scraper-checker)
- [OmniRoute Proxy Guide](../ops/PROXY_GUIDE.md)

## Support

For issues specific to:
- **OmniRoute integration** - Open issue in OmniRoute repo
- **proxy-scraper-checker** - See [upstream repo](https://github.com/monosans/proxy-scraper-checker)
