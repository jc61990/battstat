'use strict';

const Database = require('better-sqlite3');
const crypto   = require('crypto');
const path     = require('path');
const fs       = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'battstat.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS sites (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    location   TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS devices (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id           INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    name              TEXT NOT NULL,
    ip                TEXT NOT NULL UNIQUE,
    floor             TEXT NOT NULL DEFAULT '',
    serial            TEXT NOT NULL DEFAULT '',
    model             TEXT NOT NULL DEFAULT '',
    part_number       TEXT NOT NULL DEFAULT '',
    battery_installed TEXT NOT NULL DEFAULT '',
    notes             TEXT NOT NULL DEFAULT '',
    snmp_version      TEXT NOT NULL DEFAULT 'auto',
    created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at        INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS poll_results (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id         INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    polled_at         INTEGER NOT NULL DEFAULT (unixepoch()),
    reachable         INTEGER NOT NULL DEFAULT 0,
    batt_capacity     INTEGER,
    batt_status       TEXT,
    batt_replace_date TEXT,
    batt_run_time     INTEGER,
    batt_temperature  INTEGER,
    input_voltage     INTEGER,
    output_voltage    INTEGER,
    output_load       INTEGER,
    model_snmp        TEXT,
    serial_snmp       TEXT,
    firmware          TEXT,
    raw_error         TEXT
  );

  CREATE TABLE IF NOT EXISTS snmp_config (
    id              INTEGER PRIMARY KEY CHECK (id = 1),
    security_name   TEXT NOT NULL DEFAULT '',
    auth_protocol   TEXT NOT NULL DEFAULT 'SHA',
    auth_key        TEXT NOT NULL DEFAULT '',
    priv_protocol   TEXT NOT NULL DEFAULT 'AES',
    priv_key        TEXT NOT NULL DEFAULT '',
    security_level  TEXT NOT NULL DEFAULT 'authPriv',
    port            INTEGER NOT NULL DEFAULT 161,
    timeout_ms      INTEGER NOT NULL DEFAULT 5000,
    retries         INTEGER NOT NULL DEFAULT 1,
    poll_interval_s INTEGER NOT NULL DEFAULT 60,
    community       TEXT NOT NULL DEFAULT 'public'
  );

  INSERT OR IGNORE INTO snmp_config (id) VALUES (1);

  CREATE TABLE IF NOT EXISTS roles (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT NOT NULL UNIQUE,
    description      TEXT NOT NULL DEFAULT '',
    can_view         INTEGER NOT NULL DEFAULT 1,
    can_edit_devices INTEGER NOT NULL DEFAULT 0,
    can_manage_sites INTEGER NOT NULL DEFAULT 0,
    can_manage_users INTEGER NOT NULL DEFAULT 0,
    can_manage_snmp  INTEGER NOT NULL DEFAULT 0,
    can_poll         INTEGER NOT NULL DEFAULT 0,
    is_system        INTEGER NOT NULL DEFAULT 0,
    created_at       INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS local_users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name  TEXT NOT NULL DEFAULT '',
    email         TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    role_id       INTEGER NOT NULL REFERENCES roles(id),
    is_active     INTEGER NOT NULL DEFAULT 1,
    session_type  TEXT NOT NULL DEFAULT 'session',
    session_ttl_h INTEGER NOT NULL DEFAULT 8,
    last_login    INTEGER,
    created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS ldap_config (
    id                 INTEGER PRIMARY KEY CHECK (id = 1),
    enabled            INTEGER NOT NULL DEFAULT 0,
    url                TEXT NOT NULL DEFAULT '',
    bind_dn            TEXT NOT NULL DEFAULT '',
    bind_password      TEXT NOT NULL DEFAULT '',
    search_base        TEXT NOT NULL DEFAULT '',
    search_filter      TEXT NOT NULL DEFAULT '(sAMAccountName={{username}})',
    tls_verify         INTEGER NOT NULL DEFAULT 1,
    connect_timeout_ms INTEGER NOT NULL DEFAULT 5000,
    default_role_id    INTEGER REFERENCES roles(id)
  );

  INSERT OR IGNORE INTO ldap_config (id) VALUES (1);

  CREATE TABLE IF NOT EXISTS ldap_group_role_map (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    group_dn TEXT NOT NULL UNIQUE,
    role_id  INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    label    TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    token        TEXT NOT NULL UNIQUE,
    user_id      INTEGER NOT NULL,
    user_type    TEXT NOT NULL DEFAULT 'local',
    username     TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    role_id      INTEGER NOT NULL REFERENCES roles(id),
    persistent   INTEGER NOT NULL DEFAULT 0,
    expires_at   INTEGER NOT NULL,
    created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
    last_seen    INTEGER NOT NULL DEFAULT (unixepoch()),
    ip_address   TEXT NOT NULL DEFAULT '',
    user_agent   TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS user_site_access (
    user_id  INTEGER NOT NULL REFERENCES local_users(id) ON DELETE CASCADE,
    site_id  INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, site_id)
  );

  CREATE INDEX IF NOT EXISTS idx_user_site_access_user ON user_site_access(user_id);

  CREATE TABLE IF NOT EXISTS audit_log (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    ts       INTEGER NOT NULL DEFAULT (unixepoch()),
    username TEXT NOT NULL DEFAULT '',
    ip       TEXT NOT NULL DEFAULT '',
    action   TEXT NOT NULL,
    target   TEXT NOT NULL DEFAULT '',
    detail   TEXT NOT NULL DEFAULT '',
    success  INTEGER NOT NULL DEFAULT 1
  );

  CREATE INDEX IF NOT EXISTS idx_poll_device    ON poll_results(device_id, polled_at DESC);
  CREATE INDEX IF NOT EXISTS idx_session_token  ON sessions(token);
  CREATE INDEX IF NOT EXISTS idx_session_expiry ON sessions(expires_at);
  CREATE INDEX IF NOT EXISTS idx_audit_ts       ON audit_log(ts DESC);
`);

(function bootstrapRoles() {
  if (db.prepare('SELECT COUNT(*) as c FROM roles').get().c > 0) return;
  const ins = db.prepare(`INSERT INTO roles (name,description,can_view,can_edit_devices,can_manage_sites,can_manage_users,can_manage_snmp,can_poll,is_system) VALUES (?,?,?,?,?,?,?,?,?)`);
  ins.run('Administrator','Full access to all features',1,1,1,1,1,1,1);
  ins.run('Viewer','Read-only dashboard access',1,0,0,0,0,0,1);
})();

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 310000, 32, 'sha256').toString('hex');
}
function verifyPassword(password, salt, hash) {
  const computed = hashPassword(password, salt);
  const a = Buffer.from(computed, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

module.exports = {
  db,

  getSites() { return db.prepare('SELECT * FROM sites ORDER BY name').all(); },
  getSite(id) { return db.prepare('SELECT * FROM sites WHERE id=?').get(id); },
  createSite(name, location) {
    const r = db.prepare('INSERT INTO sites (name,location) VALUES (?,?)').run(name, location||'');
    return this.getSite(r.lastInsertRowid);
  },
  updateSite(id, name, location) {
    db.prepare('UPDATE sites SET name=?,location=? WHERE id=?').run(name, location||'', id);
    return this.getSite(id);
  },
  deleteSite(id) { return db.prepare('DELETE FROM sites WHERE id=?').run(id); },

  getDevices(siteId) {
    const sql = siteId
      ? 'SELECT d.*,s.name as site_name,s.location as site_location FROM devices d JOIN sites s ON d.site_id=s.id WHERE d.site_id=? ORDER BY d.name'
      : 'SELECT d.*,s.name as site_name,s.location as site_location FROM devices d JOIN sites s ON d.site_id=s.id ORDER BY s.name,d.name';
    return siteId ? db.prepare(sql).all(siteId) : db.prepare(sql).all();
  },
  getDevice(id) {
    return db.prepare('SELECT d.*,s.name as site_name,s.location as site_location FROM devices d JOIN sites s ON d.site_id=s.id WHERE d.id=?').get(id);
  },
  createDevice(f) {
    const r = db.prepare('INSERT INTO devices (site_id,name,ip,floor,serial,model,part_number,battery_installed,notes,snmp_version) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(f.site_id,f.name,f.ip,f.floor||'',f.serial||'',f.model||'',f.part_number||'',f.battery_installed||'',f.notes||'',f.snmp_version||'auto');
    return this.getDevice(r.lastInsertRowid);
  },
  updateDevice(id, f) {
    db.prepare('UPDATE devices SET site_id=?,name=?,ip=?,floor=?,serial=?,model=?,part_number=?,battery_installed=?,notes=?,snmp_version=?,updated_at=unixepoch() WHERE id=?')
      .run(f.site_id,f.name,f.ip,f.floor||'',f.serial||'',f.model||'',f.part_number||'',f.battery_installed||'',f.notes||'',f.snmp_version||'auto',id);
    return this.getDevice(id);
  },
  deleteDevice(id) { return db.prepare('DELETE FROM devices WHERE id=?').run(id); },

  savePollResult(deviceId, data) {
    return db.prepare('INSERT INTO poll_results (device_id,reachable,batt_capacity,batt_status,batt_replace_date,batt_run_time,batt_temperature,input_voltage,output_voltage,output_load,model_snmp,serial_snmp,firmware,raw_error) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(deviceId,data.reachable?1:0,data.batt_capacity??null,data.batt_status??null,data.batt_replace_date??null,data.batt_run_time??null,data.batt_temperature??null,data.input_voltage??null,data.output_voltage??null,data.output_load??null,data.model_snmp??null,data.serial_snmp??null,data.firmware??null,data.raw_error??null);
  },
  getLatestPoll(deviceId) {
    return db.prepare('SELECT * FROM poll_results WHERE device_id=? ORDER BY polled_at DESC LIMIT 1').get(deviceId);
  },
  getLatestPollAll() {
    return db.prepare('SELECT pr.* FROM poll_results pr INNER JOIN (SELECT device_id,MAX(polled_at) AS max_at FROM poll_results GROUP BY device_id) l ON pr.device_id=l.device_id AND pr.polled_at=l.max_at').all();
  },
  getPollHistory(deviceId, limit=288) {
    return db.prepare('SELECT * FROM poll_results WHERE device_id=? ORDER BY polled_at DESC LIMIT ?').all(deviceId, limit);
  },
  pruneOldPolls(days=30) {
    return db.prepare('DELETE FROM poll_results WHERE polled_at<?').run(Math.floor(Date.now()/1000)-days*86400);
  },

  getSnmpConfig() { return db.prepare('SELECT * FROM snmp_config WHERE id=1').get(); },
  saveSnmpConfig(cfg) {
    db.prepare('UPDATE snmp_config SET security_name=?,auth_protocol=?,auth_key=?,priv_protocol=?,priv_key=?,security_level=?,port=?,timeout_ms=?,retries=?,poll_interval_s=?,community=? WHERE id=1')
      .run(cfg.security_name||'',cfg.auth_protocol||'SHA',cfg.auth_key||'',cfg.priv_protocol||'AES',cfg.priv_key||'',cfg.security_level||'authPriv',cfg.port||161,cfg.timeout_ms||5000,cfg.retries??1,cfg.poll_interval_s||60,cfg.community||'public');
    return this.getSnmpConfig();
  },

  getRoles() { return db.prepare('SELECT * FROM roles ORDER BY is_system DESC,name').all(); },
  getRole(id) { return db.prepare('SELECT * FROM roles WHERE id=?').get(id); },
  createRole(f) {
    const r = db.prepare('INSERT INTO roles (name,description,can_view,can_edit_devices,can_manage_sites,can_manage_users,can_manage_snmp,can_poll,is_system) VALUES (?,?,?,?,?,?,?,?,0)')
      .run(f.name,f.description||'',f.can_view?1:0,f.can_edit_devices?1:0,f.can_manage_sites?1:0,f.can_manage_users?1:0,f.can_manage_snmp?1:0,f.can_poll?1:0);
    return this.getRole(r.lastInsertRowid);
  },
  updateRole(id, f) {
    db.prepare('UPDATE roles SET name=?,description=?,can_view=?,can_edit_devices=?,can_manage_sites=?,can_manage_users=?,can_manage_snmp=?,can_poll=? WHERE id=? AND is_system=0')
      .run(f.name,f.description||'',f.can_view?1:0,f.can_edit_devices?1:0,f.can_manage_sites?1:0,f.can_manage_users?1:0,f.can_manage_snmp?1:0,f.can_poll?1:0,id);
    return this.getRole(id);
  },
  deleteRole(id) {
    const role = this.getRole(id);
    if (!role || role.is_system) throw new Error('Cannot delete a system role');
    return db.prepare('DELETE FROM roles WHERE id=?').run(id);
  },

  getUsers() {
    return db.prepare('SELECT u.id,u.username,u.display_name,u.email,u.role_id,u.is_active,u.session_type,u.session_ttl_h,u.last_login,u.created_at,u.updated_at,r.name as role_name FROM local_users u JOIN roles r ON u.role_id=r.id ORDER BY u.username').all();
  },
  getUser(id) {
    return db.prepare('SELECT u.*,r.name as role_name FROM local_users u JOIN roles r ON u.role_id=r.id WHERE u.id=?').get(id);
  },
  getUserByUsername(username) {
    return db.prepare('SELECT u.*,r.id as r_id,r.name as role_name,r.can_view,r.can_edit_devices,r.can_manage_sites,r.can_manage_users,r.can_manage_snmp,r.can_poll FROM local_users u JOIN roles r ON u.role_id=r.id WHERE u.username=? COLLATE NOCASE AND u.is_active=1').get(username);
  },
  createUser(f) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = hashPassword(f.password, salt);
    const r = db.prepare('INSERT INTO local_users (username,display_name,email,password_hash,password_salt,role_id,session_type,session_ttl_h) VALUES (?,?,?,?,?,?,?,?)')
      .run(f.username.trim(),f.display_name||f.username.trim(),f.email||'',hash,salt,f.role_id,f.session_type||'session',f.session_ttl_h||8);
    return this.getUser(r.lastInsertRowid);
  },
  updateUser(id, f) {
    const cols = ['display_name=?','email=?','role_id=?','is_active=?','session_type=?','session_ttl_h=?','updated_at=unixepoch()'];
    const vals = [f.display_name||'',f.email||'',f.role_id,f.is_active?1:0,f.session_type||'session',f.session_ttl_h||8];
    if (f.password) {
      const salt = crypto.randomBytes(16).toString('hex');
      cols.push('password_hash=?','password_salt=?');
      vals.push(hashPassword(f.password,salt),salt);
    }
    vals.push(id);
    db.prepare(`UPDATE local_users SET ${cols.join(',')} WHERE id=?`).run(...vals);
    return this.getUser(id);
  },
  deleteUser(id) { return db.prepare('DELETE FROM local_users WHERE id=?').run(id); },
  verifyLocalUser(username, password) {
    const user = this.getUserByUsername(username);
    if (!user) return null;
    if (!verifyPassword(password, user.password_salt, user.password_hash)) return null;
    db.prepare('UPDATE local_users SET last_login=unixepoch() WHERE id=?').run(user.id);
    return user;
  },

  getLdapConfig() { return db.prepare('SELECT * FROM ldap_config WHERE id=1').get(); },
  saveLdapConfig(cfg) {
    db.prepare('UPDATE ldap_config SET enabled=?,url=?,bind_dn=?,bind_password=?,search_base=?,search_filter=?,tls_verify=?,connect_timeout_ms=?,default_role_id=? WHERE id=1')
      .run(cfg.enabled?1:0,cfg.url||'',cfg.bind_dn||'',cfg.bind_password||'',cfg.search_base||'',cfg.search_filter||'(sAMAccountName={{username}})',cfg.tls_verify?1:0,cfg.connect_timeout_ms||5000,cfg.default_role_id||null);
    return this.getLdapConfig();
  },

  getLdapGroupMaps() {
    return db.prepare('SELECT m.*,r.name as role_name FROM ldap_group_role_map m JOIN roles r ON m.role_id=r.id ORDER BY m.label,m.group_dn').all();
  },
  addLdapGroupMap(group_dn, role_id, label) {
    const r = db.prepare('INSERT INTO ldap_group_role_map (group_dn,role_id,label) VALUES (?,?,?)').run(group_dn,role_id,label||group_dn);
    return db.prepare('SELECT m.*,r.name as role_name FROM ldap_group_role_map m JOIN roles r ON m.role_id=r.id WHERE m.id=?').get(r.lastInsertRowid);
  },
  updateLdapGroupMap(id, group_dn, role_id, label) {
    db.prepare('UPDATE ldap_group_role_map SET group_dn=?,role_id=?,label=? WHERE id=?').run(group_dn,role_id,label||group_dn,id);
    return db.prepare('SELECT m.*,r.name as role_name FROM ldap_group_role_map m JOIN roles r ON m.role_id=r.id WHERE m.id=?').get(id);
  },
  deleteLdapGroupMap(id) { return db.prepare('DELETE FROM ldap_group_role_map WHERE id=?').run(id); },

  createSession(data) {
    const token     = generateToken();
    const ttlSecs   = (data.session_ttl_h || 8) * 3600;
    const expiresAt = Math.floor(Date.now()/1000) + ttlSecs;
    db.prepare('INSERT INTO sessions (token,user_id,user_type,username,display_name,role_id,persistent,expires_at,ip_address,user_agent) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(token,data.user_id,data.user_type||'local',data.username,data.display_name||data.username,data.role_id,data.persistent?1:0,expiresAt,data.ip||'',data.ua||'');
    return { token, expiresAt };
  },
  getSession(token) {
    const s = db.prepare('SELECT s.*,r.name as role_name,r.can_view,r.can_edit_devices,r.can_manage_sites,r.can_manage_users,r.can_manage_snmp,r.can_poll FROM sessions s JOIN roles r ON s.role_id=r.id WHERE s.token=? AND s.expires_at>unixepoch()').get(token);
    if (s) db.prepare('UPDATE sessions SET last_seen=unixepoch() WHERE token=?').run(token);
    return s || null;
  },
  renewSession(token, ttlSecs) {
    db.prepare('UPDATE sessions SET expires_at=unixepoch()+? WHERE token=?').run(ttlSecs, token);
  },
  deleteSession(token) { return db.prepare('DELETE FROM sessions WHERE token=?').run(token); },
  deleteUserSessions(userId, userType) {
    return db.prepare('DELETE FROM sessions WHERE user_id=? AND user_type=?').run(userId, userType||'local');
  },
  pruneExpiredSessions() { return db.prepare('DELETE FROM sessions WHERE expires_at<=unixepoch()').run(); },
  getActiveSessions() {
    return db.prepare('SELECT s.*,r.name as role_name FROM sessions s JOIN roles r ON s.role_id=r.id WHERE s.expires_at>unixepoch() ORDER BY s.last_seen DESC').all();
  },

  // Called by poller when auto-detection finds a working SNMP version.
  // Stores the discovered version so future polls skip the fallback sequence.
  // Only updates if device is currently set to 'auto' -- never overwrites a manual choice.
  setDiscoveredSnmpVersion(deviceId, version) {
    db.prepare("UPDATE devices SET snmp_version=? WHERE id=? AND snmp_version='auto'")
      .run(version, deviceId);
  },

  // Reset a device back to auto-detect (called if device stops responding).
  resetSnmpVersionToAuto(deviceId) {
    db.prepare("UPDATE devices SET snmp_version='auto' WHERE id=? AND snmp_version NOT IN ('v3','v2c','v1')")
      .run(deviceId);
  },

  // Auto-fill the part_number field if blank and we have a known model match.
  // Called from the poller after each successful poll -- never overwrites existing values.
  autoFillPartNumber(deviceId, partNumber) {
    if (!partNumber) return;
    db.prepare(
      "UPDATE devices SET part_number=?, updated_at=unixepoch() WHERE id=? AND (part_number IS NULL OR part_number='')"
    ).run(partNumber, deviceId);
  },

  // Auto-fill battery_installed date from SNMP if the field is currently blank.
  // Only Tripp Lite NMC5 returns a last-replaced date via SNMP.
  // Site access control
  getUserSiteIds(userId) {
    const rows = db.prepare('SELECT site_id FROM user_site_access WHERE user_id=?').all(userId);
    return rows.map(r => r.site_id);
  },
  setUserSites(userId, siteIds) {
    db.transaction(() => {
      db.prepare('DELETE FROM user_site_access WHERE user_id=?').run(userId);
      const ins = db.prepare('INSERT OR IGNORE INTO user_site_access (user_id,site_id) VALUES (?,?)');
      for (const siteId of (siteIds || [])) ins.run(userId, siteId);
    })();
  },
  // Returns null if user has no restriction (admin or all-access), or array of allowed site IDs
  getAllowedSiteIds(userId, userType, roleId) {
    // LDAP users and admins always get all sites
    if (userType === 'ldap') return null;
    const role = this.getRole(roleId);
    if (role && role.can_manage_sites) return null; // site managers see all
    const ids = this.getUserSiteIds(userId);
    // If no explicit assignments, default to all sites (backward compat)
    return ids.length > 0 ? ids : null;
  },

  autoFillBatteryInstalled(deviceId, dateStr) {
    if (!dateStr) return;
    // Validate it looks like a date before writing (YYYY-MM-DD or similar)
    if (!/^\d{4}-\d{2}-\d{2}/.test(dateStr)) return;
    db.prepare(
      "UPDATE devices SET battery_installed=?, updated_at=unixepoch() WHERE id=? AND (battery_installed IS NULL OR battery_installed='')"
    ).run(dateStr, deviceId);
  },

  auditLog(username, ip, action, target, detail, success=true) {
    return db.prepare('INSERT INTO audit_log (username,ip,action,target,detail,success) VALUES (?,?,?,?,?,?)').run(username||'',ip||'',action,target||'',detail||'',success?1:0);
  },
  getAuditLog(limit=200) {
    return db.prepare('SELECT * FROM audit_log ORDER BY ts DESC LIMIT ?').all(limit);
  },
};
