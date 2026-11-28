#!/usr/bin/env bash
# On the VM host, run with HC_PING_URL set to the LCP Healthchecks.io check URL.
set -euo pipefail

case "${HC_PING_URL:-}" in
  https://hc-ping.com/?*) ;;
  *) printf '%s\n' 'Set HC_PING_URL to the LCP Healthchecks.io check URL.' >&2; exit 1 ;;
esac

url="${HC_PING_URL%/}"
code=$(curl -s -o /dev/null -w '%{http_code}' -m 10 http://127.0.0.1:8081/health || true)
if [[ "$code" == 200 ]]; then
  curl -fs -m 10 --retry 3 -o /dev/null "$url"
else
  curl -fs -m 10 --retry 3 -o /dev/null --data-raw "LCP health returned HTTP ${code:-000}" "$url/fail"
fi
