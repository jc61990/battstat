'use strict';

const snmp = require('net-snmp');
const { getDevices, getDevice, getSnmpConfig, savePollResult, pruneOldPolls } = require('./db');

let pollTimer = null;
let wsClients = new Set();
let isPolling = false;

function registerWsClient(ws) { wsClients.add(ws); }
function unregisterWsClient(ws) { wsClients.delete(ws); }

function broadcast(event, data) {
  const msg = JSON.stringify({ event, data });
  for (const ws of wsClients) {
    try { if (ws.readyState === 1) ws.send(msg); } catch (_) {}
  }
}

const OID = {
  sysDescr:           '1.3.6.1.2.1.1.1.0',
  sysName:            '1.3.6.1.2.1.1.5.0',
  apcBattCapacity:    '1.3.6.1.4.1.318.1.1.1.2.2.1.0',
  apcBattStatus:      '1.3.6.1.4.1.318.1.1.1.2.1.1.0',
  apcBattTempC:       '1.3.6.1.4.1.318.1.1.1.2.2.2.0',
  apcBattRunTime:     '1.3.6.1.4.1.318.1.1.1.2.2.3.0',
  apcBattReplaceDate: '1.3.6.1.4.1.318.1.1.1.2.2.21.0',
  apcInputVoltage:    '1.3.6.1.4.1.318.1.1.1.3.2.1.0',
  apcOutputVoltage:   '1.3.6.1.4.1.318.1.1.1.4.2.1.0',
  apcOutputLoad:      '1.3.6.1.4.1.318.1.1.1.4.2.3.0',
  apcModel:           '1.3.6.1.4.1.318.1.1.1.1.1.1.0',
  apcSerial:          '1.3.6.1.4.1.318.1.1.1.1.2.3.0',
  apcFirmware:        '1.3.6.1.4.1.318.1.1.1.1.2.1.0',
  eatonBattCapacity:  '1.3.6.1.4.1.534.1.2.4.0',
  eatonBattTemp:      '1.3.6.1.4.1.534.1.2.2.0',
  eatonBattRunTime:   '1.3.6.1.4.1.534.1.2.1.0',
  eatonInputVoltage:  '1.3.6.1.4.1.534.1.3.4.1.2.1',
  eatonOutputVoltage: '1.3.6.1.4.1.534.1.4.4.1.2.1',
  eatonOutputLoad:    '1.3.6.1.4.1.534.1.4.1.0',
  cyberBattCapacity:  '1.3.6.1.4.1.3808.1.1.1.2.2.1.0',
  cyberBattTemp:      '1.3.6.1.4.1.3808.1.1.1.2.2.2.0',
  cyberBattRunTime:   '1.3.6.1.4.1.3808.1.1.1.2.2.4.0',
  cyberBattStatus:    '1.3.6.1.4.1.3808.1.1.1.2.1.1.0',
  cyberInputVoltage:  '1.3.6.1.4.1.3808.1.1.1.3.2.1.0',
  cyberOutputVoltage: '1.3.6.1.4.1.3808.1.1.1.4.2.1.0',
  cyberOutputLoad:    '1.3.6.1.4.1.3808.1.1.1.4.2.3.0',
  cyberModel:         '1.3.6.1.4.1.3808.1.1.1.1.1.1.0',
  cyberSerial:        '1.3.6.1.4.1.3808.1.1.1.1.2.3.0',

  // Tripp Lite — LX Platform / WEBCARDLX (newer, firmware 15.x+)
  // Enterprise OID prefix: 1.3.6.1.4.1.850
  tlBattCapacity:     '1.3.6.1.4.1.850.1.1.3.1.3.1.1.1.4.1',  // percent
  tlBattStatus:       '1.3.6.1.4.1.850.1.1.3.1.3.1.1.1.3.1',  // 1=unknown,2=normal,3=low,4=depleted
  tlBattRunTime:      '1.3.6.1.4.1.850.1.1.3.1.3.1.1.1.5.1',  // seconds
  tlBattTemp:         '1.3.6.1.4.1.850.1.1.3.1.2.1.1.7',      // celsius
  tlInputVoltage:     '1.3.6.1.4.1.850.1.1.3.1.3.2.2.1.3.1',  // V
  tlOutputVoltage:    '1.3.6.1.4.1.850.1.1.3.1.3.3.1.3.1',    // V
  tlOutputLoad:       '1.3.6.1.4.1.850.1.1.3.1.3.3.1.10.1',   // percent
  tlModel:            '1.3.6.1.4.1.850.1.1.1.2.1.6.1',
  tlSerial:           '1.3.6.1.4.1.850.1.1.1.2.1.7.1',
  tlFirmware:         '1.3.6.1.4.1.850.1.1.1.2.1.5.1',
  tlNextReplaceDate:  '1.3.6.1.4.1.850.1.1.3.1.3.1.5.1.6',    // days until replace

  // Tripp Lite — RFC 1628 standard UPS MIB (older SNMPWEBCARD, widely supported)
  rfc1628BattCapacity:   '1.3.6.1.2.1.33.1.2.4.0',   // percent
  rfc1628BattStatus:     '1.3.6.1.2.1.33.1.2.1.0',   // 1=unknown,2=normal,3=low,4=depleted
  rfc1628BattRunTime:    '1.3.6.1.2.1.33.1.2.3.0',   // seconds (TimeTicks / 100)
  rfc1628BattTemp:       '1.3.6.1.2.1.33.1.2.7.0',   // celsius
  rfc1628InputVoltage:   '1.3.6.1.2.1.33.1.3.3.1.3.1',
  rfc1628OutputVoltage:  '1.3.6.1.2.1.33.1.4.4.1.2.1',
  rfc1628OutputLoad:     '1.3.6.1.2.1.33.1.4.4.1.5.1', // percent
};

const APC_BATT_STATUS   = { 1:'unknown', 2:'batteryNormal', 3:'batteryLow', 4:'batteryInFaultCondition' };
const CYBER_BATT_STATUS = { 1:'unknown', 2:'batteryNormal', 3:'batteryLow', 4:'batteryDepleted' };
const TL_BATT_STATUS    = { 1:'unknown', 2:'batteryNormal', 3:'batteryLow', 4:'batteryDepleted' };
const RFC1628_BATT_STATUS = { 1:'unknown', 2:'batteryNormal', 3:'batteryLow', 4:'batteryDepleted' };

function buildSnmpV3Options(cfg) {
  const authProto = cfg.auth_protocol === 'SHA256'
    ? snmp.AuthProtocols.sha256
    : cfg.auth_protocol === 'SHA512'
      ? snmp.AuthProtocols.sha512
      : snmp.AuthProtocols.sha;

  const privProto = cfg.priv_protocol === 'AES256'
    ? snmp.PrivProtocols.aes256b
    : snmp.PrivProtocols.aes;

  const secLevel = {
    noAuthNoPriv: snmp.SecurityLevel.noAuthNoPriv,
    authNoPriv:   snmp.SecurityLevel.authNoPriv,
    authPriv:     snmp.SecurityLevel.authPriv,
  }[cfg.security_level] ?? snmp.SecurityLevel.authPriv;

  return {
    sessionOpts: {
      version:    snmp.Version3,
      idBitsSize: 32,
      port:       cfg.port      || 161,
      timeout:    cfg.timeout_ms || 5000,
      retries:    cfg.retries   ?? 1,
    },
    userOpts: {
      name:         cfg.security_name,
      level:        secLevel,
      authProtocol: authProto,
      authKey:      cfg.auth_key,
      privProtocol: privProto,
      privKey:      cfg.priv_key,
    },
  };
}

function detectVendor(device) {
  const desc = (device.model || '').toLowerCase();
  if (desc.includes('eaton') || desc.includes('powerware') || desc.includes('mg')) return 'eaton';
  if (desc.includes('cyber')) return 'cyber';
  if (desc.includes('tripp') || desc.includes('tripplite') || desc.includes('triplite')) return 'tripplite';
  return 'apc';
}

function oidListForVendor(vendor) {
  if (vendor === 'tripplite') {
    // Prefer LX Platform MIB values, fall back to RFC 1628 if not present
    const tlCap  = getInt(OID.tlBattCapacity);
    const rfcCap = getInt(OID.rfc1628BattCapacity);
    const batt_capacity = tlCap ?? rfcCap;

    const tlSi  = getInt(OID.tlBattStatus);
    const rfcSi = getInt(OID.rfc1628BattStatus);
    const si    = tlSi ?? rfcSi;
    const batt_status = si !== null ? (TL_BATT_STATUS[si] || String(si)) : null;

    const tlRt  = getInt(OID.tlBattRunTime);
    const rfcRt = getInt(OID.rfc1628BattRunTime);
    // LX Platform: seconds. RFC 1628: TimeTicks (hundredths of seconds)
    const batt_run_time = tlRt !== null
      ? Math.floor(tlRt / 60)
      : rfcRt !== null ? Math.floor(rfcRt / 6000) : null;

    const tlTemp  = getInt(OID.tlBattTemp);
    const rfcTemp = getInt(OID.rfc1628BattTemp);

    const tlInV  = getInt(OID.tlInputVoltage);
    const rfcInV = getInt(OID.rfc1628InputVoltage);

    const tlOutV  = getInt(OID.tlOutputVoltage);
    const rfcOutV = getInt(OID.rfc1628OutputVoltage);

    const tlLoad  = getInt(OID.tlOutputLoad);
    const rfcLoad = getInt(OID.rfc1628OutputLoad);

    // Next replace date from LX Platform is in days-until — convert to a date string
    const daysUntil = getInt(OID.tlNextReplaceDate);
    let batt_replace_date = null;
    if (daysUntil !== null) {
      const d = new Date();
      d.setDate(d.getDate() + daysUntil);
      batt_replace_date = d.toISOString().slice(0, 10);
    }

    return {
      batt_capacity,
      batt_status,
      batt_temperature: tlTemp ?? rfcTemp,
      batt_run_time,
      batt_replace_date,
      input_voltage:  tlInV ?? rfcInV,
      output_voltage: tlOutV ?? rfcOutV,
      output_load:    tlLoad ?? rfcLoad,
      model_snmp:  get(OID.tlModel) || get(OID.sysDescr),
      serial_snmp: get(OID.tlSerial),
      firmware:    get(OID.tlFirmware),
    };
  }

  if (vendor === 'eaton') {
    return [OID.sysDescr, OID.sysName,
      OID.eatonBattCapacity, OID.eatonBattTemp, OID.eatonBattRunTime,
      OID.eatonInputVoltage, OID.eatonOutputVoltage, OID.eatonOutputLoad];
  }
  if (vendor === 'cyber') {
    return [OID.sysDescr, OID.sysName,
      OID.cyberBattCapacity, OID.cyberBattTemp, OID.cyberBattRunTime, OID.cyberBattStatus,
      OID.cyberInputVoltage, OID.cyberOutputVoltage, OID.cyberOutputLoad,
      OID.cyberModel, OID.cyberSerial];
  }
  if (vendor === 'tripplite') {
    // Query both the LX Platform MIB and RFC 1628 — whichever responds wins
    return [OID.sysDescr, OID.sysName,
      OID.tlBattCapacity, OID.tlBattStatus, OID.tlBattRunTime, OID.tlBattTemp,
      OID.tlInputVoltage, OID.tlOutputVoltage, OID.tlOutputLoad,
      OID.tlModel, OID.tlSerial, OID.tlFirmware, OID.tlNextReplaceDate,
      OID.rfc1628BattCapacity, OID.rfc1628BattStatus, OID.rfc1628BattRunTime,
      OID.rfc1628BattTemp, OID.rfc1628InputVoltage, OID.rfc1628OutputVoltage,
      OID.rfc1628OutputLoad];
  }
  return [OID.sysDescr, OID.sysName,
    OID.apcBattCapacity, OID.apcBattStatus, OID.apcBattTempC,
    OID.apcBattRunTime, OID.apcBattReplaceDate,
    OID.apcInputVoltage, OID.apcOutputVoltage, OID.apcOutputLoad,
    OID.apcModel, OID.apcSerial, OID.apcFirmware];
}

function parseVarbinds(varbinds, vendor) {
  const vals = {};
  for (const vb of varbinds) {
    if (snmp.isVarbindError(vb)) continue;
    const raw = vb.value;
    vals[vb.oid] = Buffer.isBuffer(raw) ? raw.toString('utf8').replace(/\0/g, '').trim() : raw;
  }
  const get    = (oid) => vals[oid] ?? null;
  const getInt = (oid) => { const v = get(oid); return v !== null ? parseInt(v, 10) : null; };

  if (vendor === 'tripplite') {
    // Prefer LX Platform MIB values, fall back to RFC 1628 if not present
    const tlCap  = getInt(OID.tlBattCapacity);
    const rfcCap = getInt(OID.rfc1628BattCapacity);
    const batt_capacity = tlCap ?? rfcCap;

    const tlSi  = getInt(OID.tlBattStatus);
    const rfcSi = getInt(OID.rfc1628BattStatus);
    const si    = tlSi ?? rfcSi;
    const batt_status = si !== null ? (TL_BATT_STATUS[si] || String(si)) : null;

    const tlRt  = getInt(OID.tlBattRunTime);
    const rfcRt = getInt(OID.rfc1628BattRunTime);
    // LX Platform: seconds. RFC 1628: TimeTicks (hundredths of seconds)
    const batt_run_time = tlRt !== null
      ? Math.floor(tlRt / 60)
      : rfcRt !== null ? Math.floor(rfcRt / 6000) : null;

    const tlTemp  = getInt(OID.tlBattTemp);
    const rfcTemp = getInt(OID.rfc1628BattTemp);

    const tlInV  = getInt(OID.tlInputVoltage);
    const rfcInV = getInt(OID.rfc1628InputVoltage);

    const tlOutV  = getInt(OID.tlOutputVoltage);
    const rfcOutV = getInt(OID.rfc1628OutputVoltage);

    const tlLoad  = getInt(OID.tlOutputLoad);
    const rfcLoad = getInt(OID.rfc1628OutputLoad);

    // Next replace date from LX Platform is in days-until — convert to a date string
    const daysUntil = getInt(OID.tlNextReplaceDate);
    let batt_replace_date = null;
    if (daysUntil !== null) {
      const d = new Date();
      d.setDate(d.getDate() + daysUntil);
      batt_replace_date = d.toISOString().slice(0, 10);
    }

    return {
      batt_capacity,
      batt_status,
      batt_temperature: tlTemp ?? rfcTemp,
      batt_run_time,
      batt_replace_date,
      input_voltage:  tlInV ?? rfcInV,
      output_voltage: tlOutV ?? rfcOutV,
      output_load:    tlLoad ?? rfcLoad,
      model_snmp:  get(OID.tlModel) || get(OID.sysDescr),
      serial_snmp: get(OID.tlSerial),
      firmware:    get(OID.tlFirmware),
    };
  }

  if (vendor === 'eaton') {
    const rt = getInt(OID.eatonBattRunTime);
    return {
      batt_capacity: getInt(OID.eatonBattCapacity), batt_status: null,
      batt_temperature: getInt(OID.eatonBattTemp),
      batt_run_time: rt !== null ? Math.floor(rt / 60) : null,
      batt_replace_date: null,
      input_voltage: getInt(OID.eatonInputVoltage), output_voltage: getInt(OID.eatonOutputVoltage),
      output_load: getInt(OID.eatonOutputLoad), model_snmp: get(OID.sysDescr),
      serial_snmp: null, firmware: null,
    };
  }
  if (vendor === 'cyber') {
    const si = getInt(OID.cyberBattStatus);
    const rt = getInt(OID.cyberBattRunTime);
    return {
      batt_capacity: getInt(OID.cyberBattCapacity),
      batt_status: si !== null ? (CYBER_BATT_STATUS[si] || String(si)) : null,
      batt_temperature: getInt(OID.cyberBattTemp),
      batt_run_time: rt !== null ? Math.floor(rt / 60) : null,
      batt_replace_date: null,
      input_voltage: getInt(OID.cyberInputVoltage), output_voltage: getInt(OID.cyberOutputVoltage),
      output_load: getInt(OID.cyberOutputLoad),
      model_snmp: get(OID.cyberModel) || get(OID.sysDescr), serial_snmp: get(OID.cyberSerial),
      firmware: null,
    };
  }
  const si = getInt(OID.apcBattStatus);
  const rt = getInt(OID.apcBattRunTime);
  return {
    batt_capacity: getInt(OID.apcBattCapacity),
    batt_status: si !== null ? (APC_BATT_STATUS[si] || String(si)) : null,
    batt_temperature: getInt(OID.apcBattTempC),
    batt_run_time: rt !== null ? Math.floor(rt / 6000) : null,
    batt_replace_date: get(OID.apcBattReplaceDate) || null,
    input_voltage: getInt(OID.apcInputVoltage), output_voltage: getInt(OID.apcOutputVoltage),
    output_load: getInt(OID.apcOutputLoad),
    model_snmp: get(OID.apcModel) || get(OID.sysDescr), serial_snmp: get(OID.apcSerial),
    firmware: get(OID.apcFirmware),
  };
}

function pollDevice(device, cfg) {
  return new Promise((resolve) => {
    const vendor = detectVendor(device);
    const oids   = oidListForVendor(vendor);
    const { sessionOpts, userOpts } = buildSnmpV3Options(cfg);

    let session;
    try {
      session = snmp.createV3Session(device.ip, userOpts, sessionOpts);
    } catch (err) {
      resolve({ reachable: false, raw_error: err.message });
      return;
    }

    const cleanup = () => { try { session.close(); } catch (_) {} };

    session.get(oids, (err, varbinds) => {
      cleanup();
      if (err) { resolve({ reachable: false, raw_error: err.message }); return; }
      try {
        resolve({ reachable: true, ...parseVarbinds(varbinds, vendor) });
      } catch (parseErr) {
        resolve({ reachable: false, raw_error: 'Parse error: ' + parseErr.message });
      }
    });
  });
}

async function runPollCycle() {
  if (isPolling) return;
  isPolling = true;
  try {
    const cfg = getSnmpConfig();
    if (!cfg || !cfg.security_name || !cfg.auth_key) return;
    const devices = getDevices();
    if (!devices.length) return;
    const results = [];
    for (const device of devices) {
      const data = await pollDevice(device, cfg);
      savePollResult(device.id, data);
      results.push({ device_id: device.id, device_name: device.name, ...data });
    }
    broadcast('poll_complete', results);
    pruneOldPolls(30);
  } catch (err) {
    console.error('[poller] Cycle error:', err.message);
  } finally {
    isPolling = false;
  }
}

function startPoller() {
  if (pollTimer) clearInterval(pollTimer);
  const cfg      = getSnmpConfig();
  const interval = ((cfg && cfg.poll_interval_s) || 60) * 1000;
  runPollCycle().catch(console.error);
  pollTimer = setInterval(() => runPollCycle().catch(console.error), interval);
  console.log(`[poller] Started — interval ${interval / 1000}s`);
}

function stopPoller() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function restartPoller() { stopPoller(); startPoller(); }

function pollSingleDevice(deviceId) {
  const device = getDevice(deviceId);
  if (!device) return Promise.reject(new Error('Device not found'));
  const cfg = getSnmpConfig();
  if (!cfg || !cfg.security_name) return Promise.reject(new Error('SNMP not configured'));
  return pollDevice(device, cfg).then(data => {
    savePollResult(device.id, data);
    broadcast('poll_complete', [{ device_id: device.id, device_name: device.name, ...data }]);
    return data;
  });
}

module.exports = { startPoller, stopPoller, restartPoller, pollSingleDevice, registerWsClient, unregisterWsClient };
