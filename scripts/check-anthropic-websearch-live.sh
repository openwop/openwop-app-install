#!/usr/bin/env bash
# ADR 0101 §149 live check — the ONE thing blocking `webSearch: true` for Anthropic.
#
# The dispatcher (dispatchAnthropicTools.ts:259) sends the server tool
#   { type: 'web_search_20250305', name: 'web_search', max_uses: 5 }
# with ONLY `anthropic-version: 2023-06-01` and NO beta header. It is unit-tested
# against a mock, so the mock proves the parse, not the request shape. The ADR
# says: "we don't advertise webSearch:true until a live check confirms the request
# shape (e.g. whether a beta header is required)."
#
# This script answers exactly that, and nothing else.
#
# Usage:  ANTHROPIC_API_KEY=sk-ant-... bash anthropic-websearch-livecheck.sh
#
# The key is read from the environment and never echoed. Cost: one short turn.

set -uo pipefail
: "${ANTHROPIC_API_KEY:?set ANTHROPIC_API_KEY first}"
MODEL="${MODEL:-claude-sonnet-4-5-20250929}"

echo "model: $MODEL"
echo "sending web_search_20250305 with NO beta header (exactly what the dispatcher sends)..."

BODY=$(cat <<JSON
{
  "model": "$MODEL",
  "max_tokens": 1024,
  "tools": [{ "type": "web_search_20250305", "name": "web_search", "max_uses": 5 }],
  "messages": [{ "role": "user",
    "content": "Search the web: what is the current stable version of Node.js? Cite your source." }]
}
JSON
)

HTTP=$(curl -sS -o /tmp/anthropic-ws.json -w '%{http_code}' \
  https://api.anthropic.com/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H 'anthropic-version: 2023-06-01' \
  -H 'content-type: application/json' \
  -d "$BODY")

echo "HTTP $HTTP"
python3 - "$HTTP" <<'PY'
import json, sys
http = sys.argv[1]
try:
    d = json.load(open('/tmp/anthropic-ws.json'))
except Exception as e:
    print("could not parse response:", e); raise SystemExit(1)

if http != '200':
    err = d.get('error', {})
    print("VERDICT: FAIL —", err.get('type'), "|", str(err.get('message'))[:400])
    print()
    msg = str(err.get('message', '')).lower()
    if 'beta' in msg or 'header' in msg:
        print(">> A beta header IS required. Do NOT flip the flag; add the header to")
        print("   dispatchAnthropicTools.ts first, then re-run this check.")
    else:
        print(">> Flag stays OFF. Record this output in ADR 0101 §149.")
    raise SystemExit(1)

blocks = d.get('content', [])
kinds = [b.get('type') for b in blocks]
results = [r for b in blocks if b.get('type') == 'web_search_tool_result'
             for r in (b.get('content') or []) if isinstance(r, dict)]
urls = [r.get('url') for r in results if r.get('type') == 'web_search_result' and r.get('url')]

print("block types :", kinds)
print("citations   :", len(urls))
for u in urls[:5]:
    print("   -", u)
print()
if not urls:
    print("VERDICT: INCONCLUSIVE — 200 OK but no web_search_tool_result block.")
    print(">> The request shape is accepted, but the model did not search. Re-run")
    print("   with a question it cannot answer from memory. Flag stays OFF.")
    raise SystemExit(2)

# The parse the dispatcher performs (dispatchAnthropicTools.ts:298-302) is
# exercised above: web_search_tool_result -> content[] -> web_search_result.url
publisher = [u for u in urls if 'redirect' not in u and 'vertexaisearch' not in u]
print("VERDICT: PASS — request shape accepted with no beta header, and the")
print(f"         dispatcher's parse path yields {len(urls)} citation(s).")
print(f"         {len(publisher)}/{len(urls)} look like real publisher URLs (durable-suitable).")
print()
print(">> Safe to flip `webSearch: true` for this model in providers.json.")
print("   Paste this output into ADR 0101 §149 as the live-check record.")
PY
