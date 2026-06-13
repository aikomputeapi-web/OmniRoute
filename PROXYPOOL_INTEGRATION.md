# proxy_pool Integration for OmniRoute

✅ **Integration Complete** - proxy_pool can now feed working proxies to OmniRoute!

## What Was Added

1. **ProxyPoolProvider** - New free proxy provider at `src/lib/freeProxyProviders/proxypool.ts`
2. **Docker Compose** - Service configuration at `docker-compose.proxypool.yml`
3. **Documentation** - Complete guide at `docs/integrations/PROXYPOOL.md`
4. **Setup Script** - Automated setup at `scripts/setup-proxypool.sh`

## Quick Start

```bash
# Run the setup script
./scripts/setup-proxypool.sh

# Or manually:
# 1. Start proxy_pool
docker-compose -f docker-compose.proxypool.yml up -d

# 2. Add to .env
echo "FREE_PROXY_PROXYPOOL_ENABLED=true" >> .env

# 3. Restart OmniRoute
npm run dev

# 4. Sync proxies
curl -X POST http://localhost:3000/api/settings/free-proxies/sync \
  -H "Content-Type: application/json" \
  -d '{"source": "proxypool"}'
```

## How It Works

```
proxy_pool (Python) → ProxyPoolProvider → OmniRoute Proxy Pool → AI API Requests
```

- **proxy_pool** crawls and validates free proxies from multiple sources
- **ProxyPoolProvider** fetches validated proxies via HTTP API
- **OmniRoute** manages health checks, rotation, and usage

## Configuration

Environment variables:

```bash
FREE_PROXY_PROXYPOOL_ENABLED=true              # Enable the provider
FREE_PROXY_PROXYPOOL_API_URL=http://localhost:5010  # API endpoint
FREE_PROXY_PROXYPOOL_MAX=500                   # Max proxies to sync
```

## API Endpoints

proxy_pool provides:
- `GET /get_all/` - Fetch all proxies (used by OmniRoute)
- `GET /get_status/` - Pool statistics
- `GET /` - Get one random proxy

## Testing

```bash
# Check proxy_pool status
curl http://localhost:5010/get_status/

# Check OmniRoute stats
curl http://localhost:3000/api/settings/free-proxies/stats

# Test proxy health
curl http://localhost:3000/api/settings/proxies/health \
  -H "Content-Type: application/json" \
  -d '{"source": "proxypool"}'
```

## Architecture Notes

- **Separate Services**: proxy_pool runs independently (Python/Flask)
- **HTTP Integration**: OmniRoute calls proxy_pool's REST API
- **Existing Infrastructure**: Uses OmniRoute's free proxy system
- **No Code Duplication**: Leverages proxy health checks, rotation, DB storage

## Benefits

✅ Free proxy source  
✅ Automatic validation by proxy_pool  
✅ Seamless integration with OmniRoute  
✅ Can run multiple proxy_pool instances  
✅ No changes to existing proxy logic

## Files Modified

- `src/lib/freeProxyProviders/types.ts` - Added "proxypool" to FreeProxySourceId
- `src/lib/freeProxyProviders/index.ts` - Registered ProxyPoolProvider
- `src/lib/freeProxyProviders/proxypool.ts` - New provider implementation

## Files Created

- `docker-compose.proxypool.yml` - Docker setup
- `docs/integrations/PROXYPOOL.md` - Full documentation
- `scripts/setup-proxypool.sh` - Setup automation
- `PROXYPOOL_INTEGRATION.md` - This file

## Next Steps

1. Run setup script: `./scripts/setup-proxypool.sh`
2. Test the integration
3. Set up automatic syncing (cron/scheduler)
4. Monitor proxy quality and adjust filters
5. Consider running proxy_pool on dedicated infrastructure for production

## References

- [proxy_pool GitHub](https://github.com/jhao104/proxy_pool)
- [Full Documentation](./docs/integrations/PROXYPOOL.md)
- [OmniRoute Proxy Guide](./docs/ops/PROXY_GUIDE.md)
