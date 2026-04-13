# BattStat

Self-hosted UPS battery health dashboard with SNMPv3 polling, live WebSocket updates, multi-site management, local user accounts, and LDAP / Active Directory authentication — no domain join required.

## Requirements

- Linux server or VM (Ubuntu 20.04+ / Debian 11+ / Fedora 37+ / RHEL 8+)
- Node.js 18 or newer
- Network access to UPS devices on UDP port 161
- UPS units with SNMPv3 enabled (APC, Eaton, CyberPower supported)
- For LDAP/AD: a service account with read access to your directory (no domain join, no computer account needed)

---

## Quick install

`install.sh` auto-detects your distro (Debian/Ubuntu or Fedora/RHEL/Rocky).

```bash
# From a zip download
unzip battstat.zip -d /tmp
sudo bash /tmp/battstat/install.sh

# From a git clone (recommended — enables git-based upgrades)
git clone https://github.com/yourorg/battstat.git /tmp/battstat
sudo bash /tmp/battstat/install.sh
```

The installer:
1. Detects your distro and installs Node.js 20 LTS if missing
2. Creates a locked `battstat` system user
3. Copies files to `/opt/battstat` (preserving `.git` metadata for future upgrades)
4. Runs `npm install --omit=dev`
5. Installs and starts the systemd service
6. Runs the interactive admin account creation

Dashboard will be at `http://<server-ip>:3000` after opening the port in your firewall (see Firewall section).

---

## Manual install

```bash
# Copy or clone to the server
git clone https://github.com/yourorg/battstat.git /opt/battstat
# or: scp -r battstat/ user@server:/opt/battstat

cd /opt/battstat
npm install --omit=dev

# Create the first admin user
node scripts/create-admin.js

# Run directly (foreground, for testing)
node server.js

# Install as a systemd service
sudo cp battstat.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now battstat
```

---

## First-time setup

After install, the service needs three things configured before it polls any devices:

### 1. Log in
Open `http://<server-ip>:3000` — you will be redirected to the login page. Use the admin credentials you created during install.

### 2. Configure SNMP
Go to **SNMP Settings** in the sidebar and enter:
- Security name (the SNMPv3 username configured on your UPS devices)
- Auth protocol: SHA-1 (default), SHA-256, or SHA-512
- Auth passphrase
- Privacy protocol: AES-128 (default) or AES-256
- Privacy passphrase
- Poll interval (default: 60 seconds)

Click **Save & apply**. The poller restarts immediately.

### 3. Add sites and devices
- Go to **Sites** → **+ Add Site** to add your physical locations
- Go to **All Devices** → **+ Add Device** and enter each UPS by IP address

The dashboard will begin populating with live data from the next poll cycle.

---

## Authentication

### Local users
Managed in **Users & Roles** → **Local Users**. Passwords are hashed with PBKDF2-SHA256 (310,000 iterations). Each user has a configurable session duration and can be set to persistent (stays logged in across browser closes) or session-only (expires when browser closes).

### LDAP / Active Directory
Configured in **Users & Roles** → **LDAP / Active Directory**.

**How it works — no domain join needed:**
1. When a user logs in, the server first checks for a matching local account
2. If not found locally, it binds to your LDAP/AD server using the service account credentials
3. It searches for the user's DN using the configured search filter (default: `sAMAccountName`)
4. It then binds *as that user* with the provided password to verify their credentials
5. It reads the user's `memberOf` attribute and maps AD group DNs to roles using your group mappings
6. If a matching group is found, a session is created. If no group matches and no default role is set, access is denied.

**Service account requirements:**
- Read access to the directory (no write permissions needed)
- Ability to search under the configured base DN
- Ability to read `memberOf`, `sAMAccountName`, `displayName`, `mail` attributes

**Example LDAP settings for Active Directory:**
```
URL:           ldap://dc01.company.local:389
               ldaps://dc01.company.local:636  (recommended for production)
Bind DN:       CN=svc-upsmonitor,OU=ServiceAccounts,DC=company,DC=local
Search base:   DC=company,DC=local
Search filter: (sAMAccountName={{username}})
```

**Group mapping example:**
```
Group DN:   CN=UPS-Admins,OU=Groups,DC=company,DC=local  →  Administrator
Group DN:   CN=Network-Team,OU=Groups,DC=company,DC=local  →  Viewer
```

Use the **Test** panel in the LDAP settings to verify authentication with a real AD account before enabling.

### Roles and permissions

| Permission | Description |
|---|---|
| `can_view` | View dashboard, devices, and poll data |
| `can_edit_devices` | Add, edit, and delete devices |
| `can_manage_sites` | Add, edit, and delete sites |
| `can_manage_users` | Manage users, roles, LDAP config, view audit log |
| `can_manage_snmp` | View and edit SNMP credentials |
| `can_poll` | Trigger manual on-demand polls |

Built-in system roles (cannot be edited or deleted):
- **Administrator** — all permissions
- **Viewer** — `can_view` only

Custom roles with any combination of permissions can be created in the UI.

---

## Device fields

| Field | Required | Notes |
|---|---|---|
| Site | Yes | Select from your configured sites |
| Device name | Yes | e.g. `UPS-FL3-A` |
| IP address | Yes | Must be reachable from this server on UDP 161 |
| Floor / location | No | e.g. `Floor 3`, `Data Center Cage B` |
| Serial number | No | Manual override — SNMP serial is also read and displayed separately |
| Model hint | No | Include "apc", "eaton", or "cyber" to force vendor OID selection |
| Replacement part # | No | Stored for reference, shown in device detail |
| Battery installed date | No | Required for battery life bar and replacement timeline |

---

## SNMP OID support

| Brand | Battery % | Temp | Runtime | Replace date | Load | Voltage |
|---|---|---|---|---|---|---|
| APC | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Eaton / Powerware | ✓ | ✓ | ✓ | — | ✓ | ✓ |
| CyberPower | ✓ | ✓ | ✓ | — | ✓ | ✓ |

Vendor detection is automatic via `sysDescr`. If your device isn't detected correctly, include "eaton", "cyber", or "apc" in the model hint field when adding the device.

---

## Alert thresholds

| Condition | Warning | Critical |
|---|---|---|
| Battery charge | < 40% | < 20% |
| Battery temperature | ≥ 40°C | ≥ 45°C |
| Estimated runtime | < 20 min | < 10 min |
| Battery age (4-year life) | < 180 days to replace date | Overdue |
| UPS-reported replace date | < 90 days | Overdue |
| UPS battery status | — | Low / Fault / Depleted reported by device |

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP listen port |
| `HOST` | `127.0.0.1` | Bind address. Change to `0.0.0.0` only if behind a firewall or reverse proxy |
| `DB_PATH` | `./data/battstat.db` | SQLite database path |
| `ALLOWED_ORIGIN` | _(empty)_ | If set, WebSocket connections are only accepted from this exact origin (e.g. `https://ups.internal.company.com`) |

---

## Useful commands

```bash
# View live logs
journalctl -u battstat -f

# Restart service
systemctl restart battstat

# Check service status
systemctl status battstat

# Add an admin user
cd /opt/battstat && node scripts/create-admin.js

# Run database migrations manually
cd /opt/battstat && node scripts/migrate.js

# Backup the database
cp /opt/battstat/data/battstat.db /backup/battstat-$(date +%Y%m%d).db
```

## Upgrading

### From a git clone (recommended)
```bash
sudo bash /opt/battstat/upgrade.sh
```

The upgrade script:
1. Backs up the database to `/var/backups/battstat/`
2. Stops the service
3. Runs `git pull --ff-only`
4. Runs `npm install`
5. Runs DB migrations
6. Restarts the service
7. Rolls back automatically if any step fails

### From a zip download
```bash
unzip battstat-new.zip -d /tmp
sudo bash /opt/battstat/upgrade.sh --from /tmp/battstat
```

### Options
```bash
sudo bash upgrade.sh --force         # skip confirmation prompt
sudo bash upgrade.sh --skip-backup   # skip pre-upgrade backup (not recommended)
sudo bash upgrade.sh --help          # full usage
```

## Uninstalling

```bash
# Preserve the database (default — data saved to /var/backups/battstat/)
sudo bash /opt/battstat/uninstall.sh

# Remove everything including the database (permanent)
sudo bash /opt/battstat/uninstall.sh --purge

# Full options
sudo bash /opt/battstat/uninstall.sh --help
```

---

## Firewall

### ufw (Ubuntu/Debian)
```bash
# Allow only from your internal network (recommended)
sudo ufw allow from 10.0.0.0/8 to any port 3000 comment "BattStat"

# Or allow from everywhere (if the server itself is firewalled)
sudo ufw allow 3000/tcp comment "BattStat"
```

### firewalld (Fedora/RHEL)
```bash
# Allow on the internal zone only (recommended)
sudo firewall-cmd --permanent --zone=internal --add-port=3000/tcp
sudo firewall-cmd --reload

# Or allow globally
sudo firewall-cmd --permanent --add-port=3000/tcp
sudo firewall-cmd --reload
```

---

## Putting nginx in front (recommended for production)

Binding to `127.0.0.1` and fronting with nginx gives you TLS termination and keeps the Node process off the internet directly.

```nginx
server {
    listen 443 ssl;
    server_name ups.internal.company.com;

    ssl_certificate     /etc/ssl/certs/battstat.crt;
    ssl_certificate_key /etc/ssl/private/battstat.key;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

Then set `ALLOWED_ORIGIN=https://ups.internal.company.com` in the systemd unit file so WebSocket origin validation matches.

---

## Security notes

- Sessions use cryptographically random 32-byte tokens (64 hex chars) stored as `HttpOnly; SameSite=Strict` cookies
- Passwords are hashed with PBKDF2-SHA256 at 310,000 iterations with a random per-user salt
- Password comparisons use `crypto.timingSafeEqual` to prevent timing attacks
- LDAP credentials from the search filter are escaped to prevent LDAP injection
- All admin actions (user creation, SNMP config changes, login attempts) are written to the audit log
- The WebSocket endpoint validates session cookies and rejects connections from unexpected origins
- Rate limiting: 120 API requests/min globally, 20 manual polls/min, 20 login attempts per 15 minutes
- The `battstat` system user runs with `NoNewPrivileges`, `ProtectSystem=strict`, `MemoryDenyWriteExecute`, and other systemd hardening
- SNMP credentials and LDAP bind passwords are stored in SQLite — protect the database file (`chmod 600`)
