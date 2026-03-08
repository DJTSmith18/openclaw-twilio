#!/usr/bin/env bash
# Interactive installer for the OpenClaw Twilio channel plugin.
# Usage: bash install.sh
set -euo pipefail

PLUGIN_ID="twilio"
PLUGIN_DIR="${PLUGIN_DIR:-$HOME/.openclaw/extensions/twilio}"
CONFIG_FILE="${CONFIG_FILE:-$HOME/.openclaw/openclaw.json}"
DEFAULT_DB_PATH="$HOME/.openclaw/shared/sms.db"

# ── Colours ───────────────────────────────────────────────────────────────────
red()    { printf '\033[31m%s\033[0m\n' "$*" >&2; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*" >&2; }
cyan()   { printf '\033[36m%s\033[0m\n' "$*"; }
bold()   { printf '\033[1m%s\033[0m\n' "$*"; }

# ── Prereq checks ────────────────────────────────────────────────────────────
check_prereqs() {
  local ok=true
  if ! command -v node &>/dev/null; then
    red "Node.js is required but not found."
    ok=false
  else
    local ver
    ver=$(node -e "console.log(process.versions.node.split('.')[0])")
    if [[ "$ver" -lt 18 ]]; then
      red "Node.js >= 18 required (found v${ver})."
      ok=false
    fi
  fi
  if ! command -v jq &>/dev/null; then
    red "jq is required but not found. Install: sudo apt install jq"
    ok=false
  fi
  if [[ ! -f "$CONFIG_FILE" ]]; then
    red "OpenClaw config not found at ${CONFIG_FILE}"
    ok=false
  fi
  if [[ "$ok" != true ]]; then
    red "Prerequisites not met. Aborting."
    exit 1
  fi
  green "Prerequisites OK (Node $(node -v), jq $(jq --version 2>&1))"
}

# ── Prompt helpers ────────────────────────────────────────────────────────────
prompt() {
  local var="$1" prompt_text="$2" default="$3"
  printf '%s [%s]: ' "$prompt_text" "$default"
  read -r input
  eval "$var=\"\${input:-$default}\""
}

prompt_secret() {
  local var="$1" prompt_text="$2" default="$3"
  printf '%s [%s]: ' "$prompt_text" "${default:+(set)}"
  read -r input
  eval "$var=\"\${input:-$default}\""
}

# ══════════════════════════════════════════════════════════════════════════════
echo
echo "  ╔═══════════════════════════════════════════════════════╗"
echo "  ║        OpenClaw Twilio Plugin Installer               ║"
echo "  ╚═══════════════════════════════════════════════════════╝"
echo

# Step 1: Prerequisites
bold "Step 1: Prerequisites"
check_prereqs
echo

# Step 2: Install dependencies
bold "Step 2: Installing dependencies"
cd "$PLUGIN_DIR"
if [[ -f "package.json" ]]; then
  npm install --omit=dev 2>&1 | tail -5 || true
  green "Dependencies installed"
else
  yellow "No package.json found — skipping npm install"
fi
echo

# Step 3: Twilio Credentials
bold "Step 3: Twilio Credentials"

ACCOUNT_SID=""
AUTH_TOKEN=""

# Check env vars first
if [[ -n "${TWILIO_ACCOUNT_SID:-}" ]]; then
  green "Found TWILIO_ACCOUNT_SID in environment: ${TWILIO_ACCOUNT_SID:0:8}..."
  printf 'Use environment credentials? [Y/n]: '
  read -r use_env
  use_env="${use_env:-Y}"
  if [[ "${use_env}" == [yY]* ]]; then
    ACCOUNT_SID="$TWILIO_ACCOUNT_SID"
    AUTH_TOKEN="${TWILIO_AUTH_TOKEN:-}"
  fi
fi

if [[ -z "$ACCOUNT_SID" ]]; then
  prompt ACCOUNT_SID "Twilio Account SID" ""
fi
if [[ -z "$AUTH_TOKEN" ]]; then
  prompt_secret AUTH_TOKEN "Twilio Auth Token" ""
fi

if [[ -z "$ACCOUNT_SID" || -z "$AUTH_TOKEN" ]]; then
  red "Account SID and Auth Token are required."
  exit 1
fi

# Validate credentials
cyan "Validating Twilio credentials..."
_twilio_response=$(curl -s -w "\n%{http_code}" \
  -u "$ACCOUNT_SID:$AUTH_TOKEN" \
  "https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}.json" 2>/dev/null)
_twilio_code=$(printf '%s' "$_twilio_response" | tail -1)
_twilio_body=$(printf '%s' "$_twilio_response" | head -1)

if [[ "$_twilio_code" == "200" ]]; then
  _friendly=$(printf '%s' "$_twilio_body" | jq -r '.friendly_name // "unknown"' 2>/dev/null || echo "unknown")
  green "Credentials valid: $_friendly"
else
  _twilio_msg=$(printf '%s' "$_twilio_body" | jq -r '.message // "HTTP $_twilio_code"' 2>/dev/null || echo "HTTP $_twilio_code")
  yellow "Warning: Could not validate credentials ($_twilio_msg)"
  printf 'Continue anyway? [y/N]: '
  read -r cont
  if [[ "${cont}" != [yY]* ]]; then
    exit 1
  fi
fi
echo

# Step 4: DID Setup (Phone Numbers)
bold "Step 4: Phone Number (DID) Setup"

declare -A DID_NAMES
declare -A DID_MSGSVC
DIDS=()

while true; do
  printf 'Enter a Twilio phone number in E.164 format (e.g. +12125551234), or "done": '
  read -r DID_INPUT
  [[ "$DID_INPUT" == "done" || -z "$DID_INPUT" ]] && break

  # Validate format
  if [[ ! "$DID_INPUT" =~ ^\+[0-9]{10,15}$ ]]; then
    yellow "Invalid format. Must be E.164 (e.g. +12125551234)."
    continue
  fi

  prompt DID_NAME "Display name for ${DID_INPUT}" "Line $(( ${#DIDS[@]} + 1 ))"
  prompt DID_MSGSVC_INPUT "Messaging Service SID (optional, for RCS)" ""

  DIDS+=("$DID_INPUT")
  DID_NAMES["$DID_INPUT"]="$DID_NAME"
  DID_MSGSVC["$DID_INPUT"]="$DID_MSGSVC_INPUT"

  green "Added: ${DID_INPUT} (${DID_NAME})"
  echo
done

if [[ ${#DIDS[@]} -eq 0 ]]; then
  yellow "No DIDs configured. Using environment variable TWILIO_FROM_NUMBER as fallback."
fi
echo

# Step 5: Webhook Configuration
bold "Step 5: Webhook Configuration"

prompt WEBHOOK_PORT "Webhook port" "3100"
prompt WEBHOOK_PATH "Webhook path" "/conversations/events"
prompt WEBHOOK_BASE_URL "Public base URL (e.g. https://example.com — required for Twilio to send webhooks to you)" ""
echo

# Step 6: Conversations Service SID
bold "Step 6: Conversations Service SID"
echo "  Find this in: Twilio Console → Conversations → Manage → Services → your service → SID"
echo "  It starts with IS... — leave blank to use the Twilio default service."
echo
prompt CONV_SERVICE_SID "Conversations Service SID (IS..., or blank for default)" ""
echo

# Step 7: Access Policies
bold "Step 7: Access Policies"

prompt DM_POLICY "Default DM policy (open/pairing/disabled)" "pairing"

ALLOW_FROM='[]'
if [[ "$DM_POLICY" == "pairing" || "$DM_POLICY" == "allowlist" ]]; then
  printf 'Enter allowFrom phone numbers (comma-separated E.164, or * for all): '
  read -r ALLOW_INPUT
  if [[ -n "$ALLOW_INPUT" ]]; then
    ALLOW_FROM=$(echo "$ALLOW_INPUT" | tr ',' '\n' | sed 's/^ *//;s/ *$//' | jq -R . | jq -s .)
  fi
fi

prompt GROUP_POLICY "Default group policy (open/allowlist/disabled)" "allowlist"
echo

# Step 8: Agent Bindings
bold "Step 8: Agent Bindings"

AGENTS=$(jq -r '.agents[]?.id // empty' "$CONFIG_FILE" 2>/dev/null || true)
if [[ -n "$AGENTS" ]]; then
  echo "Available agents:"
  echo "$AGENTS" | head -20 | while read -r a; do echo "    - $a"; done
fi

declare -A DID_AGENTS
for did in "${DIDS[@]}"; do
  prompt AGENT_ID "Agent for ${did} (${DID_NAMES[$did]})" ""
  if [[ -n "$AGENT_ID" ]]; then
    DID_AGENTS["$did"]="$AGENT_ID"
  fi
done
echo

# ──────────────────────────────────────────────────────────────────────────────
# Step 9: Database Setup (shared SQLite — contacts + conversation history)
# ──────────────────────────────────────────────────────────────────────────────
bold "Step 9: Database Setup"

DB_PATH=""
DB_SOURCE=""
CONTACTS_TABLE="contacts"
CONTACTS_PHONE_COL="phone"
CONTACTS_EXTRA_COLS="name"
VOIPMS_DETECTED=false

# ── 8a. Detect voipms-sms plugin ─────────────────────────────────────────────
VOIPMS_DB=$(jq -r '.plugins.entries["voipms-sms"].config.dbPath // empty' "$CONFIG_FILE" 2>/dev/null || true)

if [[ -n "$VOIPMS_DB" && -f "$VOIPMS_DB" ]]; then
  VOIPMS_DETECTED=true
  green "Detected voipms-sms plugin with database at: $VOIPMS_DB"

  # Read the contact lookup config from the first DID
  VOIPMS_TABLE=$(jq -r '
    .plugins.entries["voipms-sms"].config.dids
    | to_entries[0].value.contactLookup.table // "contacts"
  ' "$CONFIG_FILE" 2>/dev/null || echo "contacts")

  VOIPMS_PHONE_COL=$(jq -r '
    .plugins.entries["voipms-sms"].config.dids
    | to_entries[0].value.contactLookup.phoneColumn // "phone"
  ' "$CONFIG_FILE" 2>/dev/null || echo "phone")

  VOIPMS_PHONE_MATCH=$(jq -r '
    .plugins.entries["voipms-sms"].config.dids
    | to_entries[0].value.contactLookup.phoneMatch // "like"
  ' "$CONFIG_FILE" 2>/dev/null || echo "like")

  VOIPMS_SELECT_COLS=$(jq -r '
    .plugins.entries["voipms-sms"].config.dids
    | to_entries[0].value.contactLookup.selectColumns // ["*"]
    | join(",")
  ' "$CONFIG_FILE" 2>/dev/null || echo "*")

  VOIPMS_DISPLAY_NAME=$(jq -r '
    .plugins.entries["voipms-sms"].config.dids
    | to_entries[0].value.contactLookup.displayName // "name"
  ' "$CONFIG_FILE" 2>/dev/null || echo "name")

  echo "  Table:        $VOIPMS_TABLE"
  echo "  Phone column: $VOIPMS_PHONE_COL"
  echo "  Match mode:   $VOIPMS_PHONE_MATCH"
  echo "  Display name: $VOIPMS_DISPLAY_NAME"
  echo

  printf 'Share this database for centralized contacts? [Y/n]: '
  read -r share_db
  share_db="${share_db:-Y}"

  if [[ "${share_db}" == [yY]* ]]; then
    DB_PATH="$VOIPMS_DB"
    DB_SOURCE="voipms-sms"
    CONTACTS_TABLE="$VOIPMS_TABLE"
    CONTACTS_PHONE_COL="$VOIPMS_PHONE_COL"
    green "Using shared database: $DB_PATH"
  fi
fi

# ── 8b. If no shared DB, set up a new one ────────────────────────────────────
if [[ -z "$DB_PATH" ]]; then
  cyan "No existing shared database found. Setting up a new one."

  # Check for sqlite3 CLI
  if ! command -v sqlite3 &>/dev/null; then
    yellow "sqlite3 command not found. Attempting to install..."
    if command -v apt-get &>/dev/null; then
      sudo apt-get update -qq && sudo apt-get install -y -qq sqlite3 2>&1 | tail -3
    elif command -v dnf &>/dev/null; then
      sudo dnf install -y sqlite 2>&1 | tail -3
    elif command -v yum &>/dev/null; then
      sudo yum install -y sqlite 2>&1 | tail -3
    elif command -v brew &>/dev/null; then
      brew install sqlite 2>&1 | tail -3
    elif command -v pacman &>/dev/null; then
      sudo pacman -S --noconfirm sqlite 2>&1 | tail -3
    else
      red "Cannot auto-install sqlite3. Please install it manually and re-run."
      exit 1
    fi

    if command -v sqlite3 &>/dev/null; then
      green "sqlite3 installed: $(sqlite3 --version)"
    else
      red "sqlite3 installation failed. Please install manually."
      exit 1
    fi
  else
    green "sqlite3 found: $(sqlite3 --version)"
  fi

  # Prompt for DB path
  prompt DB_PATH "Database file path" "$DEFAULT_DB_PATH"
  DB_PATH="${DB_PATH/#\~/$HOME}"
  DB_SOURCE="new"

  # Create parent directory
  mkdir -p "$(dirname "$DB_PATH")"

  # Initialize database with WAL mode
  sqlite3 "$DB_PATH" "PRAGMA journal_mode=WAL; SELECT 1;" >/dev/null
  green "Database initialized: $DB_PATH"

  # ── 8c. Create voipms-compatible contacts table ───────────────────────────
  echo
  cyan "--- Contacts Table Setup ---"
  echo "Creating a contacts table compatible with the voipms-sms plugin."
  echo "If voipms-sms is installed later, it can share this same table."
  echo

  prompt CONTACTS_TABLE "Contacts table name" "contacts"
  prompt CONTACTS_PHONE_COL "Phone column name (PRIMARY KEY)" "phone"
  prompt CONTACTS_EXTRA_COLS "Additional columns (comma-separated)" "name,email"

  # Build column definitions
  COL_DEFS="${CONTACTS_PHONE_COL} TEXT PRIMARY KEY"
  IFS=',' read -ra EXTRA_ARR <<< "$CONTACTS_EXTRA_COLS"
  for col in "${EXTRA_ARR[@]}"; do
    col=$(echo "$col" | sed 's/^ *//;s/ *$//')
    if [[ -n "$col" ]]; then
      COL_DEFS="${COL_DEFS}, ${col} TEXT"
    fi
  done

  # Create the table
  sqlite3 "$DB_PATH" "CREATE TABLE IF NOT EXISTS ${CONTACTS_TABLE} (${COL_DEFS});"
  green "Contacts table '${CONTACTS_TABLE}' created"

  # Optionally seed contacts
  printf 'Import contacts now? [y/N]: '
  read -r import_contacts
  if [[ "${import_contacts}" == [yY]* ]]; then
    echo "Enter contacts (one per line: phone,name,email,...). Type 'done' to finish:"
    while true; do
      printf '  > '
      read -r contact_line
      [[ "$contact_line" == "done" || -z "$contact_line" ]] && break

      # Parse CSV values
      IFS=',' read -ra VALS <<< "$contact_line"
      PLACEHOLDERS=""
      SQL_VALS=""
      for i in "${!VALS[@]}"; do
        val=$(echo "${VALS[$i]}" | sed "s/'/''/g" | sed 's/^ *//;s/ *$//')
        if [[ $i -gt 0 ]]; then
          PLACEHOLDERS="${PLACEHOLDERS},"
        fi
        PLACEHOLDERS="${PLACEHOLDERS}'${val}'"
      done
      sqlite3 "$DB_PATH" "INSERT OR IGNORE INTO ${CONTACTS_TABLE} VALUES (${PLACEHOLDERS});" 2>/dev/null \
        && green "    Added" || yellow "    Skipped (may already exist)"
    done
  fi
fi

# ── 8d. Create twilio_conversations table (always) ──────────────────────────
echo
cyan "Creating twilio_conversations table..."
sqlite3 "$DB_PATH" "
CREATE TABLE IF NOT EXISTS twilio_conversations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  phone_number  TEXT    NOT NULL,
  did           TEXT    NOT NULL,
  account_id    TEXT    NOT NULL,
  agent         TEXT,
  direction     TEXT    NOT NULL,
  message       TEXT    NOT NULL,
  media_url     TEXT,
  message_sid   TEXT,
  chat_type     TEXT    DEFAULT 'direct',
  status        TEXT,
  context       TEXT,
  created_at    TEXT    DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_twilio_conv_did_phone
  ON twilio_conversations (did, phone_number);
"
green "Conversation history table ready"

# ── 8e. Also ensure sms_threads exists (voipms compat) ─────────────────────
sqlite3 "$DB_PATH" "
CREATE TABLE IF NOT EXISTS sms_threads (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  phone_number TEXT NOT NULL,
  did          TEXT NOT NULL,
  agent        TEXT NOT NULL,
  direction    TEXT NOT NULL,
  message      TEXT NOT NULL,
  context      TEXT,
  created_at   TEXT DEFAULT (datetime('now'))
);
" 2>/dev/null || true

# ── 8f. Ensure sms_language_preferences exists (voipms compat) ─────────────
sqlite3 "$DB_PATH" "
CREATE TABLE IF NOT EXISTS sms_language_preferences (
  phone_number       TEXT PRIMARY KEY,
  preferred_language TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
" 2>/dev/null || true

green "All database tables verified"
echo

# ── Build contact lookup config ──────────────────────────────────────────────
if [[ "$VOIPMS_DETECTED" == true && "$DB_SOURCE" == "voipms-sms" ]]; then
  CONTACT_LOOKUP_JSON=$(jq -n \
    --arg table "$CONTACTS_TABLE" \
    --arg phoneCol "$CONTACTS_PHONE_COL" \
    --arg phoneMatch "$VOIPMS_PHONE_MATCH" \
    --arg displayName "$VOIPMS_DISPLAY_NAME" \
    '{
      table: $table,
      phoneColumn: $phoneCol,
      phoneMatch: $phoneMatch,
      displayName: $displayName
    }')
else
  # Build select columns from extras
  SELECT_COLS_JSON="[]"
  if [[ -n "$CONTACTS_EXTRA_COLS" ]]; then
    SELECT_COLS_JSON=$(echo "$CONTACTS_EXTRA_COLS" | tr ',' '\n' | sed 's/^ *//;s/ *$//' | jq -R . | jq -s .)
  fi
  CONTACT_LOOKUP_JSON=$(jq -n \
    --arg table "$CONTACTS_TABLE" \
    --arg phoneCol "$CONTACTS_PHONE_COL" \
    --arg displayName "name" \
    --argjson selectCols "$SELECT_COLS_JSON" \
    '{
      table: $table,
      phoneColumn: $phoneCol,
      phoneMatch: "like",
      displayName: $displayName,
      selectColumns: $selectCols
    }')
fi

# Step 10: Register in openclaw.json
bold "Step 10: Registering plugin in openclaw.json"

backup="${CONFIG_FILE}.bak.$(date +%Y%m%d_%H%M%S)"
cp "$CONFIG_FILE" "$backup"
green "Backed up config to $backup"

tmp=$(mktemp)

# Add to plugins.allow
jq --arg id "$PLUGIN_ID" '
  if (.plugins.allow | index($id)) then . else .plugins.allow += [$id] end
' "$CONFIG_FILE" > "$tmp" && mv "$tmp" "$CONFIG_FILE"

# Add to plugins.load.paths
jq --arg path "$PLUGIN_DIR" '
  if (.plugins.load.paths | index($path)) then . else .plugins.load.paths += [$path] end
' "$CONFIG_FILE" > "$tmp" && mv "$tmp" "$CONFIG_FILE"

# Build accounts JSON
ACCOUNTS_JSON="{}"
for did in "${DIDS[@]}"; do
  ACCT_CFG=$(jq -n \
    --arg name "${DID_NAMES[$did]}" \
    --arg fromNumber "$did" \
    --arg msgSvc "${DID_MSGSVC[$did]}" \
    --arg policy "$DM_POLICY" \
    --argjson allowFrom "$ALLOW_FROM" \
    --arg groupPolicy "$GROUP_POLICY" \
    '{
      name: $name,
      fromNumber: $fromNumber,
      dmPolicy: $policy,
      allowFrom: $allowFrom,
      groupPolicy: $groupPolicy
    } + (if $msgSvc != "" then {messagingServiceSid: $msgSvc} else {} end)')

  ACCOUNTS_JSON=$(echo "$ACCOUNTS_JSON" | jq --arg did "$did" --argjson cfg "$ACCT_CFG" '. + {($did): $cfg}')
done

# Build webhook JSON
WEBHOOK_JSON=$(jq -n \
  --argjson port "$WEBHOOK_PORT" \
  --arg path "$WEBHOOK_PATH" \
  --arg baseUrl "$WEBHOOK_BASE_URL" \
  '{port: $port, path: $path} + (if $baseUrl != "" then {baseUrl: $baseUrl} else {} end)')

# Build shared infrastructure JSON — nested under "shared" so openclaw doctor
# does not mistake these for single-account fields and attempt a migration.
SHARED_JSON=$(jq -n \
  --arg sid "$ACCOUNT_SID" \
  --arg token "$AUTH_TOKEN" \
  --arg dbPath "$DB_PATH" \
  --arg convSid "$CONV_SERVICE_SID" \
  --argjson webhook "$WEBHOOK_JSON" \
  --argjson contactLookup "$CONTACT_LOOKUP_JSON" \
  '{
    accountSid: $sid,
    authToken: $token,
    dbPath: $dbPath,
    contactLookup: $contactLookup,
    webhook: $webhook
  } + (if $convSid != "" then {conversationServiceSid: $convSid} else {} end)')

# Build channel config.
# Always use the accounts block even for a single DID — this keeps the
# config structure consistent and makes adding DIDs later trivial.
# Only fall back to top-level single-account format when no DIDs were
# entered (env-var fallback mode, number unknown at install time).
if [[ ${#DIDS[@]} -gt 0 ]]; then
  CHANNEL_CONFIG=$(jq -n \
    --argjson shared "$SHARED_JSON" \
    --argjson accounts "$ACCOUNTS_JSON" \
    '{
      enabled: true,
      shared: $shared,
      accounts: $accounts
    }')
else
  # No DIDs entered — phone number comes from TWILIO_FROM_NUMBER at runtime.
  CHANNEL_CONFIG=$(jq -n \
    --argjson shared "$SHARED_JSON" \
    --arg policy "$DM_POLICY" \
    --argjson allowFrom "$ALLOW_FROM" \
    --arg groupPolicy "$GROUP_POLICY" \
    '{
      enabled: true,
      shared: $shared,
      dmPolicy: $policy,
      allowFrom: $allowFrom,
      groupPolicy: $groupPolicy
    }')
fi

# Apply channel config
jq --argjson cfg "$CHANNEL_CONFIG" '.channels.twilio = $cfg' "$CONFIG_FILE" > "$tmp" && mv "$tmp" "$CONFIG_FILE"

# Add plugin entry
jq --argjson cfg '{}' '.plugins.entries.twilio = {config: $cfg}' "$CONFIG_FILE" > "$tmp" && mv "$tmp" "$CONFIG_FILE"

# Add bindings
for did in "${DIDS[@]}"; do
  agent="${DID_AGENTS[$did]:-}"
  if [[ -n "$agent" ]]; then
    BINDING=$(jq -n --arg agent "$agent" --arg did "$did" \
      '{agentId: $agent, match: {channel: "twilio", accountId: $did}}')
    jq --argjson binding "$BINDING" '.bindings += [$binding]' "$CONFIG_FILE" > "$tmp" && mv "$tmp" "$CONFIG_FILE"
  fi
done

green "Plugin registered in openclaw.json"
echo

# Step 10: Summary
echo "  ╔═══════════════════════════════════════════════════════╗"
echo "  ║           Installation Successful!                    ║"
echo "  ╚═══════════════════════════════════════════════════════╝"
echo
echo "  Account SID:     ${ACCOUNT_SID:0:8}..."
if [[ ${#DIDS[@]} -gt 0 ]]; then
  for did in "${DIDS[@]}"; do
    agent="${DID_AGENTS[$did]:-<none>}"
    echo "  DID:             ${did} (${DID_NAMES[$did]}) → agent: ${agent}"
  done
else
  echo "  DID:             (using TWILIO_FROM_NUMBER env var)"
fi
echo "  Webhook:         http://0.0.0.0:${WEBHOOK_PORT}${WEBHOOK_PATH}"
echo "  DM Policy:       ${DM_POLICY}"
echo "  Group Policy:    ${GROUP_POLICY}"
echo
echo "  Database:        ${DB_PATH}"
if [[ "$DB_SOURCE" == "voipms-sms" ]]; then
  echo "                   (shared with voipms-sms plugin)"
fi
echo "  Contacts table:  ${CONTACTS_TABLE} (phone column: ${CONTACTS_PHONE_COL})"
echo "  History table:   twilio_conversations"
echo
echo "  Next Steps:"
echo "    1. Complete Twilio Console setup: see docs/twilio-setup.md"
echo "    2. Restart OpenClaw: openclaw restart"
echo "       The plugin will auto-register your DID with Twilio Conversations on startup."
echo "    3. Test: bash scripts/test.sh"
echo "    4. Manage settings: bash scripts/manage.sh"
echo
