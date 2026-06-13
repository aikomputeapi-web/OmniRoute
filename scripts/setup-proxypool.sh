#!/bin/bash
# Quick setup script for proxy_pool integration

set -e

echo "🚀 Setting up proxy_pool integration for OmniRoute..."

# Check if Docker is installed
if ! command -v docker &> /dev/null; then
    echo "❌ Docker is not installed. Please install Docker first."
    exit 1
fi

# Start proxy_pool service
echo "📦 Starting proxy_pool service..."
docker-compose -f docker-compose.proxypool.yml up -d

# Wait for service to be ready
echo "⏳ Waiting for proxy_pool to be ready..."
sleep 10

# Check if proxy_pool is responding
MAX_RETRIES=30
RETRY_COUNT=0
while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
    if curl -s http://localhost:5010/get_status/ > /dev/null 2>&1; then
        echo "✅ proxy_pool is running!"
        break
    fi
    RETRY_COUNT=$((RETRY_COUNT + 1))
    echo "Waiting... ($RETRY_COUNT/$MAX_RETRIES)"
    sleep 2
done

if [ $RETRY_COUNT -eq $MAX_RETRIES ]; then
    echo "❌ proxy_pool failed to start. Check logs with: docker logs proxy_pool"
    exit 1
fi

# Update .env file
echo "📝 Updating .env configuration..."
if ! grep -q "FREE_PROXY_PROXYPOOL_ENABLED" .env 2>/dev/null; then
    cat >> .env << EOF

# ProxyPool Integration
FREE_PROXY_PROXYPOOL_ENABLED=true
FREE_PROXY_PROXYPOOL_API_URL=http://localhost:5010
FREE_PROXY_PROXYPOOL_MAX=500
EOF
    echo "✅ Configuration added to .env"
else
    echo "⚠️  ProxyPool config already exists in .env"
fi

echo ""
echo "✨ Setup complete!"
echo ""
echo "Next steps:"
echo "1. Restart OmniRoute to load the new configuration"
echo "2. Navigate to Dashboard → Settings → Proxy → Free Proxy Pool"
echo "3. Click 'Sync' for ProxyPool source"
echo ""
echo "Or sync via API:"
echo "  curl -X POST http://localhost:3000/api/settings/free-proxies/sync \\"
echo "    -H 'Content-Type: application/json' \\"
echo "    -d '{\"source\": \"proxypool\"}'"
echo ""
echo "Check proxy_pool status:"
echo "  curl http://localhost:5010/get_status/"
