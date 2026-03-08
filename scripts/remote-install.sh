#!/usr/bin/env bash
# Remote installer for the OpenClaw Twilio channel plugin.
#
# Usage (one-liner on destination machine):
#   curl -fsSL https://raw.githubusercontent.com/DJTSmith18/openclaw-twilio/main/scripts/remote-install.sh | bash
#
# Or, to pin to a specific branch/tag:
#   curl -fsSL https://raw.githubusercontent.com/DJTSmith18/openclaw-twilio/main/scripts/remote-install.sh | bash -s -- --branch main
set -euo pipefail

REPO_URL="https://github.com/DJTSmith18/openclaw-twilio.git"
BRANCH="main"
CUSTOM_DIR=""   # set by --dir; empty means "derive from openclaw base"

# ── Parse args ────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --branch|-b) BRANCH="$2"; shift 2 ;;
    --dir|-d)    CUSTOM_DIR="$2"; shift 2 ;;
    --help|-h)
      echo "Usage: remote-install.sh [--branch <branch>] [--dir <path>]"
      echo "  --branch, -b   Git branch/tag to clone (default: main)"
      echo "  --dir,    -d   Plugin install directory (default: <openclaw-base>/extensions/twilio)"
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
echo "  ║        OpenClaw Twilio Plugin — Remote Installer      ║"
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

# ── Prereq: git ───────────────────────────────────────────────────────────────
if ! command -v git &>/dev/null; then
  red "git is required but not found."
  red "Install it first:  sudo apt install git   (or brew install git on macOS)"
  exit 1
fi
green "git found: $(git --version)"

# ── Clone or update ───────────────────────────────────────────────────────────
if [[ -d "$PLUGIN_DIR/.git" ]]; then
  cyan "Plugin directory already exists — pulling latest changes..."
  git -C "$PLUGIN_DIR" fetch origin
  git -C "$PLUGIN_DIR" checkout "$BRANCH"
  git -C "$PLUGIN_DIR" pull --ff-only origin "$BRANCH"
  green "Repository updated at $PLUGIN_DIR"
else
  cyan "Cloning $REPO_URL (branch: $BRANCH) → $PLUGIN_DIR"
  mkdir -p "$(dirname "$PLUGIN_DIR")"
  git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$PLUGIN_DIR"
  green "Repository cloned to $PLUGIN_DIR"
fi

echo

# ── Hand off to the bundled installer ────────────────────────────────────────
bold "Launching interactive installer..."
echo
# Export PLUGIN_DIR so install.sh uses the same directory we cloned into,
# rather than its own hardcoded default.
export PLUGIN_DIR
exec bash "$PLUGIN_DIR/scripts/install.sh"
