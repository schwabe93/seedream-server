#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="${SERVICE_NAME:-seedream-studio}"
APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:${PORT:-7842}/api/health}"

echo "Deploying Seedream Studio from $APP_DIR"
cd "$APP_DIR"

if command -v git >/dev/null 2>&1; then
  echo "Pulling latest changes..."
  git pull --ff-only
fi

if [ -f package-lock.json ]; then
  echo "Installing production dependencies..."
  npm ci --omit=dev
else
  echo "Installing production dependencies..."
  npm install --omit=dev
fi

echo "Restarting $SERVICE_NAME..."
sudo systemctl restart "$SERVICE_NAME"

echo "Waiting for health check..."
for i in {1..20}; do
  if curl -fsS "$HEALTH_URL" >/dev/null; then
    echo "Deploy complete: $HEALTH_URL"
    sudo systemctl --no-pager --lines=0 status "$SERVICE_NAME"
    exit 0
  fi
  sleep 1
done

echo "Service did not become healthy. Recent logs:"
sudo journalctl -u "$SERVICE_NAME" -n 80 --no-pager
exit 1
