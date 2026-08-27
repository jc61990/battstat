'use strict';
const db = require('./db');
const { sendAlert } = require('./mailer');

const OFFLINE_THRESHOLD = 2;

const POWER_EVENT_REASONS = new Set([
  'Brownout', 'Loss of mains power', 'Small temporary power drop',
  'Large temporary power drop', 'Small spike', 'Large spike',
  'Excessive input voltage fluctuation', 'High line voltage',
]);

const STATUS_LABEL = { red:'Critical', yellow:'Warning', unreachable:'Offline', green:'Healthy' };
const STATUS_COLOR = { red:'#dc2626', yellow:'#d97706', unreachable:'#6b7280', green:'#16a34a' };

function battStatusFromPoll(poll) {
  if (!poll || !poll.reachable) return 'unreachable';
  const { batt_capacity: cap, batt_temperature: temp, batt_run_time: rt, batt_status: st, batt_replace_date: rd } = poll;
  if (['batteryLow','batteryInFaultCondition','batteryDepleted'].includes(st)) return 'red';
  if (cap  !== null && cap  < 20)  return 'red';
  if (temp !== null && temp >= 45) return 'red';
  if (rt   !== null && rt   < 10)  return 'red';
  if (rd) { const d = new Date(rd); if (!isNaN(d) && d < new Date()) return 'red'; }
  if (cap  !== null && cap  < 40)  return 'yellow';
  if (temp !== null && temp >= 40) return 'yellow';
  if (rt   !== null && rt   < 20)  return 'yellow';
  if (rd) { const d = new Date(rd); if (!isNaN(d) && (d - new Date()) / 86400000 < 90) return 'yellow'; }
  return 'green';
}

function header(color, emoji, title, subtitle) {
  return `<div style="background:${color};padding:20px 24px">
    <div style="display:flex;align-items:center;gap:10px">
      <span style="font-size:24px">${emoji}</span>
      <div>
        <div style="color:#fff;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;opacity:.85">BattStat UPS Monitor</div>
        <div style="color:#fff;font-size:18px;font-weight:600;margin-top:2px">${title}</div>
        ${subtitle ? `<div style="color:#fff;font-size:13px;opacity:.85;margin-top:2px">${subtitle}</div>` : ''}
      </div>
    </div>
  </div>`;
}

function deviceTable(device, site, poll, extra) {
  const rows = [
    ['🏢 Device', `<strong>${device.name}</strong>`],
    ['📍 Site', `${site?.name || '—'}${device.floor ? ` · Floor ${device.floor}` : ''}`],
    ['🌐 IP', `<span style="font-family:monospace">${device.ip}</span>`],
    poll?.model_snmp || device.model ? ['🖥️ Model', poll?.model_snmp || device.model] : null,
    device.part_number ? ['🔩 Replacement Part', `<span style="font-family:monospace;background:#f3f4f6;padding:2px 6px;border-radius:3px">${device.part_number}</span>`] : null,
    ...(extra || []),
  ].filter(Boolean);
  return `<div style="padding:16px 24px;background:#f9fafb;border-bottom:1px solid #e5e7eb">
    <table style="width:100%;border-collapse:collapse">
      ${rows.map(([k,v]) => `<tr>
        <td style="padding:5px 0;color:#6b7280;font-size:13px;width:140px;vertical-align:top">${k}</td>
        <td style="padding:5px 0;font-size:13px;color:#111">${v}</td>
      </tr>`).join('')}
    </table>
  </div>`;
}

function reasonBox(color, border, items) {
  return `<div style="background:#fff;border:1px solid ${border};border-radius:6px;padding:14px;margin:16px 24px">
    ${items.map(([icon, text]) => `<div style="display:flex;align-items:flex-start;gap:8px;padding:5px 0;border-bottom:1px solid #f3f4f6">
      <span style="font-size:14px;flex-shrink:0">${icon}</span>
      <span style="font-size:14px;color:#374151">${text}</span>
    </div>`).join('')}
  </div>`;
}

function footer(note) {
  return `<div style="padding:14px 24px;background:#f9fafb;border-top:1px solid #e5e7eb;text-align:center">
    <p style="margin:0;font-size:11px;color:#9ca3af">${note || `Sent by BattStat · ${new Date().toLocaleString()}`}</p>
  </div>`;
}

function wrap(inner) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <div style="max-width:580px;margin:24px auto;background:#fff;border-radius:10px;overflow:hidden;border:1px solid #e5e7eb;box-shadow:0 1px 3px rgba(0,0,0,.08)">
    ${inner}
  </div>
</body></html>`;
}

function buildStatusEmail(device, site, poll, status, isReminder) {
  const color = STATUS_COLOR[status];
  const label = STATUS_LABEL[status];
  const reasons = [];
  if (status === 'unreachable') {
    reasons.push(['📡', 'Device is not responding to SNMP polls']);
  } else if (poll) {
    const { batt_capacity: cap, batt_temperature: temp, batt_run_time: rt, batt_replace_date: rd, batt_status: st } = poll;
    if (cap  !== null && cap  < 40)  reasons.push(['🔋', `Battery charge: ${cap}%`]);
    if (temp !== null && temp >= 40) reasons.push(['🌡️', `Temperature: ${temp}°C`]);
    if (rt   !== null && rt   < 20)  reasons.push(['⏱️', `Estimated runtime: ${rt} minutes`]);
    if (rd) { const d = new Date(rd); if (!isNaN(d)) { const days = Math.round((d-new Date())/86400000); if (days < 90) reasons.push(['📅', days < 0 ? `Battery replace date overdue by ${Math.abs(days)} days` : `Battery replace date in ${days} days (${rd})`]); } }
    if (['batteryLow','batteryInFaultCondition','batteryDepleted'].includes(st)) reasons.push(['⚠️', `UPS reports: ${st}`]);
  }
  const reminderBox = isReminder ? `<div style="margin:0 24px 16px;background:#fffbeb;border:1px solid #fde68a;border-radius:6px;padding:12px 14px;font-size:13px;color:#92400e">⏰ This is a reminder — the alert condition has not been resolved.</div>` : '';
  return wrap(
    header(color, status === 'unreachable' ? '⚫' : status === 'red' ? '🔴' : '🟡', `${isReminder ? 'Reminder: ' : ''}${label} Alert`, device.name) +
    deviceTable(device, site, poll) +
    (reasons.length ? reasonBox('#fff', '#e5e7eb', reasons) : '') +
    reminderBox +
    `<div style="padding:0 24px 16px"></div>` +
    footer(`Sent by BattStat · ${new Date().toLocaleString()} · Log in to acknowledge`)
  );
}

function buildSimpleEmail(device, site, poll, emoji, color, title, items, note) {
  return wrap(
    header(color, emoji, title, device.name) +
    deviceTable(device, site, poll) +
    reasonBox('#fff', '#e5e7eb', items) +
    (note ? `<div style="margin:0 24px 16px;background:#fffbeb;border:1px solid #fde68a;border-radius:6px;padding:12px 14px;font-size:13px;color:#92400e">${note}</div>` : '') +
    `<div style="padding:4px 0"></div>` +
    footer(`Sent by BattStat · ${new Date().toLocaleString()}`)
  );
}

async function fire(cfg, subject, html, label, deviceName) {
  try {
    await sendAlert(cfg, subject, html);
    console.log(`[alerter] ${label}: ${deviceName}`);
  } catch (e) {
    console.error(`[alerter] Failed to send ${label} for ${deviceName}:`, e.message);
  }
}

async function runAlertCheck(pollResults) {
  const cfg = db.getAlertConfig();
  if (!cfg || !cfg.enabled) return;

  const sites   = db.getSites();
  const devices = db.getDevices();
  const now     = Math.floor(Date.now() / 1000);
  const reminderSec = (cfg.reminder_hours || 24) * 3600;

  for (const result of pollResults) {
    const device = devices.find(d => d.id === result.device_id);
    if (!device) continue;
    const site  = sites.find(s => s.id === device.site_id);
    const poll  = result;
    const reachable = !!poll.reachable;
    const status = battStatusFromPoll(poll);

    db.upsertAlertState(device.id, status, reachable);
    let state = db.getAlertState(device.id);

    // ── Transfer / on-battery alert ────────────────────────────────────────
    const xferReason = poll.last_xfer_reason;
    if (reachable && xferReason && POWER_EVENT_REASONS.has(xferReason)) {
      if (xferReason !== state?.last_xfer_reason) {
        const html = buildSimpleEmail(device, site, poll, '⚡', '#dc2626', 'UPS On Battery Power',
          [['⚡', `Transfer reason: <strong>${xferReason}</strong>`],
           ...(poll.batt_capacity !== null ? [['🔋', `Battery charge: ${poll.batt_capacity}%`]] : []),
           ...(poll.batt_run_time  !== null ? [['⏱️', `Estimated runtime: ${poll.batt_run_time} minutes`]] : []),
           ...(poll.output_load    !== null ? [['📊', `Output load: ${poll.output_load}%`]] : [])],
          '⚠️ The UPS is running on battery. Check the power source immediately.');
        await fire(cfg, `⚡ BattStat Power Event: ${device.name} on battery (${site?.name || device.ip})`, html, 'power event', device.name);
        db.markXferAlerted(device.id, xferReason);
        state = db.getAlertState(device.id);
      }
    } else if (reachable && state?.last_xfer_reason) {
      // ── Recovery alert ─────────────────────────────────────────────────
      if (cfg.alert_recovery) {
        const lastRecovery = state.recovery_alerted_at || 0;
        if (!lastRecovery || (now - lastRecovery) > 3600) {
          const html = buildSimpleEmail(device, site, poll, '✅', '#16a34a', 'UPS Returned to Line Power',
            [['🔌', 'UPS has transferred back to utility power'],
             ...(poll.batt_capacity !== null ? [['🔋', `Battery charge: ${poll.batt_capacity}%`]] : []),
             ...(poll.input_voltage  !== null ? [['⚡', `Input voltage: ${poll.input_voltage}V`]] : [])],
            null);
          await fire(cfg, `✅ BattStat Recovery: ${device.name} back on line power (${site?.name || device.ip})`, html, 'recovery', device.name);
          db.prepare('UPDATE alert_state SET recovery_alerted_at=?, last_xfer_reason=NULL WHERE device_id=?').run(now, device.id);
          state = db.getAlertState(device.id);
        }
      } else {
        db.clearXferAlert(device.id);
      }
    }

    if (!reachable) {
      const failures = state?.consecutive_failures || 0;
      if (failures < OFFLINE_THRESHOLD) continue;
    }

    // ── Self-test failure ──────────────────────────────────────────────────
    if (reachable && cfg.alert_self_test_fail && poll.self_test_result === 'Fail') {
      const lastSelfTest = state?.last_self_test;
      if (lastSelfTest !== 'Fail') {
        const html = buildSimpleEmail(device, site, poll, '🧪', '#dc2626', 'Self-Test Failed',
          [['🧪', 'UPS self-test returned a failure result'],
           poll.self_test_date ? ['📅', `Test date: ${poll.self_test_date}`] : null,
           poll.batt_capacity !== null ? ['🔋', `Battery charge: ${poll.batt_capacity}%`] : null].filter(Boolean),
          '⚠️ A failed self-test may indicate the battery needs replacement. Schedule a manual test and inspection.');
        await fire(cfg, `🧪 BattStat Self-Test Failed: ${device.name} (${site?.name || device.ip})`, html, 'self-test fail', device.name);
      }
      db.prepare('UPDATE alert_state SET last_self_test=? WHERE device_id=?').run('Fail', device.id);
    } else if (reachable && poll.self_test_result && poll.self_test_result !== 'Fail') {
      db.prepare('UPDATE alert_state SET last_self_test=? WHERE device_id=?').run(poll.self_test_result, device.id);
    }

    // ── Not charging (capacity declining) ──────────────────────────────────
    if (reachable && cfg.alert_not_charging && poll.batt_capacity !== null) {
      const lastCap = state?.last_capacity;
      const notChargingAt = state?.not_charging_at;
      if (lastCap !== null && lastCap !== undefined && poll.batt_capacity < lastCap - 5) {
        // Capacity dropped 5+ points since last poll
        if (!notChargingAt) {
          db.prepare('UPDATE alert_state SET not_charging_at=? WHERE device_id=?').run(now, device.id);
        } else if ((now - notChargingAt) > 3600 && (!state.last_alerted_at || (now - state.last_alerted_at) > reminderSec)) {
          const html = buildSimpleEmail(device, site, poll, '📉', '#d97706', 'Battery Not Charging',
            [['📉', `Capacity dropped from ${lastCap}% to ${poll.batt_capacity}%`],
             poll.batt_run_time !== null ? ['⏱️', `Current runtime: ${poll.batt_run_time} minutes`] : null].filter(Boolean),
            '⚠️ The battery capacity is declining. The battery may not be charging properly.');
          await fire(cfg, `📉 BattStat Not Charging: ${device.name} (${site?.name || device.ip})`, html, 'not charging', device.name);
        }
      } else {
        db.prepare('UPDATE alert_state SET not_charging_at=NULL WHERE device_id=?').run(device.id);
      }
      db.prepare('UPDATE alert_state SET last_capacity=? WHERE device_id=?').run(poll.batt_capacity, device.id);
      state = db.getAlertState(device.id);
    }

    // ── Battery age ────────────────────────────────────────────────────────
    if (reachable && cfg.alert_battery_age && device.battery_installed) {
      const installedDate = new Date(device.battery_installed);
      if (!isNaN(installedDate)) {
        const ageYears = (Date.now() - installedDate) / (365.25 * 24 * 3600 * 1000);
        const maxYears = parseFloat(cfg.battery_age_years) || 4.0;
        if (ageYears >= maxYears) {
          const lastAlerted = state?.last_alerted_at || 0;
          if (!lastAlerted || (now - lastAlerted) > 7 * 86400) { // weekly reminder
            const html = buildSimpleEmail(device, site, poll, '🗓️', '#d97706', 'Battery Age Exceeded',
              [['🗓️', `Battery installed: ${device.battery_installed}`],
               ['📊', `Age: ${ageYears.toFixed(1)} years (threshold: ${maxYears} years)`],
               device.part_number ? ['🔩', `Replacement part: ${device.part_number}`] : null].filter(Boolean),
              `⚠️ This battery has exceeded the recommended replacement interval of ${maxYears} years.`);
            await fire(cfg, `🗓️ BattStat Battery Age: ${device.name} needs replacement (${site?.name || device.ip})`, html, 'battery age', device.name);
            db.markAlerted(device.id, 'age');
            state = db.getAlertState(device.id);
          }
        }
      }
    }

    // ── High load ──────────────────────────────────────────────────────────
    if (reachable && cfg.alert_high_load && poll.output_load !== null) {
      const threshold = parseInt(cfg.high_load_threshold) || 80;
      const loadAlertedAt = state?.load_alerted_at || 0;
      if (poll.output_load >= threshold && (now - loadAlertedAt) > reminderSec) {
        const html = buildSimpleEmail(device, site, poll, '📊', '#d97706', 'High Output Load',
          [['📊', `Output load: <strong>${poll.output_load}%</strong> (threshold: ${threshold}%)`],
           poll.batt_capacity !== null ? ['🔋', `Battery charge: ${poll.batt_capacity}%`] : null,
           poll.batt_run_time  !== null ? ['⏱️', `Estimated runtime: ${poll.batt_run_time} minutes`] : null].filter(Boolean),
          '⚠️ High load increases battery drain rate and reduces runtime in the event of a power failure.');
        await fire(cfg, `📊 BattStat High Load: ${device.name} at ${poll.output_load}% (${site?.name || device.ip})`, html, 'high load', device.name);
        db.prepare('UPDATE alert_state SET load_alerted_at=? WHERE device_id=?').run(now, device.id);
        state = db.getAlertState(device.id);
      } else if (poll.output_load < threshold) {
        db.prepare('UPDATE alert_state SET load_alerted_at=NULL WHERE device_id=?').run(device.id);
      }
    }

    // ── High temperature ───────────────────────────────────────────────────
    if (reachable && cfg.alert_high_temp && poll.batt_temperature !== null) {
      const threshold = parseInt(cfg.high_temp_threshold) || 35;
      const tempAlertedAt = state?.temp_alerted_at || 0;
      if (poll.batt_temperature >= threshold && (now - tempAlertedAt) > reminderSec) {
        const html = buildSimpleEmail(device, site, poll, '🌡️', '#d97706', 'High Temperature',
          [['🌡️', `Battery temperature: <strong>${poll.batt_temperature}°C</strong> (threshold: ${threshold}°C)`],
           poll.batt_capacity !== null ? ['🔋', `Battery charge: ${poll.batt_capacity}%`] : null].filter(Boolean),
          '⚠️ Elevated temperature reduces battery life and increases the risk of failure.');
        await fire(cfg, `🌡️ BattStat High Temp: ${device.name} at ${poll.batt_temperature}°C (${site?.name || device.ip})`, html, 'high temp', device.name);
        db.prepare('UPDATE alert_state SET temp_alerted_at=? WHERE device_id=?').run(now, device.id);
        state = db.getAlertState(device.id);
      } else if (poll.batt_temperature < threshold) {
        db.prepare('UPDATE alert_state SET temp_alerted_at=NULL WHERE device_id=?').run(device.id);
      }
    }

    // ── Stale / not polling ────────────────────────────────────────────────
    if (cfg.alert_stale && poll.polled_at) {
      const staleThreshold = (parseInt(cfg.stale_hours) || 2) * 3600;
      const staleAlertedAt = state?.stale_alerted_at || 0;
      const lastPoll = poll.polled_at;
      if ((now - lastPoll) > staleThreshold && (now - staleAlertedAt) > reminderSec) {
        const hoursAgo = Math.round((now - lastPoll) / 3600);
        const html = buildSimpleEmail(device, site, poll, '🕐', '#6b7280', 'Device Not Polling',
          [['🕐', `Last successful poll: ${hoursAgo} hour${hoursAgo !== 1 ? 's' : ''} ago`],
           ['🌐', `IP: ${device.ip}`],
           ['📡', 'Device may be unreachable or SNMP may be misconfigured']],
          null);
        await fire(cfg, `🕐 BattStat Stale: ${device.name} not polled in ${hoursAgo}h (${site?.name || device.ip})`, html, 'stale', device.name);
        db.prepare('UPDATE alert_state SET stale_alerted_at=? WHERE device_id=?').run(now, device.id);
        state = db.getAlertState(device.id);
      } else if ((now - lastPoll) < staleThreshold) {
        db.prepare('UPDATE alert_state SET stale_alerted_at=NULL WHERE device_id=?').run(device.id);
      }
    }

    // ── Status alert (critical / warning / offline) ────────────────────────
    const needsAlert = (status === 'red' && cfg.alert_critical) ||
                       (status === 'yellow' && cfg.alert_warning) ||
                       (status === 'unreachable' && cfg.alert_offline);

    if (!needsAlert) { if (state?.alerted_status) db.clearAlertState(device.id); continue; }

    const alreadyAlerted = state?.alerted_status === status;
    const reminderDue    = alreadyAlerted && state.last_alerted_at && (now - state.last_alerted_at) >= reminderSec;

    if (!alreadyAlerted || reminderDue) {
      const label = STATUS_LABEL[status];
      const subject = `${reminderDue ? '[Reminder] ' : ''}BattStat ${label}: ${device.name} (${site?.name || device.ip})`;
      const html = buildStatusEmail(device, site, poll, status, reminderDue);
      await fire(cfg, subject, html, `status ${label}`, device.name);
      db.markAlerted(device.id, status);
    }
  }
}

module.exports = { runAlertCheck };
