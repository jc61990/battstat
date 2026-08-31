#!/usr/bin/env node
/**
 * Database migration runner.
 * Each migration is identified by a numeric version, runs once,
 * and is recorded in the schema_migrations table.
 * Safe to run multiple times -- already-applied migrations are skipped.
 *
 * Called automatically by upgrade.sh after files are updated.
 * Can also be run manually: node scripts/migrate.js
 */
'use strict';

const path = require('path');
process.env.DB_PATH = process.env.DB_PATH ||
  path.join(__dirname, '..', 'data', 'battstat.db');

const Database = require('better-sqlite3');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH;

if (!fs.existsSync(DB_PATH)) {
  console.log('[migrate] No database found -- nothing to migrate.');
  process.exit(0);
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Create migrations tracking table if it doesn't exist
db.exec(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
`);

function applied(version) {
  return !!db.prepare('SELECT 1 FROM schema_migrations WHERE version=?').get(version);
}

function apply(version, name, fn) {
  if (applied(version)) {
    console.log(`[migrate] ${version} -- ${name}: already applied, skipping`);
    return;
  }
  console.log(`[migrate] ${version} -- ${name}: applying...`);
  try {
    db.transaction(() => {
      fn(db);
      db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)')
        .run(version, name);
    })();
    console.log(`[migrate] ${version} -- ${name}: done`);
  } catch (err) {
    console.error(`[migrate] ${version} -- ${name}: FAILED -- ${err.message}`);
    process.exit(1);
  }
}

// -- Migrations ----------------------------------------------------------------
// Add new migrations at the bottom. Never edit existing ones.
// Each migration must be idempotent -- use IF NOT EXISTS / IF EXISTS guards.

apply(1, 'initial_schema', (db) => {
  // Version 1 is the baseline -- nothing to run if the tables already exist
  // (db.js creates them on first run). This just records the baseline.
});

apply(2, 'add_email_to_local_users', (db) => {
  // email column was added in v1.2 -- add it if somehow missing
  const cols = db.prepare("PRAGMA table_info(local_users)").all();
  if (!cols.find(c => c.name === 'email')) {
    db.exec("ALTER TABLE local_users ADD COLUMN email TEXT NOT NULL DEFAULT ''");
  }
});

apply(3, 'add_batt_status_text', (db) => {
  // batt_status was INTEGER in early builds, changed to TEXT in v1.1
  // SQLite doesn't enforce column types so no migration needed --
  // just record that we've checked.
});

apply(4, 'add_audit_log_indexes', (db) => {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_audit_username ON audit_log(username);
    CREATE INDEX IF NOT EXISTS idx_audit_action   ON audit_log(action);
  `);
});

apply(5, 'add_session_user_agent_index', (db) => {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_session_user ON sessions(user_id, user_type);
  `);
});

apply(6, 'add_device_snmp_version', (db) => {
  const cols = db.prepare('PRAGMA table_info(devices)').all();
  if (!cols.find(c => c.name === 'snmp_version')) {
    db.exec("ALTER TABLE devices ADD COLUMN snmp_version TEXT NOT NULL DEFAULT 'auto'");
  }
});

apply(7, 'add_snmp_community', (db) => {
  const cols = db.prepare('PRAGMA table_info(snmp_config)').all();
  if (!cols.find(c => c.name === 'community')) {
    db.exec("ALTER TABLE snmp_config ADD COLUMN community TEXT NOT NULL DEFAULT 'public'");
  }
});

apply(8, 'set_snmp_version_auto_default', (db) => {
  // Migrate existing devices from old 'v3' default to 'auto' so they
  // benefit from fallback detection. Devices explicitly set to v2c/v1 unchanged.
  db.prepare("UPDATE devices SET snmp_version='auto' WHERE snmp_version='v3'").run();
});

apply(9, 'add_user_site_access', (db) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_site_access (
      user_id  INTEGER NOT NULL REFERENCES local_users(id) ON DELETE CASCADE,
      site_id  INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      PRIMARY KEY (user_id, site_id)
    );
    CREATE INDEX IF NOT EXISTS idx_user_site_access_user ON user_site_access(user_id);
  `);
});

apply(10, 'add_site_role_access', (db) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS site_role_access (
      role_id  INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      site_id  INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      PRIMARY KEY (role_id, site_id)
    );
    CREATE INDEX IF NOT EXISTS idx_site_role_access_role ON site_role_access(role_id);
  `);
  // Migrate any existing user_site_access entries to role-based access.
  // For each user that had explicit site access, apply it to their role instead.
  // This is best-effort -- if multiple users have different sites on the same role,
  // the role gets the union of all their sites.
  const userSites = db.prepare('SELECT u.role_id, usa.site_id FROM user_site_access usa JOIN local_users u ON usa.user_id=u.id').all();
  const ins = db.prepare('INSERT OR IGNORE INTO site_role_access (role_id,site_id) VALUES (?,?)');
  for (const row of userSites) ins.run(row.role_id, row.site_id);
});

apply(11, 'add_poll_diagnostics', (db) => {
  const cols = db.prepare('PRAGMA table_info(poll_results)').all().map(c => c.name);
  if (!cols.includes('input_frequency'))  db.exec('ALTER TABLE poll_results ADD COLUMN input_frequency  INTEGER');
  if (!cols.includes('output_current'))   db.exec('ALTER TABLE poll_results ADD COLUMN output_current   INTEGER');
  if (!cols.includes('self_test_result')) db.exec('ALTER TABLE poll_results ADD COLUMN self_test_result TEXT');
  if (!cols.includes('self_test_date'))   db.exec('ALTER TABLE poll_results ADD COLUMN self_test_date   TEXT');
  if (!cols.includes('last_xfer_reason')) db.exec('ALTER TABLE poll_results ADD COLUMN last_xfer_reason INTEGER');
  if (!cols.includes('transfer_count'))   db.exec('ALTER TABLE poll_results ADD COLUMN transfer_count   INTEGER');
});

apply(12, 'add_device_auth_protocol_override', (db) => {
  const cols = db.prepare('PRAGMA table_info(devices)').all().map(c => c.name);
  if (!cols.includes('auth_protocol')) db.exec('ALTER TABLE devices ADD COLUMN auth_protocol TEXT');
  if (!cols.includes('priv_protocol')) db.exec('ALTER TABLE devices ADD COLUMN priv_protocol TEXT');
});

apply(13, 'add_alerting', (db) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS alert_config (
      id              INTEGER PRIMARY KEY,
      enabled         INTEGER NOT NULL DEFAULT 0,
      smtp_host       TEXT NOT NULL DEFAULT '',
      smtp_port       INTEGER NOT NULL DEFAULT 587,
      smtp_secure     INTEGER NOT NULL DEFAULT 0,
      smtp_user       TEXT NOT NULL DEFAULT '',
      smtp_pass       TEXT NOT NULL DEFAULT '',
      smtp_from       TEXT NOT NULL DEFAULT '',
      recipients      TEXT NOT NULL DEFAULT '',
      alert_critical  INTEGER NOT NULL DEFAULT 1,
      alert_warning   INTEGER NOT NULL DEFAULT 1,
      alert_offline   INTEGER NOT NULL DEFAULT 1,
      reminder_hours  INTEGER NOT NULL DEFAULT 24
    );
    INSERT OR IGNORE INTO alert_config (id) VALUES (1);
    CREATE TABLE IF NOT EXISTS alert_state (
      device_id       INTEGER PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
      last_status     TEXT NOT NULL DEFAULT 'green',
      alerted_status  TEXT,
      last_alerted_at INTEGER
    );
  `);
});

apply(14, 'add_alert_state_columns', (db) => {
  const cols = db.prepare('PRAGMA table_info(alert_state)').all().map(c => c.name);
  if (!cols.includes('consecutive_failures'))
    db.exec("ALTER TABLE alert_state ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0");
  if (!cols.includes('last_xfer_reason'))
    db.exec("ALTER TABLE alert_state ADD COLUMN last_xfer_reason TEXT");
  if (!cols.includes('xfer_alerted_at'))
    db.exec("ALTER TABLE alert_state ADD COLUMN xfer_alerted_at INTEGER");
});

apply(15, 'add_extended_alert_config', (db) => {
  const cfgCols = db.prepare('PRAGMA table_info(alert_config)').all().map(c => c.name);
  const addCfg = (col, def) => { if (!cfgCols.includes(col)) db.exec(`ALTER TABLE alert_config ADD COLUMN ${col} ${def}`); };
  addCfg('alert_self_test_fail', 'INTEGER NOT NULL DEFAULT 1');
  addCfg('alert_not_charging',   'INTEGER NOT NULL DEFAULT 1');
  addCfg('alert_battery_age',    'INTEGER NOT NULL DEFAULT 1');
  addCfg('battery_age_years',    'REAL NOT NULL DEFAULT 4.0');
  addCfg('alert_recovery',       'INTEGER NOT NULL DEFAULT 1');
  addCfg('alert_high_load',      'INTEGER NOT NULL DEFAULT 1');
  addCfg('high_load_threshold',  'INTEGER NOT NULL DEFAULT 80');
  addCfg('alert_high_temp',      'INTEGER NOT NULL DEFAULT 1');
  addCfg('high_temp_threshold',  'INTEGER NOT NULL DEFAULT 35');
  addCfg('alert_stale',          'INTEGER NOT NULL DEFAULT 1');
  addCfg('stale_hours',          'INTEGER NOT NULL DEFAULT 2');

  const stateCols = db.prepare('PRAGMA table_info(alert_state)').all().map(c => c.name);
  const addState = (col, def) => { if (!stateCols.includes(col)) db.exec(`ALTER TABLE alert_state ADD COLUMN ${col} ${def}`); };
  addState('last_capacity',     'INTEGER');
  addState('last_self_test',    'TEXT');
  addState('recovery_alerted_at','INTEGER');
  addState('load_alerted_at',   'INTEGER');
  addState('temp_alerted_at',   'INTEGER');
  addState('stale_alerted_at',  'INTEGER');
  addState('not_charging_at',   'INTEGER');
});

apply(16, 'add_alert_history', (db) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS alert_history (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id  INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      ts         INTEGER NOT NULL DEFAULT (unixepoch()),
      event_type TEXT NOT NULL,
      detail     TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_alert_history_device ON alert_history(device_id, ts DESC);
  `);
});

// -- Summary -------------------------------------------------------------------
const allMigrations = db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
console.log(`\n[migrate] ${allMigrations.length} migration(s) recorded in schema_migrations.`);
console.log('[migrate] Database is up to date.\n');
