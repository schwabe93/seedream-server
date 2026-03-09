#!/bin/bash
# ─────────────────────────────────────────────────────────────
#  Seedream Studio — Ubuntu Server Setup Script
#  Run this once on your Ubuntu server
# ─────────────────────────────────────────────────────────────

set -e

INSTALL_DIR="$HOME/seedream-studio"
SERVICE_NAME="seedream-studio"
PORT=7842

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║   🎨  Seedream Studio — Server Setup         ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

# ── 1. Check Node.js ──────────────────────────────────────────
echo "▶ Checking Node.js..."
if ! command -v node &> /dev/null; then
  echo "  Node.js not found. Installing via NodeSource..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
else
  NODE_VER=$(node --version)
  echo "  ✓ Node.js $NODE_VER found"
fi

# ── 2. Copy files ─────────────────────────────────────────────
echo "▶ Installing to $INSTALL_DIR..."
mkdir -p "$INSTALL_DIR"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cp "$SCRIPT_DIR/server.js"    "$INSTALL_DIR/"
cp "$SCRIPT_DIR/package.json" "$INSTALL_DIR/"
cp -r "$SCRIPT_DIR/public"    "$INSTALL_DIR/"
mkdir -p "$INSTALL_DIR/data"

echo "  ✓ Files copied"

# ── 3. Install npm dependencies ───────────────────────────────
echo "▶ Installing dependencies..."
cd "$INSTALL_DIR"
npm install --omit=dev --silent
echo "  ✓ Dependencies installed"

# ── 4. Create systemd service ─────────────────────────────────
echo "▶ Creating systemd service..."

SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

sudo tee "$SERVICE_FILE" > /dev/null <<EOF
[Unit]
Description=Seedream Studio — Local AI Image/Video Server
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$INSTALL_DIR
ExecStart=$(which node) server.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
Environment=PORT=$PORT

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"
sudo systemctl restart "$SERVICE_NAME"

echo "  ✓ Service created and started"

# ── 5. Open firewall port ─────────────────────────────────────
echo "▶ Opening firewall port $PORT..."
if command -v ufw &> /dev/null; then
  sudo ufw allow "$PORT/tcp" > /dev/null 2>&1 && echo "  ✓ ufw: port $PORT opened"
else
  echo "  ℹ  ufw not found — skipping firewall (open port $PORT manually if needed)"
fi

# ── 6. Done ───────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║   ✅  Setup complete!                        ║"
echo "╠══════════════════════════════════════════════╣"

# Show all network IPs
IPS=$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' | head -5)
while IFS= read -r ip; do
  LINE="  → http://$ip:$PORT"
  printf "║  %-44s║\n" "$LINE"
done <<< "$IPS"

echo "╠══════════════════════════════════════════════╣"
echo "║  Useful commands:                            ║"
echo "║    systemctl status $SERVICE_NAME            ║"
echo "║    journalctl -u $SERVICE_NAME -f            ║"
echo "║    systemctl restart $SERVICE_NAME           ║"
echo "╚══════════════════════════════════════════════╝"
echo ""
