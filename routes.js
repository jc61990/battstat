'use strict';

const express = require('express');
const router  = express.Router();
const db      = require('./db');
const { requireAuth, requirePerm } = require('./auth/middleware');
const { restartPoller, pollSingleDevice } = require('./poller');

function ok(res, data)           { res.json({ ok: true, data }); }
function err(res, msg, code=400) { res.status(code).json({ ok: false, error: msg }); }

router.get('/status', requireAuth, (req, res) => ok(res, { status: 'running', time: new Date().toISOString() }));

router.get('/sites',      requireAuth,                  (req, res) => ok(res, db.getSites()));
router.post('/sites',     requirePerm('can_manage_sites'), (req, res) => {
  const { name, location } = req.body;
  if (!name?.trim()) return err(res, 'name is required');
  try {
    const s = db.createSite(name.trim(), location);
    db.auditLog(req.session.username, req.ip, 'CREATE_SITE', name, '', true);
    ok(res, s);
  } catch (e) { err(res, e.message); }
});
router.put('/sites/:id',  requirePerm('can_manage_sites'), (req, res) => {
  const { name, location } = req.body;
  if (!name?.trim()) return err(res, 'name is required');
  if (!db.getSite(req.params.id)) return err(res, 'Site not found', 404);
  try {
    const s = db.updateSite(req.params.id, name.trim(), location);
    db.auditLog(req.session.username, req.ip, 'UPDATE_SITE', name, '', true);
    ok(res, s);
  } catch (e) { err(res, e.message); }
});
router.delete('/sites/:id', requirePerm('can_manage_sites'), (req, res) => {
  if (!db.getSite(req.params.id)) return err(res, 'Site not found', 404);
  try {
    db.deleteSite(req.params.id);
    db.auditLog(req.session.username, req.ip, 'DELETE_SITE', req.params.id, '', true);
    ok(res, null);
  } catch (e) { err(res, e.message); }
});

router.get('/devices',      requireAuth,                    (req, res) => ok(res, db.getDevices(req.query.site_id||null)));
router.get('/devices/:id',  requireAuth,                    (req, res) => { const d = db.getDevice(req.params.id); if (!d) return err(res, 'Not found', 404); ok(res, d); });
router.post('/devices',     requirePerm('can_edit_devices'), (req, res) => {
  const { site_id, name, ip } = req.body;
  if (!site_id || !name?.trim() || !ip?.trim()) return err(res, 'site_id, name and ip are required');
  if (!db.getSite(site_id)) return err(res, 'Site not found', 404);
  try {
    const d = db.createDevice(req.body);
    db.auditLog(req.session.username, req.ip, 'CREATE_DEVICE', name, ip, true);
    ok(res, d);
  } catch (e) {
    if (e.message.includes('UNIQUE')) return err(res, 'A device with that IP already exists');
    err(res, e.message);
  }
});
router.put('/devices/:id',  requirePerm('can_edit_devices'), (req, res) => {
  const { site_id, name, ip } = req.body;
  if (!site_id || !name?.trim() || !ip?.trim()) return err(res, 'site_id, name and ip are required');
  if (!db.getDevice(req.params.id)) return err(res, 'Device not found', 404);
  try {
    const d = db.updateDevice(req.params.id, req.body);
    db.auditLog(req.session.username, req.ip, 'UPDATE_DEVICE', name, ip, true);
    ok(res, d);
  } catch (e) {
    if (e.message.includes('UNIQUE')) return err(res, 'A device with that IP already exists');
    err(res, e.message);
  }
});
router.delete('/devices/:id', requirePerm('can_edit_devices'), (req, res) => {
  if (!db.getDevice(req.params.id)) return err(res, 'Device not found', 404);
  try {
    db.deleteDevice(req.params.id);
    db.auditLog(req.session.username, req.ip, 'DELETE_DEVICE', req.params.id, '', true);
    ok(res, null);
  } catch (e) { err(res, e.message); }
});

router.get('/poll/latest',         requireAuth,          (req, res) => ok(res, db.getLatestPollAll()));
router.get('/poll/history/:id',    requireAuth,          (req, res) => {
  const limit = Math.min(parseInt(req.query.limit)||288, 1440);
  ok(res, db.getPollHistory(req.params.id, limit));
});
router.post('/poll/device/:id',    requirePerm('can_poll'), async (req, res) => {
  if (!db.getDevice(req.params.id)) return err(res, 'Device not found', 404);
  try { ok(res, await pollSingleDevice(req.params.id)); }
  catch (e) { err(res, e.message); }
});

router.get('/snmp/config',  requirePerm('can_manage_snmp'), (req, res) => {
  const cfg = db.getSnmpConfig();
  ok(res, { ...cfg, auth_key: cfg.auth_key ? '••••••••' : '', priv_key: cfg.priv_key ? '••••••••' : '' });
});
router.post('/snmp/config', requirePerm('can_manage_snmp'), (req, res) => {
  try {
    const saved = db.saveSnmpConfig(req.body);
    restartPoller();
    db.auditLog(req.session.username, req.ip, 'UPDATE_SNMP_CONFIG', 'snmp', '', true);
    ok(res, { ...saved, auth_key: saved.auth_key ? '••••••••' : '', priv_key: saved.priv_key ? '••••••••' : '' });
  } catch (e) { err(res, e.message); }
});

module.exports = router;
