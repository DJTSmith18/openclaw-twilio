#!/usr/bin/env bash
# Interactive TUI management console for the OpenClaw Twilio plugin.
# Usage: bash manage.sh
set -euo pipefail

PLUGIN_ID="twilio"
CONFIG_FILE="$HOME/.openclaw/openclaw.json"

# ── Colours ───────────────────────────────────────────────────────────────────
red()    { printf '\033[31m%s\033[0m\n' "$*" >&2; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*" >&2; }
cyan()   { printf '\033[36m%s\033[0m\n' "$*"; }
bold()   { printf '\033[1m%s\033[0m\n' "$*"; }

# ── Config helpers ────────────────────────────────────────────────────────────
require_config() {
  if [[ ! -f "$CONFIG_FILE" ]]; then
    red "Config not found at $CONFIG_FILE"
    exit 1
  fi
}

get_twilio_config() {
  jq '.channels.twilio // empty' "$CONFIG_FILE" 2>/dev/null
}

backup_config() {
  local backup="${CONFIG_FILE}.bak.$(date +%Y%m%d_%H%M%S)"
  cp "$CONFIG_FILE" "$backup"
  green "Backed up config to $backup"
}

update_twilio_config() {
  local filter="$1"
  local tmp
  tmp=$(mktemp)
  jq "$filter" "$CONFIG_FILE" > "$tmp" && mv "$tmp" "$CONFIG_FILE"
}

prompt() {
  local var="$1" prompt_text="$2" default="$3"
  printf '%s [%s]: ' "$prompt_text" "$default"
  read -r input
  eval "$var=\"\${input:-$default}\""
}

prompt_secret() {
  local var="$1" prompt_text="$2" default="$3"
  printf '%s [%s]: ' "$prompt_text" "${default:+(hidden)}"
  read -rs input
  echo
  eval "$var=\"\${input:-$default}\""
}

require_config

# ── Main menu ─────────────────────────────────────────────────────────────────
while true; do
  echo
  bold "Twilio Plugin Management"
  echo "─────────────────────────"
  echo "  1) Twilio Credentials    — change Account SID, Auth Token"
  echo "  2) DID Management        — add/remove/enable/disable phone numbers"
  echo "  3) Webhook Settings      — port, path, base URL"
  echo "  4) DM Policies           — per-DID open/pairing/disabled + allowFrom"
  echo "  5) Group Policies        — per-DID open/allowlist/disabled"
  echo "  6) Agent Bindings        — assign DIDs to agents"
  echo "  7) RCS Settings          — enable/disable RCS, fallback to SMS"
  echo "  8) Status Callbacks      — configure delivery tracking"
  echo "  9) Database & Contacts   — view DB info, manage contacts"
  echo "  10) Group Management     — list/delete group MMS sessions"
  echo "  11) View Current Config  — display full config as formatted JSON"
  echo "  12) Save & Exit"
  echo
  printf 'Choice: '
  read -r choice

  case "$choice" in
    1)
      bold "Twilio Credentials"
      SID=$(jq -r '.channels.twilio.shared.accountSid // .channels.twilio.accountSid // "not set"' "$CONFIG_FILE")
      echo "  Current Account SID: ${SID:0:8}..."
      prompt NEW_SID "New Account SID (blank = keep)" ""
      prompt_secret NEW_TOKEN "New Auth Token (blank = keep)" ""
      if [[ -n "$NEW_SID" || -n "$NEW_TOKEN" ]]; then
        backup_config
        if [[ -n "$NEW_SID" ]]; then
          update_twilio_config --arg v "$NEW_SID" '.channels.twilio.shared.accountSid = $v'
        fi
        if [[ -n "$NEW_TOKEN" ]]; then
          update_twilio_config --arg v "$NEW_TOKEN" '.channels.twilio.shared.authToken = $v'
        fi
        green "Credentials updated"
      fi
      ;;

    2)
      bold "DID Management"
      echo "Current DIDs:"
      jq -r '.channels.twilio.accounts // {} | to_entries[] | "  \(.key) — \(.value.name // "unnamed") (enabled: \(.value.enabled // true))"' "$CONFIG_FILE" 2>/dev/null || echo "  (none)"
      echo
      echo "  a) Add DID"
      echo "  r) Remove DID"
      echo "  e) Enable/Disable DID"
      echo "  b) Back"
      printf 'Choice: '
      read -r sub

      case "$sub" in
        a)
          printf 'Phone number (E.164): '
          read -r NEW_DID
          if [[ ! "$NEW_DID" =~ ^\+[0-9]{10,15}$ ]]; then
            yellow "Invalid format."
          else
            prompt DID_NAME "Display name" "New Line"
            prompt MSG_SVC "Messaging Service SID (optional)" ""
            backup_config
            ACCT_JSON=$(jq -n --arg name "$DID_NAME" --arg from "$NEW_DID" \
              '{name: $name, fromNumber: $from, enabled: true}')
            if [[ -n "$MSG_SVC" ]]; then
              ACCT_JSON=$(echo "$ACCT_JSON" | jq --arg s "$MSG_SVC" '. + {messagingServiceSid: $s}')
            fi
            update_twilio_config --arg did "$NEW_DID" --argjson cfg "$ACCT_JSON" \
              '.channels.twilio.accounts[$did] = $cfg'
            green "Added DID: $NEW_DID"
          fi
          ;;
        r)
          printf 'DID to remove: '
          read -r RM_DID
          if [[ -n "$RM_DID" ]]; then
            backup_config
            update_twilio_config --arg did "$RM_DID" 'del(.channels.twilio.accounts[$did])'
            # Remove associated binding
            update_twilio_config --arg did "$RM_DID" \
              '.bindings = [.bindings[]? | select(.match.accountId != $did)]'
            green "Removed DID: $RM_DID"
          fi
          ;;
        e)
          printf 'DID to toggle: '
          read -r TOG_DID
          if [[ -n "$TOG_DID" ]]; then
            CURRENT=$(jq -r --arg d "$TOG_DID" '.channels.twilio.accounts[$d].enabled // true' "$CONFIG_FILE")
            if [[ "$CURRENT" == "true" ]]; then
              NEW_STATE="false"
            else
              NEW_STATE="true"
            fi
            backup_config
            update_twilio_config --arg d "$TOG_DID" --argjson v "$NEW_STATE" \
              '.channels.twilio.accounts[$d].enabled = $v'
            green "DID $TOG_DID enabled: $NEW_STATE"
          fi
          ;;
        *) ;;
      esac
      ;;

    3)
      bold "Webhook Settings"
      jq '.channels.twilio.shared.webhook // .channels.twilio.webhook // {}' "$CONFIG_FILE" 2>/dev/null
      prompt NEW_PORT "Port (blank = keep)" ""
      prompt NEW_PATH "Path (blank = keep)" ""
      prompt NEW_STATUS "Status path (blank = keep)" ""
      prompt NEW_BASE "Base URL (blank = keep)" ""
      if [[ -n "$NEW_PORT" || -n "$NEW_PATH" || -n "$NEW_STATUS" || -n "$NEW_BASE" ]]; then
        backup_config
        [[ -n "$NEW_PORT" ]] && update_twilio_config --argjson v "$NEW_PORT" \
          '.channels.twilio.shared.webhook.port = $v'
        [[ -n "$NEW_PATH" ]] && update_twilio_config --arg v "$NEW_PATH" \
          '.channels.twilio.shared.webhook.path = $v'
        [[ -n "$NEW_STATUS" ]] && update_twilio_config --arg v "$NEW_STATUS" \
          '.channels.twilio.shared.webhook.statusPath = $v'
        [[ -n "$NEW_BASE" ]] && update_twilio_config --arg v "$NEW_BASE" \
          '.channels.twilio.shared.webhook.baseUrl = $v'
        green "Webhook settings updated"
      fi
      ;;

    4)
      bold "DM Policies"
      echo "Current default:"
      jq -r '"  dmPolicy: \(.channels.twilio.dmPolicy // "pairing")\n  allowFrom: \(.channels.twilio.allowFrom // [])"' "$CONFIG_FILE"
      echo
      echo "Per-DID overrides:"
      jq -r '.channels.twilio.accounts // {} | to_entries[] | "  \(.key): dmPolicy=\(.value.dmPolicy // "inherit") allowFrom=\(.value.allowFrom // [])"' "$CONFIG_FILE" 2>/dev/null || echo "  (none)"
      echo
      printf 'DID to configure (or "default" for top-level): '
      read -r POL_DID
      if [[ -n "$POL_DID" ]]; then
        prompt NEW_POL "DM policy (open/pairing/allowlist/disabled)" "pairing"
        backup_config
        if [[ "$POL_DID" == "default" ]]; then
          update_twilio_config --arg v "$NEW_POL" '.channels.twilio.dmPolicy = $v'
        else
          update_twilio_config --arg d "$POL_DID" --arg v "$NEW_POL" \
            '.channels.twilio.accounts[$d].dmPolicy = $v'
        fi
        if [[ "$NEW_POL" == "pairing" || "$NEW_POL" == "allowlist" ]]; then
          printf 'allowFrom numbers (comma-separated E.164, or * for all): '
          read -r AF_INPUT
          if [[ -n "$AF_INPUT" ]]; then
            AF_JSON=$(echo "$AF_INPUT" | tr ',' '\n' | sed 's/^ *//;s/ *$//' | jq -R . | jq -s .)
            if [[ "$POL_DID" == "default" ]]; then
              update_twilio_config --argjson v "$AF_JSON" '.channels.twilio.allowFrom = $v'
            else
              update_twilio_config --arg d "$POL_DID" --argjson v "$AF_JSON" \
                '.channels.twilio.accounts[$d].allowFrom = $v'
            fi
          fi
        fi
        green "DM policy updated"
      fi
      ;;

    5)
      bold "Group Policies"
      echo "Current default:"
      jq -r '"  groupPolicy: \(.channels.twilio.groupPolicy // "allowlist")"' "$CONFIG_FILE"
      echo
      printf 'DID to configure (or "default"): '
      read -r GP_DID
      if [[ -n "$GP_DID" ]]; then
        prompt NEW_GP "Group policy (open/allowlist/disabled)" "allowlist"
        backup_config
        if [[ "$GP_DID" == "default" ]]; then
          update_twilio_config --arg v "$NEW_GP" '.channels.twilio.groupPolicy = $v'
        else
          update_twilio_config --arg d "$GP_DID" --arg v "$NEW_GP" \
            '.channels.twilio.accounts[$d].groupPolicy = $v'
        fi
        green "Group policy updated"
      fi
      ;;

    6)
      bold "Agent Bindings"
      echo "Current bindings:"
      jq -r '.bindings[]? | select(.match.channel == "twilio") | "  \(.match.accountId // "default") → agent: \(.agentId)"' "$CONFIG_FILE" 2>/dev/null || echo "  (none)"
      echo
      echo "Available agents:"
      jq -r '.agents[]?.id // empty' "$CONFIG_FILE" 2>/dev/null | head -20 | while read -r a; do echo "    - $a"; done
      echo
      printf 'DID to bind: '
      read -r BIND_DID
      if [[ -n "$BIND_DID" ]]; then
        prompt BIND_AGENT "Agent ID" ""
        if [[ -n "$BIND_AGENT" ]]; then
          backup_config
          # Remove existing binding for this DID
          update_twilio_config --arg d "$BIND_DID" \
            '.bindings = [.bindings[]? | select(.match.channel != "twilio" or .match.accountId != $d)]'
          # Add new binding
          BINDING=$(jq -n --arg agent "$BIND_AGENT" --arg did "$BIND_DID" \
            '{agentId: $agent, match: {channel: "twilio", accountId: $did}}')
          update_twilio_config --argjson b "$BINDING" '.bindings += [$b]'
          green "Bound $BIND_DID → $BIND_AGENT"
        fi
      fi
      ;;

    7)
      bold "RCS Settings"
      echo "Per-DID RCS config:"
      jq -r '.channels.twilio.accounts // {} | to_entries[] | "  \(.key): rcs=\(.value.rcs // {})"' "$CONFIG_FILE" 2>/dev/null || echo "  (none)"
      echo
      printf 'DID to configure: '
      read -r RCS_DID
      if [[ -n "$RCS_DID" ]]; then
        printf 'Enable RCS? [y/N]: '
        read -r RCS_EN
        if [[ "${RCS_EN}" == [yY]* ]]; then
          printf 'Fallback to SMS? [Y/n]: '
          read -r RCS_FB
          RCS_FB="${RCS_FB:-Y}"
          FALLBACK="true"
          [[ "${RCS_FB}" == [nN]* ]] && FALLBACK="false"
          backup_config
          update_twilio_config --arg d "$RCS_DID" --argjson fb "$FALLBACK" \
            '.channels.twilio.accounts[$d].rcs = {enabled: true, fallbackToSms: $fb}'
          green "RCS enabled for $RCS_DID (fallback: $FALLBACK)"
        else
          backup_config
          update_twilio_config --arg d "$RCS_DID" \
            '.channels.twilio.accounts[$d].rcs = {enabled: false}'
          green "RCS disabled for $RCS_DID"
        fi
      fi
      ;;

    8)
      bold "Status Callbacks"
      echo "Current webhook config:"
      jq '.channels.twilio.shared.webhook // .channels.twilio.webhook // {}' "$CONFIG_FILE" 2>/dev/null
      echo
      echo "Status callbacks are automatically configured when baseUrl is set."
      echo "Current status path:"
      jq -r '.channels.twilio.shared.webhook.statusPath // .channels.twilio.webhook.statusPath // "/sms/status"' "$CONFIG_FILE"
      prompt NEW_STATUS_PATH "New status path (blank = keep)" ""
      if [[ -n "$NEW_STATUS_PATH" ]]; then
        backup_config
        update_twilio_config --arg v "$NEW_STATUS_PATH" \
          '.channels.twilio.shared.webhook.statusPath = $v'
        green "Status callback path updated"
      fi
      ;;

    9)
      bold "Database & Contacts"
      DB_PATH=$(jq -r '.channels.twilio.shared.dbPath // .channels.twilio.dbPath // ""' "$CONFIG_FILE" 2>/dev/null)
      if [[ -z "$DB_PATH" ]]; then
        DB_PATH="$HOME/.openclaw/shared/sms.db"
      fi
      echo "  Database: $DB_PATH"

      VOIPMS_DB=$(jq -r '.plugins.entries["voipms-sms"].config.dbPath // ""' "$CONFIG_FILE" 2>/dev/null || true)
      if [[ -n "$VOIPMS_DB" && "$VOIPMS_DB" == "$DB_PATH" ]]; then
        echo "  Shared with: voipms-sms plugin"
      fi

      if [[ -f "$DB_PATH" ]]; then
        echo
        TABLES=$(sqlite3 "$DB_PATH" ".tables" 2>/dev/null || echo "(error)")
        echo "  Tables: $TABLES"

        CONTACT_TABLE=$(jq -r '.channels.twilio.shared.contactLookup.table // .channels.twilio.contactLookup.table // "contacts"' "$CONFIG_FILE" 2>/dev/null)
        CONTACT_COUNT=$(sqlite3 "$DB_PATH" "SELECT count(*) FROM ${CONTACT_TABLE};" 2>/dev/null || echo "0")
        CONV_COUNT=$(sqlite3 "$DB_PATH" "SELECT count(*) FROM twilio_conversations;" 2>/dev/null || echo "0")
        GROUP_COUNT=$(sqlite3 "$DB_PATH" "SELECT count(*) FROM twilio_groups;" 2>/dev/null || echo "0")
        echo "  Contacts ($CONTACT_TABLE): $CONTACT_COUNT rows"
        echo "  Conversation history: $CONV_COUNT rows"
        echo "  Group MMS sessions:  $GROUP_COUNT rows"
        echo
        echo "  a) View recent contacts"
        echo "  b) Add a contact"
        echo "  c) View recent conversations"
        echo "  d) Change database path"
        echo "  e) Back"
        printf 'Choice: '
        read -r db_sub

        case "$db_sub" in
          a)
            echo
            PHONE_COL=$(jq -r '.channels.twilio.shared.contactLookup.phoneColumn // .channels.twilio.contactLookup.phoneColumn // "phone"' "$CONFIG_FILE" 2>/dev/null)
            sqlite3 -header -column "$DB_PATH" "SELECT * FROM ${CONTACT_TABLE} LIMIT 20;" 2>/dev/null || echo "(empty or error)"
            ;;
          b)
            PHONE_COL=$(jq -r '.channels.twilio.shared.contactLookup.phoneColumn // .channels.twilio.contactLookup.phoneColumn // "phone"' "$CONFIG_FILE" 2>/dev/null)
            printf 'Phone (10 digits or E.164): '
            read -r NEW_PHONE
            prompt NEW_NAME "Name" ""
            prompt NEW_EMAIL "Email" ""
            if [[ -n "$NEW_PHONE" ]]; then
              CLEAN_PHONE=$(echo "$NEW_PHONE" | sed 's/[^0-9]//g' | grep -oP '.{10}$' || echo "$NEW_PHONE")
              sqlite3 "$DB_PATH" "INSERT OR REPLACE INTO ${CONTACT_TABLE} (${PHONE_COL}, name, email) VALUES ('${CLEAN_PHONE}', '${NEW_NAME}', '${NEW_EMAIL}');" 2>/dev/null \
                && green "Contact added" || red "Failed to add contact"
            fi
            ;;
          c)
            echo
            sqlite3 -header -column "$DB_PATH" \
              "SELECT id, phone_number, did, direction, substr(message,1,40) as message, created_at FROM twilio_conversations WHERE context NOT LIKE 'ref:%' ORDER BY created_at DESC LIMIT 20;" \
              2>/dev/null || echo "(empty or error)"
            ;;
          d)
            prompt NEW_DB_PATH "New database path" "$DB_PATH"
            if [[ -n "$NEW_DB_PATH" && "$NEW_DB_PATH" != "$DB_PATH" ]]; then
              backup_config
              update_twilio_config --arg v "$NEW_DB_PATH" '.channels.twilio.shared.dbPath = $v'
              green "Database path updated to $NEW_DB_PATH"
            fi
            ;;
          *) ;;
        esac
      else
        red "Database file not found at $DB_PATH"
        prompt NEW_DB_PATH "Set database path" "$DB_PATH"
        if [[ -n "$NEW_DB_PATH" ]]; then
          backup_config
          update_twilio_config --arg v "$NEW_DB_PATH" '.channels.twilio.shared.dbPath = $v'
          green "Database path updated"
        fi
      fi
      ;;

    10)
      bold "Group MMS Management"
      DB_PATH=$(jq -r '.channels.twilio.shared.dbPath // .channels.twilio.dbPath // ""' "$CONFIG_FILE" 2>/dev/null)
      [[ -z "$DB_PATH" ]] && DB_PATH="$HOME/.openclaw/shared/sms.db"
      if [[ ! -f "$DB_PATH" ]]; then
        red "Database not found at $DB_PATH"
      else
        echo "  a) List recent groups"
        echo "  b) Delete a group (forces new session on next message)"
        echo "  c) Clear ALL groups (nuclear reset)"
        echo "  d) Back"
        printf 'Choice: '
        read -r grp_sub
        case "$grp_sub" in
          a)
            echo
            sqlite3 -header -column "$DB_PATH" \
              "SELECT group_id, account_id, participants, datetime(updated_at/1000,'unixepoch') as updated FROM twilio_groups ORDER BY updated_at DESC LIMIT 20;" \
              2>/dev/null || echo "(empty or error)"
            ;;
          b)
            printf 'Group ID to delete: '
            read -r DEL_GID
            if [[ -n "$DEL_GID" ]]; then
              sqlite3 "$DB_PATH" "DELETE FROM twilio_groups WHERE group_id = '${DEL_GID}';" 2>/dev/null \
                && green "Group $DEL_GID deleted" || red "Delete failed"
            fi
            ;;
          c)
            printf 'Delete ALL groups? This will reset all group sessions. [y/N]: '
            read -r confirm_clear
            if [[ "${confirm_clear}" == [yY]* ]]; then
              sqlite3 "$DB_PATH" "DELETE FROM twilio_groups;" 2>/dev/null \
                && green "All groups cleared" || red "Clear failed"
            fi
            ;;
          *) ;;
        esac
      fi
      ;;

    11)
      bold "Current Twilio Configuration"
      echo "─────────────────────────────"
      jq '.channels.twilio' "$CONFIG_FILE" 2>/dev/null || echo "(not configured)"
      echo
      bold "Twilio Bindings"
      jq '[.bindings[]? | select(.match.channel == "twilio")]' "$CONFIG_FILE" 2>/dev/null || echo "[]"
      ;;

    12)
      green "Done."
      exit 0
      ;;

    *)
      yellow "Invalid choice."
      ;;
  esac
done
