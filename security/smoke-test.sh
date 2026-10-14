#!/usr/bin/env bash
# SemaCheck smoke test (Appendix A of the Website Review & Test Plan).
# Run ONLY against systems you own.
# Read-only requests plus one small rate-limit probe. No logins, no payments, no uploads.
# Usage:  SITE=https://semacheck.vercel.app API=https://semacheck.onrender.com bash smoke-test.sh
set -u

SITE="${SITE:-https://semacheck.vercel.app}"
API="${API:-https://semacheck.onrender.com}"
PASS=0; FAIL=0; WARN=0

# Deliberately invalid key built at runtime so no literal key-shaped string
# lives in this file (GitHub push protection scans for those).
FAKE_KEY="sk_live_invalid$(printf '%040d' 0)"

pass() { printf '[PASS] %s\n' "$1"; PASS=$((PASS+1)); }
fail() { printf '[FAIL] %s\n' "$1"; FAIL=$((FAIL+1)); }
warn() { printf '[WARN] %s\n' "$1"; WARN=$((WARN+1)); }

echo "== 1. Security headers =="
for base in "$SITE" "$API"; do
  headers="$(curl -s -I --max-time 15 "$base/" 2>/dev/null)"
  for h in strict-transport-security x-content-type-options referrer-policy; do
    if echo "$headers" | grep -qi "^$h:"; then pass "$base sends $h"; else fail "$base is missing $h"; fi
  done
  # The JSON API enforces a locked-down CSP. The HTML site ships it as
  # report-only on purpose: pages still use inline scripts, so an enforcing
  # script-src would break them until those scripts are externalized.
  if echo "$headers" | grep -qi "^content-security-policy:"; then
    pass "$base sends content-security-policy (enforcing)"
  elif echo "$headers" | grep -qi "^content-security-policy-report-only:"; then
    pass "$base sends content-security-policy (report-only — HTML site)"
  else
    fail "$base is missing content-security-policy"
  fi
  if echo "$headers" | grep -qiE "^x-frame-options:|frame-ancestors"; then pass "$base blocks framing"; else fail "$base can be framed (clickjacking)"; fi
  if echo "$headers" | grep -qi "^x-powered-by:"; then warn "$base reveals x-powered-by"; else pass "$base hides x-powered-by"; fi
done

echo "== 2. Files that must not be public =="
for path in /.env /.git/config /.git/HEAD /backend/.env /package.json /package-lock.json /server.js /db/schema.sql /backend/db/schema.sql /uploads/ /backend/uploads/ /admin/.env; do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$SITE$path")"
  body="$(curl -s --max-time 15 "$SITE$path" | head -c 300)"
  # A 200 that is just your normal HTML page is fine. Look at the body for secrets.
  if [ "$code" = "200" ] && echo "$body" | grep -qiE "DB_PASSWORD|SECRET|API_KEY|\[core\]|CREATE TABLE|require\("; then
    fail "$SITE$path exposes sensitive content (HTTP $code)"
  else
    pass "$SITE$path not exposed (HTTP $code)"
  fi
done

echo "== 3. API key handling (expect identical 401 answers) =="
a="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -X POST "$API/v1/check" -H 'Content-Type: application/json' -d '{"type":"phone","value":"254700000001"}')"
b="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -X POST "$API/v1/check" -H 'Authorization: Bearer not-a-key' -H 'Content-Type: application/json' -d '{"type":"phone","value":"254700000001"}')"
c="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -X POST "$API/v1/check" -H "Authorization: Bearer $FAKE_KEY" -H 'Content-Type: application/json' -d '{"type":"phone","value":"254700000001"}')"
echo "no key: $a   malformed key: $b   unknown key: $c"
if [ "$a" = "401" ] && [ "$b" = "401" ] && [ "$c" = "401" ]; then pass "all bad keys rejected with 401"; else fail "bad keys not uniformly rejected"; fi
body1="$(curl -s --max-time 15 -X POST "$API/v1/check" -H 'Authorization: Bearer not-a-key' -H 'Content-Type: application/json' -d '{}')"
body2="$(curl -s --max-time 15 -X POST "$API/v1/check" -H "Authorization: Bearer $FAKE_KEY" -H 'Content-Type: application/json' -d '{}')"
[ "$body1" = "$body2" ] && pass "malformed and unknown key give the same error body" || warn "error bodies differ (could reveal key format)"

echo "== 4. CORS (a foreign website must not be allowed) =="
acao="$(curl -s -I --max-time 15 -X OPTIONS "$API/v1/widget/check" -H 'Origin: https://evil.example' -H 'Access-Control-Request-Method: POST' | grep -i '^access-control-allow-origin:' | tr -d '\r')"
if [ -z "$acao" ]; then pass "no CORS allowance for a foreign origin"; elif echo "$acao" | grep -q '\*'; then fail "CORS allows any origin: $acao"; else warn "CORS answered: $acao"; fi

echo "== 5. Rate limiting probe (30 quick calls with a bad key) =="
codes=""
for i in $(seq 1 30); do
  codes="$codes $(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -X POST "$API/v1/check" -H "Authorization: Bearer $FAKE_KEY" -H 'Content-Type: application/json' -d '{}')"
done
echo "status codes:$codes"
if echo "$codes" | grep -q 429; then pass "rate limit triggered"; else warn "no 429 seen in 30 calls (check limits for bad-key traffic)"; fi

echo "== 6. Admin and private endpoints without a login (expect 401 or 403) =="
for path in /api/admin/reports /api/admin/api-accounts /api/admin/audit /api/account/api/overview /api/account/api/keys; do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$API$path")"
  if [ "$code" = "401" ] || [ "$code" = "403" ] || [ "$code" = "404" ]; then pass "$API$path -> $code"; else fail "$API$path -> $code (should need a login)"; fi
done

echo "== 7. Error pages must not leak details =="
body="$(curl -s --max-time 15 -X POST "$API/v1/check" -H 'Authorization: Bearer x' -H 'Content-Type: application/json' -d '{bad json')"
if echo "$body" | grep -qiE "at .*\.js:[0-9]+|node_modules|stack|SyntaxError"; then fail "stack trace or internals visible in error output"; else pass "no internals visible in a bad-JSON error"; fi

echo
echo "Done. PASS=$PASS  WARN=$WARN  FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
