#!/usr/bin/env bash
# Test Twilio API connectivity + webhook reachability.
# Usage: bash test.sh [--live]
set -euo pipefail

CONFIG_FILE="$HOME/.openclaw/openclaw.json"
PLUGIN_DIR="$HOME/.openclaw/extensions/twilio"

# ── Colours ───────────────────────────────────────────────────────────────────
red()    { printf '\033[31m%s\033[0m\n' "$*" >&2; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*" >&2; }
bold()   { printf '\033[1m%s\033[0m\n' "$*"; }

PASS=0
FAIL=0
SKIP=0
LIVE=false
[[ "${1:-}" == "--live" ]] && LIVE=true

pass() { green "  ✓ $1"; PASS=$((PASS + 1)); }
fail() { red "  ✗ $1"; FAIL=$((FAIL + 1)); }
skip() { yellow "  ○ $1 (skipped)"; SKIP=$((SKIP + 1)); }

bold "Twilio Plugin Test Suite"
echo "════════════════════════"
echo

# ── 1. File structure ─────────────────────────────────────────────────────────
bold "1. File Structure"

[[ -f "$PLUGIN_DIR/index.ts" ]] && pass "index.ts exists" || fail "index.ts missing"
[[ -f "$PLUGIN_DIR/package.json" ]] && pass "package.json exists" || fail "package.json missing"
[[ -f "$PLUGIN_DIR/openclaw.plugin.json" ]] && pass "openclaw.plugin.json exists" || fail "openclaw.plugin.json missing"
[[ -f "$PLUGIN_DIR/src/channel.ts" ]] && pass "src/channel.ts exists" || fail "src/channel.ts missing"
[[ -f "$PLUGIN_DIR/src/types.ts" ]] && pass "src/types.ts exists" || fail "src/types.ts missing"
[[ -f "$PLUGIN_DIR/src/accounts.ts" ]] && pass "src/accounts.ts exists" || fail "src/accounts.ts missing"
[[ -f "$PLUGIN_DIR/src/send.ts" ]] && pass "src/send.ts exists" || fail "src/send.ts missing"
[[ -f "$PLUGIN_DIR/src/monitor.ts" ]] && pass "src/monitor.ts exists" || fail "src/monitor.ts missing"
[[ -f "$PLUGIN_DIR/src/inbound.ts" ]] && pass "src/inbound.ts exists" || fail "src/inbound.ts missing"
echo

# ── 2. JSON validity ─────────────────────────────────────────────────────────
bold "2. JSON Validity"

jq empty "$PLUGIN_DIR/package.json" 2>/dev/null && pass "package.json valid JSON" || fail "package.json invalid JSON"
jq empty "$PLUGIN_DIR/openclaw.plugin.json" 2>/dev/null && pass "openclaw.plugin.json valid JSON" || fail "openclaw.plugin.json invalid JSON"
echo

# ── 3. Config integration ────────────────────────────────────────────────────
bold "3. openclaw.json Integration"

if [[ -f "$CONFIG_FILE" ]]; then
  # Check plugin registered
  if jq -e '.plugins.allow | index("twilio")' "$CONFIG_FILE" &>/dev/null; then
    pass "twilio in plugins.allow"
  else
    skip "twilio not in plugins.allow (run install.sh first)"
  fi

  # Check channel config
  if jq -e '.channels.twilio' "$CONFIG_FILE" &>/dev/null; then
    pass "channels.twilio section exists"

    # Check credentials
    SID=$(jq -r '.channels.twilio.shared.accountSid // .channels.twilio.accountSid // ""' "$CONFIG_FILE")
    if [[ -n "$SID" ]]; then
      pass "accountSid configured"
    else
      skip "accountSid not set"
    fi

    # Check DIDs
    DID_COUNT=$(jq '.channels.twilio.accounts // {} | length' "$CONFIG_FILE" 2>/dev/null || echo 0)
    if [[ "$DID_COUNT" -gt 0 ]]; then
      pass "$DID_COUNT DID(s) configured"
    else
      FROM=$(jq -r '.channels.twilio.fromNumber // ""' "$CONFIG_FILE")
      if [[ -n "$FROM" ]]; then
        pass "fromNumber configured: $FROM"
      else
        skip "No DIDs or fromNumber configured"
      fi
    fi
  else
    skip "channels.twilio section not found"
  fi
else
  skip "openclaw.json not found"
fi
echo

# ── 4. Dependencies ──────────────────────────────────────────────────────────
bold "4. Dependencies"

if [[ -d "$PLUGIN_DIR/node_modules/twilio" ]]; then
  pass "twilio npm module installed"
else
  fail "twilio npm module not installed (run: cd $PLUGIN_DIR && npm install)"
fi

if [[ -d "$PLUGIN_DIR/node_modules/express" ]]; then
  pass "express npm module installed"
else
  fail "express npm module not installed"
fi

if [[ -d "$PLUGIN_DIR/node_modules/sqlite3" ]]; then
  pass "sqlite3 npm module installed"
else
  fail "sqlite3 npm module not installed"
fi

if command -v sqlite3 &>/dev/null; then
  pass "sqlite3 CLI available: $(sqlite3 --version | head -c 20)"
else
  skip "sqlite3 CLI not found (optional — npm module handles DB access)"
fi
echo

# ── 5. Database ──────────────────────────────────────────────────────────────
bold "5. Database"

DB_PATH=$(jq -r '.channels.twilio.shared.dbPath // .channels.twilio.dbPath // ""' "$CONFIG_FILE" 2>/dev/null)
if [[ -z "$DB_PATH" ]]; then
  DB_PATH="$HOME/.openclaw/shared/sms.db"
fi

if [[ -f "$DB_PATH" ]]; then
  pass "Database file exists: $DB_PATH"

  # Check contacts table
  HAS_CONTACTS=$(sqlite3 "$DB_PATH" "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='contacts';" 2>/dev/null || echo "0")
  if [[ "$HAS_CONTACTS" == "1" ]]; then
    CONTACT_COUNT=$(sqlite3 "$DB_PATH" "SELECT count(*) FROM contacts;" 2>/dev/null || echo "0")
    pass "contacts table exists ($CONTACT_COUNT rows)"
  else
    fail "contacts table not found"
  fi

  # Check twilio_conversations table
  HAS_CONV=$(sqlite3 "$DB_PATH" "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='twilio_conversations';" 2>/dev/null || echo "0")
  if [[ "$HAS_CONV" == "1" ]]; then
    CONV_COUNT=$(sqlite3 "$DB_PATH" "SELECT count(*) FROM twilio_conversations;" 2>/dev/null || echo "0")
    pass "twilio_conversations table exists ($CONV_COUNT rows)"
  else
    fail "twilio_conversations table not found"
  fi

  # Check sms_threads table (voipms compat)
  HAS_THREADS=$(sqlite3 "$DB_PATH" "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='sms_threads';" 2>/dev/null || echo "0")
  if [[ "$HAS_THREADS" == "1" ]]; then
    pass "sms_threads table exists (voipms-compatible)"
  else
    skip "sms_threads table not found (created on first use)"
  fi

  # Check WAL mode
  WAL_MODE=$(sqlite3 "$DB_PATH" "PRAGMA journal_mode;" 2>/dev/null || echo "unknown")
  if [[ "$WAL_MODE" == "wal" ]]; then
    pass "WAL journal mode active"
  else
    skip "Journal mode: $WAL_MODE (WAL recommended)"
  fi

  # Check shared with voipms-sms
  VOIPMS_DB=$(jq -r '.plugins.entries["voipms-sms"].config.dbPath // ""' "$CONFIG_FILE" 2>/dev/null || true)
  if [[ -n "$VOIPMS_DB" && "$VOIPMS_DB" == "$DB_PATH" ]]; then
    pass "Database shared with voipms-sms plugin"
  fi
else
  fail "Database file not found at $DB_PATH (run install.sh)"
fi
echo

# ── 6. Twilio API Connectivity ───────────────────────────────────────────────
bold "6. Twilio API Connectivity"

SID=$(jq -r '.channels.twilio.shared.accountSid // .channels.twilio.accountSid // ""' "$CONFIG_FILE" 2>/dev/null)
TOKEN=$(jq -r '.channels.twilio.shared.authToken // .channels.twilio.authToken // ""' "$CONFIG_FILE" 2>/dev/null)

# Fallback to env
SID="${SID:-${TWILIO_ACCOUNT_SID:-}}"
TOKEN="${TOKEN:-${TWILIO_AUTH_TOKEN:-}}"

if [[ -n "$SID" && -n "$TOKEN" ]]; then
  RESULT=$(node -e "
    const twilio = require('twilio');
    const client = twilio('$SID', '$TOKEN');
    client.api.accounts('$SID').fetch()
      .then(a => console.log('OK:' + a.friendlyName + ':' + a.status))
      .catch(e => console.log('ERR:' + e.message));
  " 2>/dev/null || echo "ERR:Node execution failed")

  if [[ "$RESULT" == OK:* ]]; then
    FRIENDLY=$(echo "$RESULT" | cut -d: -f2)
    STATUS=$(echo "$RESULT" | cut -d: -f3)
    pass "API connected: $FRIENDLY (status: $STATUS)"
  else
    fail "API connection failed: ${RESULT#ERR:}"
  fi

  # Validate DIDs
  if [[ -f "$CONFIG_FILE" ]]; then
    DIDS=$(jq -r '.channels.twilio.accounts // {} | keys[]' "$CONFIG_FILE" 2>/dev/null || true)
    for did in $DIDS; do
      DID_RESULT=$(node -e "
        const twilio = require('twilio');
        const client = twilio('$SID', '$TOKEN');
        client.incomingPhoneNumbers.list({phoneNumber: '$did'})
          .then(nums => nums.length > 0 ? console.log('OK:' + nums[0].friendlyName) : console.log('ERR:not found'))
          .catch(e => console.log('ERR:' + e.message));
      " 2>/dev/null || echo "ERR:check failed")

      if [[ "$DID_RESULT" == OK:* ]]; then
        pass "DID $did valid: ${DID_RESULT#OK:}"
      else
        fail "DID $did: ${DID_RESULT#ERR:}"
      fi
    done
  fi
else
  skip "No credentials available for API test"
fi
echo

# ── 6. Webhook reachability ──────────────────────────────────────────────────
bold "7. Webhook Reachability"

BASE_URL=$(jq -r '.channels.twilio.shared.webhook.baseUrl // .channels.twilio.webhook.baseUrl // ""' "$CONFIG_FILE" 2>/dev/null)
WEBHOOK_PATH=$(jq -r '.channels.twilio.shared.webhook.path // .channels.twilio.webhook.path // "/sms"' "$CONFIG_FILE" 2>/dev/null)

if [[ -n "$BASE_URL" ]]; then
  HEALTH_URL="${BASE_URL}/health"
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$HEALTH_URL" 2>/dev/null || echo "000")
  if [[ "$HTTP_CODE" == "200" ]]; then
    pass "Webhook reachable at $HEALTH_URL"
  else
    fail "Webhook not reachable at $HEALTH_URL (HTTP $HTTP_CODE)"
  fi
else
  skip "No baseUrl configured — cannot test external reachability"
fi

# Test local port
PORT=$(jq -r '.channels.twilio.shared.webhook.port // .channels.twilio.webhook.port // 3100' "$CONFIG_FILE" 2>/dev/null)
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${PORT}/health" 2>/dev/null || echo "000")
if [[ "$HTTP_CODE" == "200" ]]; then
  pass "Local webhook responding on port $PORT"
else
  skip "Local webhook not responding on port $PORT (is OpenClaw running?)"
fi
echo

# ── 7. Live SMS test ─────────────────────────────────────────────────────────
if [[ "$LIVE" == true ]]; then
  bold "8. Live SMS Test"
  printf 'Send test SMS to (E.164 number): '
  read -r TEST_TO
  if [[ -n "$TEST_TO" ]]; then
    FROM_NUM=$(jq -r '.channels.twilio.fromNumber // ""' "$CONFIG_FILE" 2>/dev/null)
    FROM_NUM="${FROM_NUM:-$(jq -r '.channels.twilio.accounts | to_entries[0].value.fromNumber // ""' "$CONFIG_FILE" 2>/dev/null)}"

    if [[ -n "$FROM_NUM" && -n "$SID" && -n "$TOKEN" ]]; then
      SEND_RESULT=$(node -e "
        const twilio = require('twilio');
        const client = twilio('$SID', '$TOKEN');
        client.messages.create({
          body: 'OpenClaw Twilio plugin test message',
          from: '$FROM_NUM',
          to: '$TEST_TO'
        })
          .then(m => console.log('OK:' + m.sid))
          .catch(e => console.log('ERR:' + e.message));
      " 2>/dev/null || echo "ERR:send failed")

      if [[ "$SEND_RESULT" == OK:* ]]; then
        pass "Test SMS sent: ${SEND_RESULT#OK:}"
      else
        fail "Test SMS failed: ${SEND_RESULT#ERR:}"
      fi
    else
      fail "Missing fromNumber or credentials for live test"
    fi
  else
    skip "No test number provided"
  fi
  echo
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo
bold "Results"
echo "════════"
green "  Passed:  $PASS"
[[ $FAIL -gt 0 ]] && red "  Failed:  $FAIL" || echo "  Failed:  $FAIL"
[[ $SKIP -gt 0 ]] && yellow "  Skipped: $SKIP" || echo "  Skipped: $SKIP"
echo

[[ $FAIL -gt 0 ]] && exit 1 || exit 0
