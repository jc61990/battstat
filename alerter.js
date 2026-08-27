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
  return `<div style="background:${color};padding:14px 20px">
    <div style="display:flex;align-items:center;gap:8px">
      <span style="font-size:20px;line-height:1">${emoji}</span>
      <div>
        <div style="color:rgba(255,255,255,.75);font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.07em">BattStat UPS Monitor</div>
        <div style="color:#fff;font-size:16px;font-weight:700;margin-top:1px">${title}</div>
        ${subtitle ? `<div style="color:rgba(255,255,255,.85);font-size:12px;margin-top:1px">${subtitle}</div>` : ''}
      </div>
    </div>
  </div>`;
}

function deviceTable(device, site, poll, dashboardUrl) {
  const rows = [
    ['Device', `<strong style="font-size:14px">${device.name}</strong>`],
    ['Site', `${site?.name || '—'}${device.floor ? ` · <span style="color:#6b7280">Floor ${device.floor}</span>` : ''}`],
    ['IP Address', `<span style="font-family:monospace;font-size:13px">${device.ip}</span>`],
    (poll?.model_snmp || device.model) ? ['Model', poll?.model_snmp || device.model] : null,
    device.part_number ? ['Replacement Part', `<span style="font-family:monospace;background:#f3f4f6;padding:1px 5px;border-radius:3px;font-size:12px">${device.part_number}</span>`] : null,
    device.battery_installed ? ['Battery Installed', device.battery_installed] : null,
  ].filter(Boolean);
  return `<div style="padding:10px 20px;border-bottom:1px solid #e5e7eb">
    <table style="width:100%;border-collapse:collapse">
      ${rows.map(([k,v]) => `<tr>
        <td style="padding:3px 0;color:#9ca3af;font-size:11px;text-transform:uppercase;letter-spacing:.04em;width:120px;vertical-align:top;padding-right:8px">${k}</td>
        <td style="padding:3px 0;font-size:13px;color:#111">${v}</td>
      </tr>`).join('')}
    </table>
  </div>`;
}

function reasonBox(items, accentColor) {
  const bg    = accentColor ? accentColor + '11' : '#f9fafb';
  const border= accentColor || '#e5e7eb';
  return `<div style="margin:10px 20px;background:${bg};border-left:3px solid ${border};border-radius:0 4px 4px 0;padding:10px 14px">
    <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:${accentColor || '#6b7280'};margin-bottom:6px">Alert Detail</div>
    ${items.map(([icon, text]) => `<div style="display:flex;align-items:baseline;gap:6px;padding:3px 0">
      <span style="font-size:13px;flex-shrink:0">${icon}</span>
      <span style="font-size:14px;font-weight:600;color:#1f2937">${text}</span>
    </div>`).join('')}
  </div>`;
}

function metricsRow(poll) {
  if (!poll) return '';
  const metrics = [
    poll.batt_capacity    !== null ? [`🔋`, `${poll.batt_capacity}%`, 'Charge'] : null,
    poll.batt_run_time    !== null ? [`⏱️`, `${poll.batt_run_time}m`, 'Runtime'] : null,
    poll.batt_temperature !== null ? [`🌡️`, `${poll.batt_temperature}°C`, 'Temp'] : null,
    poll.output_load      !== null ? [`📊`, `${poll.output_load}%`, 'Load'] : null,
    poll.input_voltage    !== null ? [`⚡`, `${poll.input_voltage}V`, 'Input'] : null,
  ].filter(Boolean);
  if (!metrics.length) return '';
  return `<div style="margin:0 20px 10px;display:flex;gap:6px;flex-wrap:wrap">
    ${metrics.map(([icon,val,label]) => `<div style="background:#f3f4f6;border-radius:6px;padding:6px 10px;text-align:center;min-width:56px">
      <div style="font-size:14px;line-height:1">${icon}</div>
      <div style="font-size:14px;font-weight:700;color:#111;margin-top:2px">${val}</div>
      <div style="font-size:10px;color:#9ca3af;text-transform:uppercase;letter-spacing:.04em">${label}</div>
    </div>`).join('')}
  </div>`;
}

function noteBox(text) {
  return `<div style="margin:0 20px 10px;background:#fffbeb;border:1px solid #fde68a;border-radius:5px;padding:8px 12px;font-size:12px;color:#92400e">${text}</div>`;
}

function footer(ts) {
  return `<div style="padding:10px 20px;background:#f9fafb;border-top:1px solid #e5e7eb">
    <p style="margin:0;font-size:11px;color:#9ca3af">Sent by BattStat · ${ts || new Date().toLocaleString()}</p>
  </div>`;
}

function wrap(inner) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <div style="max-width:560px;margin:16px auto;background:#fff;border-radius:8px;overflow:hidden;border:1px solid #e5e7eb;box-shadow:0 1px 3px rgba(0,0,0,.08)">
    ${inner}
  </div>
</body></html>`;
}

function buildSubject(prefix, device, site, reason) {
  const sitePart = site?.name ? ` [${site.name}]` : '';
  const floorPart = device.floor ? ` Floor ${device.floor}` : '';
  const reasonPart = reason ? ` — ${reason}` : '';
  return `${prefix}: ${device.name}${sitePart}${floorPart}${reasonPart}`;
}

function buildStatusEmail(device, site, poll, status, isReminder) {
  const color = STATUS_COLOR[status];
  const label = STATUS_LABEL[status];
  const reasons = [];

  if (status === 'unreachable') {
    reasons.push(['📡', 'Not responding to SNMP polls']);
  } else if (poll) {
    const { batt_capacity: cap, batt_temperature: temp, batt_run_time: rt, batt_replace_date: rd, batt_status: st } = poll;
    if (cap  !== null && cap  < 40)  reasons.push(['🔋', `Battery charge low: ${cap}%`]);
    if (temp !== null && temp >= 40) reasons.push(['🌡️', `High temperature: ${temp}°C`]);
    if (rt   !== null && rt   < 20)  reasons.push(['⏱️', `Low runtime: ${rt} minutes remaining`]);
    if (rd) {
      const d = new Date(rd);
      if (!isNaN(d)) {
        const days = Math.round((d - new Date()) / 86400000);
        if (days < 0)  reasons.push(['📅', `Battery replace date overdue by ${Math.abs(days)} days (was ${rd})`]);
        else if (days < 90) reasons.push(['📅', `Battery replace date approaching: ${rd} (${days} days)`]);
      }
    }
    if (['batteryLow','batteryInFaultCondition','batteryDepleted'].includes(st))
      reasons.push(['⚠️', `UPS reports: ${st}`]);
  }

  const firstReason = reasons[0]?.[1] || label;
  const subject = buildSubject(
    isReminder ? `[Reminder] BattStat ${label}` : `BattStat ${label}`,
    device, site, firstReason
  );

  const emoji = status === 'unreachable' ? '⚫' : status === 'red' ? '🔴' : '🟡';

  return {
    subject,
    html: wrap(
      header(color, emoji, `${isReminder ? 'Reminder: ' : ''}${label} Alert`, null) +
      deviceTable(device, site, poll) +
      metricsRow(poll) +
      (reasons.length ? reasonBox(reasons, color) : '') +
      (isReminder ? noteBox('⏰ This is a reminder — the alert condition has not been resolved since first notification.') : '') +
      footer()
    )
  };
}

function buildResolvedEmail(device, site, poll, resolvedType, detail) {
  const subject = buildSubject('✅ BattStat Resolved', device, site, resolvedType);
  return {
    subject,
    html: wrap(
      header('#16a34a', '✅', 'Resolved', resolvedType) +
      deviceTable(device, site, poll) +
      metricsRow(poll) +
      reasonBox([['✅', detail || 'Condition has been resolved']], '#16a34a') +
      footer()
    )
  };
}

function buildSimpleEmail(device, site, poll, emoji, color, title, items, note) {
  const firstItem = items[0]?.[1]?.replace(/<[^>]+>/g, '') || title;
  const subject = buildSubject(`BattStat ${title}`, device, site, firstItem.length > 60 ? firstItem.slice(0,60) + '…' : firstItem);
  return {
    subject,
    html: wrap(
      header(color, emoji, title, null) +
      deviceTable(device, site, poll) +
      metricsRow(poll) +
      reasonBox(items, color) +
      (note ? noteBox(note) : '') +
      footer()
    )
  };
}

async function fire(cfg, email, label, deviceName) {
  try {
    await sendAlert(cfg, email.subject, email.html);
    console.log(`[alerter] ${label}: ${deviceName} — ${email.subject}`);
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
        const email = buildSimpleEmail(device, site, poll, '⚡', '#dc2626', 'UPS On Battery Power',
          [['⚡', `Transfer reason: <strong>${xferReason}</strong>`],
           ...(poll.batt_capacity !== null ? [['🔋', `Battery charge: ${poll.batt_capacity}%`]] : []),
           ...(poll.batt_run_time  !== null ? [['⏱️', `Estimated runtime: ${poll.batt_run_time} minutes`]] : []),
           ...(poll.output_load    !== null ? [['📊', `Output load: ${poll.output_load}%`]] : [])],
          '⚠️ The UPS is running on battery. Check the power source immediately.');
        await fire(cfg, email, 'power event', device.name);
        db.markXferAlerted(device.id, xferReason);
        state = db.getAlertState(device.id);
      }
    } else if (reachable && state?.last_xfer_reason) {
      // ── Recovery alert ─────────────────────────────────────────────────
      if (cfg.alert_recovery) {
        const lastRecovery = state.recovery_alerted_at || 0;
        if (!lastRecovery || (now - lastRecovery) > 3600) {
          const email = buildResolvedEmail(device, site, poll, 'Back on Line Power', 'UPS has transferred back to utility power');
          await fire(cfg, email, 'recovery', device.name);
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
        const email = buildSimpleEmail(device, site, poll, '🧪', '#dc2626', 'Self-Test Failed',
          [['🧪', 'UPS self-test returned a failure result'],
           poll.self_test_date ? ['📅', `Test date: ${poll.self_test_date}`] : null,
           poll.batt_capacity !== null ? ['🔋', `Battery charge: ${poll.batt_capacity}%`] : null].filter(Boolean),
          '⚠️ A failed self-test may indicate the battery needs replacement.');
        await fire(cfg, email, 'self-test fail', device.name);
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
          const email = buildSimpleEmail(device, site, poll, '📉', '#d97706', 'Battery Not Charging',
            [['📉', `Capacity dropped from ${lastCap}% to ${poll.batt_capacity}%`],
             poll.batt_run_time !== null ? ['⏱️', `Current runtime: ${poll.batt_run_time} minutes`] : null].filter(Boolean),
            '⚠️ The battery capacity is declining. The battery may not be charging properly.');
          await fire(cfg, email, 'not charging', device.name);
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
            const email = buildSimpleEmail(device, site, poll, '🗓️', '#d97706', 'Battery Age Exceeded',
              [['🗓️', `Battery installed: ${device.battery_installed}`],
               ['📊', `Age: ${ageYears.toFixed(1)} years (threshold: ${maxYears} years)`],
               device.part_number ? ['🔩', `Replacement part: ${device.part_number}`] : null].filter(Boolean),
              `⚠️ This battery has exceeded the recommended replacement interval of ${maxYears} years.`);
            await fire(cfg, email, 'battery age', device.name);
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
        const email = buildSimpleEmail(device, site, poll, '📊', '#d97706', 'High Output Load',
          [['📊', `Output load: <strong>${poll.output_load}%</strong> (threshold: ${threshold}%)`],
           poll.batt_capacity !== null ? ['🔋', `Battery charge: ${poll.batt_capacity}%`] : null,
           poll.batt_run_time  !== null ? ['⏱️', `Estimated runtime: ${poll.batt_run_time} minutes`] : null].filter(Boolean),
          '⚠️ High load increases battery drain rate and reduces runtime in the event of a power failure.');
        await fire(cfg, email, 'high load', device.name);
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
        const email = buildSimpleEmail(device, site, poll, '🌡️', '#d97706', 'High Temperature',
          [['🌡️', `Battery temperature: <strong>${poll.batt_temperature}°C</strong> (threshold: ${threshold}°C)`],
           poll.batt_capacity !== null ? ['🔋', `Battery charge: ${poll.batt_capacity}%`] : null].filter(Boolean),
          '⚠️ Elevated temperature reduces battery life and increases the risk of failure.');
        await fire(cfg, email, 'high temp', device.name);
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
        const email = buildSimpleEmail(device, site, poll, '🕐', '#6b7280', 'Device Not Polling',
          [['🕐', `Last successful poll: ${hoursAgo} hour${hoursAgo !== 1 ? 's' : ''} ago`],
           ['🌐', `IP: ${device.ip}`],
           ['📡', 'Device may be unreachable or SNMP may be misconfigured']],
          null);
        await fire(cfg, email, 'stale', device.name);
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

    if (!needsAlert) {
      // Send resolved email if previously alerted and now healthy
      if (state?.alerted_status && state.alerted_status !== 'age' && cfg.alert_recovery && status === 'green') {
        const prevLabel = STATUS_LABEL[state.alerted_status] || state.alerted_status;
        const email = buildResolvedEmail(device, site, poll, `Recovered from ${prevLabel}`,
          `Device is now healthy. All monitored metrics are within normal thresholds.`);
        await fire(cfg, email, 'resolved', device.name);
      }
      if (state?.alerted_status) db.clearAlertState(device.id);
      continue;
    }

    const alreadyAlerted = state?.alerted_status === status;
    const reminderDue    = alreadyAlerted && state.last_alerted_at && (now - state.last_alerted_at) >= reminderSec;

    if (!alreadyAlerted || reminderDue) {
      const label = STATUS_LABEL[status];
      const email = buildStatusEmail(device, site, poll, status, reminderDue);
      await fire(cfg, email, `status ${label}`, device.name);
      db.markAlerted(device.id, status);
    }
  }
}

module.exports = { runAlertCheck };
