#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/query-analytics}"
SERVICE_NAME="${SERVICE_NAME:-query-analytics.service}"
RELEASE_ARCHIVE="${RELEASE_ARCHIVE:-/tmp/query-analytics-release.tar.gz}"

run_systemctl() {
  if command -v sudo >/dev/null 2>&1 && [[ "$(id -u)" -ne 0 ]]; then
    sudo systemctl "$@"
  else
    systemctl "$@"
  fi
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[deploy] required command not found: $1" >&2
    exit 1
  fi
}

require_command tar
require_command rsync
require_command npm
require_command node

if [[ ! -f "$RELEASE_ARCHIVE" ]]; then
  echo "[deploy] release archive not found: $RELEASE_ARCHIVE" >&2
  exit 1
fi

mkdir -p "$APP_DIR"

stage_dir="$(mktemp -d /tmp/query-analytics-deploy.XXXXXX)"
cleanup() {
  rm -rf "$stage_dir"
  rm -f "$RELEASE_ARCHIVE"
}
trap cleanup EXIT

echo "[deploy] app_dir=$APP_DIR service=$SERVICE_NAME archive=$RELEASE_ARCHIVE"

tar -xzf "$RELEASE_ARCHIVE" -C "$stage_dir"

if [[ ! -f "$stage_dir/package.json" ]]; then
  echo "[deploy] package.json not found in release archive" >&2
  exit 1
fi

mkdir -p "$APP_DIR/config"

rsync -a --delete \
  --exclude ".env" \
  --exclude "config/sources.local.json" \
  "$stage_dir"/ "$APP_DIR"/

cd "$APP_DIR"

npm ci
npm run build

run_systemctl daemon-reload
run_systemctl restart "$SERVICE_NAME"
run_systemctl --no-pager --lines=20 status "$SERVICE_NAME"

echo "[deploy] done"
