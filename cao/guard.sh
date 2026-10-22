#!/usr/bin/env bash
# Pre-flight for the housekeeping flow. Skips the turn while the work turn's
# session is still processing; otherwise hands the open daily PR to the prompt.
set -euo pipefail
API=${CAO_API:-http://localhost:9889}
busy=$(curl -sf "$API/sessions/cao-flow-ask-anything-work" 2>/dev/null \
  | python3 -c 'import sys,json
try:
  t=json.load(sys.stdin).get("terminals") or []
  print("1" if t and t[0].get("status")=="processing" else "0")
except Exception:
  print("0")' || echo 0)
if [ "$busy" = "1" ]; then
  echo '{"execute": false, "output": {}}'
  exit 0
fi
pr=$(gh pr list --repo lukeocodes/ask-anything --state open --label daily \
  --json number,url,headRefName,isDraft,labels 2>/dev/null || echo '[]')
python3 - "$pr" <<'PY'
import json,sys
prs=json.loads(sys.argv[1])
open_=[p for p in prs if not any(l["name"]=="needs-decision" for l in p.get("labels",[]))]
desc="none" if not open_ else " ".join(f"#{p['number']} {p['url']} branch {p['headRefName']}" for p in open_)
print(json.dumps({"execute": True, "output": {"pr": desc}}))
PY
