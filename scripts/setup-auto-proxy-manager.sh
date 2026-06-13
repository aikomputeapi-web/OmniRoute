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

# Option 1: Setup cron job (recommended for simplicity)
read -p "Setup automatic proxy management? (yes/no) [yes]: " SETUP_AUTO
SETUP_AUTO=${SETUP_AUTO:-yes}

if [[ "$SETUP_AUTO" == "yes" ]]; then
    # Check if cron job already exists
    if crontab -l 2>/dev/null | grep -q "auto-proxy-manager.sh"; then
        echo "⚠️  Cron job already exists"
    else
        # Add cron job to run every 2 hours
        (crontab -l 2>/dev/null; echo "# OmniRoute Auto Proxy Manager - Runs every 2 hours") | crontab -
        (crontab -l 2>/dev/null; echo "0 */2 * * * $OMNIROUTE_DIR/scripts/auto-proxy-manager.sh >> /var/log/omniroute-proxy-manager.log 2>&1") | crontab -
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
    echo "  $OMNIROUTE_DIR/scripts/auto-proxy-manager.sh"
    echo ""
    echo "To setup cron manually, add this line:"
    echo "  0 */2 * * * $OMNIROUTE_DIR/scripts/auto-proxy-manager.sh >> /var/log/omniroute-proxy-manager.log 2>&1"
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
