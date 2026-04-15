'use strict';

const express  = require('express');
const rateLimit = require('express-rate-limit');
const router   = express.Router();
const db       = require('../db');
const { authenticateLdap } = require('./ldap');
const { requireAuth, requirePerm, getTokenFromRequest } = require('./middleware');

function ok(res, data)         { res.json({ ok: true, data }); }
function err(res, msg, code=400) { res.status(code).json({ ok: false, error: msg }); }

function setSessionCookie(res, token, expiresAt, persistent) {
  const maxAge = persistent ? (expiresAt - Math.floor(Date.now()/1000)) : undefined;
  // secure=true is only set when HTTPS=true is explicitly configured --
  // NOT based on NODE_ENV, because production deployments often use plain
  // HTTP on an internal network. Setting secure=true over HTTP causes the
  // browser to silently drop the cookie, breaking login with no error shown.
  const secure = process.env.HTTPS === 'true';
  const opts = {
    httpOnly: true,
    sameSite: 'Strict',
    path:     '/',
    secure,
    ...(maxAge ? { maxAge: maxAge * 1000 } : {}),
  };
  res.cookie('battstat_session', token, opts);
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many login attempts -- try again in 15 minutes' },
});

router.post('/login', loginLimiter, async (req, res) => {
  const { username, password, persistent } = req.body;
  const ip = req.ip || '';
  const ua = req.headers['user-agent'] || '';

  if (!username || !password) return err(res, 'Username and password required');

  let user = null;
  let userType = 'local';

  const localUser = db.verifyLocalUser(username, password);
  if (localUser) {
    user     = localUser;
    userType = 'local';
  } else {
    const ldapResult = await authenticateLdap(username, password);
    if (ldapResult.success) {
      user     = ldapResult;
      userType = 'ldap';
    } else {
      const isNotConfigured = ldapResult.error.includes('not configured');
      db.auditLog(username, ip, 'LOGIN_FAILED', 'auth', isNotConfigured ? 'invalid_credentials' : ldapResult.error, false);
      return err(res, 'Invalid username or password', 401);
    }
  }

  const roleId     = userType === 'local' ? user.role_id : user.role_id;
  const ttlH       = userType === 'local' ? (user.session_ttl_h || 8) : 8;
  const isPersist  = userType === 'local'
    ? (user.session_type === 'persistent' || persistent)
    : !!persistent;

  const { token, expiresAt } = db.createSession({
    user_id:      userType === 'local' ? user.id : user.user_id,
    user_type:    userType,
    username:     userType === 'local' ? user.username : user.username,
    display_name: userType === 'local' ? user.display_name : user.display_name,
    role_id:      roleId,
    persistent:   isPersist,
    session_ttl_h: ttlH,
    ip,
    ua,
  });

  setSessionCookie(res, token, expiresAt, isPersist);
  db.auditLog(userType === 'local' ? user.username : user.username, ip, 'LOGIN_SUCCESS', 'auth', userType, true);

  const session = db.getSession(token);
  ok(res, {
    username:     session.username,
    display_name: session.display_name,
    role_name:    session.role_name,
    permissions: {
      can_view:          !!session.can_view,
      can_edit_devices:  !!session.can_edit_devices,
      can_manage_sites:  !!session.can_manage_sites,
      can_manage_users:  !!session.can_manage_users,
      can_manage_snmp:   !!session.can_manage_snmp,
      can_poll:          !!session.can_poll,
    },
  });
});

router.post('/logout', (req, res) => {
  const token = getTokenFromRequest(req);
  if (token) {
    const session = db.getSession(token);
    if (session) db.auditLog(session.username, req.ip||'', 'LOGOUT', 'auth', '', true);
    db.deleteSession(token);
  }
  res.clearCookie('battstat_session', { path: '/' });
  ok(res, null);
});

router.get('/me', requireAuth, (req, res) => {
  const s = req.session;
  // Get site restrictions for local users (null = unrestricted = sees all)
  const allowedSiteIds = s.user_type === 'local'
    ? db.getAllowedSiteIds(s.user_id, s.user_type, s.role_id)
    : null;
  ok(res, {
    username:        s.username,
    display_name:    s.display_name,
    user_type:       s.user_type,
    role_name:       s.role_name,
    allowed_site_ids: allowedSiteIds,  // null = all sites, array = restricted
    permissions: {
      can_view:         !!s.can_view,
      can_edit_devices: !!s.can_edit_devices,
      can_manage_sites: !!s.can_manage_sites,
      can_manage_users: !!s.can_manage_users,
      can_manage_snmp:  !!s.can_manage_snmp,
      can_poll:         !!s.can_poll,
    },
  });
});

router.get('/roles', requireAuth, (req, res) => ok(res, db.getRoles()));

router.post('/roles', requirePerm('can_manage_users'), (req, res) => {
  const { name, description, can_view, can_edit_devices, can_manage_sites, can_manage_users, can_manage_snmp, can_poll } = req.body;
  if (!name?.trim()) return err(res, 'Role name required');
  try {
    const role = db.createRole({ name: name.trim(), description, can_view, can_edit_devices, can_manage_sites, can_manage_users, can_manage_snmp, can_poll });
    db.auditLog(req.session.username, req.ip, 'CREATE_ROLE', 'roles', name, true);
    ok(res, role);
  } catch (e) {
    if (e.message.includes('UNIQUE')) return err(res, 'A role with that name already exists');
    err(res, e.message);
  }
});

router.put('/roles/:id', requirePerm('can_manage_users'), (req, res) => {
  const role = db.getRole(req.params.id);
  if (!role) return err(res, 'Role not found', 404);
  if (role.is_system) return err(res, 'Cannot edit system roles');
  try {
    const updated = db.updateRole(req.params.id, req.body);
    db.auditLog(req.session.username, req.ip, 'UPDATE_ROLE', role.name, '', true);
    ok(res, updated);
  } catch (e) { err(res, e.message); }
});

router.delete('/roles/:id', requirePerm('can_manage_users'), (req, res) => {
  try {
    const role = db.getRole(req.params.id);
    if (!role) return err(res, 'Role not found', 404);
    db.deleteRole(req.params.id);
    db.auditLog(req.session.username, req.ip, 'DELETE_ROLE', role.name, '', true);
    ok(res, null);
  } catch (e) { err(res, e.message); }
});

router.get('/users', requirePerm('can_manage_users'), (req, res) => ok(res, db.getUsers()));

router.get('/users/:id/sites', requirePerm('can_manage_users'), (req, res) => {
  ok(res, db.getUserSiteIds(req.params.id));
});

router.post('/users', requirePerm('can_manage_users'), (req, res) => {
  const { username, password, display_name, email, role_id, session_type, session_ttl_h, site_ids } = req.body;
  if (!username?.trim()) return err(res, 'Username required');
  if (!password || password.length < 8) return err(res, 'Password must be at least 8 characters');
  if (!role_id) return err(res, 'Role required');
  if (!db.getRole(role_id)) return err(res, 'Role not found', 404);
  try {
    const user = db.createUser({ username, password, display_name, email, role_id, session_type, session_ttl_h });
    if (Array.isArray(site_ids)) db.setUserSites(user.id, site_ids);
    db.auditLog(req.session.username, req.ip, 'CREATE_USER', username, '', true);
    ok(res, user);
  } catch (e) {
    if (e.message.includes('UNIQUE')) return err(res, 'Username already exists');
    err(res, e.message);
  }
});

router.put('/users/:id', requirePerm('can_manage_users'), (req, res) => {
  const user = db.getUser(req.params.id);
  if (!user) return err(res, 'User not found', 404);
  const { display_name, email, role_id, is_active, session_type, session_ttl_h, password, site_ids } = req.body;
  if (role_id && !db.getRole(role_id)) return err(res, 'Role not found', 404);
  if (password && password.length < 8) return err(res, 'Password must be at least 8 characters');
  try {
    const updated = db.updateUser(req.params.id, { display_name, email, role_id: role_id||user.role_id, is_active, session_type, session_ttl_h, password });
    if (Array.isArray(site_ids)) db.setUserSites(req.params.id, site_ids);
    if (password) db.deleteUserSessions(user.id, 'local');
    db.auditLog(req.session.username, req.ip, 'UPDATE_USER', user.username, '', true);
    ok(res, updated);
  } catch (e) { err(res, e.message); }
});

router.delete('/users/:id', requirePerm('can_manage_users'), (req, res) => {
  const user = db.getUser(req.params.id);
  if (!user) return err(res, 'User not found', 404);
  if (user.id === req.session.user_id && req.session.user_type === 'local') {
    return err(res, 'Cannot delete your own account');
  }
  db.deleteUser(req.params.id);
  db.deleteUserSessions(req.params.id, 'local');
  db.auditLog(req.session.username, req.ip, 'DELETE_USER', user.username, '', true);
  ok(res, null);
});

router.get('/ldap/config', requirePerm('can_manage_users'), (req, res) => {
  const cfg = db.getLdapConfig();
  ok(res, { ...cfg, bind_password: cfg.bind_password ? '********' : '' });
});

router.post('/ldap/config', requirePerm('can_manage_users'), (req, res) => {
  try {
    const saved = db.saveLdapConfig(req.body);
    db.auditLog(req.session.username, req.ip, 'UPDATE_LDAP_CONFIG', 'ldap', '', true);
    ok(res, { ...saved, bind_password: saved.bind_password ? '********' : '' });
  } catch (e) { err(res, e.message); }
});

router.post('/ldap/test', requirePerm('can_manage_users'), async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return err(res, 'Test username and password required');
  const result = await authenticateLdap(username, password);
  if (result.success) {
    ok(res, {
      success:      true,
      username:     result.username,
      display_name: result.display_name,
      email:        result.email,
      role_id:      result.role_id,
      role_name:    result.role?.name,
      groups:       result.memberOf?.slice(0, 20),
    });
  } else {
    ok(res, { success: false, error: result.error });
  }
});

router.get('/ldap/groups', requirePerm('can_manage_users'), (req, res) => ok(res, db.getLdapGroupMaps()));

router.post('/ldap/groups', requirePerm('can_manage_users'), (req, res) => {
  const { group_dn, role_id, label } = req.body;
  if (!group_dn?.trim()) return err(res, 'Group DN required');
  if (!role_id) return err(res, 'Role required');
  try {
    ok(res, db.addLdapGroupMap(group_dn.trim(), role_id, label));
  } catch (e) {
    if (e.message.includes('UNIQUE')) return err(res, 'This group DN is already mapped');
    err(res, e.message);
  }
});

router.put('/ldap/groups/:id', requirePerm('can_manage_users'), (req, res) => {
  const { group_dn, role_id, label } = req.body;
  if (!group_dn?.trim()) return err(res, 'Group DN required');
  if (!role_id) return err(res, 'Role required');
  try { ok(res, db.updateLdapGroupMap(req.params.id, group_dn.trim(), role_id, label)); }
  catch (e) { err(res, e.message); }
});

router.delete('/ldap/groups/:id', requirePerm('can_manage_users'), (req, res) => {
  db.deleteLdapGroupMap(req.params.id);
  ok(res, null);
});

router.get('/sessions', requirePerm('can_manage_users'), (req, res) => ok(res, db.getActiveSessions()));

router.delete('/sessions/:token', requirePerm('can_manage_users'), (req, res) => {
  db.deleteSession(req.params.token);
  ok(res, null);
});

router.get('/audit', requirePerm('can_manage_users'), (req, res) => {
  const limit = Math.min(parseInt(req.query.limit)||200, 1000);
  ok(res, db.getAuditLog(limit));
});

module.exports = router;
