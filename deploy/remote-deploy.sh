#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/query-analytics}"
BRANCH="${BRANCH:-main}"
SERVICE_NAME="${SERVICE_NAME:-query-analytics.service}"

cd "$APP_DIR"

echo "[deploy] app_dir=$APP_DIR branch=$BRANCH service=$SERVICE_NAME"

git fetch origin "$BRANCH"
git checkout "$BRANCH"
git pull --ff-only origin "$BRANCH"

npm ci
npm run build

sudo systemctl daemon-reload
sudo systemctl restart "$SERVICE_NAME"
sudo systemctl --no-pager --lines=20 status "$SERVICE_NAME"

echo "[deploy] done"
