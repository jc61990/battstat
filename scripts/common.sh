#!/bin/bash
# Shared functions used by install.sh, upgrade.sh, and uninstall.sh.
# Source this file -- do not run directly.

APP_DIR="/opt/battstat"
SERVICE_NAME="battstat"
SERVICE_USER="battstat"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
DATA_DIR="${APP_DIR}/data"
BACKUP_DIR="/var/backups/battstat"

# -- Colour helpers ------------------------------------------------------------
RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

info()    { echo -e "${CYAN}>${RESET} $*"; }
success() { echo -e "${GREEN}[OK]${RESET} $*"; }
warn()    { echo -e "${YELLOW}[WARN]${RESET}  $*"; }
error()   { echo -e "${RED}[ERR]${RESET}  $*" >&2; }
header()  { echo -e "\n${BOLD}$*${RESET}"; echo "$(echo "$*" | tr '[:print:]' '-')"; }

# -- Root guard ----------------------------------------------------------------
require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    error "This script must be run as root or with sudo."
    exit 1
  fi
}

# -- Detect distro / package manager ------------------------------------------
# Sets DISTRO (debian|fedora|rhel) and PKG_MGR (apt-get|dnf|yum).
# Safe to call multiple times -- detection result is cached.
detect_distro() {
  if [ -n "${DISTRO:-}" ]; then return; fi  # already detected
  if command -v apt-get &>/dev/null; then
    DISTRO="debian"
    PKG_MGR="apt-get"
  elif command -v dnf &>/dev/null; then
    DISTRO="fedora"
    PKG_MGR="dnf"
  elif command -v yum &>/dev/null; then
    DISTRO="rhel"
    PKG_MGR="yum"
  else
    error "Unsupported distribution. Supported: Debian/Ubuntu, Fedora, RHEL/Rocky/AlmaLinux."
    exit 1
  fi
  info "Detected: ${DISTRO} (${PKG_MGR})"
}

# -- Build tools ---------------------------------------------------------------
# better-sqlite3 and ldapjs compile native C++ addons during npm install.
# On a minimal server image the compiler toolchain is often absent.
ensure_build_tools() {
  detect_distro
  info "Checking build tools (required for native npm modules)..."

  local missing=()

  command -v gcc   &>/dev/null || missing+=("gcc")
  command -v g++   &>/dev/null || missing+=("g++ / gcc-c++")
  command -v make  &>/dev/null || missing+=("make")
  command -v python3 &>/dev/null || missing+=("python3")

  if [ "${#missing[@]}" -eq 0 ]; then
    success "Build tools present"
    return
  fi

  warn "Missing build tools: ${missing[*]}"
  info "Installing compiler toolchain..."

  case "$DISTRO" in
    debian)
      apt-get install -y build-essential python3
      ;;
    fedora|rhel)
      # gcc-c++ pulls in gcc; python3 is the package name on both
      "${PKG_MGR}" install -y gcc gcc-c++ make python3
      ;;
  esac

  success "Build tools installed"
}

# -- Node.js install / check ---------------------------------------------------
ensure_node() {
  if command -v node &>/dev/null; then
    local ver
    ver=$(node -e "process.stdout.write(process.version.split('.')[0].slice(1))")
    if [ "$ver" -lt 18 ]; then
      warn "Node.js v${ver} found but 18+ is required -- upgrading..."
      install_node
    else
      success "Node.js $(node --version) already installed"
    fi
  else
    info "Node.js not found -- installing Node.js 20 LTS..."
    install_node
  fi
  success "npm $(npm --version)"
}

install_node() {
  detect_distro
  case "$DISTRO" in
    debian)
      curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
      apt-get install -y nodejs
      ;;
    fedora|rhel)
      curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
      "${PKG_MGR}" install -y nodejs
      ;;
  esac
  success "Node.js $(node --version) installed"
}

# -- System user ---------------------------------------------------------------
ensure_service_user() {
  if id "$SERVICE_USER" &>/dev/null; then
    success "System user '${SERVICE_USER}' already exists"
  else
    info "Creating system user '${SERVICE_USER}'..."
    useradd --system --no-create-home --shell /sbin/nologin "$SERVICE_USER"
    success "Created system user '${SERVICE_USER}'"
  fi
}

# -- Git detection -------------------------------------------------------------
is_git_repo() {
  git -C "$1" rev-parse --git-dir &>/dev/null 2>&1
}

get_git_version() {
  # Try APP_DIR first, then fall back to wherever the script is running from
  local repo=""
  if is_git_repo "$APP_DIR"; then
    repo="$APP_DIR"
  elif [ -n "${SCRIPT_DIR:-}" ] && is_git_repo "$SCRIPT_DIR"; then
    repo="$SCRIPT_DIR"
  fi
  if [ -n "$repo" ]; then
    # Show short hash + first line of commit message, e.g. "abc1234 Fix CSP headers"
    git -C "$repo" log -1 --format="%h %s" 2>/dev/null \
      || echo "unknown"
  else
    echo "unknown"
  fi
}

get_git_remote() {
  git -C "$APP_DIR" remote get-url origin 2>/dev/null || echo ""
}

# -- npm install ---------------------------------------------------------------
npm_install() {
  info "Installing Node.js dependencies..."
  cd "$APP_DIR"

  # Show output but suppress the noisy funding/audit lines
  if ! npm install --omit=dev 2>&1 \
      | grep -v "^npm warn" \
      | grep -v "^npm notice" \
      | grep -v "funding" \
      | grep -v "looking for funding"; then
    error "npm install failed -- check output above"
    exit 1
  fi

  success "Dependencies installed"
}

# -- Permissions ---------------------------------------------------------------
fix_permissions() {
  chown -R "${SERVICE_USER}:${SERVICE_USER}" "$APP_DIR"
  chmod 750 "$APP_DIR"
  chmod 770 "$DATA_DIR"
  if [ -f "${DATA_DIR}/battstat.db" ]; then
    chmod 660 "${DATA_DIR}/battstat.db"
    chown "${SERVICE_USER}:${SERVICE_USER}" "${DATA_DIR}/battstat.db"
  fi
  if [ -d "${APP_DIR}/node_modules" ]; then
    chmod 750 "${APP_DIR}/node_modules"
  fi
}

# -- Systemd -------------------------------------------------------------------
install_service() {
  info "Installing systemd service..."
  cp "${APP_DIR}/battstat.service" "$SERVICE_FILE"
  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME"
  success "Service installed and enabled"
}

start_service() {
  info "Starting service..."
  systemctl restart "$SERVICE_NAME"
  sleep 3
  if systemctl is-active --quiet "$SERVICE_NAME"; then
    success "Service is running"
    return 0
  else
    error "Service failed to start. Check: journalctl -u ${SERVICE_NAME} -n 50"
    return 1
  fi
}

stop_service() {
  if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
    info "Stopping service..."
    systemctl stop "$SERVICE_NAME"
    success "Service stopped"
  fi
}

disable_service() {
  if systemctl is-enabled --quiet "$SERVICE_NAME" 2>/dev/null; then
    info "Disabling service..."
    systemctl disable "$SERVICE_NAME"
  fi
}

# -- Backup --------------------------------------------------------------------
backup_data() {
  local label="${1:-manual}"
  local ts dest
  ts=$(date +%Y%m%d_%H%M%S)
  dest="${BACKUP_DIR}/${ts}_${label}"

  mkdir -p "$BACKUP_DIR"
  chmod 700 "$BACKUP_DIR"

  if [ -f "${DATA_DIR}/battstat.db" ]; then
    info "Backing up database to ${dest}..."
    mkdir -p "$dest"
    cp "${DATA_DIR}/battstat.db" "${dest}/battstat.db"
    printf "version=%s\ntimestamp=%s\nlabel=%s\n" \
      "$(get_git_version)" "$ts" "$label" > "${dest}/backup.info"
    success "Database backed up to ${dest}/battstat.db"
    echo "$dest"
  else
    warn "No database found at ${DATA_DIR}/battstat.db -- skipping backup"
    echo ""
  fi
}

list_backups() {
  if [ -d "$BACKUP_DIR" ] && [ "$(ls -A "$BACKUP_DIR" 2>/dev/null)" ]; then
    echo ""
    info "Available backups in ${BACKUP_DIR}:"
    for d in "${BACKUP_DIR}"/*/; do
      if [ -f "${d}backup.info" ]; then
        local ts ver label
        ts=$(grep    "^timestamp=" "${d}backup.info" | cut -d= -f2)
        ver=$(grep   "^version="   "${d}backup.info" | cut -d= -f2)
        label=$(grep "^label="     "${d}backup.info" | cut -d= -f2)
        printf "  %-30s  ver: %-12s  %s\n" "$(basename "$d")" "$ver" "$label"
      fi
    done
  fi
}

# Keep only the most recent N backups, delete the rest.
prune_old_backups() {
  local keep="${1:-2}"
  [ -d "$BACKUP_DIR" ] || return
  # List subdirectories sorted oldest-first, skip the final-uninstall dir
  local all_backups
  all_backups=$(find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d \
    ! -name 'final_uninstall' | sort)
  local total
  total=$(echo "$all_backups" | grep -c . 2>/dev/null || echo 0)
  if [ "$total" -le "$keep" ]; then
    return
  fi
  local to_delete
  to_delete=$(echo "$all_backups" | head -n $(( total - keep )))
  local count=0
  while IFS= read -r dir; do
    [ -z "$dir" ] && continue
    rm -rf "$dir"
    count=$(( count + 1 ))
  done <<< "$to_delete"
  [ "$count" -gt 0 ] && info "Pruned ${count} old backup(s), kept ${keep} most recent"
}

# -- nginx reverse proxy setup -------------------------------------------------
setup_nginx() {
  local hostname="$1"

  info "Setting up nginx reverse proxy for https://${hostname}..."

  # Install nginx if missing
  if ! command -v nginx &>/dev/null; then
    info "Installing nginx..."
    case "$DISTRO" in
      debian) apt-get install -y nginx ;;
      fedora|rhel) "${PKG_MGR}" install -y nginx ;;
    esac
  fi

  # Install openssl if missing
  if ! command -v openssl &>/dev/null; then
    info "Installing openssl..."
    case "$DISTRO" in
      debian) apt-get install -y openssl ;;
      fedora|rhel) "${PKG_MGR}" install -y openssl ;;
    esac
  fi

  # Generate self-signed certificate
  local cert_dir="/etc/ssl/battstat"
  mkdir -p "$cert_dir"
  chmod 700 "$cert_dir"

  if [ ! -f "${cert_dir}/${hostname}.crt" ]; then
    info "Generating self-signed certificate for ${hostname}..."
    openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
      -keyout "${cert_dir}/${hostname}.key" \
      -out    "${cert_dir}/${hostname}.crt" \
      -subj   "/CN=${hostname}" \
      -addext "subjectAltName=DNS:${hostname}" \
      2>/dev/null
    chmod 600 "${cert_dir}/${hostname}.key"
    success "Certificate generated at ${cert_dir}/${hostname}.crt"
  else
    info "Certificate already exists -- skipping generation"
  fi

  # Write nginx site config
  local nginx_conf="/etc/nginx/sites-available/battstat"
  # Fedora/RHEL uses conf.d instead of sites-available
  if [ ! -d /etc/nginx/sites-available ]; then
    nginx_conf="/etc/nginx/conf.d/battstat.conf"
  fi

  cat > "$nginx_conf" << NGINXEOF
# BattStat reverse proxy -- managed by install.sh
# Regenerate with: sudo bash ${APP_DIR}/install.sh

server {
    listen 80;
    server_name ${hostname};
    return 301 https://\$host\$request_uri;
}

server {
    listen 443 ssl;
    server_name ${hostname};

    ssl_certificate     ${cert_dir}/${hostname}.crt;
    ssl_certificate_key ${cert_dir}/${hostname}.key;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;
    ssl_session_cache   shared:SSL:10m;
    ssl_session_timeout 10m;

    # Proxy to BattStat
    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade    \$http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host              \$host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_read_timeout 86400s;
        proxy_buffering    off;
    }
}
NGINXEOF

  success "Nginx config written to ${nginx_conf}"

  # Enable the site on Debian/Ubuntu (sites-available/sites-enabled pattern)
  if [ -d /etc/nginx/sites-enabled ]; then
    ln -sf "$nginx_conf" /etc/nginx/sites-enabled/battstat 2>/dev/null || true
  fi

  # Test and reload nginx
  if nginx -t 2>/dev/null; then
    systemctl enable nginx 2>/dev/null || true
    systemctl reload nginx 2>/dev/null || systemctl start nginx
    success "Nginx configured and reloaded"
  else
    error "Nginx config test failed -- check: nginx -t"
    return 1
  fi

  # Update the service file to use HTTPS mode and lock to localhost
  local svc_file="$SERVICE_FILE"
  # Switch HOST to 127.0.0.1 -- nginx handles external access
  sed -i 's/^Environment=HOST=.*/Environment=HOST=127.0.0.1/' "$svc_file"
  # Enable secure cookie flag
  sed -i 's/^# Environment=HTTPS=true/Environment=HTTPS=true/' "$svc_file"
  # Set allowed origin
  if grep -q "ALLOWED_ORIGIN" "$svc_file"; then
    sed -i "s|^# Environment=ALLOWED_ORIGIN=.*|Environment=ALLOWED_ORIGIN=https://${hostname}|" "$svc_file"
  else
    echo "Environment=ALLOWED_ORIGIN=https://${hostname}" >> "$svc_file"
  fi
  systemctl daemon-reload
  success "Service updated: HOST=127.0.0.1, HTTPS=true, ALLOWED_ORIGIN=https://${hostname}"

  # Open firewall for HTTPS if needed
  if command -v ufw &>/dev/null && ufw status | grep -q "Status: active"; then
    ufw allow 443/tcp comment "BattStat HTTPS" 2>/dev/null || true
    ufw allow 80/tcp  comment "BattStat HTTP redirect" 2>/dev/null || true
    info "ufw: opened ports 80 and 443"
  fi
  if command -v firewall-cmd &>/dev/null; then
    firewall-cmd --permanent --add-service=https 2>/dev/null || true
    firewall-cmd --permanent --add-service=http  2>/dev/null || true
    firewall-cmd --reload 2>/dev/null || true
    info "firewalld: opened http and https services"
  fi
}

# -- Post-install summary ------------------------------------------------------
print_dashboard_url() {
  local ip
  ip=$(hostname -I 2>/dev/null | awk '{print $1}')
  echo ""
  echo -e "${GREEN}${BOLD}  Dashboard -> http://${ip}:3000${RESET}"
  echo ""
}

print_useful_commands() {
  echo "  journalctl -u ${SERVICE_NAME} -f           # live logs"
  echo "  systemctl status ${SERVICE_NAME}            # service status"
  echo "  systemctl restart ${SERVICE_NAME}           # restart"
  echo "  node ${APP_DIR}/scripts/create-admin.js    # add admin user"
  echo "  sudo bash ${APP_DIR}/upgrade.sh             # upgrade to latest"
  echo "  sudo bash ${APP_DIR}/uninstall.sh           # uninstall"
}
