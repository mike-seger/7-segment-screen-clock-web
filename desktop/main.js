const { app, BrowserWindow, powerMonitor, ipcMain } = require('electron');
const path = require('path');
const express = require('express');
const cors = require('cors');
const dgram = require('dgram');
const ip = require('ip');
const http = require('http');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');

const SERVER_START_MS = Date.now();
const GIT_COMMIT = (() => {
  try { return execSync('git rev-parse --short HEAD', { cwd: path.join(__dirname, '..'), timeout: 2000 }).toString().trim(); }
  catch (_) { return 'unknown'; }
})();
const BUILD_TIME = (() => {
  try { return execSync('git log -1 --format=%cI HEAD', { cwd: path.join(__dirname, '..'), timeout: 2000 }).toString().trim(); }
  catch (_) { return 'unknown'; }
})();
const activityLog = [{ timestampMs: SERVER_START_MS, isAwake: true }];

const BATTERY_BUCKET_MS = 10 * 60 * 1000;
const BATTERY_RETENTION_MS = 8 * 24 * 60 * 60 * 1000;
const BATTERY_MAX_POINTS = Math.floor(BATTERY_RETENTION_MS / BATTERY_BUCKET_MS);
const BATTERY_SAMPLE_INTERVAL_MS = 60 * 1000;
const AUTOMATION_MIN_COMMAND_INTERVAL_MS = 5 * 60 * 1000;

let batteryHistory = [];
let thresholdHistory = [];
let switchStateHistory = [];
let lastBatterySampleBucketMs = 0;
let lastAutomationActionAt = 0;
let lastAutomationAction = '';

function batteryHistoryFilePath() {
  try {
    return path.join(app.getPath('userData'), 'battery_events.json');
  } catch (_) {
    return path.join(__dirname, 'battery_events.json');
  }
}

function batteryThresholdEventsFilePath() {
  try {
    return path.join(app.getPath('userData'), 'battery_threshold_events.json');
  } catch (_) {
    return path.join(__dirname, 'battery_threshold_events.json');
  }
}

function batterySwitchEventsFilePath() {
  try {
    return path.join(app.getPath('userData'), 'battery_switch_events.json');
  } catch (_) {
    return path.join(__dirname, 'battery_switch_events.json');
  }
}

function trimBatteryHistory(nowMs = Date.now()) {
  const cutoff = nowMs - BATTERY_RETENTION_MS;
  batteryHistory = batteryHistory.filter(p => p && Number.isFinite(p.ts) && p.ts >= cutoff);
  if (batteryHistory.length > BATTERY_MAX_POINTS) {
    batteryHistory = batteryHistory.slice(-BATTERY_MAX_POINTS);
  }
}

function trimThresholdHistory(nowMs = Date.now()) {
  const cutoff = nowMs - BATTERY_RETENTION_MS;
  const sorted = thresholdHistory
    .filter(p => p && Number.isFinite(p.ts))
    .sort((a, b) => a.ts - b.ts);
  const firstInWindow = sorted.findIndex(p => p.ts >= cutoff);
  if (firstInWindow <= 0) {
    thresholdHistory = sorted;
    return;
  }
  thresholdHistory = sorted.slice(firstInWindow - 1);
}

function trimSwitchStateHistory(nowMs = Date.now()) {
  const cutoff = nowMs - BATTERY_RETENTION_MS;
  const sorted = switchStateHistory
    .filter(p => p && Number.isFinite(p.ts) && (p.on === 0 || p.on === 1))
    .sort((a, b) => a.ts - b.ts);
  const firstInWindow = sorted.findIndex(p => p.ts >= cutoff);
  if (firstInWindow <= 0) {
    switchStateHistory = sorted;
    return;
  }
  switchStateHistory = sorted.slice(firstInWindow - 1);
}

function writeJsonFileSafe(filePath, value) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(value), 'utf8');
  } catch (err) {
    console.warn('[DESKTOP] Failed to write', filePath, err && err.message ? err.message : err);
  }
}

function loadBatteryPersistence() {
  try {
    const raw = fs.readFileSync(batteryHistoryFilePath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      batteryHistory = parsed
        .map(p => ({ ts: Number(p.ts), battery: Number(p.battery) }))
        .filter(p => Number.isFinite(p.ts) && Number.isFinite(p.battery));
    }
  } catch (_) {}
  try {
    const raw = fs.readFileSync(batteryThresholdEventsFilePath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      thresholdHistory = parsed
        .map(p => ({
          ts: Number(p.ts),
          thresholdOnPct: Number(p.thresholdOnPct),
          thresholdOffPct: Number(p.thresholdOffPct)
        }))
        .filter(p => Number.isFinite(p.ts) && Number.isFinite(p.thresholdOnPct) && Number.isFinite(p.thresholdOffPct));
    }
  } catch (_) {}
  try {
    const raw = fs.readFileSync(batterySwitchEventsFilePath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      switchStateHistory = parsed
        .map(p => ({ ts: Number(p.ts), on: Number(p.on) ? 1 : 0 }))
        .filter(p => Number.isFinite(p.ts));
    }
  } catch (_) {}
  trimBatteryHistory();
  trimThresholdHistory();
  trimSwitchStateHistory();
}

function persistBatteryHistory() {
  trimBatteryHistory();
  writeJsonFileSafe(batteryHistoryFilePath(), batteryHistory);
}

function persistThresholdHistory() {
  trimThresholdHistory();
  writeJsonFileSafe(batteryThresholdEventsFilePath(), thresholdHistory);
}

function persistSwitchStateHistory() {
  trimSwitchStateHistory();
  writeJsonFileSafe(batterySwitchEventsFilePath(), switchStateHistory);
}

function clampPct(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function parseBatterySettingsObject(src) {
  const fallback = { enabled: false, switchIp: '', thresholdOnPct: 40, thresholdOffPct: 85 };
  const input = (src && typeof src === 'object') ? src : {};
  let thresholdOnPct = clampPct(input.thresholdOnPct, fallback.thresholdOnPct);
  let thresholdOffPct = clampPct(input.thresholdOffPct, fallback.thresholdOffPct);
  if (thresholdOnPct >= thresholdOffPct) {
    thresholdOnPct = Math.max(0, thresholdOffPct - 1);
  }
  return {
    enabled: !!input.enabled,
    switchIp: String(input.switchIp || '').trim(),
    thresholdOnPct,
    thresholdOffPct
  };
}

function getBatterySettingsFromState() {
  const fallback = { enabled: false, switchIp: '', thresholdOnPct: 40, thresholdOffPct: 85 };
  try {
    const explicitRaw = systemState['screenClock_batteryAutomation'];
    if (explicitRaw) {
      const explicitParsed = typeof explicitRaw === 'string' ? JSON.parse(explicitRaw) : explicitRaw;
      return parseBatterySettingsObject(explicitParsed);
    }

    const raw = systemState['screenClock_state'];
    if (!raw) return fallback;
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const src = (parsed && typeof parsed === 'object' && parsed.batterySettings && typeof parsed.batterySettings === 'object')
      ? parsed.batterySettings
      : {};
    return parseBatterySettingsObject(src);
  } catch (_) {
    return fallback;
  }
}

function hasPersistedBatterySettingsInState() {
  try {
    const explicitRaw = systemState['screenClock_batteryAutomation'];
    if (explicitRaw) {
      const explicitParsed = typeof explicitRaw === 'string' ? JSON.parse(explicitRaw) : explicitRaw;
      return Number.isFinite(Number(explicitParsed && explicitParsed.thresholdOnPct))
        && Number.isFinite(Number(explicitParsed && explicitParsed.thresholdOffPct));
    }

    const raw = systemState['screenClock_state'];
    if (!raw) return false;
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const bs = parsed && typeof parsed === 'object' ? parsed.batterySettings : null;
    if (!bs || typeof bs !== 'object') return false;
    return Number.isFinite(Number(bs.thresholdOnPct))
      && Number.isFinite(Number(bs.thresholdOffPct));
  } catch (_) {
    return false;
  }
}

function recordThresholdSnapshot(settings, nowMs = Date.now()) {
  if (!settings) return;
  if (!hasPersistedBatterySettingsInState()) return;
  const next = {
    ts: nowMs,
    thresholdOnPct: clampPct(settings.thresholdOnPct, 40),
    thresholdOffPct: clampPct(settings.thresholdOffPct, 85)
  };
  if (next.thresholdOnPct >= next.thresholdOffPct) {
    next.thresholdOnPct = Math.max(0, next.thresholdOffPct - 1);
  }
  const prev = thresholdHistory[thresholdHistory.length - 1];
  if (prev && prev.thresholdOnPct === next.thresholdOnPct && prev.thresholdOffPct === next.thresholdOffPct) {
    return;
  }
  thresholdHistory.push(next);
  trimThresholdHistory(nowMs);
  persistThresholdHistory();
}

function sampleSelfBattery(nowMs = Date.now(), forcePoint = false) {
  const level = getSelfBattery();
  if (!Number.isFinite(level) || level < 0) return;
  const bucketMs = Math.floor(nowMs / BATTERY_BUCKET_MS) * BATTERY_BUCKET_MS;
  if (!forcePoint && bucketMs === lastBatterySampleBucketMs) return;
  lastBatterySampleBucketMs = bucketMs;
  const sampleTs = forcePoint ? nowMs : bucketMs;
  batteryHistory.push({ ts: sampleTs, battery: clampPct(level, 0) });
  trimBatteryHistory(nowMs);
  persistBatteryHistory();
}

function normalizeSwitchHost(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  try {
    if (raw.startsWith('http://') || raw.startsWith('https://')) {
      const u = new URL(raw);
      return u.host;
    }
  } catch (_) {}
  return raw.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

function tasmotaCommand(hostInput, command) {
  return new Promise((resolve, reject) => {
    const host = normalizeSwitchHost(hostInput);
    if (!host) {
      reject(new Error('Missing switch host'));
      return;
    }
    const options = {
      host,
      path: `/cm?cmnd=${encodeURIComponent(command)}`,
      method: 'GET',
      timeout: 4000
    };
    const req = http.request(options, (resp) => {
      let body = '';
      resp.setEncoding('utf8');
      resp.on('data', (chunk) => { body += chunk; });
      resp.on('end', () => {
        if (resp.statusCode && resp.statusCode >= 400) {
          reject(new Error(`Tasmota HTTP ${resp.statusCode}`));
          return;
        }
        try {
          const parsed = JSON.parse(body || '{}');
          resolve(parsed);
        } catch (_) {
          resolve({ raw: body });
        }
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error('Tasmota timeout'));
    });
    req.on('error', reject);
    req.end();
  });
}

function normalizePowerPayload(payload) {
  const pick = payload && (payload.POWER ?? payload.Power ?? payload.power);
  if (typeof pick === 'string') {
    const up = pick.toUpperCase();
    if (up === 'ON' || up === 'OFF') return up;
  }
  if (pick === 1 || pick === true) return 'ON';
  if (pick === 0 || pick === false) return 'OFF';
  return null;
}

function recordSwitchState(power, nowMs = Date.now()) {
  const on = String(power || '').toUpperCase() === 'ON' ? 1 : 0;
  const prev = switchStateHistory[switchStateHistory.length - 1];
  if (prev && prev.on === on) return;
  switchStateHistory.push({ ts: nowMs, on });
  trimSwitchStateHistory(nowMs);
  persistSwitchStateHistory();
}

async function evaluateBatteryAutomation() {
  const settings = getBatterySettingsFromState();
  recordThresholdSnapshot(settings);
  sampleSelfBattery();
  if (!settings.enabled || !settings.switchIp) return;
  const battery = getSelfBattery();
  if (!Number.isFinite(battery) || battery < 0) return;

  let desiredAction = '';
  if (battery >= settings.thresholdOffPct) desiredAction = 'off';
  else if (battery <= settings.thresholdOnPct) desiredAction = 'on';
  if (!desiredAction) return;

  const desiredPower = desiredAction === 'on' ? 'ON' : 'OFF';
  let currentPower = null;
  try {
    const currentRaw = await tasmotaCommand(settings.switchIp, 'Power');
    currentPower = normalizePowerPayload(currentRaw);
    if (currentPower) recordSwitchState(currentPower);
    if (currentPower === desiredPower) return;
  } catch (_) {
    // Non-fatal: fall back to command path below.
  }

  const now = Date.now();
  const sameActionCooldown = desiredAction === lastAutomationAction
    && (now - lastAutomationActionAt) < AUTOMATION_MIN_COMMAND_INTERVAL_MS;
  if (sameActionCooldown && (currentPower == null || currentPower === desiredPower)) {
    return;
  }

  try {
    const raw = await tasmotaCommand(settings.switchIp, desiredAction === 'on' ? 'Power On' : 'Power Off');
    const power = normalizePowerPayload(raw) || desiredPower;
    recordSwitchState(power);
    lastAutomationAction = desiredAction;
    lastAutomationActionAt = now;
  } catch (err) {
    console.warn('[DESKTOP] Battery automation command failed:', err && err.message ? err.message : err);
  }
}

function buildBatterySeries(bucketZeroMs, bucketCount, bucketMs) {
  const sorted = batteryHistory.slice().sort((a, b) => a.ts - b.ts);
  const out = new Array(bucketCount).fill(null);
  if (!sorted.length) return out;
  let idx = 0;
  let last = null;
  while (idx < sorted.length && sorted[idx].ts < bucketZeroMs) {
    last = sorted[idx].battery;
    idx++;
  }
  for (let i = 0; i < bucketCount; i++) {
    const t = bucketZeroMs + i * bucketMs;
    while (idx < sorted.length && sorted[idx].ts <= t) {
      last = sorted[idx].battery;
      idx++;
    }
    out[i] = Number.isFinite(last) ? last : null;
  }
  return out;
}

function buildThresholdSeries(bucketZeroMs, bucketCount, bucketMs, field, fallback) {
  const sorted = thresholdHistory.slice().sort((a, b) => a.ts - b.ts);
  const out = new Array(bucketCount).fill(fallback);
  let idx = 0;
  let last = fallback;
  while (idx < sorted.length && sorted[idx].ts < bucketZeroMs) {
    const v = Number(sorted[idx][field]);
    if (Number.isFinite(v)) last = v;
    idx++;
  }
  for (let i = 0; i < bucketCount; i++) {
    const t = bucketZeroMs + i * bucketMs;
    while (idx < sorted.length && sorted[idx].ts <= t) {
      const v = Number(sorted[idx][field]);
      if (Number.isFinite(v)) last = v;
      idx++;
    }
    out[i] = last;
  }
  return out;
}

function buildSwitchSeries(bucketZeroMs, bucketCount, bucketMs) {
  const sorted = switchStateHistory.slice().sort((a, b) => a.ts - b.ts);
  const out = new Array(bucketCount).fill(0);
  let idx = 0;
  let last = 0;
  while (idx < sorted.length && sorted[idx].ts < bucketZeroMs) {
    last = sorted[idx].on ? 1 : 0;
    idx++;
  }
  for (let i = 0; i < bucketCount; i++) {
    const t = bucketZeroMs + i * bucketMs;
    while (idx < sorted.length && sorted[idx].ts <= t) {
      last = sorted[idx].on ? 1 : 0;
      idx++;
    }
    out[i] = last;
  }
  return out;
}

loadBatteryPersistence();
sampleSelfBattery();

function trimActivityLog() {
  const cutoff = Date.now() - BATTERY_RETENTION_MS;
  const firstKeep = activityLog.findIndex(e => e.timestampMs > cutoff);
  if (firstKeep > 1) activityLog.splice(0, firstKeep - 1);
}

function computeDesktopAwakeFraction(bucketStart, bucketEnd) {
  if (!activityLog.length) return 0;
  let stateAtStart = false;
  for (const ev of activityLog) {
    if (ev.timestampMs <= bucketStart) stateAtStart = ev.isAwake; else break;
  }
  let segStart = bucketStart, currentState = stateAtStart, awakeDuration = 0;
  for (const ev of activityLog) {
    if (ev.timestampMs <= bucketStart) continue;
    if (ev.timestampMs >= bucketEnd) break;
    if (currentState) awakeDuration += ev.timestampMs - segStart;
    segStart = ev.timestampMs;
    currentState = ev.isAwake;
  }
  if (currentState) awakeDuration += bucketEnd - segStart;
  return awakeDuration / (bucketEnd - bucketStart);
}

function fmtBuildTime(iso) {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const p = n => n < 10 ? '0' + n : '' + n;
    return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  } catch (_) { return iso; }
}

function fmtUptime(ms) {
  const totalS = Math.floor(ms / 1000), m = Math.floor(totalS / 60) % 60, h = Math.floor(totalS / 3600) % 24, d = Math.floor(totalS / 86400);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${totalS % 60}s`;
}

let mainWindow;
const EXPRESS_PORT = 8080;
const UDP_PORT = 8766;
const MULTICAST_ADDR = '255.255.255.255';
const HOST_IP = ip.address();
const HOST_MAC = getMacForIp(HOST_IP);

// Memory store for discovered clocks: { url: { name, url, lastSeen, battery, milliWatts, isAsleep, ipAddress, macAddress } }
const discoveredClocks = {};

function normalizeMacAddress(raw) {
  if (typeof raw !== 'string') return '';
  const normalized = raw.trim().replace(/-/g, ':').toUpperCase();
  if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(normalized)) return '';
  if (normalized === '00:00:00:00:00:00') return '';
  return normalized;
}

function getBroadcastTargets() {
  const targets = new Set([MULTICAST_ADDR]);
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || entry.family !== 'IPv4' || entry.internal || !entry.address) continue;
      if (typeof entry.broadcast === 'string' && entry.broadcast) {
        targets.add(entry.broadcast);
        continue;
      }
      if (!entry.netmask) continue;
      const ipParts = entry.address.split('.').map((part) => Number(part));
      const maskParts = entry.netmask.split('.').map((part) => Number(part));
      if (ipParts.length !== 4 || maskParts.length !== 4 || ipParts.some(Number.isNaN) || maskParts.some(Number.isNaN)) continue;
      const broadcastParts = ipParts.map((part, index) => ((part & maskParts[index]) | (~maskParts[index] & 255)) & 255);
      targets.add(broadcastParts.join('.'));
    }
  }
  return Array.from(targets);
}

function getMacForIp(targetIp) {
  try {
    const interfaces = os.networkInterfaces() || {};
    let fallbackMac = '';
    for (const entries of Object.values(interfaces)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (!entry || entry.internal) continue;
        const mac = normalizeMacAddress(entry.mac || '');
        if (!fallbackMac && mac) fallbackMac = mac;
        if (entry.family === 'IPv4' && entry.address === targetIp && mac) {
          return mac;
        }
      }
    }
    return fallbackMac;
  } catch (_) {
    return '';
  }
}

function extractHostFromUrl(urlString) {
  if (typeof urlString !== 'string' || !urlString) return '';
  try {
    return new URL(urlString).hostname || '';
  } catch (_) {
    return '';
  }
}

// SSE clients for /api/events
const sseClients = new Set();

function broadcastClocksUpdate() {
  const msg = Buffer.from('event: clocks\ndata: \n\n');
  for (const res of sseClients) {
    try { res.write(msg); } catch (_) { sseClients.delete(res); }
  }
}

// Return own battery percentage (0-100) or -1 if unavailable.
function getSelfBattery() {
  try {
    const status = powerMonitor.getSystemIdleState ? powerMonitor : null;
    if (status && typeof powerMonitor.getCurrentPowerSourceType === 'function') {
      // Electron >= 22 exposes getBatteryStatus() on powerMonitor in some builds;
      // fall back to -1 if not available.
    }
    // powerMonitor.getBatteryLevel() is available in Electron >= 31 (returns 0-1 float)
    if (typeof powerMonitor.getBatteryLevel === 'function') {
      const level = powerMonitor.getBatteryLevel();
      return Math.round(level * 100);
    }
  } catch (_) {}
  return -1;
}

// Express server Setup
const expressApp = express();
expressApp.use(cors());
// Presence history/state snapshots can exceed the default 100kb parser limit.
expressApp.use(express.json({ limit: '8mb' }));

// In memory state
let systemState = {};

// Per-client UI keys that must never live in server state — they describe a
// single browser's local navigation and would otherwise be broadcast back to
// other clients via snapshot/SSE and yank their open tab/position.
const PER_CLIENT_UI_KEYS = new Set([
  'screenClock_selectedTab',
  'screenClock_menuPosition',
  'screenClock_menuOpen'
]);

const PER_DEVICE_KEYS = new Set([
  'screenClock_batteryAutomation',
  'screenClock_batterySettings',
  'screenClock_presenceSettings',
  'screenClock_presenceNativeStatus'
]);

function getPublicStateSnapshot() {
  const snapshot = { ...systemState };
  for (const k of PER_CLIENT_UI_KEYS) delete snapshot[k];
  for (const k of PER_DEVICE_KEYS) delete snapshot[k];
  if (snapshot.screenClock_state) {
    try {
      const parsed = typeof snapshot.screenClock_state === 'string'
        ? JSON.parse(snapshot.screenClock_state)
        : snapshot.screenClock_state;
      if (parsed && typeof parsed === 'object') {
        delete parsed.batterySettings;
        delete parsed.presenceSettings;
        snapshot.screenClock_state = JSON.stringify(parsed);
      }
    } catch (_) {}
  }
  return snapshot;
}

let calculatedOffsetMs = 0;
let lastNtpSyncTime = 0;
let lastP2pSyncTime = 0;
const NTP_SYNC_INTERVAL = 300000; // 5 minutes standard NTP sync
const P2P_SYNC_INTERVAL = 2000;   // 2 seconds P2P sync

// Handle state synchronisation endpoints
expressApp.get('/api/state', (req, res) => {
  // Scrub per-client UI keys defensively in case any historical value leaked in.
  for (const k of PER_CLIENT_UI_KEYS) {
    if (k in systemState) delete systemState[k];
  }
  res.json(getPublicStateSnapshot());
});

expressApp.post('/api/state', (req, res) => {
  const { key, value } = req.body;
  if (key) {
    if (PER_CLIENT_UI_KEYS.has(key)) {
      // Never store per-client UI navigation keys on the server.
      delete systemState[key];
      res.json({ success: true, ignored: true });
      return;
    }
      if (value === null) {
      delete systemState[key];
    } else {
        let nextValue = value;
        if (key === 'screenClock_state' && typeof value === 'string') {
          try {
            const parsed = JSON.parse(value);
            if (parsed && typeof parsed === 'object') {
              delete parsed.batterySettings;
              delete parsed.presenceSettings;
              nextValue = JSON.stringify(parsed);
            }
          } catch (_) {}
        }
        systemState[key] = nextValue;
    }
    if (key === "screenClock_timeMasterUrl" || key === "screenClock_ntpServer") {
      lastNtpSyncTime = 0;
      lastP2pSyncTime = 0;
    }
    if (key === 'screenClock_state') {
      recordThresholdSnapshot(getBatterySettingsFromState());
    }
  }
  res.json({ success: true });
});

expressApp.get('/api/clocks', (req, res) => {
  const currentTime = Date.now();
  const clocksList = [];

  // Add self
  clocksList.push({
    name: `macOS Clock (${HOST_IP})`,
    url: `http://${HOST_IP}:${EXPRESS_PORT}`,
    isSelf: true,
    battery: getSelfBattery(),
    ipAddress: HOST_IP,
    macAddress: HOST_MAC,
    isAsleep: false
  });

  // Add others
  for (const url in discoveredClocks) {
    if (discoveredClocks[url].lastSeen > currentTime - 12000) { // 12 second expiration threshold
      clocksList.push({
        name: discoveredClocks[url].name,
        url: discoveredClocks[url].url,
        isSelf: false,
        battery: typeof discoveredClocks[url].battery === 'number' ? discoveredClocks[url].battery : -1,
        milliWatts: typeof discoveredClocks[url].milliWatts === 'number' ? discoveredClocks[url].milliWatts : -1,
        ipAddress: discoveredClocks[url].ipAddress || extractHostFromUrl(discoveredClocks[url].url),
        macAddress: normalizeMacAddress(discoveredClocks[url].macAddress || ''),
        isAsleep: !!discoveredClocks[url].isAsleep
      });
    } else {
      delete discoveredClocks[url];
    }
  }

  res.json(clocksList);
});

expressApp.post('/api/wake', (req, res) => {
  activityLog.push({ timestampMs: Date.now(), isAwake: true });
  trimActivityLog();
  if (process.platform === 'darwin') {
    const { exec } = require('child_process');
    exec('caffeinate -u -t 2', (err) => {
      if (err) console.error('Failed to wake screen on macOS:', err);
    });
  }
  broadcastClocksUpdate();
  res.json({ ok: true });
});

expressApp.post('/api/sleep', (req, res) => {
  activityLog.push({ timestampMs: Date.now(), isAwake: false });
  trimActivityLog();
  if (process.platform === 'darwin') {
    const { exec } = require('child_process');
    exec('pmset displaysleepnow', (err) => {
      if (err) console.error('Failed to put screen to sleep on macOS:', err);
    });
  }
  broadcastClocksUpdate();
  res.json({ ok: true });
});

expressApp.get('/api/battery-switch/state', async (req, res) => {
  const host = String(req.query.ip || '').trim();
  if (!host) {
    res.status(400).json({ ok: false, error: 'Missing ip query parameter' });
    return;
  }
  try {
    const raw = await tasmotaCommand(host, 'Power');
    const power = normalizePowerPayload(raw);
    if (power) recordSwitchState(power);
    res.json({ ok: true, power, raw });
  } catch (err) {
    res.status(502).json({ ok: false, error: err && err.message ? err.message : 'Switch query failed' });
  }
});

expressApp.post('/api/battery-switch/on', async (req, res) => {
  const host = String(req.body && req.body.ip ? req.body.ip : '').trim();
  if (!host) {
    res.status(400).json({ ok: false, error: 'Missing ip in request body' });
    return;
  }
  try {
    const raw = await tasmotaCommand(host, 'Power On');
    const power = normalizePowerPayload(raw) || 'ON';
    recordSwitchState(power);
    // Reset automation rate-limit tracker so next automation cycle can correct state if needed
    lastAutomationActionAt = 0;
    res.json({ ok: true, power, raw });
  } catch (err) {
    res.status(502).json({ ok: false, error: err && err.message ? err.message : 'Switch ON failed' });
  }
});

expressApp.post('/api/battery-switch/off', async (req, res) => {
  const host = String(req.body && req.body.ip ? req.body.ip : '').trim();
  if (!host) {
    res.status(400).json({ ok: false, error: 'Missing ip in request body' });
    return;
  }
  try {
    const raw = await tasmotaCommand(host, 'Power Off');
    const power = normalizePowerPayload(raw) || 'OFF';
    recordSwitchState(power);
    // Reset automation rate-limit tracker so next automation cycle can correct state if needed
    lastAutomationActionAt = 0;
    res.json({ ok: true, power, raw });
  } catch (err) {
    res.status(502).json({ ok: false, error: err && err.message ? err.message : 'Switch OFF failed' });
  }
});

expressApp.post('/api/battery-automation/config', (req, res) => {
  try {
    const settings = parseBatterySettingsObject(req.body || {});
    const payload = JSON.stringify(settings);
    systemState['screenClock_batteryAutomation'] = payload;
    recordThresholdSnapshot(settings);
    res.json({ ok: true, settings });
  } catch (err) {
    res.status(400).json({ ok: false, error: err && err.message ? err.message : 'Invalid payload' });
  }
});

expressApp.post('/api/battery/sample', (req, res) => {
  sampleSelfBattery(Date.now(), true);
  res.json({ ok: true, points: batteryHistory.length });
});

/**
 * GET /api/info
 *
 * Returns device information and an 8-day activity history for one clock node.
 *
 * Response JSON schema:
 * {
 *   brand:          string         — device brand (e.g. "samsung") or OS type for desktop
 *   model:          string         — device model (e.g. "SM-X200") or hostname for desktop
 *   androidVersion: string | null  — Android OS version (e.g. "14"), null on desktop
 *   platform:       string         — OS platform string (e.g. "darwin", "android")
 *   buildTime:      string         — ISO-8601 git commit timestamp of the running build
 *   gitCommit:      string         — short git commit hash of the running build
 *   uptimeMs:       number         — milliseconds since the process / device booted
 *   serverStartMs:  number         — Unix ms when the HTTP server started in this session
 *   nowMs:          number         — server-side Unix ms at response time
 *   chart: {
 *     bucketMs:     number         — duration of each bucket in ms (3 600 000 = 1 h)
 *     bucketZeroMs: number         — Unix ms of the first (oldest) bucket start
 *     appActive:    number[]       — 168 values [0,1]: fraction of each hour the app was running
 *     screenAwake:  number[]       — 168 values [0,1]: fraction of each hour the screen was on
 *   }
 * }
 */
expressApp.get('/api/info', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const now = Date.now();
  const bucketMs = BATTERY_BUCKET_MS;
  const bucketCount = BATTERY_MAX_POINTS;
  const bucketZero = now - (bucketCount - 1) * bucketMs;
  const appActive = [];
  const screenAwake = [];
  for (let i = 0; i < bucketCount; i++) {
    const bs = bucketZero + i * bucketMs;
    const be = bs + bucketMs;
    appActive.push(SERVER_START_MS < be ? (be - Math.max(SERVER_START_MS, bs)) / bucketMs : 0);
    screenAwake.push(computeDesktopAwakeFraction(bs, be));
  }
  sampleSelfBattery(now);
  const batterySettings = getBatterySettingsFromState();
  recordThresholdSnapshot(batterySettings, now);
  const batterySamplesInWindow = batteryHistory
    .filter((p) => p && Number.isFinite(p.ts) && p.ts >= bucketZero && p.ts <= now)
    .sort((a, b) => a.ts - b.ts);
  const batterySampleCount = batterySamplesInWindow.length;
  const batteryFirstSampleMs = batterySampleCount ? batterySamplesInWindow[0].ts : null;
  const batteryLastSampleMs = batterySampleCount ? batterySamplesInWindow[batterySampleCount - 1].ts : null;
  const batterySampleSpanMs = batterySampleCount
    ? Math.max(bucketMs, (batteryLastSampleMs - batteryFirstSampleMs) + bucketMs)
    : 0;
  const battery = buildBatterySeries(bucketZero, bucketCount, bucketMs);
  const thresholdOn = buildThresholdSeries(bucketZero, bucketCount, bucketMs, 'thresholdOnPct', batterySettings.thresholdOnPct);
  const thresholdOff = buildThresholdSeries(bucketZero, bucketCount, bucketMs, 'thresholdOffPct', batterySettings.thresholdOffPct);
  const switchOn = buildSwitchSeries(bucketZero, bucketCount, bucketMs);
  res.json({
    attrs: [
      { label: 'Brand / Model', value: `${os.type()}  /  ${os.hostname()}` },
      { label: 'OS', value: `${process.platform} ${os.release()}` },
      { label: 'IP Address', value: HOST_IP || '-' },
      { label: 'MAC Address', value: HOST_MAC || '-' },
      { label: 'Build', value: fmtBuildTime(BUILD_TIME) },
      { label: 'Git commit', value: GIT_COMMIT },
      { label: 'Uptime', value: fmtUptime(Math.round(process.uptime() * 1000)) }
    ],
    serverStartMs: SERVER_START_MS,
    nowMs: now,
    milliWatts: -1,
    chart: {
      bucketMs,
      bucketZeroMs: bucketZero,
      appActive,
      screenAwake,
      battery,
      thresholdOn,
      thresholdOff,
      switchOn,
      batterySampleCount,
      batterySampleSpanMs,
      batteryFirstSampleMs,
      batteryLastSampleMs,
      nowBattery: getSelfBattery(),
      nowThresholdOn: batterySettings.thresholdOnPct,
      nowThresholdOff: batterySettings.thresholdOffPct,
      nowAppActive: true,
      nowScreenAwake: activityLog[activityLog.length - 1]?.isAwake ?? true
    }
  });
});

expressApp.get('/api/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders();
  res.write(': connected\n\n');
  // Send a snapshot of the current state
  res.write(`event: snapshot\ndata: ${JSON.stringify(getPublicStateSnapshot())}\n\n`);
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

expressApp.get('/api/url', (req, res) => {
  res.json({ url: `http://${HOST_IP}:${EXPRESS_PORT}/` });
});

expressApp.get('/api/time', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const t1 = Date.now() + calculatedOffsetMs;
  res.json({ t1: t1, t2: Date.now() + calculatedOffsetMs, now: t1 });
});

const SERVER_ID = `desktop-mac-${HOST_IP}`;

// Serve index.html with remote-bridge.js injected (mirrors Android ClockServer).
// When packaged, extraResources places web/, remote-bridge.js, and qrcode.min.js under process.resourcesPath.
const isPackaged = app.isPackaged;
const WEB_DIR = isPackaged
  ? path.join(process.resourcesPath, 'web')
  : path.join(__dirname, '../web');
const BRIDGE_FILE = isPackaged
  ? path.join(process.resourcesPath, 'remote-bridge.js')
  : path.join(__dirname, '../mobile/wv-clock/app/src/main/assets/remote-bridge.js');
const QR_CODE_FILE = isPackaged
  ? path.join(process.resourcesPath, 'qrcode.min.js')
  : path.join(__dirname, '../mobile/wv-clock/app/src/main/assets/qrcode.min.js');

function serveIndex(req, res) {
  try {
    const html = fs.readFileSync(path.join(WEB_DIR, 'index.html'), 'utf8');
    const injected = html.replace(
      '</head>',
      '<script src="/qrcode.min.js"></script><script src="/remote-bridge.js"></script></head>'
    );
    res.set('Cache-Control', 'no-store');
    res.type('html').send(injected);
  } catch (e) {
    res.status(500).send('index load failed: ' + e.message);
  }
}
expressApp.get('/', serveIndex);
expressApp.get('/index.html', serveIndex);

expressApp.get('/remote-bridge.js', (req, res) => {
  res.type('application/javascript');
  res.set('Cache-Control', 'no-store');
  res.sendFile(BRIDGE_FILE);
});

expressApp.get('/qrcode.min.js', (req, res) => {
  res.type('application/javascript');
  res.set('Cache-Control', 'no-store');
  res.sendFile(QR_CODE_FILE);
});

// Serve static assets from front-end folders
expressApp.use('/', express.static(WEB_DIR));

const server = http.createServer(expressApp);
server.listen(EXPRESS_PORT, '0.0.0.0', () => {
  console.log(`[DESKTOP] Express server active at http://${HOST_IP}:${EXPRESS_PORT}`);
});

// UDP discovery Setup
const udpSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

udpSocket.on('listening', () => {
  udpSocket.setBroadcast(true);
  console.log(`[DESKTOP] UDP Socket listening on port ${UDP_PORT}`);
});

udpSocket.on('message', (msg, rinfo) => {
  try {
    const rawData = msg.toString().trim();
    if (rawData.startsWith('WvClockDiscovery:')) {
      const jsonStr = rawData.substring('WvClockDiscovery:'.length);
      const obj = JSON.parse(jsonStr);
      if (obj && obj.id && obj.id !== SERVER_ID) {
        const prev = discoveredClocks[obj.id];
        const battery = typeof obj.battery === 'number' ? obj.battery : -1;
        const milliWatts = typeof obj.milliWatts === 'number' ? obj.milliWatts : -1;
        const isAsleep = !!obj.isAsleep;
        const ipAddress = typeof obj.ipAddress === 'string' && obj.ipAddress ? obj.ipAddress : extractHostFromUrl(obj.url);
        const macAddress = normalizeMacAddress(typeof obj.macAddress === 'string' ? obj.macAddress : '');
        const changed = !prev
          || prev.isAsleep !== isAsleep
          || Math.abs((prev.battery || -1) - battery) >= 5;
        discoveredClocks[obj.id] = {
          name: obj.name,
          url: obj.url,
          lastSeen: Date.now(),
          battery,
          milliWatts,
          isAsleep,
          ipAddress,
          macAddress
        };
        if (changed) broadcastClocksUpdate();
      }
    }
  } catch (err) {
    console.error('[DESKTOP] UDP parse error:', err);
  }
});

udpSocket.bind(UDP_PORT);

// Broadcast heartbeat every 5 seconds
setInterval(() => {
  try {
    const payload = {
      id: SERVER_ID,
      name: `macOS Clock (${HOST_IP})`,
      url: `http://${HOST_IP}:${EXPRESS_PORT}`,
      battery: getSelfBattery(),
      ipAddress: HOST_IP,
      macAddress: HOST_MAC,
      isAsleep: false
    };
    const message = `WvClockDiscovery:${JSON.stringify(payload)}`;
    const buffer = Buffer.from(message);
    for (const target of getBroadcastTargets()) {
      udpSocket.send(buffer, 0, buffer.length, UDP_PORT, target);
    }
  } catch (err) {
    console.error('[DESKTOP] UDP broadcast failure:', err);
  }
}, 5000);

setInterval(() => {
  sampleSelfBattery();
}, BATTERY_SAMPLE_INTERVAL_MS);

setInterval(() => {
  evaluateBatteryAutomation().catch((err) => {
    console.warn('[DESKTOP] Battery automation loop error:', err && err.message ? err.message : err);
  });
}, BATTERY_SAMPLE_INTERVAL_MS);

// ---------------- High-precision Synchronization System ----------------

// Helper to check if this clock is currently the Master
function isMaster() {
  const masterUrl = systemState["screenClock_timeMasterUrl"];
  return !masterUrl || masterUrl === "" || masterUrl === `http://127.0.0.1:${EXPRESS_PORT}/` || masterUrl === `http://${HOST_IP}:${EXPRESS_PORT}/` || masterUrl === `http://localhost:${EXPRESS_PORT}/`;
}

// Extraction helper for master IP/hostname
function getMasterHost() {
  const masterUrl = systemState["screenClock_timeMasterUrl"];
  if (!masterUrl) return null;
  try {
    const url = new URL(masterUrl);
    return url.hostname;
  } catch (e) {
    const match = masterUrl.match(/https?:\/\/([^:/]+)/);
    return match ? match[1] : null;
  }
}

// Update time offset inside the Electron frontend web view
function updateWebOffset() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.executeJavaScript(`window.__timeMasterOffsetMs = ${calculatedOffsetMs};`).catch(() => {});
  }
}

function safeCloseDgramSocket(socket) {
  if (!socket) return;
  try {
    socket.close();
  } catch (err) {
    if (!err || err.code !== 'ERR_SOCKET_DGRAM_NOT_RUNNING') {
      console.warn('[DESKTOP] Unexpected UDP socket close error:', err && err.message ? err.message : err);
    }
  }
}

// Query upstream NTP server using raw binary SNTP (RFC 4330)
function queryNtp(host, callback) {
  const socket = dgram.createSocket('udp4');
  const packet = Buffer.alloc(48);
  packet[0] = 0x1b; // LI = 0, VN = 3, Mode = 3 (Client)

  const t0 = Date.now();
  const seconds = Math.floor(t0 / 1000) + 2208988800;
  const fraction = Math.round(((t0 % 1000) / 1000) * 0x100000000);
  packet.writeUInt32BE(seconds, 40);
  packet.writeUInt32BE(fraction, 44);

  let done = false;
  function finish(err, offset, rtt) {
    if (done) return;
    done = true;
    clearTimeout(timeoutId);
    safeCloseDgramSocket(socket);
    callback(err, offset, rtt);
  }

  const timeoutId = setTimeout(() => {
    finish(new Error('NTP query timeout'));
  }, 4000);

  socket.on('message', (msg) => {
    const t3 = Date.now();

    if (msg.length < 48) {
      finish(new Error('Invalid NTP packet length'));
      return;
    }

    function readTimestamp(offset) {
      const secs = msg.readUInt32BE(offset);
      const frac = msg.readUInt32BE(offset + 4);
      return Math.round((secs - 2208988800) * 1000 + (frac / 0x100000000) * 1000);
    }

    const t1 = readTimestamp(32); // Server Receive
    const t2 = readTimestamp(40); // Server Transmit

    let rtt = (t3 - t0) - (t2 - t1);
    if (rtt < 0) rtt = t3 - t0;

    const offset = Math.round(((t1 - t0) + (t2 - t3)) / 2);
    finish(null, offset, rtt);
  });

  socket.on('error', (err) => {
    finish(err);
  });

  socket.send(packet, 0, packet.length, 123, host, (err) => {
    if (err) {
      finish(err);
    }
  });
}

// Sync to Master clock using UDP packet exchange (Cristian's algorithm)
function performP2pSync(masterHost) {
  const clientSocket = dgram.createSocket('udp4');
  const t0 = Date.now();
  const requestPayload = JSON.stringify({ type: "ping", t0: t0 });
  const buffer = Buffer.from(requestPayload);

  let done = false;
  function finish() {
    if (done) return;
    done = true;
    clearTimeout(timeoutId);
    safeCloseDgramSocket(clientSocket);
  }

  const timeoutId = setTimeout(() => {
    finish();
  }, 1500);

  clientSocket.on('message', (msg) => {
    const t3 = Date.now();
    finish();
    try {
      const response = JSON.parse(msg.toString().trim());
      if (response && response.type === "pong" && response.t0 === t0) {
        const t1 = response.t1;
        const t2 = response.t2;

        let rtt = (t3 - t0) - (t2 - t1);
        if (rtt < 0) rtt = t3 - t0;

        const offset = Math.round(((t1 - t0) + (t2 - t3)) / 2);
        calculatedOffsetMs = offset;
        lastP2pSyncTime = Date.now();
        console.log(`[DESKTOP] P2P sync successful. Offset: ${offset}ms, RTT: ${rtt}ms`);
        updateWebOffset();
      }
    } catch (e) {
      console.warn(`[DESKTOP] P2P response parse failed:`, e);
    }
  });

  clientSocket.on('error', (err) => {
    finish();
    console.warn(`[DESKTOP] P2P socket error during sync to ${masterHost}:`, err.message);
  });

  clientSocket.send(buffer, 0, buffer.length, 8767, masterHost, (err) => {
    if (err) {
      finish();
      console.warn(`[DESKTOP] P2P send error to ${masterHost}:`, err.message);
    }
  });
}

// UDP Sync Server (Port 8767) for responding to Cristian's algorithm requests
const syncSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

syncSocket.on('listening', () => {
  console.log(`[DESKTOP] UDP Sync Server listening on port 8767`);
});

syncSocket.on('message', (msg, rinfo) => {
  try {
    const rawData = msg.toString().trim();
    const packet = JSON.parse(rawData);
    if (packet && packet.type === 'ping') {
      const t1 = Date.now() + calculatedOffsetMs;
      const responsePayload = JSON.stringify({
        type: 'pong',
        t0: packet.t0,
        t1: t1,
        t2: Date.now() + calculatedOffsetMs
      });
      const responseBuffer = Buffer.from(responsePayload);
      syncSocket.send(responseBuffer, 0, responseBuffer.length, rinfo.port, rinfo.address);
    }
  } catch (err) {
    // Ignore invalid JSON payloads on the sync port
  }
});

syncSocket.on('error', (err) => {
  console.error('[DESKTOP] UDP Sync Server error:', err);
});

try {
  syncSocket.bind(8767);
} catch (e) {
  console.error('[DESKTOP] Could not bind UDP sync port 8767:', e);
}

// Standard 1-second interval execution loop
setInterval(() => {
  const now = Date.now();
  if (isMaster()) {
    // Queries upstream NTP
    if (now - lastNtpSyncTime > NTP_SYNC_INTERVAL) {
      const serverHost = systemState["screenClock_ntpServer"] || "pool.ntp.org";
      console.log(`[DESKTOP] Syncing with upstream NTP server: ${serverHost}`);
      queryNtp(serverHost, (err, offset, rtt) => {
        if (!err) {
          calculatedOffsetMs = offset;
          lastNtpSyncTime = Date.now();
          console.log(`[DESKTOP] Upstream NTP sync successful. Offset: ${offset}ms, RTT: ${rtt}ms`);
          updateWebOffset();
        } else {
          console.warn(`[DESKTOP] Upstream NTP sync failed: ${err.message}`);
          // Retry faster on failure (30 seconds)
          lastNtpSyncTime = now - NTP_SYNC_INTERVAL + 30000;
        }
      });
    }
  } else {
    // Queries master clock via UDP P2P
    if (now - lastP2pSyncTime > P2P_SYNC_INTERVAL) {
      const masterHost = getMasterHost();
      if (masterHost) {
        performP2pSync(masterHost);
      }
    }
  }
}, 1000);

// Electron UI initialization
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1024,
    height: 768,
    backgroundColor: '#000000',
    fullscreen: false,
    fullscreenable: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  ipcMain.handle('toggle-fullscreen', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.setFullScreen(!mainWindow.isFullScreen());
  });

  ipcMain.handle('is-fullscreen', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    return mainWindow.isFullScreen();
  });

  // Load Express clock index
  mainWindow.loadURL(`http://localhost:${EXPRESS_PORT}/index.html`);

  mainWindow.webContents.on('did-finish-load', () => {
    updateWebOffset();
  });

  mainWindow.on('closed', function () {
    mainWindow = null;
  });
}

app.on('ready', createWindow);

app.on('window-all-closed', function () {
  try {
    safeCloseDgramSocket(udpSocket);
    safeCloseDgramSocket(syncSocket);
    server.close();
  } catch (e) {}
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', function () {
  if (mainWindow === null) {
    createWindow();
  }
});
