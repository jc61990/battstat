'use strict';

const ldap = require('ldapjs');
const db   = require('../db');

function escLdap(str) {
  return String(str)
    .replace(/\\/g, '\\5c')
    .replace(/\*/g,  '\\2a')
    .replace(/\(/g,  '\\28')
    .replace(/\)/g,  '\\29')
    .replace(/\0/g,  '\\00');
}

function createClient(cfg) {
  return ldap.createClient({
    url:              cfg.url,
    timeout:          cfg.connect_timeout_ms || 5000,
    connectTimeout:   cfg.connect_timeout_ms || 5000,
    tlsOptions:       cfg.tls_verify ? {} : { rejectUnauthorized: false },
    reconnect:        false,
  });
}

function bindClient(client, dn, password) {
  return new Promise((resolve, reject) => {
    client.bind(dn, password, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function searchUser(client, base, filter) {
  return new Promise((resolve, reject) => {
    const results = [];
    client.search(base, {
      scope:      'sub',
      filter,
      attributes: ['dn', 'sAMAccountName', 'userPrincipalName', 'displayName',
                   'mail', 'memberOf', 'cn'],
      sizeLimit:  5,
      timeLimit:  10,
    }, (err, res) => {
      if (err) { reject(err); return; }
      res.on('searchEntry', (entry) => results.push(entry));
      res.on('error',  reject);
      res.on('end',    () => resolve(results));
    });
  });
}

function unbindClient(client) {
  return new Promise((resolve) => {
    try { client.unbind(() => resolve()); }
    catch (_) { resolve(); }
  });
}

function resolveRoleFromGroups(memberOf, groupMaps, defaultRoleId) {
  if (!memberOf || !memberOf.length) return defaultRoleId || null;
  const groups = Array.isArray(memberOf) ? memberOf : [memberOf];
  const groupsUpper = groups.map(g => g.toUpperCase());

  for (const mapping of groupMaps) {
    if (groupsUpper.includes(mapping.group_dn.toUpperCase())) {
      return mapping.role_id;
    }
  }
  return defaultRoleId || null;
}

async function authenticateLdap(username, password) {
  const cfg = db.getLdapConfig();
  if (!cfg || !cfg.enabled || !cfg.url) {
    return { success: false, error: 'LDAP not configured' };
  }
  if (!username || !password) {
    return { success: false, error: 'Username and password required' };
  }

  const safeUsername = escLdap(username.trim());
  const filter = (cfg.search_filter || '(sAMAccountName={{username}})').replace('{{username}}', safeUsername);

  let serviceClient;
  try {
    serviceClient = createClient(cfg);
    await bindClient(serviceClient, cfg.bind_dn, cfg.bind_password);
  } catch (err) {
    try { await unbindClient(serviceClient); } catch (_) {}
    return { success: false, error: 'LDAP service bind failed: ' + err.message };
  }

  let entries;
  try {
    entries = await searchUser(serviceClient, cfg.search_base, filter);
  } catch (err) {
    await unbindClient(serviceClient);
    return { success: false, error: 'LDAP search failed: ' + err.message };
  }
  await unbindClient(serviceClient);

  if (!entries.length) {
    return { success: false, error: 'User not found in directory' };
  }
  if (entries.length > 1) {
    return { success: false, error: 'Ambiguous user -- multiple directory entries matched' };
  }

  const entry = entries[0];
  const userDn = entry.objectName || entry.dn?.toString();

  if (!userDn) {
    return { success: false, error: 'Could not resolve user DN' };
  }

  let userClient;
  try {
    userClient = createClient(cfg);
    await bindClient(userClient, userDn, password);
    await unbindClient(userClient);
  } catch (err) {
    try { await unbindClient(userClient); } catch (_) {}
    const msg = err.message || '';
    if (msg.includes('AcceptSecurityContext') || msg.includes('Invalid credentials') || msg.includes('invalidCredentials')) {
      return { success: false, error: 'Invalid credentials' };
    }
    if (msg.includes('Account locked') || msg.includes('775')) {
      return { success: false, error: 'Account is locked in Active Directory' };
    }
    if (msg.includes('password expired') || msg.includes('532')) {
      return { success: false, error: 'Password has expired -- change it in Active Directory' };
    }
    return { success: false, error: 'Authentication failed: ' + msg };
  }

  const attrs    = entry.attributes || [];
  const getAttr  = (name) => {
    const a = attrs.find(x => x.type?.toLowerCase() === name.toLowerCase());
    if (!a) return null;
    const v = a.values || a._vals;
    if (!v) return null;
    return Array.isArray(v) ? v.map(x => Buffer.isBuffer(x) ? x.toString('utf8') : x) : [v];
  };
  const getFirst = (name) => { const v = getAttr(name); return v && v.length ? v[0] : null; };

  const memberOf   = getAttr('memberOf') || [];
  const groupMaps  = db.getLdapGroupMaps();
  const roleId     = resolveRoleFromGroups(memberOf, groupMaps, cfg.default_role_id);

  if (!roleId) {
    return {
      success: false,
      error:   'No role assigned -- your AD groups are not mapped to any role. Contact your administrator.',
    };
  }

  const role = db.getRole(roleId);
  if (!role) {
    return { success: false, error: 'Mapped role no longer exists -- contact administrator' };
  }

  return {
    success:      true,
    user_id:      userDn,
    user_type:    'ldap',
    username:     getFirst('sAMAccountName') || username,
    display_name: getFirst('displayName') || getFirst('cn') || username,
    email:        getFirst('mail') || '',
    role_id:      roleId,
    role,
    memberOf,
  };
}

module.exports = { authenticateLdap };
