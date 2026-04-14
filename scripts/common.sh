#!/bin/bash
# Shared functions used by install.sh, upgrade.sh, and uninstall.sh.
# Source this file — do not run directly.

APP_DIR="/opt/battstat"
SERVICE_NAME="battstat"
SERVICE_USER="battstat"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
DATA_DIR="${APP_DIR}/data"
BACKUP_DIR="/var/backups/battstat"

# ── Colour helpers ────────────────────────────────────────────────────────────
RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

info()    { echo -e "${CYAN}▸${RESET} $*"; }
success() { echo -e "${GREEN}✓${RESET} $*"; }
warn()    { echo -e "${YELLOW}⚠${RESET}  $*"; }
error()   { echo -e "${RED}✗${RESET}  $*" >&2; }
header()  { echo -e "\n${BOLD}$*${RESET}"; echo "$(echo "$*" | tr '[:print:]' '─')"; }

# ── Root guard ────────────────────────────────────────────────────────────────
require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    error "This script must be run as root or with sudo."
    exit 1
  fi
}

# ── Detect distro / package manager ──────────────────────────────────────────
# Sets DISTRO (debian|fedora|rhel) and PKG_MGR (apt-get|dnf|yum).
# Safe to call multiple times — detection result is cached.
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

# ── Build tools ───────────────────────────────────────────────────────────────
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

# ── Node.js install / check ───────────────────────────────────────────────────
ensure_node() {
  if command -v node &>/dev/null; then
    local ver
    ver=$(node -e "process.stdout.write(process.version.split('.')[0].slice(1))")
    if [ "$ver" -lt 18 ]; then
      warn "Node.js v${ver} found but 18+ is required — upgrading..."
      install_node
    else
      success "Node.js $(node --version) already installed"
    fi
  else
    info "Node.js not found — installing Node.js 20 LTS..."
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

# ── System user ───────────────────────────────────────────────────────────────
ensure_service_user() {
  if id "$SERVICE_USER" &>/dev/null; then
    success "System user '${SERVICE_USER}' already exists"
  else
    info "Creating system user '${SERVICE_USER}'..."
    useradd --system --no-create-home --shell /sbin/nologin "$SERVICE_USER"
    success "Created system user '${SERVICE_USER}'"
  fi
}

# ── Git detection ─────────────────────────────────────────────────────────────
is_git_repo() {
  git -C "$1" rev-parse --git-dir &>/dev/null 2>&1
}

get_git_version() {
  if is_git_repo "$APP_DIR"; then
    git -C "$APP_DIR" describe --tags --always 2>/dev/null \
      || git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null \
      || echo "unknown"
  else
    echo "unknown"
  fi
}

get_git_remote() {
  git -C "$APP_DIR" remote get-url origin 2>/dev/null || echo ""
}

# ── npm install ───────────────────────────────────────────────────────────────
npm_install() {
  info "Installing Node.js dependencies..."
  cd "$APP_DIR"

  # Show output but suppress the noisy funding/audit lines
  if ! npm install --omit=dev 2>&1 \
      | grep -v "^npm warn" \
      | grep -v "^npm notice" \
      | grep -v "funding" \
      | grep -v "looking for funding"; then
    error "npm install failed — check output above"
    exit 1
  fi

  success "Dependencies installed"
}

# ── Permissions ───────────────────────────────────────────────────────────────
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

# ── Systemd ───────────────────────────────────────────────────────────────────
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

# ── Backup ────────────────────────────────────────────────────────────────────
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
    warn "No database found at ${DATA_DIR}/battstat.db — skipping backup"
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

# ── Post-install summary ──────────────────────────────────────────────────────
print_dashboard_url() {
  local ip
  ip=$(hostname -I 2>/dev/null | awk '{print $1}')
  echo ""
  echo -e "${GREEN}${BOLD}  Dashboard → http://${ip}:3000${RESET}"
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
