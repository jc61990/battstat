'use strict';

const snmp = require('net-snmp');
const { getDevices, getDevice, getSnmpConfig, savePollResult, pruneOldPolls, autoFillPartNumber, autoFillBatteryInstalled, setDiscoveredSnmpVersion } = require('./db');

let pollTimer  = null;
let wsClients  = new Set();
let isPolling  = false;

function registerWsClient(ws)   { wsClients.add(ws); }
function unregisterWsClient(ws) { wsClients.delete(ws); }

function broadcast(event, data) {
  const msg = JSON.stringify({ event, data });
  for (const ws of wsClients) {
    try { if (ws.readyState === 1) ws.send(msg); } catch (_) {}
  }
}

// ── OID definitions ───────────────────────────────────────────────────────────

const OID = {
  sysDescr:  '1.3.6.1.2.1.1.1.0',
  sysName:   '1.3.6.1.2.1.1.5.0',

  // APC
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

  // Eaton / Powerware
  eatonBattCapacity:  '1.3.6.1.4.1.534.1.2.4.0',
  eatonBattTemp:      '1.3.6.1.4.1.534.1.2.2.0',
  eatonBattRunTime:   '1.3.6.1.4.1.534.1.2.1.0',
  eatonInputVoltage:  '1.3.6.1.4.1.534.1.3.4.1.2.1',
  eatonOutputVoltage: '1.3.6.1.4.1.534.1.4.4.1.2.1',
  eatonOutputLoad:    '1.3.6.1.4.1.534.1.4.1.0',

  // CyberPower
  cyberBattCapacity:  '1.3.6.1.4.1.3808.1.1.1.2.2.1.0',
  cyberBattTemp:      '1.3.6.1.4.1.3808.1.1.1.2.2.2.0',
  cyberBattRunTime:   '1.3.6.1.4.1.3808.1.1.1.2.2.4.0',
  cyberBattStatus:    '1.3.6.1.4.1.3808.1.1.1.2.1.1.0',
  cyberInputVoltage:  '1.3.6.1.4.1.3808.1.1.1.3.2.1.0',
  cyberOutputVoltage: '1.3.6.1.4.1.3808.1.1.1.4.2.1.0',
  cyberOutputLoad:    '1.3.6.1.4.1.3808.1.1.1.4.2.3.0',
  cyberModel:         '1.3.6.1.4.1.3808.1.1.1.1.1.1.0',
  cyberSerial:        '1.3.6.1.4.1.3808.1.1.1.1.2.3.0',

  // Tripp Lite -- NMC5 / PADM 20 (confirmed OIDs from snmpwalk, context "" required)
  tlBattCapacity:    '1.3.6.1.4.1.850.1.1.3.1.3.1.1.1.4.1',    // % INTEGER 100
  tlBattStatus:      '1.3.6.1.4.1.850.1.1.3.1.3.1.1.1.2.1',    // Gauge32 0=normal
  tlBattRunTime:     '1.3.6.1.4.1.850.1.1.3.1.3.1.1.1.3.1',    // seconds Gauge32 1092
  tlBattTemp:        '1.3.6.1.4.1.850.1.1.3.1.3.4.1.1.1.1',    // Gauge32 599 (tenths C)
  tlInputVoltage:    '1.3.6.1.4.1.850.1.1.3.1.3.2.2.1.3.1.1',  // Gauge32 1130 (tenths V)
  tlOutputVoltage:   '1.3.6.1.4.1.850.1.1.3.1.3.3.2.1.2.1.1',  // Gauge32 1200 (tenths V)
  tlOutputLoad:      '1.3.6.1.4.1.850.1.1.3.1.3.3.2.1.10.1.1', // % Gauge32
  tlModel:           '1.3.6.1.4.1.850.1.1.1.2.1.5.1',           // STRING SU2200RTXLCD2U
  tlSerial:          '1.3.6.1.4.1.850.1.1.2.1.1.5.1',           // STRING serial
  tlFirmware:        '1.3.6.1.4.1.850.1.1.2.1.1.4.1',           // STRING firmware
  tlLastReplaceDate: '1.3.6.1.4.1.850.1.1.3.1.3.1.5.1.5.1.1',  // STRING 2025-05-07
  tlNextReplaceDate: '1.3.6.1.4.1.850.1.1.3.1.3.1.5.1.6.1.1',  // STRING 2028-05-07

  // Tripp Lite -- RFC 1628 standard UPS MIB (older SNMPWEBCARD, widely supported)
  rfc1628BattCapacity:  '1.3.6.1.2.1.33.1.2.4.0',
  rfc1628BattStatus:    '1.3.6.1.2.1.33.1.2.1.0',
  rfc1628BattRunTime:   '1.3.6.1.2.1.33.1.2.3.0',
  rfc1628BattTemp:      '1.3.6.1.2.1.33.1.2.7.0',
  rfc1628InputVoltage:  '1.3.6.1.2.1.33.1.3.3.1.3.1',
  rfc1628OutputVoltage: '1.3.6.1.2.1.33.1.4.4.1.2.1',
  rfc1628OutputLoad:    '1.3.6.1.2.1.33.1.4.4.1.5.1',
};

// ── Replacement battery part number lookup ────────────────────────────────────
// Keyed on substrings of the SNMP model string (lowercase). First match wins.
// Only fills in the part_number field if it is currently blank -- never overwrites.
const BATTERY_PART_LOOKUP = [
  // APC Smart-UPS SRT (Online)
  { match: 'srt1000',  part: 'APCRBC155' },
  { match: 'srt1500',  part: 'APCRBC155' },
  { match: 'srt2200',  part: 'APCRBC141' },
  { match: 'srt3000',  part: 'APCRBC140' },
  { match: 'srt5000',  part: 'APCRBC140' },
  { match: 'srt6000',  part: 'APCRBC140' },
  { match: 'srt8000',  part: 'APCRBC140' },
  { match: 'srt10000', part: 'APCRBC140' },
  // APC Smart-UPS (line-interactive, "Smart-UPS NNNN" model string from older NMC)
  { match: 'smart-ups 750',  part: 'APCRBC123' },
  { match: 'smart-ups 1000', part: 'APCRBC123' },
  { match: 'smart-ups 1500', part: 'APCRBC115' },
  { match: 'smart-ups 2200', part: 'APCRBC117' },
  { match: 'smart-ups 3000', part: 'APCRBC117' },
  { match: 'smart-ups 5000', part: 'APCRBC140' },
  // APC Smart-UPS SMT
  { match: 'smt750',   part: 'APCRBC123' },
  { match: 'smt1000',  part: 'APCRBC123' },
  { match: 'smt1500',  part: 'APCRBC115' },
  { match: 'smt2200',  part: 'APCRBC117' },
  { match: 'smt3000',  part: 'APCRBC117' },
  // APC Smart-UPS SMX
  { match: 'smx750',   part: 'APCRBC116' },
  { match: 'smx1000',  part: 'APCRBC116' },
  { match: 'smx1500',  part: 'APCRBC116' },
  { match: 'smx2000',  part: 'APCRBC130' },
  // APC Smart-UPS SUA/SURT (Online)
  { match: 'surt3000', part: 'APCRBC140' },
  { match: 'surt5000', part: 'APCRBC140' },
  { match: 'surt6000', part: 'APCRBC140' },
  // Tripp Lite SmartOnline
  { match: 'su2200rtxlcd2u', part: 'RBC94-2U' },
  { match: 'su1500rtxlcd2u', part: 'RBC59-2U' },
  { match: 'su3000rtxlcd2u', part: 'RBC94-2U' },
  { match: 'su750rt2u',      part: 'RBC25-2U' },
  { match: 'su1000rt2u',     part: 'RBC93-2U' },
  // Tripp Lite SmartPro
  { match: 'smart2200rm2u',  part: 'RBC94-2U' },
  { match: 'smart1500rm2u',  part: 'RBC93-2U' },
  { match: 'smart3000rm2u',  part: 'RBC105-2U' },
];

function lookupPartNumber(modelSnmp) {
  if (!modelSnmp) return null;
  const lower = modelSnmp.toLowerCase().replace(/[\s-]/g, '');
  for (const entry of BATTERY_PART_LOOKUP) {
    if (lower.includes(entry.match.toLowerCase().replace(/[\s-]/g, ''))) {
      return entry.part;
    }
  }
  return null;
}

const APC_BATT_STATUS    = { 1:'unknown', 2:'batteryNormal', 3:'batteryLow', 4:'batteryInFaultCondition' };
const CYBER_BATT_STATUS  = { 1:'unknown', 2:'batteryNormal', 3:'batteryLow', 4:'batteryDepleted' };
const TL_BATT_STATUS     = { 1:'unknown', 2:'batteryNormal', 3:'batteryLow', 4:'batteryDepleted' };

// ── SNMP session builder ──────────────────────────────────────────────────────

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
      port:       cfg.port       || 161,
      timeout:    cfg.timeout_ms || 5000,
      retries:    cfg.retries    ?? 1,
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

// ── Vendor detection ──────────────────────────────────────────────────────────

function detectVendor(device) {
  const desc = (device.model || '').toLowerCase();
  if (desc.includes('eaton') || desc.includes('powerware') || desc.includes('mg')) return 'eaton';
  if (desc.includes('cyber')) return 'cyber';
  if (desc.includes('tripp') || desc.includes('tripplite') || desc.includes('triplite')) return 'tripplite';
  return 'apc';
}

// ── OID list per vendor ───────────────────────────────────────────────────────

function oidListForVendor(vendor) {
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
    return [OID.sysDescr, OID.sysName,
      OID.tlBattCapacity, OID.tlBattStatus, OID.tlBattRunTime, OID.tlBattTemp,
      OID.tlInputVoltage, OID.tlOutputVoltage, OID.tlOutputLoad,
      OID.tlModel, OID.tlSerial, OID.tlFirmware,
      OID.tlLastReplaceDate, OID.tlNextReplaceDate,
      OID.rfc1628BattCapacity, OID.rfc1628BattStatus, OID.rfc1628BattRunTime,
      OID.rfc1628BattTemp, OID.rfc1628InputVoltage, OID.rfc1628OutputVoltage,
      OID.rfc1628OutputLoad];
  }
  // APC (default)
  return [OID.sysDescr, OID.sysName,
    OID.apcBattCapacity, OID.apcBattStatus, OID.apcBattTempC,
    OID.apcBattRunTime, OID.apcBattReplaceDate,
    OID.apcInputVoltage, OID.apcOutputVoltage, OID.apcOutputLoad,
    OID.apcModel, OID.apcSerial, OID.apcFirmware];
}

// ── Parse varbinds into normalised result object ──────────────────────────────

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
    // NMC5/PADM20 confirmed OIDs. Voltages in tenths (1130=113.0V), runtime in seconds.
    // Fall back to RFC 1628 if LX Platform OIDs don't respond.
    const tlCap = getInt(OID.tlBattCapacity);
    const batt_capacity = tlCap ?? getInt(OID.rfc1628BattCapacity);

    // Status: NMC5 returns 0=normal (non-standard). RFC 1628 uses 1-4.
    const tlSi  = getInt(OID.tlBattStatus);
    const rfcSi = getInt(OID.rfc1628BattStatus);
    let batt_status = null;
    if (tlSi !== null) {
      // NMC5: 0=normal, non-zero=abnormal
      batt_status = tlSi === 0 ? 'batteryNormal' : 'batteryLow';
    } else if (rfcSi !== null) {
      batt_status = TL_BATT_STATUS[rfcSi] || String(rfcSi);
    }

    // Runtime: LX Platform in seconds, RFC 1628 in TimeTicks (hundredths of a second)
    const tlRt  = getInt(OID.tlBattRunTime);
    const rfcRt = getInt(OID.rfc1628BattRunTime);
    const batt_run_time = tlRt !== null
      ? Math.floor(tlRt / 60)
      : rfcRt !== null ? Math.floor(rfcRt / 6000) : null;

    // Temperature: NMC5 returns tenths of degrees (599 = 59.9F = ~15.5C... or just 59.9C?)
    // 599 seems too high for C, likely tenths: 59.9F = 15.5C. Divide by 10.
    const tlTempRaw = getInt(OID.tlBattTemp);
    const batt_temperature = tlTempRaw !== null
      ? Math.round(tlTempRaw / 10)
      : getInt(OID.rfc1628BattTemp);

    // Voltages: NMC5 in tenths of volts (1130 = 113.0V)
    const tlInV  = getInt(OID.tlInputVoltage);
    const tlOutV = getInt(OID.tlOutputVoltage);

    // Replace date: NMC5 returns ISO date strings directly
    const batt_replace_date = get(OID.tlNextReplaceDate) || null;

    return {
      batt_capacity,
      batt_status,
      batt_temperature,
      batt_run_time,
      batt_replace_date,
      input_voltage:  tlInV  !== null ? Math.round(tlInV  / 10) : getInt(OID.rfc1628InputVoltage),
      output_voltage: tlOutV !== null ? Math.round(tlOutV / 10) : getInt(OID.rfc1628OutputVoltage),
      output_load:    getInt(OID.tlOutputLoad) ?? getInt(OID.rfc1628OutputLoad),
      model_snmp:  get(OID.tlModel) || get(OID.sysDescr),
      serial_snmp: get(OID.tlSerial),
      firmware:    get(OID.tlFirmware),
      // Not saved to poll_results -- used by poller to auto-fill device.battery_installed
      battery_installed_snmp: get(OID.tlLastReplaceDate) || null,
    };
  }

  if (vendor === 'eaton') {
    const rt = getInt(OID.eatonBattRunTime);
    return {
      batt_capacity:    getInt(OID.eatonBattCapacity),
      batt_status:      null,
      batt_temperature: getInt(OID.eatonBattTemp),
      batt_run_time:    rt !== null ? Math.floor(rt / 60) : null,
      batt_replace_date: null,
      input_voltage:    getInt(OID.eatonInputVoltage),
      output_voltage:   getInt(OID.eatonOutputVoltage),
      output_load:      getInt(OID.eatonOutputLoad),
      model_snmp:       get(OID.sysDescr),
      serial_snmp:      null,
      firmware:         null,
    };
  }

  if (vendor === 'cyber') {
    const si = getInt(OID.cyberBattStatus);
    const rt = getInt(OID.cyberBattRunTime);
    return {
      batt_capacity:    getInt(OID.cyberBattCapacity),
      batt_status:      si !== null ? (CYBER_BATT_STATUS[si] || String(si)) : null,
      batt_temperature: getInt(OID.cyberBattTemp),
      batt_run_time:    rt !== null ? Math.floor(rt / 60) : null,
      batt_replace_date: null,
      input_voltage:    getInt(OID.cyberInputVoltage),
      output_voltage:   getInt(OID.cyberOutputVoltage),
      output_load:      getInt(OID.cyberOutputLoad),
      model_snmp:       get(OID.cyberModel) || get(OID.sysDescr),
      serial_snmp:      get(OID.cyberSerial),
      firmware:         null,
    };
  }

  // APC (default)
  const si = getInt(OID.apcBattStatus);
  const rt = getInt(OID.apcBattRunTime);
  return {
    batt_capacity:    getInt(OID.apcBattCapacity),
    batt_status:      si !== null ? (APC_BATT_STATUS[si] || String(si)) : null,
    batt_temperature: getInt(OID.apcBattTempC),
    batt_run_time:    rt !== null ? Math.floor(rt / 6000) : null,
    batt_replace_date: get(OID.apcBattReplaceDate) || null,
    input_voltage:    getInt(OID.apcInputVoltage),
    output_voltage:   getInt(OID.apcOutputVoltage),
    output_load:      getInt(OID.apcOutputLoad),
    model_snmp:       get(OID.apcModel) || get(OID.sysDescr),
    serial_snmp:      get(OID.apcSerial),
    firmware:         get(OID.apcFirmware),
  };
}

// ── SNMP session factory ──────────────────────────────────────────────────────

function createSnmpSession(device, cfg, version) {
  const vendor = detectVendor(device);
  if (version === 'v1' || version === 'v2c') {
    const snmpVer = version === 'v1' ? snmp.Version1 : snmp.Version2c;
    return snmp.createSession(device.ip, cfg.community || 'public', {
      version:  snmpVer,
      port:     cfg.port      || 161,
      timeout:  cfg.timeout_ms || 5000,
      retries:  cfg.retries   ?? 1,
    });
  }
  // v3
  const { sessionOpts, userOpts } = buildSnmpV3Options(cfg);
  if (vendor === 'tripplite') sessionOpts.context = '';
  return snmp.createV3Session(device.ip, userOpts, sessionOpts);
}

function trySnmpGet(device, cfg, oids, version) {
  return new Promise((resolve) => {
    let session;
    try {
      session = createSnmpSession(device, cfg, version);
    } catch (err) {
      resolve({ ok: false, error: err.message });
      return;
    }
    const cleanup = () => { try { session.close(); } catch (_) {} };
    session.get(oids, (err, varbinds) => {
      cleanup();
      if (err) { resolve({ ok: false, error: err.message }); return; }
      resolve({ ok: true, varbinds });
    });
  });
}

// ── Poll a single device ──────────────────────────────────────────────────────

async function pollDevice(device, cfg) {
  const vendor  = detectVendor(device);
  const oids    = oidListForVendor(vendor);
  const setting = device.snmp_version || 'auto';

  // Build list of versions to try in order
  let versions;
  if (setting === 'auto') {
    versions = ['v3', 'v2c', 'v1'];
  } else {
    versions = [setting];
  }

  for (const version of versions) {
    const result = await trySnmpGet(device, cfg, oids, version);

    if (result.ok) {
      // Success -- if we were in auto mode and had to fall back, save the discovered version
      if (setting === 'auto' && version !== 'v3') {
        setDiscoveredSnmpVersion(device.id, version);
        console.log(`[poller] ${device.name}: discovered SNMP ${version}, saved for future polls`);
      }
      try {
        return { reachable: true, ...parseVarbinds(result.varbinds, vendor) };
      } catch (parseErr) {
        return { reachable: false, raw_error: 'Parse error: ' + parseErr.message };
      }
    }

    // Only fall back on authentication/access errors.
    // Timeouts mean the device is unreachable -- no point trying other versions.
    const isAuthError = result.error && (
      result.error.includes('Wrong Digest') ||
      result.error.includes('Unknown User Name') ||
      result.error.includes('Unknown Security Name') ||
      result.error.includes('Authorization Error') ||
      result.error.includes('Authentication')
    );

    const isLastVersion = version === versions[versions.length - 1];

    if (isLastVersion || !isAuthError) {
      // Timeout or last fallback -- give up
      return { reachable: false, raw_error: result.error };
    }

    // Auth error on v3 -- worth trying v2c/v1 since credentials differ
    console.log(`[poller] ${device.name}: SNMP ${version} auth failed, trying fallback...`);
  }

  return { reachable: false, raw_error: 'All SNMP versions failed' };
}

// ── Poll cycle ────────────────────────────────────────────────────────────────

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
      if (data.reachable && data.model_snmp) {
        const part = lookupPartNumber(data.model_snmp);
        if (part) autoFillPartNumber(device.id, part);
      }
      if (data.reachable && data.battery_installed_snmp) {
        autoFillBatteryInstalled(device.id, data.battery_installed_snmp);
      }
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
  console.log(`[poller] Started -- interval ${interval / 1000}s`);
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
    if (data.reachable && data.model_snmp) {
      const part = lookupPartNumber(data.model_snmp);
      if (part) autoFillPartNumber(device.id, part);
    }
    if (data.reachable && data.battery_installed_snmp) {
      autoFillBatteryInstalled(device.id, data.battery_installed_snmp);
    }
    broadcast('poll_complete', [{ device_id: device.id, device_name: device.name, ...data }]);
    return data;
  });
}

module.exports = { startPoller, stopPoller, restartPoller, pollSingleDevice, registerWsClient, unregisterWsClient };
