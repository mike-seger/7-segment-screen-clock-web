const { app, BrowserWindow } = require('electron');
const path = require('path');
const express = require('express');
const cors = require('cors');
const dgram = require('dgram');
const ip = require('ip');
const http = require('http');
const fs = require('fs');

let mainWindow;
const EXPRESS_PORT = 8080;
const UDP_PORT = 8766;
const MULTICAST_ADDR = '255.255.255.255';
const HOST_IP = ip.address();

// Memory store for discovered clocks: { url: { name, url, lastSeen, isSelf } }
const discoveredClocks = {};

// Express server Setup
const expressApp = express();
expressApp.use(cors());
expressApp.use(express.json());

// In memory state
let systemState = {};

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
    isSelf: true
  });

  // Add others
  for (const url in discoveredClocks) {
    if (discoveredClocks[url].lastSeen > currentTime - 12000) { // 12 second expiration threshold
      clocksList.push({
        name: discoveredClocks[url].name,
        url: discoveredClocks[url].url,
        isSelf: false
      });
    } else {
      delete discoveredClocks[url];
    }
  }

  res.json(clocksList);
});

expressApp.get('/api/url', (req, res) => {
  res.json({ url: `http://${HOST_IP}:${EXPRESS_PORT}/` });
});

expressApp.get('/api/time', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const t1 = Date.now();
  res.json({ t1: t1, t2: Date.now(), now: t1 });
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
        discoveredClocks[obj.id] = {
          name: obj.name,
          url: obj.url,
          lastSeen: Date.now()
        };
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
      url: `http://${HOST_IP}:${EXPRESS_PORT}`
    };
    const message = `WvClockDiscovery:${JSON.stringify(payload)}`;
    const buffer = Buffer.from(message);
    udpSocket.send(buffer, 0, buffer.length, UDP_PORT, MULTICAST_ADDR);
  } catch (err) {
    console.error('[DESKTOP] UDP broadcast failure:', err);
  }
}, 5000);

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

  mainWindow.on('closed', function () {
    mainWindow = null;
  });
}

app.on('ready', createWindow);

app.on('window-all-closed', function () {
  try {
    udpSocket.close();
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
