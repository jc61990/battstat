'use strict';
const db      = require('./db');
const { sendAlert } = require('./mailer');

const STATUS_LABEL = {
  red:         'Critical',
  yellow:      'Warning',
  unreachable: 'Offline',
  green:       'Healthy',
};

const STATUS_COLOR = {
  red:         '#e24b4a',
  yellow:      '#ef9f27',
  unreachable: '#888',
  green:       '#639922',
};

function battStatusFromPoll(poll, device) {
  if (!poll || !poll.reachable) return 'unreachable';
  const cap  = poll.batt_capacity;
  const temp = poll.batt_temperature;
  const rt   = poll.batt_run_time;
  const st   = poll.batt_status;

  if (st === 'batteryLow' || st === 'batteryInFaultCondition' || st === 'batteryDepleted') return 'red';
  if (cap !== null && cap < 20)  return 'red';
  if (temp !== null && temp >= 45) return 'red';
  if (rt !== null && rt < 10)    return 'red';

  // Replace date checks
  const replaceDate = poll.batt_replace_date;
  if (replaceDate) {
    const d = new Date(replaceDate);
    if (!isNaN(d) && d < new Date()) return 'red';
    const daysLeft = (d - new Date()) / 86400000;
    if (daysLeft < 90) return 'yellow';
  }

  if (cap !== null && cap < 40)  return 'yellow';
  if (temp !== null && temp >= 40) return 'yellow';
  if (rt !== null && rt < 20)    return 'yellow';

  return 'green';
}

function shouldAlert(cfg, status) {
  if (status === 'red')         return !!cfg.alert_critical;
  if (status === 'yellow')      return !!cfg.alert_warning;
  if (status === 'unreachable') return !!cfg.alert_offline;
  return false;
}

function buildEmailHtml(device, site, poll, status, isReminder) {
  const label = STATUS_LABEL[status] || status;
  const color = STATUS_COLOR[status] || '#888';
  const reasons = [];

  if (status === 'unreachable') {
    reasons.push('Device is not responding to SNMP polls');
  } else if (poll) {
    if (poll.batt_capacity !== null && poll.batt_capacity < 40)
      reasons.push(`Battery charge: ${poll.batt_capacity}%`);
    if (poll.batt_temperature !== null && poll.batt_temperature >= 40)
      reasons.push(`Temperature: ${poll.batt_temperature}°C`);
    if (poll.batt_run_time !== null && poll.batt_run_time < 20)
      reasons.push(`Runtime: ${poll.batt_run_time} min`);
    if (poll.batt_replace_date) {
      const d = new Date(poll.batt_replace_date);
      if (!isNaN(d)) {
        const days = Math.round((d - new Date()) / 86400000);
        if (days < 90) reasons.push(`Battery replace date: ${poll.batt_replace_date}${days < 0 ? ' (overdue)' : ` (${days} days)`}`);
      }
    }
    if (['batteryLow','batteryInFaultCondition','batteryDepleted'].includes(poll.batt_status))
      reasons.push(`UPS status: ${poll.batt_status}`);
  }

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f4f4f4;padding:20px;margin:0">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;border:1px solid #e0e0e0">
    <div style="background:${color};padding:16px 20px">
      <h2 style="margin:0;color:#fff;font-size:18px">${isReminder ? '⏰ Reminder: ' : '🔋 '}BattStat Alert — ${label}</h2>
    </div>
    <div style="padding:20px">
      <table style="width:100%;border-collapse:collapse;margin-bottom:16px">
        <tr><td style="padding:5px 0;color:#666;width:130px">Device</td><td style="padding:5px 0;font-weight:500">${device.name}</td></tr>
        <tr><td style="padding:5px 0;color:#666">Site</td><td style="padding:5px 0">${site?.name || '—'}</td></tr>
        <tr><td style="padding:5px 0;color:#666">IP Address</td><td style="padding:5px 0;font-family:monospace">${device.ip}</td></tr>
        ${device.floor ? `<tr><td style="padding:5px 0;color:#666">Floor</td><td style="padding:5px 0">${device.floor}</td></tr>` : ''}
        ${poll?.model_snmp || device.model ? `<tr><td style="padding:5px 0;color:#666">Model</td><td style="padding:5px 0">${poll?.model_snmp || device.model}</td></tr>` : ''}
        ${device.part_number ? `<tr><td style="padding:5px 0;color:#666">Replacement part</td><td style="padding:5px 0;font-family:monospace">${device.part_number}</td></tr>` : ''}
      </table>
      ${reasons.length ? `
        <div style="background:#fafafa;border-left:3px solid ${color};padding:10px 14px;border-radius:0 4px 4px 0;margin-bottom:16px">
          <div style="font-weight:500;margin-bottom:6px;color:#333">Alert reason${reasons.length > 1 ? 's' : ''}</div>
          ${reasons.map(r => `<div style="color:#555;font-size:14px;margin:3px 0">• ${r}</div>`).join('')}
        </div>
      ` : ''}
      <p style="color:#888;font-size:12px;margin:0">
        Sent by BattStat · ${new Date().toLocaleString()}
        ${isReminder ? '<br>This is a reminder — the alert condition has not been resolved.' : ''}
      </p>
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
    const status = battStatusFromPoll(poll, device);

    // Update last known status
    db.upsertAlertState(device.id, status);
    const state = db.getAlertState(device.id);

    const needsAlert = shouldAlert(cfg, status);
    if (!needsAlert) {
      // Status is good -- clear any active alert state
      if (state?.alerted_status) db.clearAlertState(device.id);
      continue;
    }

    const alreadyAlerted = state?.alerted_status === status;
    const reminderDue    = alreadyAlerted &&
      state.last_alerted_at &&
      (now - state.last_alerted_at) >= (cfg.reminder_hours * 3600);

    const isNewAlert   = !alreadyAlerted;
    const isReminder   = alreadyAlerted && reminderDue;

    if (!isNewAlert && !isReminder) continue;

    const label   = STATUS_LABEL[status] || status;
    const subject = `${isReminder ? '[Reminder] ' : ''}BattStat ${label}: ${device.name} (${site?.name || device.ip})`;
    const html    = buildEmailHtml(device, site, poll, status, isReminder);

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
