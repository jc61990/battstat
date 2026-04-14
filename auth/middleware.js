'use strict';

const db = require('../db');

function getTokenFromRequest(req) {
  const cookie = req.headers.cookie || '';
  const match  = cookie.match(/battstat_session=([a-f0-9]{64})/);
  return match ? match[1] : null;
}

function requireAuth(req, res, next) {
  const token = getTokenFromRequest(req);
  if (!token) return res.status(401).json({ ok: false, error: 'Not authenticated', code: 'UNAUTHENTICATED' });

  const session = db.getSession(token);
  if (!session) return res.status(401).json({ ok: false, error: 'Session expired or invalid', code: 'SESSION_EXPIRED' });

  req.session = session;
  next();
}

function requirePerm(perm) {
  return [requireAuth, (req, res, next) => {
    if (!req.session[perm]) {
      db.auditLog(req.session.username, req.ip, 'PERMISSION_DENIED', req.path, perm, false);
      return res.status(403).json({ ok: false, error: `Permission denied -- requires ${perm}` });
    }
    next();
  }];
}

function optionalAuth(req, res, next) {
  const token = getTokenFromRequest(req);
  if (token) {
    const session = db.getSession(token);
    req.session   = session || null;
  } else {
    req.session = null;
  }
  next();
}

module.exports = { requireAuth, requirePerm, optionalAuth, getTokenFromRequest };
