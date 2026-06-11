#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Run the SEO + GEO audit against a live site and save a dated report.
#
#   seo-audit/run.sh https://example.com
#
# crawl.mjs collects the data (sitemap + every internal link/image target) and
# report.mjs renders it into markdown. Reports land in reports/.
#
# Advanced: to audit an origin that differs from the public host (behind a
# CDN/proxy, or the app server directly), call crawl.mjs yourself with
# CRAWL_BASE + CRAWL_HOST — see the header of crawl.mjs.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")/.."

URL="${1:-}"
if [ -z "$URL" ]; then echo "usage: $0 <https://your-site.com>"; exit 1; fi
HOST="$(node -e "console.log(new URL(process.argv[1]).host)" "$URL")"

STAMP="$(date +%Y-%m-%d_%H-%M-%S)"
OUT_DIR="reports"
JSON="$OUT_DIR/audit-${HOST}-${STAMP}.json"
MD="$OUT_DIR/audit-${HOST}-${STAMP}.md"
mkdir -p "$OUT_DIR"

echo "▶ crawling $URL (sitemap + every internal link — can take ~30–90s) …"
node seo-audit/crawl.mjs "$URL" > "$JSON"

BYTES=$(wc -c < "$JSON" | tr -d ' ')
if [ "$BYTES" -lt 100 ]; then echo "✖ crawl produced no data ($BYTES bytes)"; exit 1; fi

echo "▶ rendering report …"
node seo-audit/report.mjs "$JSON" "$MD" > /dev/null

echo ""
echo "✅ done:"
echo "   JSON: $JSON"
echo "   MD:   $MD"
echo ""
# print the overview + the issue-summary tables to the terminal
awk '/^## Overview/{f=1} /^## Broken link targets/{f=0} /^---/{f=0} f' "$MD"
