#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/common.sh
source "${SCRIPT_DIR}/scripts/common.sh"

header "BattStat -- Installer"

require_root
detect_distro
ensure_node
ensure_service_user

# -- Copy files if running from outside APP_DIR --------------------------------
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

  if ! is_git_repo "$APP_DIR" && is_git_repo "$SCRIPT_DIR"; then
    info "Preserving git repository metadata..."
    cp -r "${SCRIPT_DIR}/.git" "${APP_DIR}/.git"
    success "Git metadata preserved -- 'sudo bash upgrade.sh' will use git pull"
  fi
else
  success "Running from ${APP_DIR} -- no copy needed"
fi

mkdir -p "$DATA_DIR"
ensure_build_tools
npm_install
fix_permissions

# -- Optional nginx reverse proxy setup ----------------------------------------
SETUP_NGINX=0
NGINX_HOSTNAME=""

echo ""
read -r -p "Set up nginx reverse proxy with HTTPS? [y/N] " NGINX_ANSWER
if [[ "$NGINX_ANSWER" =~ ^[Yy]$ ]]; then
  SETUP_NGINX=1
  echo ""
  read -r -p "Hostname (e.g. battstat.company.com): " NGINX_HOSTNAME
  NGINX_HOSTNAME="${NGINX_HOSTNAME// /}"  # strip spaces
  if [ -z "$NGINX_HOSTNAME" ]; then
    warn "No hostname entered -- skipping nginx setup"
    SETUP_NGINX=0
  fi
fi

if [ "$SETUP_NGINX" -eq 1 ]; then
  setup_nginx "$NGINX_HOSTNAME"
fi

install_service

if start_service; then
  header "Installation complete"

  if [ "$SETUP_NGINX" -eq 1 ] && [ -n "$NGINX_HOSTNAME" ]; then
    echo ""
    echo -e "${GREEN}${BOLD}  Dashboard -> https://${NGINX_HOSTNAME}${RESET}"
    echo ""
    warn "Self-signed cert: your browser will show a security warning."
    echo "  Accept it, or install the cert in your browser/OS trust store:"
    echo "  /etc/ssl/certs/${NGINX_HOSTNAME}.crt"
  else
    print_dashboard_url
  fi

  print_useful_commands

  USER_COUNT=$(DB_PATH="${DATA_DIR}/battstat.db" \
    node -e "try{const d=require('${APP_DIR}/db');process.stdout.write(String(d.getUsers().length))}catch(e){process.stdout.write('0')}" \
    2>/dev/null || echo "0")

  if [ "$USER_COUNT" = "0" ]; then
    echo ""
    info "No users found -- creating the initial admin account..."
    echo ""
    DB_PATH="${DATA_DIR}/battstat.db" node "${APP_DIR}/scripts/create-admin.js"
  else
    echo ""
    info "${USER_COUNT} existing user(s) found -- skipping admin creation."
  fi

  if command -v firewall-cmd &>/dev/null && [ "$SETUP_NGINX" -eq 0 ]; then
    echo ""
    warn "Firewalld detected. To expose the dashboard on your internal network:"
    echo "  sudo firewall-cmd --permanent --zone=internal --add-port=3000/tcp && sudo firewall-cmd --reload"
  fi
else
  exit 1
fi
