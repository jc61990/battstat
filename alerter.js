'use strict';
const db      = require('./db');
const { sendAlert } = require('./mailer');

// Number of consecutive failed polls required before firing an offline alert.
// Prevents false alerts from transient network blips.
const OFFLINE_THRESHOLD = 2;

// Transfer reasons that indicate a real power event (not routine/self-test).
// These trigger an immediate "on battery" alert.
const POWER_EVENT_REASONS = new Set([
  'Brownout',
  'Loss of mains power',
  'Small temporary power drop',
  'Large temporary power drop',
  'Small spike',
  'Large spike',
  'Excessive input voltage fluctuation',
  'High line voltage',
]);

const STATUS_LABEL = {
  red:         'Critical',
  yellow:      'Warning',
  unreachable: 'Offline',
  green:       'Healthy',
};

const STATUS_COLOR = {
  red:         '#e24b4a',
  yellow:      '#ef9f27',
  unreachable: '#6b7280',
  green:       '#639922',
};

function battStatusFromPoll(poll) {
  if (!poll || !poll.reachable) return 'unreachable';

  const cap  = poll.batt_capacity;
  const temp = poll.batt_temperature;
  const rt   = poll.batt_run_time;
  const st   = poll.batt_status;

  if (['batteryLow','batteryInFaultCondition','batteryDepleted'].includes(st)) return 'red';
  if (cap  !== null && cap  < 20)  return 'red';
  if (temp !== null && temp >= 45) return 'red';
  if (rt   !== null && rt   < 10)  return 'red';

  const replaceDate = poll.batt_replace_date;
  if (replaceDate) {
    const d = new Date(replaceDate);
    if (!isNaN(d)) {
      if (d < new Date()) return 'red';
      const daysLeft = (d - new Date()) / 86400000;
      if (daysLeft < 90) return 'yellow';
    }
  }

  if (cap  !== null && cap  < 40)  return 'yellow';
  if (temp !== null && temp >= 40) return 'yellow';
  if (rt   !== null && rt   < 20)  return 'yellow';

  return 'green';
}

function shouldAlert(cfg, status) {
  if (status === 'red')         return !!cfg.alert_critical;
  if (status === 'yellow')      return !!cfg.alert_warning;
  if (status === 'unreachable') return !!cfg.alert_offline;
  return false;
}

function buildEmailHtml(device, site, poll, status, isReminder, extraSection) {
  const configs = {
    red:         { label: 'Critical Alert',      emoji: '🔴', color: '#dc2626', bg: '#fef2f2', border: '#fecaca' },
    yellow:      { label: 'Warning',             emoji: '🟡', color: '#d97706', bg: '#fffbeb', border: '#fde68a' },
    unreachable: { label: 'Device Offline',      emoji: '⚫', color: '#6b7280', bg: '#f9fafb', border: '#e5e7eb' },
  };
  const cfg = configs[status] || configs.red;
  const reasons = [];

  if (status === 'unreachable') {
    reasons.push({ icon: '📡', text: 'Device is not responding to SNMP polls' });
  } else if (poll) {
    if (poll.batt_capacity !== null && poll.batt_capacity < 40)
      reasons.push({ icon: '🔋', text: `Battery charge: ${poll.batt_capacity}%` });
    if (poll.batt_temperature !== null && poll.batt_temperature >= 40)
      reasons.push({ icon: '🌡️', text: `Temperature: ${poll.batt_temperature}°C` });
    if (poll.batt_run_time !== null && poll.batt_run_time < 20)
      reasons.push({ icon: '⏱️', text: `Estimated runtime: ${poll.batt_run_time} minutes` });
    if (poll.batt_replace_date) {
      const d = new Date(poll.batt_replace_date);
      if (!isNaN(d)) {
        const days = Math.round((d - new Date()) / 86400000);
        if (days < 0)  reasons.push({ icon: '📅', text: `Battery replace date overdue by ${Math.abs(days)} days` });
        else if (days < 90) reasons.push({ icon: '📅', text: `Battery replace date approaching: ${poll.batt_replace_date} (${days} days)` });
      }
    }
    if (['batteryLow','batteryInFaultCondition','batteryDepleted'].includes(poll.batt_status))
      reasons.push({ icon: '⚠️', text: `UPS reports: ${poll.batt_status}` });
  }

  const reasonsHtml = reasons.length ? `
    <div style="background:#fff;border:1px solid ${cfg.border};border-radius:6px;padding:14px;margin:16px 0">
      <div style="font-size:12px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:.05em;margin-bottom:10px">Alert Reason${reasons.length > 1 ? 's' : ''}</div>
      ${reasons.map(r => `
        <div style="display:flex;align-items:flex-start;gap:8px;padding:6px 0;border-bottom:1px solid #f3f4f6">
          <span style="font-size:14px;flex-shrink:0">${r.icon}</span>
          <span style="font-size:14px;color:#374151">${r.text}</span>
        </div>`).join('')}
    </div>` : '';

  const partRow = device.part_number ? `
    <tr>
      <td style="padding:6px 0;color:#6b7280;font-size:13px;width:140px">Replacement Part</td>
      <td style="padding:6px 0;font-size:13px;font-family:monospace;background:#f3f4f6;padding:4px 8px;border-radius:4px;display:inline-block">${device.part_number}</td>
    </tr>` : '';

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <div style="max-width:580px;margin:24px auto;background:#fff;border-radius:10px;overflow:hidden;border:1px solid #e5e7eb;box-shadow:0 1px 3px rgba(0,0,0,.08)">

    <!-- Header -->
    <div style="background:${cfg.color};padding:20px 24px">
      <div style="display:flex;align-items:center;gap:10px">
        <span style="font-size:24px">${cfg.emoji}</span>
        <div>
          <div style="color:#fff;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;opacity:.85">BattStat UPS Monitor</div>
          <div style="color:#fff;font-size:18px;font-weight:600;margin-top:2px">${isReminder ? '⏰ Reminder: ' : ''}${cfg.label}</div>
        </div>
      </div>
    </div>

    <!-- Device info -->
    <div style="padding:20px 24px;background:${cfg.bg};border-bottom:1px solid ${cfg.border}">
      <table style="width:100%;border-collapse:collapse">
        <tr>
          <td style="padding:6px 0;color:#6b7280;font-size:13px;width:140px">🏢 Device</td>
          <td style="padding:6px 0;font-size:14px;font-weight:600;color:#111">${device.name}</td>
        </tr>
        <tr>
          <td style="padding:6px 0;color:#6b7280;font-size:13px">📍 Site</td>
          <td style="padding:6px 0;font-size:13px;color:#374151">${site?.name || '—'}${device.floor ? ` · Floor ${device.floor}` : ''}</td>
        </tr>
        <tr>
          <td style="padding:6px 0;color:#6b7280;font-size:13px">🌐 IP Address</td>
          <td style="padding:6px 0;font-size:13px;font-family:monospace;color:#374151">${device.ip}</td>
        </tr>
        ${poll?.model_snmp || device.model ? `<tr>
          <td style="padding:6px 0;color:#6b7280;font-size:13px">🖥️ Model</td>
          <td style="padding:6px 0;font-size:13px;color:#374151">${poll?.model_snmp || device.model}</td>
        </tr>` : ''}
        ${partRow}
      </table>
    </div>

    <!-- Reasons -->
    <div style="padding:20px 24px">
      ${reasonsHtml}
      ${extraSection || ''}
      ${isReminder ? `<div style="background:#fffbeb;border:1px solid #fde68a;border-radius:6px;padding:12px 14px;font-size:13px;color:#92400e;margin-top:12px">⏰ This is a reminder — the alert condition has not been resolved since the first notification.</div>` : ''}
    </div>

    <!-- Footer -->
    <div style="padding:14px 24px;background:#f9fafb;border-top:1px solid #e5e7eb;text-align:center">
      <p style="margin:0;font-size:11px;color:#9ca3af">Sent by BattStat · ${new Date().toLocaleString()} · Log in to the dashboard to acknowledge this alert</p>
    </div>

  </div>
</body>
</html>`;
}

function buildXferEmailHtml(device, site, poll, xferReason) {
  const cap = poll?.batt_capacity;
  const rt  = poll?.batt_run_time;
  const load = poll?.output_load;

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <div style="max-width:580px;margin:24px auto;background:#fff;border-radius:10px;overflow:hidden;border:1px solid #e5e7eb;box-shadow:0 1px 3px rgba(0,0,0,.08)">

    <!-- Header -->
    <div style="background:#dc2626;padding:20px 24px">
      <div style="display:flex;align-items:center;gap:10px">
        <span style="font-size:24px">⚡</span>
        <div>
          <div style="color:#fff;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;opacity:.85">BattStat UPS Monitor</div>
          <div style="color:#fff;font-size:18px;font-weight:600;margin-top:2px">UPS On Battery Power</div>
        </div>
      </div>
    </div>

    <!-- Device info -->
    <div style="padding:20px 24px;background:#fef2f2;border-bottom:1px solid #fecaca">
      <table style="width:100%;border-collapse:collapse">
        <tr>
          <td style="padding:6px 0;color:#6b7280;font-size:13px;width:140px">🏢 Device</td>
          <td style="padding:6px 0;font-size:14px;font-weight:600;color:#111">${device.name}</td>
        </tr>
        <tr>
          <td style="padding:6px 0;color:#6b7280;font-size:13px">📍 Site</td>
          <td style="padding:6px 0;font-size:13px;color:#374151">${site?.name || '—'}${device.floor ? ` · Floor ${device.floor}` : ''}</td>
        </tr>
        <tr>
          <td style="padding:6px 0;color:#6b7280;font-size:13px">🌐 IP Address</td>
          <td style="padding:6px 0;font-size:13px;font-family:monospace;color:#374151">${device.ip}</td>
        </tr>
        ${poll?.model_snmp || device.model ? `<tr>
          <td style="padding:6px 0;color:#6b7280;font-size:13px">🖥️ Model</td>
          <td style="padding:6px 0;font-size:13px;color:#374151">${poll?.model_snmp || device.model}</td>
        </tr>` : ''}
      </table>
    </div>

    <!-- Power event details -->
    <div style="padding:20px 24px">
      <div style="background:#fff;border:1px solid #fecaca;border-radius:6px;padding:14px;margin-bottom:16px">
        <div style="font-size:12px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:.05em;margin-bottom:10px">Power Event Details</div>
        <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid #f3f4f6">
          <span style="font-size:14px">⚡</span>
          <span style="font-size:14px;color:#374151">Transfer reason: <strong>${xferReason}</strong></span>
        </div>
        ${cap !== null && cap !== undefined ? `<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid #f3f4f6">
          <span style="font-size:14px">🔋</span>
          <span style="font-size:14px;color:#374151">Battery charge: <strong>${cap}%</strong></span>
        </div>` : ''}
        ${rt !== null && rt !== undefined ? `<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid #f3f4f6">
          <span style="font-size:14px">⏱️</span>
          <span style="font-size:14px;color:#374151">Estimated runtime: <strong>${rt} minutes</strong></span>
        </div>` : ''}
        ${load !== null && load !== undefined ? `<div style="display:flex;align-items:center;gap:8px;padding:6px 0">
          <span style="font-size:14px">📊</span>
          <span style="font-size:14px;color:#374151">Output load: <strong>${load}%</strong></span>
        </div>` : ''}
      </div>
      <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:6px;padding:12px 14px;font-size:13px;color:#92400e">
        ⚠️ The UPS is running on battery. Check the power source immediately.
      </div>
    </div>

    <!-- Footer -->
    <div style="padding:14px 24px;background:#f9fafb;border-top:1px solid #e5e7eb;text-align:center">
      <p style="margin:0;font-size:11px;color:#9ca3af">Sent by BattStat · ${new Date().toLocaleString()} · Log in to the dashboard to monitor this event</p>
    </div>

  </div>
</body>
</html>`;
}

async function runAlertCheck(pollResults) {
  const cfg = db.getAlertConfig();
  if (!cfg || !cfg.enabled) return;

  const sites   = db.getSites();
  const devices = db.getDevices();
  const now     = Math.floor(Date.now() / 1000);

  for (const result of pollResults) {
    const device = devices.find(d => d.id === result.device_id);
    if (!device) continue;

    const site   = sites.find(s => s.id === device.site_id);
    const poll   = result;
    const reachable = !!poll.reachable;
    const status = battStatusFromPoll(poll);

    // Update state (increments consecutive_failures if unreachable)
    db.upsertAlertState(device.id, status, reachable);
    const state = db.getAlertState(device.id);

    // ── Transfer / on-battery alert ─────────────────────────────────────────
    const xferReason = poll.last_xfer_reason;
    if (reachable && xferReason && POWER_EVENT_REASONS.has(xferReason)) {
      const lastXfer = state?.last_xfer_reason;
      // Only alert if this is a new transfer event (reason changed)
      if (xferReason !== lastXfer) {
        const subject = `⚡ BattStat Power Event: ${device.name} on battery (${site?.name || device.ip})`;
        const html    = buildXferEmailHtml(device, site, poll, xferReason);
        try {
          await sendAlert(cfg, subject, html);
          db.markXferAlerted(device.id, xferReason);
          console.log(`[alerter] Power event alert for ${device.name}: ${xferReason}`);
        } catch (err) {
          console.error(`[alerter] Failed to send power event alert for ${device.name}:`, err.message);
        }
      }
    } else if (reachable && state?.last_xfer_reason) {
      // Device back on line power -- clear transfer alert state
      db.clearXferAlert(device.id);
    }

    // ── Status alert ─────────────────────────────────────────────────────────
    const needsAlert = shouldAlert(cfg, status);

    if (!needsAlert) {
      if (state?.alerted_status) db.clearAlertState(device.id);
      continue;
    }

    // For offline alerts, require OFFLINE_THRESHOLD consecutive failures
    if (status === 'unreachable') {
      const failures = state?.consecutive_failures || 0;
      if (failures < OFFLINE_THRESHOLD) {
        console.log(`[alerter] ${device.name}: offline (${failures}/${OFFLINE_THRESHOLD} failures, waiting for threshold)`);
        continue;
      }
    }

    const alreadyAlerted = state?.alerted_status === status;
    const reminderDue    = alreadyAlerted &&
      state.last_alerted_at &&
      (now - state.last_alerted_at) >= (cfg.reminder_hours * 3600);

    const isNewAlert = !alreadyAlerted;
    const isReminder = alreadyAlerted && reminderDue;

    if (!isNewAlert && !isReminder) continue;

    const label   = STATUS_LABEL[status] || status;
    const subject = `${isReminder ? '[Reminder] ' : ''}BattStat ${label}: ${device.name} (${site?.name || device.ip})`;
    const html    = buildEmailHtml(device, site, poll, status, isReminder, null);

    try {
      await sendAlert(cfg, subject, html);
      db.markAlerted(device.id, status);
      console.log(`[alerter] Sent ${isReminder ? 'reminder' : 'alert'} for ${device.name} (${label})`);
    } catch (err) {
      console.error(`[alerter] Failed to send alert for ${device.name}:`, err.message);
    }
  }
}

module.exports = { runAlertCheck };
