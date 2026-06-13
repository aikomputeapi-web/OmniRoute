#!/bin/bash
# Setup automated proxy management for OmniRoute

set -e

echo "🔧 Setting up automated proxy management..."

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OMNIROUTE_DIR="$(dirname "$SCRIPT_DIR")"

# Create log directory
sudo mkdir -p /var/log
sudo touch /var/log/omniroute-proxy-manager.log
sudo chmod 666 /var/log/omniroute-proxy-manager.log

echo "✅ Log file created"
echo ""
echo "🔑 API Key Setup Required"
echo "The automation script needs an API key with 'manage' scope."
echo ""
echo "Steps to create:"
echo "  1. Open OmniRoute Dashboard: http://localhost:3000/dashboard" 
echo "  2. Go to Settings → API Keys"
echo "  3. Create New API Key"
echo "  4. Enable the 'manage' scope checkbox"
echo "  5. Copy the generated key"
echo ""

read -p "Do you have an API key ready? (yes/no) [no]: " HAS_KEY
HAS_KEY=${HAS_KEY:-no}

if [[ "$HAS_KEY" != "yes" ]]; then
    echo ""
    echo "⚠️  Please create the API key first, then run this setup again."
    echo ""
    echo "Quick test (once you have the key):"
    echo "  export OMNIROUTE_API_KEY=your-key-here"
    echo "  $OMNIROUTE_DIR/scripts/auto-proxy-manager.sh"
    echo ""
    exit 0
fi

read -p "Enter your API key: " API_KEY

if [ -z "$API_KEY" ]; then
    echo "❌ No API key provided. Exiting."
    exit 1
fi

# Add to .env if not already there
if grep -q "^OMNIROUTE_API_KEY=" "$OMNIROUTE_DIR/.env" 2>/dev/null; then
    echo "⚠️  OMNIROUTE_API_KEY already exists in .env"
    read -p "Replace it? (yes/no) [no]: " REPLACE
    if [[ "$REPLACE" == "yes" ]]; then
        sed -i "s|^OMNIROUTE_API_KEY=.*|OMNIROUTE_API_KEY=$API_KEY|" "$OMNIROUTE_DIR/.env"
        echo "✅ Updated OMNIROUTE_API_KEY in .env"
    fi
else
    echo "" >> "$OMNIROUTE_DIR/.env"
    echo "# Auto Proxy Manager API Key" >> "$OMNIROUTE_DIR/.env"
    echo "OMNIROUTE_API_KEY=$API_KEY" >> "$OMNIROUTE_DIR/.env"
    echo "✅ Added OMNIROUTE_API_KEY to .env"
fi

# Export for immediate use
export OMNIROUTE_API_KEY="$API_KEY"

echo ""
read -p "Setup automatic proxy management? (yes/no) [yes]: " SETUP_AUTO
SETUP_AUTO=${SETUP_AUTO:-yes}

if [[ "$SETUP_AUTO" == "yes" ]]; then
    # Check if cron job already exists
    if crontab -l 2>/dev/null | grep -q "auto-proxy-manager.sh"; then
        echo "⚠️  Cron job already exists"
    else
        # Add cron job to run every 2 hours
        (crontab -l 2>/dev/null; echo "# OmniRoute Auto Proxy Manager - Runs every 2 hours") | crontab -
        (crontab -l 2>/dev/null; echo "0 */2 * * * export OMNIROUTE_API_KEY='$API_KEY' && $OMNIROUTE_DIR/scripts/auto-proxy-manager.sh >> /var/log/omniroute-proxy-manager.log 2>&1") | crontab -
        echo "✅ Cron job added (runs every 2 hours)"
    fi

    # Run once now for testing
    echo ""
    echo "🧪 Running initial test..."
    bash "$OMNIROUTE_DIR/scripts/auto-proxy-manager.sh"
else
    echo "⏭️  Skipped automatic setup"
    echo ""
    echo "To run manually:"
    echo "  export OMNIROUTE_API_KEY='$API_KEY'"
    echo "  $OMNIROUTE_DIR/scripts/auto-proxy-manager.sh"
    echo ""
    echo "To setup cron manually, add this line:"
    echo "  0 */2 * * * export OMNIROUTE_API_KEY='$API_KEY' && $OMNIROUTE_DIR/scripts/auto-proxy-manager.sh >> /var/log/omniroute-proxy-manager.log 2>&1"
fi

echo ""
echo "✨ Setup complete!"
echo ""
echo "📋 What happens now:"
echo "   • Every 2 hours, the script will:"
echo "     1. Sync new proxies from scraper"
echo "     2. Add top 100 quality USA proxies to active pool"
echo "     3. Log results to /var/log/omniroute-proxy-manager.log"
echo ""
echo "📊 Monitor logs:"
echo "   tail -f /var/log/omniroute-proxy-manager.log"
echo ""
echo "🔧 Customize behavior:"
echo "   Edit: $OMNIROUTE_DIR/scripts/auto-proxy-manager.sh"
echo "   Variables: MIN_QUALITY (default: 60), MAX_PROXIES (default: 100)"
echo ""
echo "⏰ Change schedule:"
echo "   crontab -e"
echo "   Current: Every 2 hours (0 */2 * * *)"
echo "   Hourly: 0 * * * *"
echo "   Every 30 min: */30 * * * *"
echo ""
