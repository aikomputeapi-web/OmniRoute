# ProxyPool Integration Guide

This guide explains how to integrate [proxy_pool](https://github.com/jhao104/proxy_pool) with OmniRoute to automatically fetch and use working proxies.

## Overview

proxy_pool is a Python-based proxy pool system that:
- Automatically crawls free proxies from multiple sources
- Validates proxies and maintains an up-to-date pool
- Provides a simple HTTP API to fetch working proxies

OmniRoute integrates with proxy_pool as a **free proxy provider**, treating it like other sources (1proxy, proxifly, etc.).

## Architecture

```
┌─────────────┐         ┌──────────────┐         ┌────────────┐
│ proxy_pool  │ HTTP    │  OmniRoute   │  Uses   │   AI API   │
│  (Python)   │────────>│  ProxyPool   │────────>│  Requests  │
│             │  API    │   Provider   │         │            │
└─────────────┘         └──────────────┘         └────────────┘
```

## Setup

### 1. Start proxy_pool Service

Using Docker Compose:

```bash
cd /home/stevenleblanc62920/ai-platform/OmniRoute
docker-compose -f docker-compose.proxypool.yml up -d
```

Or manually with Docker:

```bash
docker run -d \
  --name proxy_pool \
  -p 5010:5010 \
  -e DB_CONN=redis://redis:6379/0 \
  jhao104/proxy_pool:latest
```

### 2. Configure OmniRoute

Add to your `.env` file:

```bash
# Enable ProxyPool Provider
FREE_PROXY_PROXYPOOL_ENABLED=true

# ProxyPool API URL (default: http://localhost:5010)
FREE_PROXY_PROXYPOOL_API_URL=http://localhost:5010

# Max proxies to fetch from ProxyPool (default: 500)
FREE_PROXY_PROXYPOOL_MAX=500
```

### 3. Sync Proxies

After starting proxy_pool and configuring OmniRoute, sync proxies using:

**Via UI:**
- Navigate to Dashboard → Settings → Proxy
- Find "Free Proxy Pool" tab
- Click "Sync" for ProxyPool source

**Via API:**
```bash
curl -X POST http://localhost:3000/api/settings/free-proxies/sync \
  -H "Content-Type: application/json" \
  -d '{"source": "proxypool"}'
```

## proxy_pool API Endpoints

The integration uses these proxy_pool endpoints:

| Endpoint | Description |
|----------|-------------|
| `GET /` | Get one random proxy |
| `GET /get_all/` | Get all proxies in pool (used by OmniRoute) |
| `GET /get_status/` | Get pool statistics |
| `DELETE /delete/?proxy=ip:port` | Delete a specific proxy |

## Configuration Options

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `FREE_PROXY_PROXYPOOL_ENABLED` | `false` | Enable/disable ProxyPool provider |
| `FREE_PROXY_PROXYPOOL_API_URL` | `http://localhost:5010` | ProxyPool API base URL |
| `FREE_PROXY_PROXYPOOL_MAX` | `500` | Maximum proxies to fetch |

### Docker Network Integration

If running OmniRoute in Docker, update the network configuration:

```yaml
services:
  omniroute:
    networks:
      - omniroute-network
    environment:
      - FREE_PROXY_PROXYPOOL_API_URL=http://proxy_pool:5010

networks:
  omniroute-network:
    external: true
```

## Usage

### Automatic Proxy Rotation

Once synced, ProxyPool proxies are available in OmniRoute's proxy pool and will be:
1. Automatically health-checked
2. Rotated based on your proxy strategy
3. Used for API requests when configured

### Manual Testing

Test a synced proxy:

```bash
curl http://localhost:3000/api/settings/proxies/health \
  -H "Content-Type: application/json" \
  -d '{"source": "proxypool"}'
```

### Monitoring

View ProxyPool statistics:

```bash
# OmniRoute stats
curl http://localhost:3000/api/settings/free-proxies/stats

# proxy_pool stats
curl http://localhost:5010/get_status/
```

## Troubleshooting

### proxy_pool not responding

Check if the service is running:
```bash
docker ps | grep proxy_pool
docker logs proxy_pool
```

### No proxies synced

1. Verify proxy_pool has collected proxies:
   ```bash
   curl http://localhost:5010/get_status/
   ```

2. Check OmniRoute logs for sync errors

3. Ensure `FREE_PROXY_PROXYPOOL_ENABLED=true`

### Proxies failing health checks

proxy_pool proxies are free and may have:
- High failure rates
- Short lifespans
- Geographic restrictions

Recommendations:
- Set up automatic re-sync (every 15-30 minutes)
- Use quality filters
- Combine with paid proxy services for critical traffic

## Advanced Configuration

### Scheduled Sync

Add a cron job or systemd timer:

```bash
# Sync every 15 minutes
*/15 * * * * curl -X POST http://localhost:3000/api/settings/free-proxies/sync -d '{"source":"proxypool"}'
```

### Production Deployment

For production, consider:
1. Running proxy_pool on a separate server
2. Using persistent Redis storage
3. Setting up monitoring/alerting
4. Implementing rate limiting on sync operations

## Benefits

- **Zero Cost**: Free proxy source
- **Auto-Updated**: proxy_pool continuously validates proxies
- **Easy Integration**: Works with existing OmniRoute infrastructure
- **Scalable**: Can deploy multiple proxy_pool instances

## Limitations

- Free proxies have lower reliability than paid services
- No SLA or guaranteed uptime
- May be slower or have geographic limitations
- Requires maintaining proxy_pool service
