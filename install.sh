#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/scripts/common.sh"

header "UPS Monitor — Installer"

require_root
detect_distro
ensure_node
ensure_service_user

# ── Copy files if running from outside APP_DIR ────────────────────────────────
if [ "$SCRIPT_DIR" != "$APP_DIR" ]; then
  info "Installing files to ${APP_DIR}..."
  mkdir -p "$APP_DIR"

  if command -v rsync &>/dev/null; then
    rsync -a --exclude='data/' --exclude='node_modules/' \
      "${SCRIPT_DIR}/" "${APP_DIR}/"
  else
    find "$SCRIPT_DIR" -mindepth 1 -maxdepth 1 \
      ! -name 'data' ! -name 'node_modules' \
      -exec cp -r {} "$APP_DIR/" \;
  fi
  success "Files copied to ${APP_DIR}"

  # Preserve .git metadata if source was a git clone
  if ! is_git_repo "$APP_DIR" && is_git_repo "$SCRIPT_DIR"; then
    info "Preserving git repository metadata..."
    cp -r "${SCRIPT_DIR}/.git" "${APP_DIR}/.git"
    success "Git metadata preserved — upgrades via 'git pull' will work"
  fi
else
  success "Running from ${APP_DIR} — no copy needed"
fi

mkdir -p "$DATA_DIR"
npm_install
fix_permissions
install_service

if start_service; then
  header "Installation complete"
  print_dashboard_url
  print_useful_commands

  # Only run first-user setup if the database has no users yet
  USER_COUNT=$(DB_PATH="${DATA_DIR}/ups-monitor.db" node -e \
    "try{const d=require('${APP_DIR}/db');process.stdout.write(String(d.getUsers().length))}catch(e){process.stdout.write('0')}" \
    2>/dev/null || echo "0")

  if [ "$USER_COUNT" = "0" ]; then
    echo ""
    info "No users found. Creating the initial admin account..."
    echo ""
    DB_PATH="${DATA_DIR}/ups-monitor.db" node "${APP_DIR}/scripts/create-admin.js"
  else
    echo ""
    info "${USER_COUNT} existing user(s) found — skipping admin creation."
  fi

  if command -v firewall-cmd &>/dev/null; then
    echo ""
    warn "Firewalld detected. To expose the dashboard on your internal network:"
    echo "  sudo firewall-cmd --permanent --zone=internal --add-port=3000/tcp && sudo firewall-cmd --reload"
  fi
else
  exit 1
fi
