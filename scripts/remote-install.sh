#!/usr/bin/env bash
# Remote installer / upgrader for the OpenClaw Twilio channel plugin.
#
# Fresh install:
#   bash <(curl -fsSL https://raw.githubusercontent.com/DJTSmith18/openclaw-twilio/main/scripts/remote-install.sh)
#
# Upgrade existing install:
#   bash <(curl -fsSL https://raw.githubusercontent.com/DJTSmith18/openclaw-twilio/main/scripts/remote-install.sh) --upgrade
#
# Force full reconfiguration on an existing install:
#   bash <(curl -fsSL https://raw.githubusercontent.com/DJTSmith18/openclaw-twilio/main/scripts/remote-install.sh) --reconfigure
#
# NOTE: Use "bash <(curl ...)" not "curl ... | bash".
# Process substitution keeps stdin connected to the terminal so interactive
# prompts work. Piping through bash consumes stdin and breaks all read commands.
set -euo pipefail

REPO_OWNER="DJTSmith18"
REPO_NAME="openclaw-twilio"
BRANCH="main"
CUSTOM_DIR=""        # set by --dir; empty means "derive from openclaw base"
FORCE_UPGRADE=false  # skip prompts, just pull + npm install
FORCE_RECONFIGURE=false  # run full install.sh even on existing install

# ── Parse args ────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --branch|-b)      BRANCH="$2"; shift 2 ;;
    --dir|-d)         CUSTOM_DIR="$2"; shift 2 ;;
    --upgrade|-u)     FORCE_UPGRADE=true; shift ;;
    --reconfigure|-r) FORCE_RECONFIGURE=true; shift ;;
    --help|-h)
      echo "Usage: remote-install.sh [options]"
      echo "  --branch,      -b   Git branch/tag to clone (default: main)"
      echo "  --dir,         -d   Plugin install directory (default: <openclaw-base>/extensions/twilio)"
      echo "  --upgrade,     -u   Pull latest code and update deps; skip all config prompts"
      echo "  --reconfigure, -r   Force full interactive reconfiguration on an existing install"
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# ── Colours ───────────────────────────────────────────────────────────────────
red()    { printf '\033[31m%s\033[0m\n' "$*" >&2; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*" >&2; }
cyan()   { printf '\033[36m%s\033[0m\n' "$*"; }
bold()   { printf '\033[1m%s\033[0m\n' "$*"; }

echo
echo "  ╔═══════════════════════════════════════════════════════╗"
echo "  ║     OpenClaw Twilio Plugin — Install / Upgrade        ║"
echo "  ╚═══════════════════════════════════════════════════════╝"
echo

# ── Detect OpenClaw installation ─────────────────────────────────────────────
OPENCLAW_BASE="$HOME/.openclaw"

detect_openclaw() {
  local base="$1"

  # 1. Binary in PATH
  if command -v openclaw &>/dev/null; then
    green "OpenClaw found: $(command -v openclaw)"
    return 0
  fi

  # 2. Config file at the given base dir
  if [[ -f "$base/openclaw.json" ]]; then
    green "OpenClaw config found: $base/openclaw.json"
    return 0
  fi

  # 3. npm global install (binary may not be symlinked yet)
  if command -v npm &>/dev/null && npm list -g openclaw --depth=0 2>/dev/null | grep -q openclaw; then
    green "OpenClaw found via npm global packages"
    return 0
  fi

  return 1
}

if ! detect_openclaw "$OPENCLAW_BASE"; then
  yellow "OpenClaw was not detected at the standard location ($OPENCLAW_BASE)."
  printf 'Enter your OpenClaw base directory [%s]: ' "$OPENCLAW_BASE"
  read -r _input
  OPENCLAW_BASE="${_input:-$OPENCLAW_BASE}"
  OPENCLAW_BASE="${OPENCLAW_BASE/#\~/$HOME}"

  if [[ ! -f "$OPENCLAW_BASE/openclaw.json" ]]; then
    red "No openclaw.json found at $OPENCLAW_BASE"
    red "Please verify your OpenClaw installation and try again."
    exit 1
  fi
  green "OpenClaw config found: $OPENCLAW_BASE/openclaw.json"
fi
echo

# Derive CONFIG_FILE and PLUGIN_DIR from the confirmed base path.
# --dir overrides the plugin destination; otherwise use <base>/extensions/twilio.
export CONFIG_FILE="$OPENCLAW_BASE/openclaw.json"
PLUGIN_DIR="${CUSTOM_DIR:-$OPENCLAW_BASE/extensions/twilio}"

# ── Detect whether this is an existing install ────────────────────────────────
already_configured() {
  command -v jq &>/dev/null \
    && [[ -f "$CONFIG_FILE" ]] \
    && [[ "$(jq -r '.channels.twilio.enabled // empty' "$CONFIG_FILE" 2>/dev/null)" != "" ]]
}

IS_UPGRADE=false
if [[ -f "$PLUGIN_DIR/package.json" ]] && already_configured; then
  IS_UPGRADE=true
fi

# --reconfigure overrides --upgrade and auto-detect
if [[ "$FORCE_RECONFIGURE" == true ]]; then
  IS_UPGRADE=false
fi
# --upgrade flag forces upgrade mode even if auto-detect missed it
if [[ "$FORCE_UPGRADE" == true ]]; then
  IS_UPGRADE=true
fi

# ── Download plugin (curl tarball — no git required) ─────────────────────────
TARBALL_URL="https://github.com/${REPO_OWNER}/${REPO_NAME}/archive/refs/heads/${BRANCH}.tar.gz"
cyan "Downloading plugin from: $TARBALL_URL"
mkdir -p "$PLUGIN_DIR"

_tmp_tar=$(mktemp /tmp/openclaw-twilio-XXXXXX.tar.gz)
cyan "Saving tarball to: $_tmp_tar"
curl -fsSL --progress-bar "$TARBALL_URL" -o "$_tmp_tar"
_tar_size=$(du -sh "$_tmp_tar" 2>/dev/null | cut -f1)
green "Download complete ($_tar_size)"

cyan "Extracting to: $PLUGIN_DIR"
tar -xzv --strip-components=1 -C "$PLUGIN_DIR" -f "$_tmp_tar" 2>&1 | tail -20
rm -f "$_tmp_tar"

_file_count=$(find "$PLUGIN_DIR" -type f | wc -l | tr -d ' ')
green "Extraction complete — $_file_count files in $PLUGIN_DIR"

echo

# Export so install.sh uses the correct paths if invoked below.
export PLUGIN_DIR

# ── Upgrade path: update deps only, preserve all config ──────────────────────
if [[ "$IS_UPGRADE" == true ]]; then
  bold "Existing install detected — upgrading dependencies only."
  echo

  if [[ -f "$PLUGIN_DIR/package.json" ]]; then
    cyan "Running npm install..."
    npm install --omit=dev --prefix "$PLUGIN_DIR" 2>&1 | tail -5 || true
    green "Dependencies updated"
  fi

  echo

  # ── Config migration ──────────────────────────────────────────────────────
  # Migrate older config formats to the current structure:
  #   1. Move accountSid/authToken/dbPath/contactLookup/webhook into shared{}
  #   2. Remove top-level dmPolicy/allowFrom/groupPolicy from multi-DID setups
  # Both issues caused "openclaw doctor" to flag the config for migration.
  if command -v jq &>/dev/null && [[ -f "$CONFIG_FILE" ]]; then
    _needs_migration=false

    _has_shared=$(jq -r '.channels.twilio | has("shared")' "$CONFIG_FILE" 2>/dev/null || echo "false")
    _has_toplevel_creds=$(jq -r '.channels.twilio | has("accountSid")' "$CONFIG_FILE" 2>/dev/null || echo "false")
    if [[ "$_has_shared" == "false" && "$_has_toplevel_creds" == "true" ]]; then
      _needs_migration=true
    fi

    _has_accounts=$(jq -r '.channels.twilio.accounts | keys | length' "$CONFIG_FILE" 2>/dev/null || echo "0")
    _has_toplevel_policy=$(jq -r '.channels.twilio | has("dmPolicy") or has("allowFrom") or has("groupPolicy")' "$CONFIG_FILE" 2>/dev/null || echo "false")
    if [[ "$_has_accounts" -gt 0 && "$_has_toplevel_policy" == "true" ]]; then
      _needs_migration=true
    fi

    if [[ "$_needs_migration" == true ]]; then
      cyan "Migrating config to current format..."
      _backup="${CONFIG_FILE}.bak.$(date +%Y%m%d_%H%M%S)"
      cp "$CONFIG_FILE" "$_backup"
      _tmp=$(mktemp)
      jq '
        .channels.twilio |= (
          . as $t |
          . + {
            shared: (
              ($t.shared // {}) + {
                accountSid:   $t.accountSid,
                authToken:    $t.authToken,
                dbPath:       $t.dbPath,
                contactLookup: $t.contactLookup,
                webhook:      $t.webhook
              } | with_entries(select(.value != null))
            )
          }
          | del(.accountSid, .authToken, .dbPath, .contactLookup, .webhook,
                .dmPolicy, .allowFrom, .groupPolicy)
        )
      ' "$CONFIG_FILE" > "$_tmp" && mv "$_tmp" "$CONFIG_FILE"
      green "Config migrated (backup: $_backup)"
    else
      cyan "Config structure is up to date."
    fi

    # ── Migrate top-level messagingServiceSid into shared ────────────────
    _toplevel_msg=$(jq -r '.channels.twilio.messagingServiceSid // ""' "$CONFIG_FILE" 2>/dev/null || echo "")
    _shared_msg=$(jq -r '.channels.twilio.shared.messagingServiceSid // ""' "$CONFIG_FILE" 2>/dev/null || echo "")
    if [[ -n "$_toplevel_msg" && -z "$_shared_msg" ]]; then
      cyan "Migrating messagingServiceSid into shared..."
      _tmp=$(mktemp)
      jq '.channels.twilio.shared.messagingServiceSid = .channels.twilio.messagingServiceSid
          | del(.channels.twilio.messagingServiceSid)' \
        "$CONFIG_FILE" > "$_tmp" && mv "$_tmp" "$CONFIG_FILE"
      green "messagingServiceSid moved to shared: $_toplevel_msg"
    fi

    # ── Conversations API migration notice ────────────────────────────────
    _has_base_url=$(jq -r '.channels.twilio.shared.webhook.baseUrl // ""' "$CONFIG_FILE" 2>/dev/null || echo "")
    if [[ -z "$_has_base_url" ]]; then
      echo
      yellow "NOTE: 'baseUrl' is not set in your config."
      yellow "The plugin needs it to register your phone number with Twilio Conversations."
      yellow "Add it under channels.twilio.shared.webhook.baseUrl then restart OpenClaw."
      yellow "See docs/twilio-setup.md for details."
    else
      green "Conversations API: baseUrl configured → $_has_base_url"
    fi
  fi

  echo
  echo "  ╔═══════════════════════════════════════════════════════╗"
  echo "  ║           Upgrade complete!                           ║"
  echo "  ╚═══════════════════════════════════════════════════════╝"
  echo
  cyan "Current config summary:"
  if command -v jq &>/dev/null; then
    jq -r '
      .channels.twilio.shared |
      "  Account SID:  " + (.accountSid[0:8] // "?") + "...",
      "  Webhook port: " + (.webhook.port // "?" | tostring),
      "  Webhook path: " + (.webhook.path // "?"),
      "  Base URL:     " + (.webhook.baseUrl // "(not set — required for Conversations)"),
      "  DB path:      " + (.dbPath // "?")
    ' "$CONFIG_FILE" 2>/dev/null || true
    echo
    jq -r '
      .channels.twilio.accounts // {} | to_entries[] |
      "  DID:  " + .key + " (" + (.value.name // "unnamed") + ")"
    ' "$CONFIG_FILE" 2>/dev/null || true
  fi
  echo
  echo "  To apply changes: openclaw restart"
  echo "  To reconfigure:   re-run with --reconfigure"
  echo
  exit 0
fi

# ── Fresh install path ────────────────────────────────────────────────────────
bold "Launching interactive installer..."
echo
exec bash "$PLUGIN_DIR/scripts/install.sh"
