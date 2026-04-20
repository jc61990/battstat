'use strict';

const API = '/api';
let state = {
  sites: [],
  devices: [],
  polls: {},
  currentPage: 'overview',
  deviceFilter: 'all',
  deviceSort: { col: 'status', dir: 1 },
  editDeviceId: null,
  editSiteId: null,
  ws: null,
  wsOk: false,
  allowedSiteIds: null,  // null = unrestricted, array = limited to these site IDs
};

async function apiFetch(path, opts = {}) {
  const res = await fetch(API + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || 'Request failed');
  return json.data;
}

function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

function nav(page, filter) {
  state.currentPage = page;
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-' + page).classList.add('active');
  document.querySelectorAll('.nav-item').forEach(n => {
    n.classList.toggle('active', n.dataset.page === page);
  });
  if (page === 'devices' && filter) {
    state.deviceFilter = filter;
    document.querySelectorAll('.filter-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.f === filter);
    });
  }
  if (page === 'devices') renderDeviceTable();
  if (page === 'sites') renderSitesTable();
  if (page === 'settings') loadSnmpConfig();
  if (page === 'users') { if(typeof loadAdminData==='function'){loadAdminData();loadLdapConfig();} }
  if (page === 'audit') { if(typeof loadAuditLog==='function') loadAuditLog(); }
}

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d)) return null;
  return Math.round((d - Date.now()) / 86400000);
}

function fmtDate(str) {
  if (!str) return '—';
  const d = new Date(str);
  if (isNaN(d)) return str;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtTs(unix) {
  if (!unix) return '—';
  const d = new Date(unix * 1000);
  const now = Date.now();
  const diff = Math.round((now - d) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return d.toLocaleDateString();
}

function battStatus(poll, device) {
  if (!poll || !poll.reachable) return 'unreachable';
  const alerts = getAlerts(poll, device);
  const crit = alerts.filter(a => a.level === 'red');
  if (crit.length) return 'red';
  const warn = alerts.filter(a => a.level === 'yellow');
  if (warn.length) return 'yellow';
  return 'green';
}

function getAlerts(poll, device) {
  const alerts = [];
  if (!poll || !poll.reachable) {
    alerts.push({ level: 'red', msg: 'Device unreachable' });
    return alerts;
  }
  if (poll.batt_capacity !== null && poll.batt_capacity <= 20)
    alerts.push({ level: 'red', msg: `Battery critical — ${poll.batt_capacity}% charge` });
  else if (poll.batt_capacity !== null && poll.batt_capacity <= 40)
    alerts.push({ level: 'yellow', msg: `Battery low — ${poll.batt_capacity}% charge` });

  if (poll.batt_status && poll.batt_status.toLowerCase().includes('low'))
    alerts.push({ level: 'red', msg: `UPS reports battery low` });
  if (poll.batt_status && poll.batt_status.toLowerCase().includes('fault'))
    alerts.push({ level: 'red', msg: `Battery fault condition` });
  if (poll.batt_status && poll.batt_status.toLowerCase().includes('deplet'))
    alerts.push({ level: 'red', msg: `Battery depleted` });

  if (poll.batt_temperature !== null) {
    if (poll.batt_temperature >= 45)
      alerts.push({ level: 'red', msg: `Critical temperature — ${poll.batt_temperature}°C` });
    else if (poll.batt_temperature >= 40)
      alerts.push({ level: 'yellow', msg: `High temperature — ${poll.batt_temperature}°C` });
  }

  if (poll.batt_run_time !== null && poll.batt_run_time <= 10)
    alerts.push({ level: 'red', msg: `Runtime critical — ${poll.batt_run_time} min` });
  else if (poll.batt_run_time !== null && poll.batt_run_time <= 20)
    alerts.push({ level: 'yellow', msg: `Runtime low — ${poll.batt_run_time} min` });

  const days = daysUntil(device.battery_installed
    ? new Date(new Date(device.battery_installed).setFullYear(new Date(device.battery_installed).getFullYear() + 4)).toISOString().slice(0, 10)
    : null);
  if (days !== null && days < 0)
    alerts.push({ level: 'red', msg: `Battery replacement overdue (${Math.abs(days)}d)` });
  else if (days !== null && days < 180)
    alerts.push({ level: 'yellow', msg: `Battery replacement due in ${days}d` });

  if (poll.batt_replace_date) {
    const rd = daysUntil(poll.batt_replace_date);
    if (rd !== null && rd < 0)
      alerts.push({ level: 'red', msg: `UPS reports battery past replace date` });
    else if (rd !== null && rd < 90)
      alerts.push({ level: 'yellow', msg: `UPS recommends battery replacement in ${rd}d` });
  }

  return alerts;
}

function battLifePercent(device) {
  if (!device.battery_installed) return null;
  const installed = new Date(device.battery_installed);
  const lifeMs = 4 * 365 * 86400000;
  const elapsed = Date.now() - installed.getTime();
  const pct = Math.max(0, Math.min(100, 100 - (elapsed / lifeMs) * 100));
  return Math.round(pct);
}

function battLifeBarHtml(device, poll) {
  const pct = battLifePercent(device);
  if (pct === null) return '<span class="mono">—</span>';

  let color, level;
  if (pct > 50) { color = '#639922'; level = 'green'; }
  else if (pct > 20) { color = '#ef9f27'; level = 'yellow'; }
  else { color = '#e24b4a'; level = 'red'; }

  const segs = 5;
  const filled = Math.round((pct / 100) * segs);
  let segHtml = '';
  for (let i = 0; i < segs; i++) {
    const active = i < filled;
    const c = active ? color : 'var(--bg3)';
    segHtml += `<div class="batt-life-seg" style="flex:1;background:${c}"></div>`;
    if (i < segs - 1) segHtml += `<div class="batt-notch"></div>`;
  }
  return `
    <div style="display:flex;flex-direction:column;gap:2px;min-width:90px">
      <div class="batt-life-bar">${segHtml}</div>
      <div style="font-size:10px;color:var(--text3);text-align:center">${pct}% life remaining</div>
    </div>`;
}

function chargeBarHtml(pct) {
  if (pct === null || pct === undefined) return '<span class="mono">—</span>';
  let color;
  if (pct > 50) color = '#639922';
  else if (pct > 25) color = '#ef9f27';
  else color = '#e24b4a';
  return `<div class="batt-bar-wrap">
    <div class="batt-bar-outer">
      <div class="batt-bar-inner" style="width:${pct}%;background:${color}"></div>
    </div>
    <span class="batt-pct" style="color:${color}">${pct}%</span>
  </div>`;
}

function pillHtml(cls, text) {
  return `<span class="pill pill-${cls}">${text}</span>`;
}

function statusPill(status) {
  const map = { green: ['green', 'Good'], yellow: ['yellow', 'Warn'], red: ['red', 'Crit'], unreachable: ['gray', 'Offline'] };
  const [cls, lbl] = map[status] || ['gray', status];
  return pillHtml(cls, lbl);
}

function tempPill(t) {
  if (t === null || t === undefined) return '<span class="mono">—</span>';
  const cls = t >= 45 ? 'red' : t >= 40 ? 'yellow' : 'green';
  return pillHtml(cls, `${t}°C`);
}

function replacePill(device) {
  const installed = device.battery_installed;
  if (!installed) return '<span class="mono">—</span>';
  const replaceDate = new Date(new Date(installed).setFullYear(new Date(installed).getFullYear() + 4));
  const days = daysUntil(replaceDate.toISOString().slice(0, 10));
  if (days === null) return '<span class="mono">—</span>';
  const cls = days < 0 ? 'red' : days < 180 ? 'yellow' : 'green';
  const lbl = days < 0 ? `Overdue ${Math.abs(days)}d` : days < 365 ? `${days}d` : fmtDate(replaceDate);
  return pillHtml(cls, lbl);
}

async function loadAll() {
  try {
    const [sites, devices, polls, me] = await Promise.all([
      apiFetch('/sites'),
      apiFetch('/devices'),
      apiFetch('/poll/latest'),
      apiFetch('/auth/me'),
    ]);
    state.sites   = sites;
    state.devices = devices;
    state.polls   = {};
    for (const p of polls) state.polls[p.device_id] = p;
    state.allowedSiteIds = me.allowed_site_ids || null;
    renderAll();
  } catch (e) {
    toast('Failed to load data: ' + e.message, 'error');
  }
}

function renderAll() {
  renderOverview();
  if (state.currentPage === 'devices') renderDeviceTable();
  if (state.currentPage === 'sites') renderSitesTable();
  updateNavBadges();
}

function updateNavBadges() {
  let red = 0, yellow = 0;
  for (const d of state.devices) {
    const p = state.polls[d.id];
    const s = battStatus(p, d);
    if (s === 'red') red++;
    else if (s === 'yellow') yellow++;
  }
  const rb = document.getElementById('nav-red');
  const yb = document.getElementById('nav-yellow');
  rb.style.display = red ? '' : 'none';
  rb.textContent = red;
  yb.style.display = yellow ? '' : 'none';
  yb.textContent = yellow;
}

function renderOverview() {
  // Show restricted access banner if user is limited to specific sites
  const banner = document.getElementById('site-restriction-banner');
  if (banner) {
    if (state.allowedSiteIds) {
      const names = state.sites.map(s => s.name).join(', ');
      banner.style.display = '';
      banner.textContent = `Restricted view: you have access to ${state.sites.length} site${state.sites.length !== 1 ? 's' : ''} (${names})`;
    } else {
      banner.style.display = 'none';
    }
  }

  let green = 0, yellow = 0, red = 0;
  const attention = [];
  for (const d of state.devices) {
    const p = state.polls[d.id];
    const s = battStatus(p, d);
    if (s === 'green') green++;
    else if (s === 'yellow') yellow++;
    else if (s === 'red') red++;
    if (s === 'red' || s === 'yellow' || s === 'unreachable') attention.push({ d, p, s });
  }
  attention.sort((a, b) => {
    const order = { red: 0, unreachable: 1, yellow: 2 };
    return (order[a.s] ?? 3) - (order[b.s] ?? 3);
  });

  document.getElementById('cnt-green').textContent = green;
  document.getElementById('cnt-yellow').textContent = yellow;
  document.getElementById('cnt-red').textContent = red;
  document.getElementById('overview-sub').textContent =
    `${state.devices.length} devices across ${state.sites.length} sites`;

  const attnEl = document.getElementById('alert-list');
  document.getElementById('attn-count').textContent = attention.length ? `(${attention.length})` : '';
  if (!attention.length) {
    attnEl.innerHTML = `<div style="padding:16px;color:var(--text3);font-size:13px;text-align:center;background:var(--bg2);border-radius:var(--radius);border:0.5px solid var(--border)">All devices healthy</div>`;
  } else {
    attnEl.innerHTML = attention.map(({ d, p, s }) => {
      const alerts = getAlerts(p, d);
      const msgs = alerts.map(a => a.msg).join(' · ');
      const site = state.sites.find(si => si.id === d.site_id);
      return `<div class="alert-row ${s}" onclick="openDrawer(${d.id})">
        <div class="alert-dot"></div>
        <div class="alert-body">
          <div class="alert-name">${esc(d.name)} — ${esc(d.model || p?.model_snmp || '')}</div>
          <div class="alert-msg">${esc(msgs)}</div>
        </div>
        <span class="alert-site-tag">${esc(site?.name || '')}</span>
        <div class="alert-meta">${esc(d.floor)}<br><span class="mono">${esc(d.ip)}</span></div>
      </div>`;
    }).join('');
  }

  const sgEl = document.getElementById('sites-grid');
  sgEl.innerHTML = state.sites.map(site => {
    const devs = state.devices.filter(d => d.site_id === site.id);
    let sg = 0, sy = 0, sr = 0;
    for (const d of devs) {
      const s = battStatus(state.polls[d.id], d);
      if (s === 'green') sg++;
      else if (s === 'yellow') sy++;
      else sr++;
    }
    const total = devs.length || 1;
    const gw = Math.round((sg / total) * 100);
    const yw = Math.round((sy / total) * 100);
    const rw = 100 - gw - yw;
    return `<div class="site-card" onclick="nav('devices');document.getElementById('site-filter').value='${site.id}';renderDeviceTable()">
      <div class="site-card-name">${esc(site.name)}</div>
      <div class="site-card-loc">${esc(site.location)}</div>
      <div class="site-bar-row">
        <div class="site-bar" style="flex:${gw||0.5};background:#639922"></div>
        <div class="site-bar" style="flex:${yw||0.5};background:#ef9f27"></div>
        <div class="site-bar" style="flex:${rw||0.5};background:#e24b4a"></div>
      </div>
      <div class="site-counts">
        <span class="site-count" style="color:#3b6d11"><span class="dot-xs" style="background:#639922"></span>${sg}</span>
        <span class="site-count" style="color:#854f0b"><span class="dot-xs" style="background:#ef9f27"></span>${sy}</span>
        <span class="site-count" style="color:#a32d2d"><span class="dot-xs" style="background:#e24b4a"></span>${sr}</span>
        <span class="site-count" style="color:var(--text3)">${devs.length} units</span>
      </div>
    </div>`;
  }).join('');
}

let _sortCol = 'status', _sortDir = 1;
function sortBy(col) {
  if (_sortCol === col) _sortDir *= -1;
  else { _sortCol = col; _sortDir = 1; }
  document.querySelectorAll('th span[id^="sort-"]').forEach(s => s.textContent = '');
  const el = document.getElementById('sort-' + col);
  if (el) el.textContent = _sortDir > 0 ? ' ↓' : ' ↑';
  renderDeviceTable();
}

function setFilter(f, el) {
  state.deviceFilter = f;
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.toggle('active', b.dataset.f === f));
  renderDeviceTable();
}

function renderDeviceTable() {
  const search = (document.getElementById('dev-search')?.value || '').toLowerCase();
  const siteF = document.getElementById('site-filter')?.value || '';

  let devs = state.devices.filter(d => {
    const p = state.polls[d.id];
    const s = battStatus(p, d);
    if (state.deviceFilter !== 'all' && s !== state.deviceFilter) return false;
    if (siteF && String(d.site_id) !== String(siteF)) return false;
    if (search) {
      const hay = [d.name, d.ip, d.serial, d.model, d.floor,
        p?.model_snmp, p?.serial_snmp, d.part_number].join(' ').toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });

  const statusOrder = { red: 0, unreachable: 1, yellow: 2, green: 3 };
  devs.sort((a, b) => {
    const pa = state.polls[a.id], pb = state.polls[b.id];
    let av, bv;
    switch (_sortCol) {
      case 'status': av = statusOrder[battStatus(pa, a)] ?? 9; bv = statusOrder[battStatus(pb, b)] ?? 9; break;
      case 'name': av = a.name.toLowerCase(); bv = b.name.toLowerCase(); break;
      case 'site': av = (state.sites.find(s => s.id === a.site_id)?.name || '').toLowerCase(); bv = (state.sites.find(s => s.id === b.site_id)?.name || '').toLowerCase(); break;
      case 'floor': av = a.floor.toLowerCase(); bv = b.floor.toLowerCase(); break;
      case 'batt': av = pa?.batt_capacity ?? -1; bv = pb?.batt_capacity ?? -1; break;
      case 'temp': av = pa?.batt_temperature ?? -1; bv = pb?.batt_temperature ?? -1; break;
      case 'replace': av = a.battery_installed || 'z'; bv = b.battery_installed || 'z'; break;
      case 'model': av = (pa?.model_snmp || a.model || '').toLowerCase(); bv = (pb?.model_snmp || b.model || '').toLowerCase(); break;
      default: return 0;
    }
    if (av < bv) return -_sortDir;
    if (av > bv) return _sortDir;
    return 0;
  });

  document.getElementById('devices-sub').textContent = `${devs.length} device${devs.length !== 1 ? 's' : ''}`;

  const sel = document.getElementById('site-filter');
  if (sel) {
    const cur = sel.value;
    sel.innerHTML = '<option value="">All sites</option>' +
      state.sites.map(s => `<option value="${s.id}" ${String(s.id) === cur ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
  }

  const tbody = document.getElementById('device-tbody');
  if (!devs.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="15">No devices match current filters</td></tr>`;
    return;
  }

  tbody.innerHTML = devs.map(d => {
    const p = state.polls[d.id];
    const s = battStatus(p, d);
    const site = state.sites.find(si => si.id === d.site_id);
    const runtime = p?.batt_run_time !== null && p?.batt_run_time !== undefined ? `${p.batt_run_time}m` : '—';
    const load = p?.output_load !== null && p?.output_load !== undefined ? `${p.output_load}%` : '—';
    return `<tr class="clickable" onclick="openDrawer(${d.id})">
      <td>${statusPill(s)}</td>
      <td style="font-weight:500;max-width:120px">${esc(d.name)}</td>
      <td style="max-width:110px">${esc(site?.name || '')}</td>
      <td>${esc(d.floor)}</td>
      <td class="mono">${esc(d.ip)}</td>
      <td class="batt-bar-cell">${battLifeBarHtml(d, p)}</td>
      <td style="min-width:110px">${chargeBarHtml(p?.batt_capacity)}</td>
      <td>${tempPill(p?.batt_temperature)}</td>
      <td>${runtime}</td>
      <td>${load}</td>
      <td>${replacePill(d)}</td>
      <td style="max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(p?.model_snmp || d.model || '')}">${esc(p?.model_snmp || d.model || '—')}</td>
      <td class="mono" style="font-size:11px">${esc(d.part_number || '—')}</td>
      <td class="last-seen">${fmtTs(p?.polled_at)}</td>
      <td onclick="event.stopPropagation()">
        <div style="display:flex;gap:4px">
          ${currentUser?.permissions?.can_edit_devices ? `<button class="sm" onclick="openEditDevice(${d.id})">Edit</button>` : ''}
          ${currentUser?.permissions?.can_poll ? `<button class="sm" title="Poll now" onclick="pollNow(${d.id},this)">↻</button>` : ''}
        </div>
      </td>
    </tr>`;
  }).join('');
}

function renderSitesTable() {
  const tbody = document.getElementById('sites-tbody');
  if (!state.sites.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="5">No sites yet. Add your first site to get started.</td></tr>`;
    return;
  }
  const canManage = currentUser?.permissions?.can_manage_sites;
  tbody.innerHTML = state.sites.map(site => {
    const devs = state.devices.filter(d => d.site_id === site.id);
    let g = 0, y = 0, r = 0;
    for (const d of devs) {
      const s = battStatus(state.polls[d.id], d);
      if (s === 'green') g++;
      else if (s === 'yellow') y++;
      else r++;
    }
    const statusHtml = r ? pillHtml('red', `${r} critical`) : y ? pillHtml('yellow', `${y} warning`) : pillHtml('green', 'All healthy');
    return `<tr>
      <td style="font-weight:500">${esc(site.name)}</td>
      <td>${esc(site.location)}</td>
      <td>${devs.length}</td>
      <td>${statusHtml}</td>
      <td onclick="event.stopPropagation()">
        ${canManage ? `<div style="display:flex;gap:4px">
          <button class="sm" onclick="openEditSite(${site.id})">Edit</button>
          <button class="sm danger" onclick="deleteSite(${site.id})">Delete</button>
        </div>` : ''}
      </td>
    </tr>`;
  }).join('');
}

function openDrawer(deviceId) {
  const d = state.devices.find(x => x.id === deviceId);
  if (!d) return;
  const p = state.polls[d.id];
  const s = battStatus(p, d);
  const site = state.sites.find(si => si.id === d.site_id);
  const alerts = getAlerts(p, d);
  const lifePct = battLifePercent(d);
  const installed4yr = d.battery_installed
    ? new Date(new Date(d.battery_installed).setFullYear(new Date(d.battery_installed).getFullYear() + 4))
    : null;

  document.getElementById('dr-title').textContent = d.name;
  document.getElementById('dr-sub').textContent = (p?.model_snmp || d.model || 'Unknown model') + ' · ' + (site?.name || '');

  const progColor = lifePct !== null ? (lifePct > 50 ? '#639922' : lifePct > 20 ? '#ef9f27' : '#e24b4a') : '#888';
  const chargeColor = p?.batt_capacity > 50 ? '#639922' : p?.batt_capacity > 25 ? '#ef9f27' : '#e24b4a';

  document.getElementById('dr-body').innerHTML = `
    <div class="dp-sec">
      <div class="dp-sec-title">Active alerts</div>
      <div class="alert-chips">
        ${alerts.length
          ? alerts.map(a => `<div class="alert-chip ${a.level}">${esc(a.msg)}</div>`).join('')
          : '<div class="alert-chip green">No active alerts — operating normally</div>'}
      </div>
    </div>

    <div class="dp-sec">
      <div class="dp-sec-title">Battery life (time since install)</div>
      ${lifePct !== null ? `
        <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px">
          <span style="color:var(--text2)">Installed ${fmtDate(d.battery_installed)}</span>
          <span style="font-weight:500">${lifePct}% remaining</span>
        </div>
        <div class="batt-life-bar" style="height:20px;border-radius:6px;border:0.5px solid var(--border)">
          ${[...Array(5)].map((_, i) => {
            const thresh = (i + 1) * 20;
            const active = lifePct >= thresh - 10;
            const c = lifePct > 50 ? '#639922' : lifePct > 20 ? '#ef9f27' : '#e24b4a';
            return `<div class="batt-life-seg" style="flex:1;background:${active ? c : 'var(--bg3)'}"></div>${i < 4 ? '<div class="batt-notch"></div>' : ''}`;
          }).join('')}
        </div>
        ${installed4yr ? `<div style="font-size:11px;color:var(--text3);margin-top:4px">Expected replacement ${fmtDate(installed4yr)}</div>` : ''}
      ` : '<div style="font-size:12px;color:var(--text3)">Set battery installed date to track life</div>'}
    </div>

    ${p?.batt_capacity !== null && p?.batt_capacity !== undefined ? `
    <div class="dp-sec">
      <div class="dp-sec-title">Charge level &amp; runtime</div>
      <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:5px">
        <span style="color:var(--text2)">Current charge</span>
        <span style="font-weight:500;color:${chargeColor}">${p.batt_capacity}%</span>
      </div>
      <div class="prog-outer"><div class="prog-inner" style="width:${p.batt_capacity}%;background:${chargeColor}"></div></div>
      ${p.batt_run_time !== null ? `<div style="font-size:11px;color:var(--text3);margin-top:4px">Estimated runtime: ${p.batt_run_time} minutes</div>` : ''}
    </div>` : ''}

    <div class="dp-sec">
      <div class="dp-sec-title">Device identity</div>
      <div class="dp-row"><span class="dp-key">Name</span><span class="dp-val">${esc(d.name)}</span></div>
      <div class="dp-row"><span class="dp-key">Model</span><span class="dp-val">${esc(p?.model_snmp || d.model || '—')}</span></div>
      <div class="dp-row"><span class="dp-key">Serial (manual)</span><span class="dp-val mono">${esc(d.serial || '—')}</span></div>
      <div class="dp-row"><span class="dp-key">Serial (SNMP)</span><span class="dp-val mono">${esc(p?.serial_snmp || '—')}</span></div>
      <div class="dp-row"><span class="dp-key">Firmware</span><span class="dp-val mono">${esc(p?.firmware || '—')}</span></div>
      <div class="dp-row"><span class="dp-key">Replacement part #</span><span class="dp-val mono">${esc(d.part_number || '—')}</span></div>
    </div>

    <div class="dp-sec">
      <div class="dp-sec-title">Network &amp; location</div>
      <div class="dp-row"><span class="dp-key">IP address</span><span class="dp-val mono">${esc(d.ip)}</span></div>
      <div class="dp-row"><span class="dp-key">Site</span><span class="dp-val">${esc(site?.name || '—')}</span></div>
      <div class="dp-row"><span class="dp-key">Location</span><span class="dp-val">${esc(site?.location || '—')}</span></div>
      <div class="dp-row"><span class="dp-key">Floor</span><span class="dp-val">${esc(d.floor || '—')}</span></div>
    </div>

    <div class="dp-sec">
      <div class="dp-sec-title">Power readings</div>
      <div class="dp-row"><span class="dp-key">Input voltage</span><span class="dp-val">${p?.input_voltage != null ? p.input_voltage + ' V' : '—'}</span></div>
      <div class="dp-row"><span class="dp-key">Input frequency</span><span class="dp-val">${p?.input_frequency != null ? p.input_frequency + ' Hz' : '—'}</span></div>
      <div class="dp-row"><span class="dp-key">Output voltage</span><span class="dp-val">${p?.output_voltage != null ? p.output_voltage + ' V' : '—'}</span></div>
      <div class="dp-row"><span class="dp-key">Output load</span><span class="dp-val">${p?.output_load != null ? p.output_load + '%' : '—'}</span></div>
      <div class="dp-row"><span class="dp-key">Output current</span><span class="dp-val">${p?.output_current != null ? p.output_current + ' A' : '—'}</span></div>
      <div class="dp-row"><span class="dp-key">Temperature</span><span class="dp-val">${p?.batt_temperature != null ? p.batt_temperature + '°C' : '—'}</span></div>
    </div>

    <div class="dp-sec">
      <div class="dp-sec-title">Diagnostics</div>
      <div class="dp-row"><span class="dp-key">Last self test</span><span class="dp-val">${esc(p?.self_test_result || '—')}</span></div>
      <div class="dp-row"><span class="dp-key">Self test date</span><span class="dp-val">${fmtDate(p?.self_test_date) || '—'}</span></div>
      <div class="dp-row"><span class="dp-key">Last transfer reason</span><span class="dp-val">${esc(p?.last_xfer_reason || '—')}</span></div>
      <div class="dp-row"><span class="dp-key">Transfer count</span><span class="dp-val">${p?.transfer_count != null ? p.transfer_count : '—'}</span></div>
    </div>

    <div class="dp-sec">
      <div class="dp-sec-title">Lifecycle</div>
      <div class="dp-row"><span class="dp-key">Battery installed</span><span class="dp-val">${fmtDate(d.battery_installed)}</span></div>
      <div class="dp-row"><span class="dp-key">Expected replace</span><span class="dp-val">${fmtDate(installed4yr)}</span></div>
      <div class="dp-row"><span class="dp-key">UPS replace date</span><span class="dp-val">${fmtDate(p?.batt_replace_date)}</span></div>
      <div class="dp-row"><span class="dp-key">Last polled</span><span class="dp-val">${fmtTs(p?.polled_at)}</span></div>
    </div>

    ${d.notes ? `<div class="dp-sec"><div class="dp-sec-title">Notes</div><div style="font-size:12px;color:var(--text2)">${esc(d.notes)}</div></div>` : ''}

    <div style="display:flex;gap:8px;margin-top:4px">
      ${currentUser?.permissions?.can_edit_devices ? `<button onclick="openEditDevice(${d.id});closeDrawer()">Edit device</button>` : ''}
      ${currentUser?.permissions?.can_poll ? `<button onclick="pollNow(${d.id},this)">↻ Poll now</button>` : ''}
      ${currentUser?.permissions?.can_edit_devices ? `<button class="danger sm" onclick="deleteDevice(${d.id})">Delete</button>` : ''}
    </div>
  `;

  document.getElementById('drawer').classList.add('open');
  document.getElementById('drawer-bd').classList.add('open');
}

function closeDrawer() {
  document.getElementById('drawer').classList.remove('open');
  document.getElementById('drawer-bd').classList.remove('open');
}

function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

function openAddDevice() {
  state.editDeviceId = null;
  document.getElementById('modal-device-title').textContent = 'Add Device';
  document.getElementById('md-save-btn').textContent = 'Add Device';
  ['md-name','md-ip','md-floor','md-serial','md-model','md-part','md-batt-date','md-notes'].forEach(id => {
    document.getElementById(id).value = '';
  });
  document.getElementById('md-snmp-version').value = 'auto';
  const sel = document.getElementById('md-site');
  sel.innerHTML = state.sites.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  openModal('modal-device');
}

function openEditDevice(id) {
  const d = state.devices.find(x => x.id === id);
  if (!d) return;
  state.editDeviceId = id;
  document.getElementById('modal-device-title').textContent = 'Edit Device';
  document.getElementById('md-save-btn').textContent = 'Save Changes';
  const sel = document.getElementById('md-site');
  sel.innerHTML = state.sites.map(s => `<option value="${s.id}" ${s.id === d.site_id ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
  document.getElementById('md-name').value = d.name;
  document.getElementById('md-ip').value = d.ip;
  document.getElementById('md-floor').value = d.floor;
  document.getElementById('md-serial').value = d.serial;
  document.getElementById('md-model').value = d.model;
  document.getElementById('md-part').value = d.part_number;
  document.getElementById('md-batt-date').value = d.battery_installed || '';
  document.getElementById('md-notes').value = d.notes;
  document.getElementById('md-snmp-version').value = d.snmp_version || 'auto';
  openModal('modal-device');
}

async function saveDevice() {
  const body = {
    site_id: parseInt(document.getElementById('md-site').value),
    name: document.getElementById('md-name').value.trim(),
    ip: document.getElementById('md-ip').value.trim(),
    floor: document.getElementById('md-floor').value.trim(),
    serial: document.getElementById('md-serial').value.trim(),
    model: document.getElementById('md-model').value.trim(),
    part_number: document.getElementById('md-part').value.trim(),
    battery_installed: document.getElementById('md-batt-date').value,
    notes: document.getElementById('md-notes').value.trim(),
    snmp_version: document.getElementById('md-snmp-version').value || 'auto',
  };
  if (!body.name || !body.ip || !body.site_id) { toast('Name, IP, and site are required', 'error'); return; }
  try {
    if (state.editDeviceId) {
      await apiFetch(`/devices/${state.editDeviceId}`, { method: 'PUT', body });
      toast('Device updated', 'success');
    } else {
      await apiFetch('/devices', { method: 'POST', body });
      toast('Device added — polling will start shortly', 'success');
    }
    closeModal('modal-device');
    await loadAll();
  } catch (e) { toast(e.message, 'error'); }
}

async function deleteDevice(id) {
  if (!confirm('Delete this device and all its poll history?')) return;
  try {
    await apiFetch(`/devices/${id}`, { method: 'DELETE' });
    closeDrawer();
    toast('Device deleted', 'success');
    await loadAll();
  } catch (e) { toast(e.message, 'error'); }
}

function openAddSite() {
  state.editSiteId = null;
  document.getElementById('modal-site-title').textContent = 'Add Site';
  document.getElementById('ms-save-btn').textContent = 'Add Site';
  document.getElementById('ms-name').value = '';
  document.getElementById('ms-location').value = '';
  openModal('modal-site');
}

function openEditSite(id) {
  const s = state.sites.find(x => x.id === id);
  if (!s) return;
  state.editSiteId = id;
  document.getElementById('modal-site-title').textContent = 'Edit Site';
  document.getElementById('ms-save-btn').textContent = 'Save Changes';
  document.getElementById('ms-name').value = s.name;
  document.getElementById('ms-location').value = s.location;
  openModal('modal-site');
}

async function saveSite() {
  const name = document.getElementById('ms-name').value.trim();
  const location = document.getElementById('ms-location').value.trim();
  if (!name) { toast('Site name is required', 'error'); return; }
  try {
    if (state.editSiteId) {
      await apiFetch(`/sites/${state.editSiteId}`, { method: 'PUT', body: { name, location } });
      toast('Site updated', 'success');
    } else {
      await apiFetch('/sites', { method: 'POST', body: { name, location } });
      toast('Site added', 'success');
    }
    closeModal('modal-site');
    await loadAll();
  } catch (e) { toast(e.message, 'error'); }
}

async function deleteSite(id) {
  const s = state.sites.find(x => x.id === id);
  const devCount = state.devices.filter(d => d.site_id === id).length;
  const msg = devCount
    ? `Delete "${s?.name}"? This will also delete ${devCount} device(s) and all their history.`
    : `Delete site "${s?.name}"?`;
  if (!confirm(msg)) return;
  try {
    await apiFetch(`/sites/${id}`, { method: 'DELETE' });
    toast('Site deleted', 'success');
    await loadAll();
  } catch (e) { toast(e.message, 'error'); }
}

async function pollNow(id, btn) {
  if (btn) { btn.textContent = '↻'; btn.disabled = true; btn.style.opacity = '.5'; }
  try {
    const data = await apiFetch(`/poll/device/${id}`, { method: 'POST' });
    state.polls[id] = { ...data, device_id: id, polled_at: Math.floor(Date.now() / 1000) };
    renderAll();
    toast('Poll complete', 'success');
  } catch (e) { toast('Poll failed: ' + e.message, 'error'); }
  finally { if (btn) { btn.textContent = '↻'; btn.disabled = false; btn.style.opacity = ''; } }
}

async function refreshAll() {
  try { await loadAll(); toast('Refreshed', 'info'); }
  catch (e) { toast('Refresh failed', 'error'); }
}

async function loadSnmpConfig() {
  try {
    const cfg = await apiFetch('/snmp/config');
    document.getElementById('cfg-user').value = cfg.security_name || '';
    document.getElementById('cfg-level').value = cfg.security_level || 'authPriv';
    document.getElementById('cfg-auth-proto').value = cfg.auth_protocol || 'SHA';
    document.getElementById('cfg-auth-key').value = '';
    document.getElementById('cfg-priv-proto').value = cfg.priv_protocol || 'AES';
    document.getElementById('cfg-priv-key').value = '';
    document.getElementById('cfg-port').value = cfg.port || 161;
    document.getElementById('cfg-timeout').value = cfg.timeout_ms || 5000;
    document.getElementById('cfg-retries').value = cfg.retries ?? 1;
    document.getElementById('cfg-interval').value = cfg.poll_interval_s || 60;
    document.getElementById('cfg-community').value = cfg.community || 'public';
  } catch (e) { toast('Failed to load config', 'error'); }
}

async function bulkSetSnmpVersion() {
  const version = document.getElementById('bulk-snmp-version').value;
  const labels = { auto: 'Auto-detect', v3: 'SNMPv3 only', v2c: 'SNMPv2c only', v1: 'SNMPv1 only' };
  if (!confirm(`Set all devices to "${labels[version]}"? This will override individual device settings.`)) return;
  try {
    const result = await apiFetch('/snmp/bulk-version', { method: 'POST', body: { version } });
    toast(`Updated ${result.count} device${result.count !== 1 ? 's' : ''} to ${labels[version]}`, 'success');
    await loadAll();
  } catch (e) { toast(e.message, 'error'); }
}

async function saveSnmpConfig() {
  const body = {
    security_name: document.getElementById('cfg-user').value.trim(),
    security_level: document.getElementById('cfg-level').value,
    auth_protocol: document.getElementById('cfg-auth-proto').value,
    auth_key: document.getElementById('cfg-auth-key').value,
    priv_protocol: document.getElementById('cfg-priv-proto').value,
    priv_key: document.getElementById('cfg-priv-key').value,
    port: parseInt(document.getElementById('cfg-port').value) || 161,
    timeout_ms: parseInt(document.getElementById('cfg-timeout').value) || 5000,
    retries: parseInt(document.getElementById('cfg-retries').value) ?? 1,
    poll_interval_s: parseInt(document.getElementById('cfg-interval').value) || 60,
    community: document.getElementById('cfg-community').value.trim() || 'public',
  };
  if (!body.security_name) { toast('Security name is required', 'error'); return; }
  try {
    await apiFetch('/snmp/config', { method: 'POST', body });
    toast('SNMP config saved — poller restarted', 'success');
    document.getElementById('cfg-auth-key').value = '';
    document.getElementById('cfg-priv-key').value = '';
  } catch (e) { toast(e.message, 'error'); }
}

function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws`);
  state.ws = ws;

  ws.onopen = () => {
    state.wsOk = true;
    document.getElementById('ws-dot').className = 'ws-dot connected';
    document.getElementById('ws-status').textContent = 'Live';
  };

  ws.onclose = () => {
    state.wsOk = false;
    document.getElementById('ws-dot').className = 'ws-dot disconnected';
    document.getElementById('ws-status').textContent = 'Reconnecting…';
    setTimeout(connectWs, 3000);
  };

  ws.onerror = () => ws.close();

  ws.onmessage = (e) => {
    try {
      const { event, data } = JSON.parse(e.data);
      if (event === 'poll_complete') {
        for (const item of data) {
          state.polls[item.device_id] = {
            ...item,
            polled_at: Math.floor(Date.now() / 1000),
          };
        }
        renderAll();
      }
    } catch (_) {}
  };
}

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });


// ─── AUTH / SESSION ──────────────────────────────────────────────────────────

let currentUser = null;

async function loadCurrentUser() {
  try {
    const data = await apiFetch('/auth/me');
    currentUser = data;
    // Store allowed site IDs for client-side filtering (null = unrestricted)
    state.allowedSiteIds = data.allowed_site_ids || null;
    renderUserBadge();
    applyPermissions();
  } catch (_) {
    window.location.href = '/login';
  }
}

function renderUserBadge() {
  const el = document.getElementById('user-badge');
  if (!el || !currentUser) return;
  el.innerHTML = `
    <span style="font-size:12px;color:var(--text2)">${esc(currentUser.display_name || currentUser.username)}</span>
    <span style="font-size:11px;padding:2px 6px;border-radius:10px;background:var(--blue-bg);color:var(--blue-text)">${esc(currentUser.role_name)}</span>
    <button class="sm" onclick="doLogout()" style="margin-left:4px">Sign out</button>
  `;
}

function applyPermissions() {
  if (!currentUser) return;
  const p = currentUser.permissions;
  document.querySelectorAll('[data-perm]').forEach(el => {
    const perm = el.dataset.perm;
    el.style.display = p[perm] ? '' : 'none';
  });
}

async function doLogout() {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/login';
}

// ─── USERS ADMIN ─────────────────────────────────────────────────────────────

let adminState = { roles: [], users: [], ldapCfg: null, groupMaps: [], auditLog: [], sessions: [], editUserId: null, editRoleId: null, editGroupId: null };

async function loadAdminData() {
  const [roles, users, groupMaps, sessions] = await Promise.all([
    apiFetch('/auth/roles'),
    apiFetch('/auth/users').catch(() => []),
    apiFetch('/auth/ldap/groups').catch(() => []),
    apiFetch('/auth/sessions').catch(() => []),
  ]);
  adminState.roles     = roles;
  adminState.users     = users;
  adminState.groupMaps = groupMaps;
  adminState.sessions  = sessions;
  // Load site assignments for all non-system roles
  adminState.roleSites = {};
  await Promise.all(roles.map(async r => {
    try {
      adminState.roleSites[r.id] = await apiFetch(`/auth/roles/${r.id}/sites`);
    } catch (_) { adminState.roleSites[r.id] = []; }
  }));
  renderAdminPage();
}

function renderAdminPage() {
  renderUsersTable();
  renderRolesTable();
  renderGroupMapsTable();
  renderSessionsTable();
  populateRoleSelects();
}

function renderUsersTable() {
  const tbody = document.getElementById('users-tbody');
  if (!tbody) return;
  if (!adminState.users.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="7">No local users yet</td></tr>';
    return;
  }
  tbody.innerHTML = adminState.users.map(u => `
    <tr>
      <td style="font-weight:500">${esc(u.username)}</td>
      <td>${esc(u.display_name)}</td>
      <td>${esc(u.email||'—')}</td>
      <td>${pillHtml('blue', esc(u.role_name))}</td>
      <td>${u.is_active ? pillHtml('green','Active') : pillHtml('gray','Disabled')}</td>
      <td style="font-size:11px;color:var(--text3)">${u.last_login ? fmtTs(u.last_login) : 'Never'}</td>
      <td>
        <div style="display:flex;gap:4px">
          <button class="sm" onclick="openEditUser(${u.id})">Edit</button>
          <button class="sm danger" onclick="deleteUser(${u.id})">Delete</button>
        </div>
      </td>
    </tr>`).join('');
}

function renderRolesTable() {
  const tbody = document.getElementById('roles-tbody');
  if (!tbody) return;
  const permIcons = (r) => {
    const perms = ['can_view','can_edit_devices','can_manage_sites','can_manage_users','can_manage_snmp','can_poll'];
    const labels = ['View','Devices','Sites','Users','SNMP','Poll'];
    return perms.map((p,i) => r[p] ? `<span class="pill pill-green" style="font-size:10px;padding:1px 5px">${labels[i]}</span>` : '').join(' ');
  };
  tbody.innerHTML = adminState.roles.map(r => {
    const siteIds = adminState.roleSites?.[r.id] || [];
    let siteCell;
    if (r.can_manage_sites) {
      siteCell = '<span style="font-size:11px;color:var(--text3)">All sites</span>';
    } else if (!siteIds.length) {
      siteCell = '<span style="font-size:11px;color:var(--text3)">All sites</span>';
    } else {
      const names = siteIds.map(id => state.sites.find(s => s.id === id)?.name || id).join(', ');
      siteCell = `<span style="font-size:11px;color:var(--blue-text)" title="${esc(names)}">${siteIds.length} site${siteIds.length !== 1 ? 's' : ''}</span>`;
    }
    return `
    <tr>
      <td style="font-weight:500">${esc(r.name)} ${r.is_system ? '<span class="pill pill-gray" style="font-size:10px">system</span>' : ''}</td>
      <td style="font-size:12px;color:var(--text2)">${esc(r.description)}</td>
      <td>${permIcons(r)}</td>
      <td>${siteCell}</td>
      <td>
        ${!r.is_system ? `<div style="display:flex;gap:4px">
          <button class="sm" onclick="openEditRole(${r.id})">Edit</button>
          <button class="sm danger" onclick="deleteRole(${r.id})">Delete</button>
        </div>` : '<span style="font-size:11px;color:var(--text3)">Protected</span>'}
      </td>
    </tr>`;
  }).join('');
}

function renderGroupMapsTable() {
  const tbody = document.getElementById('groupmaps-tbody');
  if (!tbody) return;
  if (!adminState.groupMaps.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="4">No group mappings yet</td></tr>';
    return;
  }
  tbody.innerHTML = adminState.groupMaps.map(m => `
    <tr>
      <td style="font-size:12px;color:var(--text2)">${esc(m.label||m.group_dn)}</td>
      <td class="mono" style="font-size:11px;max-width:300px;overflow:hidden;text-overflow:ellipsis">${esc(m.group_dn)}</td>
      <td>${pillHtml('blue',esc(m.role_name))}</td>
      <td>
        <div style="display:flex;gap:4px">
          <button class="sm" onclick="openEditGroupMap(${m.id})">Edit</button>
          <button class="sm danger" onclick="deleteGroupMap(${m.id})">Delete</button>
        </div>
      </td>
    </tr>`).join('');
}

function renderSessionsTable() {
  const tbody = document.getElementById('sessions-tbody');
  if (!tbody) return;
  if (!adminState.sessions.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="6">No active sessions</td></tr>';
    return;
  }
  tbody.innerHTML = adminState.sessions.map(s => `
    <tr>
      <td style="font-weight:500">${esc(s.username)}</td>
      <td>${pillHtml(s.user_type==='ldap'?'blue':'gray',s.user_type.toUpperCase())}</td>
      <td>${esc(s.role_name)}</td>
      <td class="mono" style="font-size:11px">${esc(s.ip_address||'—')}</td>
      <td class="last-seen">${fmtTs(s.last_seen)}</td>
      <td><button class="sm danger" onclick="revokeSession('${esc(s.token)}')">Revoke</button></td>
    </tr>`).join('');
}

function populateRoleSelects() {
  ['mu-role','role-select-group'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    const cur = el.value;
    el.innerHTML = adminState.roles.map(r => `<option value="${r.id}" ${String(r.id)===String(cur)?'selected':''}>${esc(r.name)}</option>`).join('');
  });
}

function openAddUser() {
  adminState.editUserId = null;
  document.getElementById('modal-user-title').textContent = 'Add Local User';
  document.getElementById('mu-save-btn').textContent = 'Add User';
  ['mu-username','mu-display','mu-email','mu-password'].forEach(id => { const el=document.getElementById(id); if(el) el.value=''; });
  document.getElementById('mu-active').checked = true;
  document.getElementById('mu-sess-type').value = 'session';
  document.getElementById('mu-sess-ttl').value  = '8';
  document.getElementById('mu-password-row').style.display = '';
  populateRoleSelects();
  openModal('modal-user');
}

function openEditUser(id) {
  const u = adminState.users.find(x => x.id === id);
  if (!u) return;
  adminState.editUserId = id;
  document.getElementById('modal-user-title').textContent = 'Edit User';
  document.getElementById('mu-save-btn').textContent = 'Save Changes';
  document.getElementById('mu-username').value   = u.username;
  document.getElementById('mu-display').value    = u.display_name;
  document.getElementById('mu-email').value      = u.email||'';
  document.getElementById('mu-password').value   = '';
  document.getElementById('mu-active').checked   = !!u.is_active;
  document.getElementById('mu-sess-type').value  = u.session_type||'session';
  document.getElementById('mu-sess-ttl').value   = u.session_ttl_h||8;
  document.getElementById('mu-password-row').style.display = '';
  populateRoleSelects();
  document.getElementById('mu-role').value = u.role_id;
  openModal('modal-user');
}

async function saveUser() {
  const body = {
    username:      document.getElementById('mu-username').value.trim(),
    display_name:  document.getElementById('mu-display').value.trim(),
    email:         document.getElementById('mu-email').value.trim(),
    password:      document.getElementById('mu-password').value,
    role_id:       parseInt(document.getElementById('mu-role').value),
    is_active:     document.getElementById('mu-active').checked,
    session_type:  document.getElementById('mu-sess-type').value,
    session_ttl_h: parseInt(document.getElementById('mu-sess-ttl').value)||8,
  };
  if (!body.username && !adminState.editUserId) { toast('Username is required','error'); return; }
  if (!body.password && !adminState.editUserId) { toast('Password is required for new users','error'); return; }
  try {
    if (adminState.editUserId) {
      if (!body.password) delete body.password;
      await apiFetch(`/auth/users/${adminState.editUserId}`, { method: 'PUT', body });
      toast('User updated','success');
    } else {
      await apiFetch('/auth/users', { method: 'POST', body });
      toast('User created','success');
    }
    closeModal('modal-user');
    await loadAdminData();
  } catch (e) { toast(e.message,'error'); }
}

async function deleteUser(id) {
  const u = adminState.users.find(x=>x.id===id);
  if (!confirm(`Delete user "${u?.username}"?`)) return;
  try { await apiFetch(`/auth/users/${id}`,{method:'DELETE'}); toast('User deleted','success'); await loadAdminData(); }
  catch (e) { toast(e.message,'error'); }
}

function openAddRole() {
  adminState.editRoleId = null;
  document.getElementById('modal-role-title').textContent = 'Add Role';
  document.getElementById('mr-save-btn').textContent = 'Add Role';
  ['mr-name','mr-desc'].forEach(id=>document.getElementById(id).value='');
  ['mr-view','mr-edit-dev','mr-manage-sites','mr-manage-users','mr-manage-snmp','mr-poll'].forEach(id=>{ document.getElementById(id).checked=false; });
  document.getElementById('mr-view').checked = true;
  renderRoleSiteCheckboxes([]);
  openModal('modal-role');
}

function openEditRole(id) {
  const r = adminState.roles.find(x=>x.id===id);
  if (!r || r.is_system) return;
  adminState.editRoleId = id;
  document.getElementById('modal-role-title').textContent = 'Edit Role';
  document.getElementById('mr-save-btn').textContent = 'Save Changes';
  document.getElementById('mr-name').value = r.name;
  document.getElementById('mr-desc').value = r.description||'';
  document.getElementById('mr-view').checked          = !!r.can_view;
  document.getElementById('mr-edit-dev').checked      = !!r.can_edit_devices;
  document.getElementById('mr-manage-sites').checked  = !!r.can_manage_sites;
  document.getElementById('mr-manage-users').checked  = !!r.can_manage_users;
  document.getElementById('mr-manage-snmp').checked   = !!r.can_manage_snmp;
  document.getElementById('mr-poll').checked          = !!r.can_poll;
  const siteIds = adminState.roleSites?.[id] || [];
  renderRoleSiteCheckboxes(siteIds);
  openModal('modal-role');
}

function renderRoleSiteCheckboxes(checkedIds) {
  const container = document.getElementById('mr-site-checkboxes');
  const section   = document.getElementById('mr-site-access-section');
  const hint      = document.getElementById('mr-site-access-hint');
  if (!container || !section) return;
  // If can_manage_sites is checked, show note that they see everything
  const isAdmin = document.getElementById('mr-manage-sites')?.checked;
  section.style.display = '';
  if (isAdmin) {
    container.innerHTML = '<span style="font-size:12px;color:var(--text3)">Roles with site management permission always see all sites.</span>';
    if (hint) hint.textContent = '';
    return;
  }
  if (!state.sites.length) {
    container.innerHTML = '<span style="font-size:12px;color:var(--text3)">No sites configured yet</span>';
    return;
  }
  container.innerHTML = state.sites.map(s => `
    <label style="display:flex;align-items:center;gap:7px;font-size:13px;font-weight:400;cursor:pointer;padding:4px 0">
      <input type="checkbox" value="${s.id}" ${checkedIds.includes(s.id) ? 'checked' : ''}
        style="width:auto;cursor:pointer">
      <span>${esc(s.name)}</span>${s.location ? `<span style="font-size:11px;color:var(--text3);margin-left:4px">${esc(s.location)}</span>` : ''}
    </label>`).join('');
  if (hint) hint.textContent = 'Restrict this role to specific sites. Leave all unchecked to grant access to all sites.';
}

function getRoleSiteIds() {
  const container = document.getElementById('mr-site-checkboxes');
  if (!container) return [];
  return Array.from(container.querySelectorAll('input[type=checkbox]:checked'))
    .map(cb => parseInt(cb.value)).filter(Boolean);
}

async function saveRole() {
  const body = {
    name:             document.getElementById('mr-name').value.trim(),
    description:      document.getElementById('mr-desc').value.trim(),
    can_view:         document.getElementById('mr-view').checked,
    can_edit_devices: document.getElementById('mr-edit-dev').checked,
    can_manage_sites: document.getElementById('mr-manage-sites').checked,
    can_manage_users: document.getElementById('mr-manage-users').checked,
    can_manage_snmp:  document.getElementById('mr-manage-snmp').checked,
    can_poll:         document.getElementById('mr-poll').checked,
    site_ids:         getRoleSiteIds(),
  };
  if (!body.name) { toast('Role name required','error'); return; }
  try {
    if (adminState.editRoleId) {
      await apiFetch(`/auth/roles/${adminState.editRoleId}`,{method:'PUT',body});
      toast('Role updated','success');
    } else {
      await apiFetch('/auth/roles',{method:'POST',body});
      toast('Role created','success');
    }
    closeModal('modal-role');
    await loadAdminData();
  } catch (e) { toast(e.message,'error'); }
}

async function deleteRole(id) {
  const r = adminState.roles.find(x=>x.id===id);
  if (!confirm(`Delete role "${r?.name}"?`)) return;
  try { await apiFetch(`/auth/roles/${id}`,{method:'DELETE'}); toast('Role deleted','success'); await loadAdminData(); }
  catch (e) { toast(e.message,'error'); }
}

function openAddGroupMap() {
  adminState.editGroupId = null;
  document.getElementById('modal-group-title').textContent = 'Add AD Group Mapping';
  document.getElementById('mg-save-btn').textContent = 'Add Mapping';
  document.getElementById('mg-dn').value    = '';
  document.getElementById('mg-label').value = '';
  populateRoleSelects();
  openModal('modal-group');
}

function openEditGroupMap(id) {
  const m = adminState.groupMaps.find(x=>x.id===id);
  if (!m) return;
  adminState.editGroupId = id;
  document.getElementById('modal-group-title').textContent = 'Edit Group Mapping';
  document.getElementById('mg-save-btn').textContent = 'Save Changes';
  document.getElementById('mg-dn').value    = m.group_dn;
  document.getElementById('mg-label').value = m.label||'';
  populateRoleSelects();
  document.getElementById('role-select-group').value = m.role_id;
  openModal('modal-group');
}

async function saveGroupMap() {
  const body = {
    group_dn: document.getElementById('mg-dn').value.trim(),
    role_id:  parseInt(document.getElementById('role-select-group').value),
    label:    document.getElementById('mg-label').value.trim(),
  };
  if (!body.group_dn) { toast('Group DN required','error'); return; }
  if (!body.role_id)  { toast('Role required','error'); return; }
  try {
    if (adminState.editGroupId) {
      await apiFetch(`/auth/ldap/groups/${adminState.editGroupId}`,{method:'PUT',body});
      toast('Group mapping updated','success');
    } else {
      await apiFetch('/auth/ldap/groups',{method:'POST',body});
      toast('Group mapping added','success');
    }
    closeModal('modal-group');
    await loadAdminData();
  } catch (e) { toast(e.message,'error'); }
}

async function deleteGroupMap(id) {
  if (!confirm('Remove this group mapping?')) return;
  try { await apiFetch(`/auth/ldap/groups/${id}`,{method:'DELETE'}); toast('Removed','success'); await loadAdminData(); }
  catch (e) { toast(e.message,'error'); }
}

async function revokeSession(token) {
  if (!confirm('Revoke this session? That user will be signed out.')) return;
  try { await apiFetch(`/auth/sessions/${token}`,{method:'DELETE'}); toast('Session revoked','success'); await loadAdminData(); }
  catch (e) { toast(e.message,'error'); }
}

async function loadLdapConfig() {
  try {
    const cfg = await apiFetch('/auth/ldap/config');
    adminState.ldapCfg = cfg;
    document.getElementById('ldap-enabled').checked = !!cfg.enabled;
    document.getElementById('ldap-url').value        = cfg.url||'';
    document.getElementById('ldap-bind-dn').value    = cfg.bind_dn||'';
    document.getElementById('ldap-bind-pw').value    = '';
    document.getElementById('ldap-base').value       = cfg.search_base||'';
    document.getElementById('ldap-filter').value     = cfg.search_filter||'(sAMAccountName={{username}})';
    document.getElementById('ldap-tls').checked      = !!cfg.tls_verify;
    document.getElementById('ldap-timeout').value    = cfg.connect_timeout_ms||5000;
  } catch(_) {}
}

async function saveLdapConfig() {
  const body = {
    enabled:           document.getElementById('ldap-enabled').checked,
    url:               document.getElementById('ldap-url').value.trim(),
    bind_dn:           document.getElementById('ldap-bind-dn').value.trim(),
    bind_password:     document.getElementById('ldap-bind-pw').value,
    search_base:       document.getElementById('ldap-base').value.trim(),
    search_filter:     document.getElementById('ldap-filter').value.trim(),
    tls_verify:        document.getElementById('ldap-tls').checked,
    connect_timeout_ms:parseInt(document.getElementById('ldap-timeout').value)||5000,
  };
  try {
    await apiFetch('/auth/ldap/config',{method:'POST',body});
    toast('LDAP config saved','success');
    document.getElementById('ldap-bind-pw').value = '';
  } catch(e) { toast(e.message,'error'); }
}

async function testLdap() {
  const username = document.getElementById('ldap-test-user').value.trim();
  const password = document.getElementById('ldap-test-pw').value;
  const resultEl = document.getElementById('ldap-test-result');
  if (!username || !password) { toast('Enter test credentials','error'); return; }
  resultEl.textContent = 'Testing…';
  resultEl.style.color = 'var(--text2)';
  try {
    const data = await apiFetch('/auth/ldap/test',{method:'POST',body:{username,password}});
    if (data.success) {
      resultEl.innerHTML = `<span style="color:var(--green-text)">✓ Success — ${esc(data.display_name)} (${esc(data.username)}) → role: ${esc(data.role_name||'none')}</span>`;
    } else {
      resultEl.innerHTML = `<span style="color:var(--red-text)">✗ ${esc(data.error)}</span>`;
    }
    document.getElementById('ldap-test-pw').value = '';
  } catch(e) { resultEl.innerHTML = `<span style="color:var(--red-text)">Error: ${esc(e.message)}</span>`; }
}

async function loadAuditLog() {
  try {
    const logs = await apiFetch('/auth/audit?limit=200');
    const tbody = document.getElementById('audit-tbody');
    if (!tbody) return;
    if (!logs.length) { tbody.innerHTML = '<tr class="empty-row"><td colspan="6">No audit events yet</td></tr>'; return; }
    tbody.innerHTML = logs.map(l => `
      <tr>
        <td class="mono" style="font-size:11px;white-space:nowrap">${new Date(l.ts*1000).toLocaleString()}</td>
        <td style="font-weight:500">${esc(l.username||'—')}</td>
        <td class="mono" style="font-size:11px">${esc(l.ip||'—')}</td>
        <td>${esc(l.action)}</td>
        <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px">${esc(l.detail||l.target||'')}</td>
        <td>${l.success ? pillHtml('green','OK') : pillHtml('red','Fail')}</td>
      </tr>`).join('');
  } catch(_) {}
}


function switchTab(page, tabId, btn) {
  const pageEl = document.getElementById('page-' + page);
  if (pageEl) {
    pageEl.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    const target = document.getElementById(tabId);
    if (target) target.classList.add('active');
  }
  const bar = btn ? btn.closest('.tab-bar') : null;
  if (bar) bar.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b === btn));
}


loadCurrentUser().then(() => { loadAll(); connectWs(); });
