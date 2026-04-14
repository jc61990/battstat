#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/common.sh
source "${SCRIPT_DIR}/scripts/common.sh"

# ── Argument parsing ──────────────────────────────────────────────────────────
SKIP_BACKUP=0
SOURCE_DIR=""
FORCE=0

usage() {
  echo "Usage: sudo bash upgrade.sh [OPTIONS]"
  echo ""
  echo "Options:"
  echo "  --from <path>    Upgrade from a local directory instead of git pull"
  echo "  --skip-backup    Skip the pre-upgrade database backup"
  echo "  --force          Skip confirmation prompt"
  echo "  -h, --help       Show this help"
  echo ""
  echo "Examples:"
  echo "  sudo bash upgrade.sh                         # git pull (requires git clone install)"
  echo "  sudo bash upgrade.sh --from /tmp/battstat    # upgrade from extracted zip"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --from)        SOURCE_DIR="$2"; shift 2 ;;
    --skip-backup) SKIP_BACKUP=1; shift ;;
    --force)       FORCE=1; shift ;;
    -h|--help)     usage; exit 0 ;;
    *) error "Unknown option: $1"; usage; exit 1 ;;
  esac
done

# ── Pre-flight ────────────────────────────────────────────────────────────────
header "BattStat — Upgrade"
require_root

if [ ! -d "$APP_DIR" ]; then
  error "${APP_DIR} does not exist. Run install.sh first."
  exit 1
fi

if [ -n "$SOURCE_DIR" ]; then
  UPGRADE_MODE="directory"
  [ -d "$SOURCE_DIR" ] || { error "Source directory not found: ${SOURCE_DIR}"; exit 1; }
  info "Upgrade mode: from directory ${SOURCE_DIR}"
elif is_git_repo "$APP_DIR"; then
  UPGRADE_MODE="git"
  info "Upgrade mode: git pull"
  info "Remote:  $(get_git_remote)"
  info "Current: $(get_git_version)"
else
  error "${APP_DIR} is not a git repo and --from was not specified."
  echo ""
  echo "To upgrade from a zip: sudo bash upgrade.sh --from /path/to/battstat"
  exit 1
fi

# ── Confirm ───────────────────────────────────────────────────────────────────
if [ "$FORCE" -ne 1 ]; then
  echo ""
  echo "This will: backup → stop → update files → npm install → migrate DB → restart"
  echo ""
  read -r -p "Continue? [y/N] " CONFIRM
  [[ "$CONFIRM" =~ ^[Yy]$ ]] || { info "Upgrade cancelled."; exit 0; }
fi

# ── Rollback trap ─────────────────────────────────────────────────────────────
BACKUP_PATH=""
ROLLBACK_NEEDED=0

rollback() {
  [ "$ROLLBACK_NEEDED" -eq 1 ] || return
  echo ""
  error "Upgrade failed — attempting rollback..."
  if [ -n "$BACKUP_PATH" ] && [ -f "${BACKUP_PATH}/battstat.db" ]; then
    warn "Restoring database from ${BACKUP_PATH}..."
    cp "${BACKUP_PATH}/battstat.db" "${DATA_DIR}/battstat.db"
    chown "${SERVICE_USER}:${SERVICE_USER}" "${DATA_DIR}/battstat.db"
    chmod 660 "${DATA_DIR}/battstat.db"
    success "Database restored"
  else
    warn "No backup available — database unchanged"
  fi
  info "Attempting to restart service on existing code..."
  systemctl restart "$SERVICE_NAME" 2>/dev/null \
    && success "Service restarted with pre-upgrade state" \
    || error "Service failed to restart. Check: journalctl -u ${SERVICE_NAME} -n 50"
}
trap rollback ERR

# ── Step 1/6: Backup ──────────────────────────────────────────────────────────
header "Step 1/6: Backup"
if [ "$SKIP_BACKUP" -ne 1 ]; then
  BACKUP_PATH=$(backup_data "pre-upgrade")
else
  warn "Skipping backup (--skip-backup passed)"
fi

# ── Step 2/6: Stop service ────────────────────────────────────────────────────
header "Step 2/6: Stop service"
stop_service
ROLLBACK_NEEDED=1

# ── Step 3/6: Update files ────────────────────────────────────────────────────
header "Step 3/6: Update files"
if [ "$UPGRADE_MODE" = "git" ]; then
  info "Fetching from origin..."
  git -C "$APP_DIR" fetch origin

  INCOMING=$(git -C "$APP_DIR" log HEAD..origin/HEAD --oneline 2>/dev/null | wc -l)
  if [ "$INCOMING" -eq 0 ]; then
    warn "Already up to date — no new commits"
  else
    info "${INCOMING} new commit(s):"
    git -C "$APP_DIR" log HEAD..origin/HEAD --oneline 2>/dev/null | head -20 | sed 's/^/    /'
  fi

  git -C "$APP_DIR" pull --ff-only
  success "Updated to $(get_git_version)"
else
  info "Syncing files from ${SOURCE_DIR}..."
  if command -v rsync &>/dev/null; then
    rsync -a --delete \
      --exclude='data/' --exclude='node_modules/' --exclude='.git/' \
      "${SOURCE_DIR}/" "${APP_DIR}/"
  else
    find "$SOURCE_DIR" -mindepth 1 -maxdepth 1 \
      ! -name 'data' ! -name 'node_modules' ! -name '.git' \
      -exec cp -r {} "$APP_DIR/" \;
  fi
  success "Files synced"
fi

# ── Step 4/6: npm install ─────────────────────────────────────────────────────
header "Step 4/6: Install dependencies"
ensure_build_tools
npm_install
fix_permissions

# ── Step 5/6: Database migrations ────────────────────────────────────────────
header "Step 5/6: Database migrations"
if DB_PATH="${DATA_DIR}/battstat.db" node "${APP_DIR}/scripts/migrate.js"; then
  success "Migrations complete"
else
  error "Migration failed"
  ROLLBACK_NEEDED=1
  exit 1
fi

# ── Step 6/6: Start service ───────────────────────────────────────────────────
header "Step 6/6: Start service"
install_service  # Re-copy unit file in case it changed

ROLLBACK_NEEDED=0  # Past the point of safe rollback

if start_service; then
  header "Upgrade complete"
  print_dashboard_url
  [ -n "$BACKUP_PATH" ] && info "Pre-upgrade backup: ${BACKUP_PATH}"
  list_backups
else
  error "Service failed to start after upgrade."
  error "Check logs: journalctl -u ${SERVICE_NAME} -n 50"
  [ -n "$BACKUP_PATH" ] && error "Restore DB: cp ${BACKUP_PATH}/battstat.db ${DATA_DIR}/"
  exit 1
fi
