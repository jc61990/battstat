#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/common.sh
source "${SCRIPT_DIR}/scripts/common.sh"

# -- Argument parsing ----------------------------------------------------------
PURGE_DATA=0
KEEP_USER=0
FORCE=0

usage() {
  echo "Usage: sudo bash uninstall.sh [OPTIONS]"
  echo ""
  echo "Options:"
  echo "  --purge        Permanently delete the database and all data"
  echo "  --keep-user    Do not remove the 'battstat' system user"
  echo "  --force        Skip confirmation prompt"
  echo "  -h, --help     Show this help"
  echo ""
  echo "By default the database is saved to ${BACKUP_DIR}/final_uninstall/"
  echo "before deletion. Use --purge to skip the backup and delete permanently."
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --purge)     PURGE_DATA=1; shift ;;
    --keep-user) KEEP_USER=1; shift ;;
    --force)     FORCE=1; shift ;;
    -h|--help)   usage; exit 0 ;;
    *) error "Unknown option: $1"; usage; exit 1 ;;
  esac
done

# -- Pre-flight ----------------------------------------------------------------
header "BattStat -- Uninstall"
require_root

APP_INSTALLED=0
SERVICE_INSTALLED=0
[ -d "$APP_DIR" ] && APP_INSTALLED=1
systemctl list-unit-files "${SERVICE_NAME}.service" &>/dev/null 2>&1 && SERVICE_INSTALLED=1

if [ "$APP_INSTALLED" -eq 0 ] && [ "$SERVICE_INSTALLED" -eq 0 ]; then
  warn "BattStat does not appear to be installed. Nothing to do."
  exit 0
fi

# -- Show what will happen -----------------------------------------------------
echo ""
echo "The following will be removed:"
[ "$SERVICE_INSTALLED" -eq 1 ] && echo "  Systemd service:   ${SERVICE_FILE}"
[ "$APP_INSTALLED" -eq 1 ]     && echo "  Application files: ${APP_DIR}"
if [ "$PURGE_DATA" -eq 1 ]; then
  echo -e "  ${RED}Database (PERMANENT DELETE): ${DATA_DIR}${RESET}"
else
  echo "  Database will be saved to: ${BACKUP_DIR}/final_uninstall/"
fi
[ "$KEEP_USER" -eq 0 ] && echo "  System user: ${SERVICE_USER}"
echo ""

if [ "$FORCE" -ne 1 ]; then
  if [ "$PURGE_DATA" -eq 1 ]; then
    echo -e "${RED}${BOLD}WARNING: --purge will permanently delete all data. This cannot be undone.${RESET}"
    read -r -p "Type 'yes' to confirm: " CONFIRM
    [ "$CONFIRM" = "yes" ] || { info "Uninstall cancelled."; exit 0; }
  else
    read -r -p "Confirm uninstall? [y/N] " CONFIRM
    [[ "$CONFIRM" =~ ^[Yy]$ ]] || { info "Uninstall cancelled."; exit 0; }
  fi
fi

# -- Stop and disable service --------------------------------------------------
header "Stopping service"
stop_service
disable_service

# -- Handle data ---------------------------------------------------------------
header "Data"
if [ "$PURGE_DATA" -eq 1 ]; then
  if [ -d "$DATA_DIR" ]; then
    warn "Permanently deleting ${DATA_DIR}..."
    rm -rf "$DATA_DIR"
    success "Data directory deleted"
  fi
else
  if [ -d "$DATA_DIR" ] && [ "$(ls -A "$DATA_DIR" 2>/dev/null)" ]; then
    SAVE_DEST="${BACKUP_DIR}/final_uninstall"
    mkdir -p "$SAVE_DEST"
    chmod 700 "$SAVE_DEST"
    cp -r "${DATA_DIR}/." "$SAVE_DEST/"
    success "Data preserved at: ${SAVE_DEST}"
    echo ""
    info "To restore after reinstalling:"
    echo "  sudo cp ${SAVE_DEST}/battstat.db ${DATA_DIR}/"
  else
    info "No data directory found -- nothing to preserve"
  fi
fi

# -- Remove systemd unit -------------------------------------------------------
header "Removing systemd service"
if [ -f "$SERVICE_FILE" ]; then
  rm -f "$SERVICE_FILE"
  systemctl daemon-reload
  success "Service file removed"
else
  info "Service file not found -- already removed"
fi

# -- Remove application files --------------------------------------------------
header "Removing application files"
if [ -d "$APP_DIR" ]; then
  rm -rf "$APP_DIR"
  success "Removed ${APP_DIR}"
else
  info "${APP_DIR} not found -- already removed"
fi

# -- Remove system user --------------------------------------------------------
if [ "$KEEP_USER" -eq 0 ]; then
  header "Removing system user"
  if id "$SERVICE_USER" &>/dev/null; then
    userdel "$SERVICE_USER"
    success "Removed system user '${SERVICE_USER}'"
  else
    info "System user '${SERVICE_USER}' not found"
  fi
fi

# -- Done ----------------------------------------------------------------------
header "Uninstall complete"
if [ "$PURGE_DATA" -ne 1 ] && [ -d "${BACKUP_DIR}/final_uninstall" ]; then
  success "Data preserved at ${BACKUP_DIR}/final_uninstall/"
  echo ""
  echo "  To remove all remaining files:"
  echo "    sudo rm -rf ${BACKUP_DIR}"
fi
echo ""
success "BattStat has been uninstalled."
