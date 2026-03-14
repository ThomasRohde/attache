#!/usr/bin/env bash
set -euo pipefail

# Attache installer
# Usage: curl -fsSL https://raw.githubusercontent.com/burkeholland/attache/main/install.sh | bash
# Dev:   ./install.sh --dev  (skips npm install, runs setup from local source)

DEV_MODE=false
if [ "${1:-}" = "--dev" ]; then
  DEV_MODE=true
fi

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
DIM='\033[2m'
RESET='\033[0m'

info() { echo -e "${BOLD}$1${RESET}"; }
success() { echo -e "${GREEN}$1${RESET}"; }
warn() { echo -e "${YELLOW}$1${RESET}"; }
error() { echo -e "${RED}$1${RESET}" >&2; }

run_setup() {
  if command -v attache &>/dev/null; then
    attache setup < /dev/tty
  else
    error "✗ Attache installed, but 'attache' is not on PATH yet."
    echo "  Open a new terminal and run: attache setup"
    exit 1
  fi
}

echo ""
info "╔══════════════════════════════════════════╗"
info "║        🤖  Attache Installer            ║"
info "╚══════════════════════════════════════════╝"
echo ""

if [ "$DEV_MODE" = true ]; then
  warn "  ⚡ Dev mode — skipping npm install, using local build"
  echo ""
fi

# Check Node.js
if ! command -v node &>/dev/null; then
  error "✗ Node.js is required but not installed."
  echo "  Install it from https://nodejs.org (v18 or later)"
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  error "✗ Node.js v18+ is required (found $(node -v))"
  echo "  Update from https://nodejs.org"
  exit 1
fi
echo -e "  ${GREEN}✓${RESET} Node.js $(node -v)"

# Check npm
if ! command -v npm &>/dev/null; then
  error "✗ npm is required but not installed."
  exit 1
fi
echo -e "  ${GREEN}✓${RESET} npm $(npm -v)"

# Check Copilot CLI
if command -v copilot &>/dev/null; then
  echo -e "  ${GREEN}✓${RESET} Copilot CLI found"
else
  warn "  ⚠ Copilot CLI not found — you'll need it before starting Attache"
  echo -e "    ${DIM}Install: npm install -g @github/copilot${RESET}"
fi

# Check gogcli (optional — Google services)
if command -v gog &>/dev/null; then
  echo -e "  ${GREEN}✓${RESET} gogcli found (Google services)"
else
  echo -e "  ${DIM}○ gogcli not found (optional — enables Gmail, Calendar, Drive, etc.)${RESET}"
  echo -e "    ${DIM}Install: brew install steipete/tap/gogcli${RESET}"
fi

echo ""

if [ "$DEV_MODE" = true ]; then
  info "Building Attache from local source..."
  npm run build
  echo ""
  info "Running Attache setup from local build..."
  echo ""
  node dist/setup.js < /dev/tty
else
  info "Installing Attache via npm..."
  npm install -g attache
  echo ""
  success "✅ Attache installed successfully!"
  echo ""
  info "Let's get Attache configured..."
  echo ""
  run_setup
fi
