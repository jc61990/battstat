#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/scripts/common.sh"

# ── Argument parsing ──────────────────────────────────────────────────────────
SKIP_BACKUP=0
SOURCE_DIR=""     # If upgrading from a zip/directory instead of git pull
FORCE=0

usage() {
  echo "Usage: sudo bash upgrade.sh [OPTIONS]"
  echo ""
  echo "Options:"
  echo "  --from <path>      Upgrade from a local directory or extracted zip"
  echo "                     instead of git pull (for non-git deployments)"
  echo "  --skip-backup      Skip the pre-upgrade database backup"
  echo "  --force            Skip confirmation prompt"
  echo "  -h, --help         Show this help"
  echo ""
  echo "Examples:"
  echo "  sudo bash upgrade.sh                         # git pull upgrade"
  echo "  sudo bash upgrade.sh --from /tmp/battstat # upgrade from zip"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --from)     SOURCE_DIR="$2"; shift 2 ;;
    --skip-backup) SKIP_BACKUP=1; shift ;;
    --force)    FORCE=1; shift ;;
    -h|--help)  usage; exit 0 ;;
    *) error "Unknown option: $1"; usage; exit 1 ;;
  esac
done

# ── Pre-flight checks ─────────────────────────────────────────────────────────
header "BattStat — Upgrade"

require_root

if [ ! -d "$APP_DIR" ]; then
  error "${APP_DIR} does not exist. Run install.sh first."
  exit 1
fi

# Determine upgrade mode
if [ -n "$SOURCE_DIR" ]; then
  UPGRADE_MODE="directory"
  if [ ! -d "$SOURCE_DIR" ]; then
    error "Source directory not found: ${SOURCE_DIR}"
    exit 1
  fi
  info "Upgrade mode: from directory ${SOURCE_DIR}"
elif is_git_repo "$APP_DIR"; then
  UPGRADE_MODE="git"
  REMOTE=$(get_git_remote)
  CURRENT_VER=$(get_git_version)
  info "Upgrade mode: git pull"
  info "Remote:  ${REMOTE:-none}"
  info "Current: ${CURRENT_VER}"
else
  error "Cannot upgrade: ${APP_DIR} is not a git repository and --from was not specified."
  echo ""
  echo "To upgrade from a zip/directory:"
  echo "  sudo bash upgrade.sh --from /path/to/extracted/battstat"
  exit 1
fi

# ── Confirmation ──────────────────────────────────────────────────────────────
if [ "$FORCE" -ne 1 ]; then
  echo ""
  warn "This will:"
  echo "  1. Back up the database"
  echo "  2. Stop the service"
  echo "  3. Update application files"
  echo "  4. Run npm install"
  echo "  5. Restart the service"
  echo ""
  read -r -p "Continue? [y/N] " CONFIRM
  if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
    info "Upgrade cancelled."
    exit 0
  fi
fi

# ── Step 1: Backup ────────────────────────────────────────────────────────────
BACKUP_PATH=""
if [ "$SKIP_BACKUP" -ne 1 ]; then
  header "Step 1/6: Backup"
  BACKUP_PATH=$(backup_data "pre-upgrade")
else
  warn "Skipping backup (--skip-backup passed)"
  header "Step 1/6: Backup — skipped"
fi

# ── Rollback function (called on any error after service stop) ────────────────
ROLLBACK_NEEDED=0
rollback() {
  if [ "$ROLLBACK_NEEDED" -ne 1 ]; then return; fi
  echo ""
  error "Upgrade failed. Attempting rollback..."

  if [ -n "$BACKUP_PATH" ] && [ -f "${BACKUP_PATH}/battstat.db" ]; then
    warn "Restoring database from backup..."
    cp "${BACKUP_PATH}/battstat.db" "${DATA_DIR}/battstat.db"
    chown "${SERVICE_USER}:${SERVICE_USER}" "${DATA_DIR}/battstat.db"
    chmod 660 "${DATA_DIR}/battstat.db"
    success "Database restored from ${BACKUP_PATH}"
  else
    warn "No backup available to restore database from."
  fi

  info "Attempting to restart service with existing code..."
  if systemctl restart "$SERVICE_NAME" 2>/dev/null; then
    success "Service restarted with pre-upgrade state"
  else
    error "Service failed to restart. Manual intervention required."
    error "Check: journalctl -u ${SERVICE_NAME} -n 50"
  fi
}
trap 'rollback' ERR

# ── Step 2: Stop service ──────────────────────────────────────────────────────
header "Step 2/6: Stop service"
stop_service
ROLLBACK_NEEDED=1

# ── Step 3: Update files ──────────────────────────────────────────────────────
header "Step 3/6: Update files"

if [ "$UPGRADE_MODE" = "git" ]; then
  info "Fetching from origin..."
  # Run git as the service user to respect any stored credentials,
  # but fall back to root if that fails
  if sudo -u "$SERVICE_USER" git -C "$APP_DIR" fetch origin 2>/dev/null; then
    :
  else
    git -C "$APP_DIR" fetch origin
  fi

  # Show what's changing
  INCOMING=$(git -C "$APP_DIR" log HEAD..origin/HEAD --oneline 2>/dev/null | wc -l)
  if [ "$INCOMING" -eq 0 ]; then
    warn "Already up to date. No new commits."
  else
    info "${INCOMING} new commit(s):"
    git -C "$APP_DIR" log HEAD..origin/HEAD --oneline 2>/dev/null | head -20 | sed 's/^/    /'
  fi

  info "Applying update..."
  git -C "$APP_DIR" pull --ff-only origin HEAD

  NEW_VER=$(get_git_version)
  success "Updated to ${NEW_VER}"

else
  # Directory/zip upgrade — rsync new files, preserve data/
  info "Syncing files from ${SOURCE_DIR}..."
  if command -v rsync &>/dev/null; then
    rsync -a --delete \
      --exclude='data/' \
      --exclude='node_modules/' \
      --exclude='.git/' \
      "${SOURCE_DIR}/" "${APP_DIR}/"
  else
    # Manually sync, protecting data/ and node_modules/
    find "$SOURCE_DIR" -mindepth 1 -maxdepth 1 \
      ! -name 'data' ! -name 'node_modules' ! -name '.git' \
      -exec cp -r {} "$APP_DIR/" \;
  fi
  success "Files synced from ${SOURCE_DIR}"
fi

# ── Step 4: npm install ───────────────────────────────────────────────────────
header "Step 4/6: Install dependencies"
npm_install
fix_permissions

# ── Step 5: Start and verify ──────────────────────────────────────────────────
header "Step 6/6: Start service"
install_service  # Re-install in case the unit file changed

# Run database migrations
header "5/5: Database migrations"
if DB_PATH="${DATA_DIR}/battstat.db" node "${APP_DIR}/scripts/migrate.js"; then
  success "Migrations complete"
else
  error "Migration failed. Database unchanged — safe to rollback."
  ROLLBACK_NEEDED=1
  exit 1
fi

ROLLBACK_NEEDED=0  # Past the point of no return — don't rollback on start failure

if start_service; then
  header "Upgrade complete"
  print_dashboard_url
  if [ -n "$BACKUP_PATH" ]; then
    info "Pre-upgrade backup saved at: ${BACKUP_PATH}"
  fi
  list_backups
else
  error "Service failed to start after upgrade."
  error "Database is intact. Check logs: journalctl -u ${SERVICE_NAME} -n 50"
  error "To restore manually: cp ${BACKUP_PATH}/battstat.db ${DATA_DIR}/"
  exit 1
fi
