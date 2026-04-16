# BattStat

Self-hosted UPS battery health dashboard. Polls UPS devices via SNMP, displays live battery status, runtime, power readings, and diagnostic data. Supports multi-site management, role-based access control with per-role site restrictions, local users, and LDAP / Active Directory authentication.

**Current version: 1.3.0**

---

## Features

- **SNMP auto-detection** — tries SNMPv3 first, falls back to v2c/v1 on auth errors only. Saves working version per device
- **Multi-vendor support** — APC, Eaton/Powerware, CyberPower, Tripp Lite NMC5/PADM20
- **Live updates** — WebSocket push, no page refresh needed
- **Multi-site** — group devices by physical location, filter dashboard by site
- **Role-based access** — custom roles with per-permission and per-site restrictions (works for LDAP users)
- **LDAP/AD auth** — no domain join required; maps AD groups to roles
- **Battery part number auto-fill** — looks up replacement part from SNMP model string
- **Battery install date auto-fill** — reads last-replaced date from Tripp Lite NMC5 via SNMP
- **Dark mode** — manual toggle, persists across sessions
- **nginx reverse proxy** — optional HTTPS setup with self-signed cert, fully automated from installer
- **Git-based upgrades** — single command, auto-backup with 5-backup retention, DB migrations automatic

---

## Requirements

- Linux (Ubuntu 20.04+ / Debian 11+ / Fedora 37+ / RHEL 8+)
- Node.js 18+
- Network access to UPS devices on UDP 161
- UPS NMC with SNMP enabled (SNMPv3 recommended, v2c/v1 supported)
- For LDAP/AD: service account with read access to your directory

---

## Quick install

```bash
# From git (recommended — enables git-based upgrades)
git clone https://github.com/jc61990/battstat.git /tmp/battstat
sudo bash /tmp/battstat/install.sh

# From zip
unzip battstat.zip -d /tmp
sudo bash /tmp/battstat/install.sh
```

The installer prompts whether to set up an nginx HTTPS reverse proxy. If yes, it asks for a hostname, generates a self-signed certificate, writes the nginx config, and updates the service file automatically.

After install the dashboard is at `http://<server-ip>:3000` (or `https://<hostname>` if nginx was configured).

---

## First-time setup

### 1. Configure SNMP
Go to **SNMP Settings** and enter your SNMPv3 credentials. Set the community string for any v2c/v1 devices.

### 2. Add sites and devices
- **Sites** → **+ Add Site**
- **All Devices** → **+ Add Device** — add each UPS by IP

The **Model hint** field drives vendor detection — include `apc`, `eaton`, `cyber`, or `tripp`. SNMP version defaults to Auto-detect.

### 3. Configure LDAP (optional)
**Users & Roles** → **LDAP / Active Directory**. UPN format (`user@domain.com`) works for Bind DN. Use the Test button to verify. Map AD groups to roles in the Group Mappings tab.

---

## SNMP support

### Version auto-detection
Auto mode tries v3 first, then v2c, then v1 — but **only falls back on authentication errors** (wrong credentials, unknown user). Timeouts mean the device is unreachable; no fallback is attempted. Once a working version is discovered it is saved to the device record.

### OID coverage by vendor

| Field | APC | Tripp Lite NMC5 | Eaton | CyberPower |
|---|---|---|---|---|
| Battery % | ✓ | ✓ | ✓ | ✓ |
| Temperature | ✓ | ✓ (°F→°C) | ✓ | ✓ |
| Runtime | ✓ | ✓ | ✓ | ✓ |
| Replace date | ✓ | ✓ | — | — |
| Input voltage | ✓ | ✓ | ✓ | ✓ |
| Output voltage | ✓ | ✓ | ✓ | ✓ |
| Output load % | ✓ | ✓ | ✓ | ✓ |
| Input frequency | ✓ | ✓ | — | — |
| Output current | ✓ | ✓ | — | — |
| Self-test result/date | ✓ | ✓ | — | — |
| Last transfer reason | ✓ | ✓ | — | — |
| Transfer count | ✓ | — | — | — |
| Serial number | ✓ | ✓ | — | ✓ |
| Firmware | ✓ | ✓ | — | — |

---

## Authentication

### Local users
PBKDF2-SHA256 passwords (310,000 iterations). Configurable session duration. Session-only or persistent.

### LDAP / Active Directory
1. Binds using the service account
2. Searches for the user's DN using the filter (default: `sAMAccountName={{username}}`)
3. Re-binds as that user to verify their password
4. Reads `memberOf` and maps AD groups to roles
5. Falls back to default role if configured, otherwise denies access

Example settings:
```
URL:           ldap://dc01.company.local
Bind DN:       svc-battstat@company.local
Search base:   DC=company,DC=local
Search filter: (sAMAccountName={{username}})
```

### Roles and permissions

| Permission | Description |
|---|---|
| `can_view` | View dashboard and poll data |
| `can_edit_devices` | Add, edit, delete devices |
| `can_manage_sites` | Add, edit, delete sites — also bypasses site restrictions |
| `can_manage_users` | Manage users, roles, LDAP config, audit log |
| `can_manage_snmp` | View and edit SNMP settings |
| `can_poll` | Trigger manual on-demand polls |

System roles (read-only): **Administrator** (all permissions), **Viewer** (`can_view` only).

### Per-role site access
Roles can be restricted to specific sites. Any user (local or LDAP) with that role only sees devices and data from those sites — enforced server-side. Roles with `can_manage_sites` always see everything. Empty site list = unrestricted.

---

## Alert thresholds

| Condition | Warning | Critical |
|---|---|---|
| Battery charge | < 40% | < 20% |
| Battery temperature | ≥ 40°C | ≥ 45°C |
| Estimated runtime | < 20 min | < 10 min |
| Battery age (4-year assumed life) | < 180 days remaining | Overdue |
| UPS-reported replace date | < 90 days | Overdue |
| UPS battery status | — | Low / Fault / Depleted |

---

## Device fields

| Field | Notes |
|---|---|
| Site | Required |
| Device name | Required |
| IP address | Required, UDP 161 reachable |
| Floor / location | Optional label |
| Serial number | Manual entry — SNMP serial shown separately |
| Model hint | Vendor keyword or full model string. Full string triggers part number auto-fill |
| Replacement part # | Auto-filled from model lookup if blank |
| Battery installed date | Auto-filled from Tripp Lite SNMP if blank. Required for life bar |
| SNMP version | Auto (default), v3 only, v2c only, v1 only |

---

## Replacement battery part lookup

Auto-fills when blank from SNMP model string:

| Model | Part |
|---|---|
| Smart-UPS SRT 1000/1500 | APCRBC155 |
| Smart-UPS SRT 2200 | APCRBC141 |
| Smart-UPS SRT 3000–10000 | APCRBC140 |
| Smart-UPS 1500 | APCRBC115 |
| Smart-UPS 2200/3000 | APCRBC117 |
| Smart-UPS SMT 750/1000 | APCRBC123 |
| SU2200RTXLCD2U | RBC94-2U |

Additional models in `BATTERY_PART_LOOKUP` in `poller.js`.

---

## nginx reverse proxy

Automated from installer. To configure on an existing install:

```bash
source /opt/battstat/scripts/common.sh
detect_distro
setup_nginx battstat.yourdomain.com
sudo systemctl restart battstat
```

Installs nginx, generates a self-signed cert at `/etc/ssl/battstat/`, writes the site config, opens the firewall, and sets `HOST=127.0.0.1`, `HTTPS=true`, `ALLOWED_ORIGIN` in the service file.

---

## Environment variables

Set in `/etc/systemd/system/battstat.service`:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP listen port |
| `HOST` | `0.0.0.0` | Bind address. `127.0.0.1` when behind nginx |
| `DB_PATH` | `/opt/battstat/data/battstat.db` | SQLite database path |
| `HTTPS` | _(unset)_ | Set `true` to enable `Secure` cookie flag |
| `ALLOWED_ORIGIN` | _(unset)_ | Restrict WebSocket to this origin |

---

## Upgrading

```bash
cd /opt/battstat-src
sudo git pull
sudo bash upgrade.sh
```

Backs up the database (keeps 5 most recent), stops the service, syncs files, runs `npm install`, runs DB migrations, restarts. Rolls back automatically on failure.

---

## Useful commands

```bash
journalctl -u battstat -f                        # live logs
systemctl restart battstat                        # restart
node /opt/battstat/scripts/create-admin.js       # add admin user
sudo bash /opt/battstat/upgrade.sh               # upgrade
sudo bash /opt/battstat/uninstall.sh             # uninstall (keeps DB)
sudo bash /opt/battstat/uninstall.sh --purge     # uninstall + delete DB
```

---

## Changelog

### 1.3.0
- Extended device drawer: input frequency, output current, self-test result/date, last transfer reason, transfer count
- Per-role site access — replaces per-user site access, works for LDAP users via group→role mapping
- UI permission enforcement: edit/delete/poll buttons hidden when user lacks the required permission
- Dark mode toggle with localStorage persistence
- SNMPv1/v2c support with community string configuration
- Auto-detect SNMP version per device (v3 → v2c → v1, auth errors only, not timeouts)
- nginx HTTPS reverse proxy setup automated in installer — prompted during install
- Backup pruning: keeps 5 most recent
- Backup version label shows git commit subject line
- Overview: Sites moved above Attention Required

### 1.2.0
- Battery part number auto-fill from SNMP model string
- Battery installed date auto-fill from Tripp Lite NMC5 SNMP
- Tripp Lite temperature fix: tenths-of-Fahrenheit to Celsius
- LDAP crash fix: unhandled TLS error on self-signed AD certs
- LDAP bind password preservation on settings save

### 1.1.0
- Multi-site management with per-site grouping
- Role-based permissions with custom roles
- LDAP / Active Directory authentication
- Audit log and active session management
- SNMPv3 context support for Tripp Lite NMC5

### 1.0.0
- Initial release: SNMPv3 polling, APC/Eaton/CyberPower support, SQLite, WebSocket live updates, local users, systemd service
