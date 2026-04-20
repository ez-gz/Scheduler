#!/usr/bin/env bash
# Usage: npm run tunnel -- --auth user:pass
set -euo pipefail

AUTH=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --auth) AUTH="$2"; shift 2 ;;
    *) shift ;;
  esac
done

if [ -z "$AUTH" ]; then
  echo "error: --auth user:pass is required"
  echo "usage: npm run tunnel -- --auth user:pass"
  exit 1
fi

echo "[tunnel] starting ngrok with basic auth"
ngrok http 3747 --basic-auth "$AUTH"
