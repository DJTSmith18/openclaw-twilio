#!/usr/bin/env bash
# Uninstall the OpenClaw Twilio channel plugin.
# Usage: bash uninstall.sh [--force]
set -euo pipefail

PLUGIN_ID="twilio"
PLUGIN_DIR="$HOME/.openclaw/extensions/twilio"
CONFIG_FILE="$HOME/.openclaw/openclaw.json"
DATA_DIR="$HOME/.openclaw/data/twilio"

red()    { printf '\033[31m%s\033[0m\n' "$*" >&2; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*" >&2; }
bold()   { printf '\033[1m%s\033[0m\n' "$*"; }

FORCE=false
[[ "${1:-}" == "--force" ]] && FORCE=true

if [[ "$FORCE" != true ]]; then
  bold "Twilio Plugin Uninstaller"
  echo
  echo "This will:"
  echo "  1. Remove '$PLUGIN_ID' from openclaw.json (allow list, load paths, entries)"
  echo "  2. Remove channels.twilio config section"
  echo "  3. Remove Twilio agent bindings"
  echo "  4. Optionally delete conversation store data"
  echo
  printf 'Continue? [y/N]: '
  read -r confirm
  if [[ "${confirm}" != [yY]* ]]; then
    echo "Aborted."
    exit 0
  fi
fi

# Backup and clean config
if [[ -f "$CONFIG_FILE" ]]; then
  backup="${CONFIG_FILE}.bak.$(date +%Y%m%d_%H%M%S)"
  cp "$CONFIG_FILE" "$backup"
  green "Backed up config to $backup"

  tmp=$(mktemp)

  # Remove from plugins.allow
  jq --arg id "$PLUGIN_ID" \
    '.plugins.allow = [.plugins.allow[]? | select(. != $id)]' \
    "$CONFIG_FILE" > "$tmp" && mv "$tmp" "$CONFIG_FILE"

  # Remove from plugins.load.paths
  jq --arg path "$PLUGIN_DIR" \
    '.plugins.load.paths = [.plugins.load.paths[]? | select(. != $path)]' \
    "$CONFIG_FILE" > "$tmp" && mv "$tmp" "$CONFIG_FILE"

  # Remove plugin entry
  jq "del(.plugins.entries.${PLUGIN_ID})" "$CONFIG_FILE" > "$tmp" && mv "$tmp" "$CONFIG_FILE"

  # Remove channels.twilio section
  jq 'del(.channels.twilio)' "$CONFIG_FILE" > "$tmp" && mv "$tmp" "$CONFIG_FILE"

  # Remove Twilio bindings
  jq '.bindings = [.bindings[]? | select(.match.channel != "twilio")]' \
    "$CONFIG_FILE" > "$tmp" && mv "$tmp" "$CONFIG_FILE"

  green "Removed '$PLUGIN_ID' from openclaw.json"
fi

# Delete conversation store data?
if [[ -d "$DATA_DIR" ]]; then
  if [[ "$FORCE" != true ]]; then
    printf 'Delete conversation store data at %s? [y/N]: ' "$DATA_DIR"
    read -r del_data
  else
    del_data="y"
  fi
  if [[ "${del_data}" == [yY]* ]]; then
    rm -rf "$DATA_DIR"
    green "Deleted conversation data"
  else
    yellow "Conversation data kept at $DATA_DIR"
  fi
fi

echo
green "Twilio plugin uninstalled successfully."
echo "Restart OpenClaw to apply changes: openclaw restart"
