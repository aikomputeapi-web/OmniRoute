#!/bin/bash
set -e

echo "🚀 Setting up proxy-scraper-checker integration for OmniRoute"

# Create directories
mkdir -p proxy_scraper_data/proxies
mkdir -p proxy_scraper_config

echo "📁 Created proxy scraper directories"

# Check if .env exists
if [ ! -f .env ]; then
  echo "❌ .env file not found. Creating one..."
  touch .env
fi

# Add configuration to .env if not present
if ! grep -q "FREE_PROXY_SCRAPER_ENABLED" .env; then
  echo "" >> .env
  echo "# Proxy Scraper Configuration" >> .env
  echo "FREE_PROXY_SCRAPER_ENABLED=true" >> .env
  echo "FREE_PROXY_SCRAPER_HTTP_FILE=./proxy_scraper_data/proxies/http.txt" >> .env
  echo "FREE_PROXY_SCRAPER_SOCKS4_FILE=./proxy_scraper_data/proxies/socks4.txt" >> .env
  echo "FREE_PROXY_SCRAPER_SOCKS5_FILE=./proxy_scraper_data/proxies/socks5.txt" >> .env
  echo "FREE_PROXY_SCRAPER_MAX=1000" >> .env
  echo "✅ Added proxy scraper configuration to .env"
else
  echo "ℹ️  Proxy scraper configuration already exists in .env"
fi

# Start the proxy scraper service
echo "🐳 Starting proxy-scraper-checker service..."
docker compose -f docker-compose.proxyscraper.yml up -d

echo ""
echo "✅ Setup complete!"
echo ""
echo "📋 Next steps:"
echo "   1. Wait ~5 minutes for first proxy scrape to complete"
echo "   2. Check logs: docker logs -f omniroute-proxy-scraper"
echo "   2a. Or check container status: docker ps | grep proxy-scraper"
echo "   3. Sync proxies to OmniRoute:"
echo "      curl -X POST http://localhost:3000/api/settings/free-proxies/sync \\"
echo "           -H 'Content-Type: application/json' \\"
echo "           -d '{\"source\": \"proxyscraper\"}'"
echo ""
echo "   4. Check stats: curl http://localhost:3000/api/settings/free-proxies/stats"
echo ""
