const { app, BrowserWindow, powerMonitor } = require('electron');
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

function trimActivityLog() {
  const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
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

// Memory store for discovered clocks: { url: { name, url, lastSeen, isSelf, battery } }
const discoveredClocks = {};

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
expressApp.use(express.json());

// In memory state
let systemState = {};

let calculatedOffsetMs = 0;
let lastNtpSyncTime = 0;
let lastP2pSyncTime = 0;
const NTP_SYNC_INTERVAL = 300000; // 5 minutes standard NTP sync
const P2P_SYNC_INTERVAL = 2000;   // 2 seconds P2P sync

// Handle state synchronisation endpoints
expressApp.get('/api/state', (req, res) => {
  res.json(systemState);
});

expressApp.post('/api/state', (req, res) => {
  const { key, value } = req.body;
  if (key) {
    if (value === null) {
      delete systemState[key];
    } else {
      systemState[key] = value;
    }
    if (key === "screenClock_timeMasterUrl" || key === "screenClock_ntpServer") {
      lastNtpSyncTime = 0;
      lastP2pSyncTime = 0;
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

/**
 * GET /api/info
 *
 * Returns device information and a 7-day activity history for one clock node.
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
  const bucketMs = 3_600_000;
  const bucketCount = 7 * 24;
  const bucketZero = now - (bucketCount - 1) * bucketMs;
  const appActiveRaw = [];
  const screenAwakeRaw = [];
  for (let i = 0; i < bucketCount; i++) {
    const bs = bucketZero + i * bucketMs;
    const be = bs + bucketMs;
    appActiveRaw.push(SERVER_START_MS < be ? (be - Math.max(SERVER_START_MS, bs)) / bucketMs : 0);
    screenAwakeRaw.push(computeDesktopAwakeFraction(bs, be));
  }
  // Trim leading all-zero buckets, keep one zero before first active bucket
  const minActive = 1 / 60; // at least 1 minute in an hour to count as non-zero
  const firstActive = appActiveRaw.findIndex((v, i) => v > minActive || screenAwakeRaw[i] > minActive);
  const trimFrom = Math.max(0, (firstActive === -1 ? 0 : firstActive) - 1);
  const appActive = appActiveRaw.slice(trimFrom);
  const screenAwake = screenAwakeRaw.slice(trimFrom);
  const trimmedBucketZero = bucketZero + trimFrom * bucketMs;
  res.json({
    attrs: [
      { label: 'Brand / Model', value: `${os.type()}  /  ${os.hostname()}` },
      { label: 'OS', value: `${process.platform} ${os.release()}` },
      { label: 'Build', value: fmtBuildTime(BUILD_TIME) },
      { label: 'Git commit', value: GIT_COMMIT },
      { label: 'Uptime', value: fmtUptime(Math.round(process.uptime() * 1000)) }
    ],
    serverStartMs: SERVER_START_MS,
    nowMs: now,
    chart: { bucketMs, bucketZeroMs: trimmedBucketZero, appActive, screenAwake,
      nowAppActive: true, nowScreenAwake: activityLog[activityLog.length - 1]?.isAwake ?? true }
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
  res.write(`event: snapshot\ndata: ${JSON.stringify(systemState)}\n\n`);
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
const WEB_DIR = path.join(__dirname, '../web');
const BRIDGE_FILE = path.join(__dirname, '../mobile/wv-clock/app/src/main/assets/remote-bridge.js');

function serveIndex(req, res) {
  try {
    const html = fs.readFileSync(path.join(WEB_DIR, 'index.html'), 'utf8');
    const injected = html.replace(
      '</head>',
      '<script src="/remote-bridge.js"></script></head>'
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
        const changed = !prev
          || prev.isAsleep !== isAsleep
          || Math.abs((prev.battery || -1) - battery) >= 5;
        discoveredClocks[obj.id] = {
          name: obj.name,
          url: obj.url,
          lastSeen: Date.now(),
          battery,
          milliWatts,
          isAsleep
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
      isAsleep: false
    };
    const message = `WvClockDiscovery:${JSON.stringify(payload)}`;
    const buffer = Buffer.from(message);
    udpSocket.send(buffer, 0, buffer.length, UDP_PORT, MULTICAST_ADDR);
  } catch (err) {
    console.error('[DESKTOP] UDP broadcast failure:', err);
  }
}, 5000);

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

  const timeoutId = setTimeout(() => {
    try { socket.close(); } catch (e) {}
    callback(new Error('NTP query timeout'));
  }, 4000);

  socket.on('message', (msg) => {
    const t3 = Date.now();
    clearTimeout(timeoutId);
    socket.close();

    if (msg.length < 48) {
      callback(new Error('Invalid NTP packet length'));
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
    callback(null, offset, rtt);
  });

  socket.on('error', (err) => {
    clearTimeout(timeoutId);
    socket.close();
    callback(err);
  });

  socket.send(packet, 0, packet.length, 123, host, (err) => {
    if (err) {
      clearTimeout(timeoutId);
      socket.close();
      callback(err);
    }
  });
}

// Sync to Master clock using UDP packet exchange (Cristian's algorithm)
function performP2pSync(masterHost) {
  const clientSocket = dgram.createSocket('udp4');
  const t0 = Date.now();
  const requestPayload = JSON.stringify({ type: "ping", t0: t0 });
  const buffer = Buffer.from(requestPayload);

  const timeoutId = setTimeout(() => {
    try { clientSocket.close(); } catch (e) {}
  }, 1500);

  clientSocket.on('message', (msg) => {
    const t3 = Date.now();
    clearTimeout(timeoutId);
    clientSocket.close();
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
    clearTimeout(timeoutId);
    clientSocket.close();
    console.warn(`[DESKTOP] P2P socket error during sync to ${masterHost}:`, err.message);
  });

  clientSocket.send(buffer, 0, buffer.length, 8767, masterHost, (err) => {
    if (err) {
      clearTimeout(timeoutId);
      clientSocket.close();
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
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
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
    udpSocket.close();
    syncSocket.close();
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
