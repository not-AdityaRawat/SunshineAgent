// COPILOT CONTEXT:
// This is the agent running on a Windows Server 2025 EC2 instance (g5.xlarge).
// It listens on port 9999 and is called only by the backend Express API.
// Every route requires the header: x-agent-secret matching process.env.AGENT_SECRET.

require('dotenv').config();
const express = require('express');
const { exec } = require('child_process');
const axios = require('axios');
const os = require('os');
const fs = require('fs');
const https = require('https');

const app = express();
app.use(express.json());

const BACKEND_URL = process.env.BACKEND_URL;
const AGENT_SECRET = process.env.AGENT_SECRET;
const SUNSHINE_PASS = process.env.SUNSHINE_PASS;
const SESSION_ID_FILE = 'C:\\agent\\current_session.txt';

// 1. auth middleware
function auth(req, res, next) {
  if (req.headers['x-agent-secret'] !== AGENT_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// 2. GET /health
app.get('/health', (req, res) => {
  res.json({
    alive: true,
    uptime: os.uptime(),
    freeMemMB: Math.round(os.freemem() / 1024 / 1024)
  });
});

// 3. POST /launch
app.post('/launch', auth, (req, res) => {
  const { steamId, sessionId } = req.body;
  if (!steamId || !sessionId) {
    return res.status(400).json({ error: 'steamId and sessionId required' });
  }

  // Write session ID for reference
  try {
    fs.writeFileSync(SESSION_ID_FILE, sessionId);
  } catch (err) {
    console.error('Error writing session ID:', err);
  }

  // Kill any running game first (clean state)
  exec('taskkill /F /IM GameOverlayUI.exe 2>nul');

  // Launch game via Steam protocol
  exec(`"C:\\Program Files (x86)\\Steam\\steam.exe" -applaunch ${steamId} -fullscreen`);

  res.json({ status: 'launching', steamId, sessionId });
});

// 4. POST /stop
app.post('/stop', auth, (req, res) => {
  const { gameExe } = req.body;

  if (gameExe) {
    exec(`taskkill /F /IM "${gameExe}"`, () => {});
  }

  // Kill Steam overlay
  exec('taskkill /F /IM GameOverlayUI.exe 2>nul', () => {});

  // Clean temp files
  exec('del /Q /F "%TEMP%\\*" 2>nul', () => {});

  try {
    fs.writeFileSync(SESSION_ID_FILE, '');
  } catch (err) {
    // Ignore error
  }
  
  res.json({ status: 'stopped' });
});

// 4.5. POST /pair
app.post('/pair', auth, async (req, res) => {
  const { pin } = req.body;
  if (!pin) return res.status(400).json({ error: 'PIN required' });
  
  try {
    // Forward PIN to Sunshine REST API
    await axios.post('http://localhost:47990/api/pin', { pin, client: 'NoclipWeb' }, {
      auth: { username: 'admin', password: SUNSHINE_PASS },
      timeout: 5000
    });
    res.json({ status: 'paired' });
  } catch (err) {
    console.error("Sunshine pairing error:", err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// 4.6. POST /unpair
app.post('/unpair', auth, async (req, res) => {
  try {
    const httpsAgent = new https.Agent({ rejectUnauthorized: false });
    await axios.post('https://localhost:47990/api/clients/unpair-all', {}, {
      auth: { username: 'admin', password: SUNSHINE_PASS },
      httpsAgent,
      timeout: 2000
    });
    res.json({ status: 'unpaired' });
  } catch (err) {
    console.error("Sunshine unpair error:", err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// 4.7. POST /reset-moonlight-pairing
// Wipes stale pair_info from Moonlight data.json and restarts web-server.exe.
// Called when Sunshine regenerates its TLS certificate (e.g. after EC2 restart)
// and the stored server_certificate in data.json is no longer valid.
const MOONLIGHT_DATA_PATH = 'C:\\package(moonlight)\\data.json';

app.post('/reset-moonlight-pairing', auth, (req, res) => {
  try {
    // Read Moonlight's database
    const raw = fs.readFileSync(MOONLIGHT_DATA_PATH, 'utf-8');
    const data = JSON.parse(raw);

    // Null out pair_info for every registered host so fresh pairing is triggered
    if (data.hosts) {
      for (const hostId of Object.keys(data.hosts)) {
        data.hosts[hostId].pair_info = null;
      }
    }

    // Write back
    fs.writeFileSync(MOONLIGHT_DATA_PATH, JSON.stringify(data, null, 4), 'utf-8');
    console.log('Moonlight data.json pair_info cleared.');

    // Restart web-server.exe so it reloads the updated data.json
    exec('taskkill /F /IM web-server.exe 2>nul', () => {
      setTimeout(() => {
        exec(
          'Start-Process "C:\\package(moonlight)\\web-server.exe" -WorkingDirectory "C:\\package(moonlight)" -WindowStyle Hidden',
          { shell: 'powershell' },
          (err) => {
            if (err) console.error('Failed to restart web-server.exe:', err.message);
            else console.log('web-server.exe restarted.');
          }
        );
      }, 1500); // Brief pause to let the process fully terminate
    });

    res.json({ status: 'pairing_reset', message: 'Moonlight pair_info cleared and web-server.exe restarting.' });
  } catch (err) {
    console.error('reset-moonlight-pairing error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 5. GET /stats
app.get('/stats', auth, (req, res) => {
  const freeMem = os.freemem();
  const totalMem = os.totalmem();
  res.json({
    freeMemMB: Math.round(freeMem / 1024 / 1024),
    totalMemMB: Math.round(totalMem / 1024 / 1024),
    uptime: os.uptime(),
    platform: os.platform()
  });
});

app.listen(9999, '0.0.0.0', () => {
  console.log('Agent listening on port 9999');
  notifyBackendReady();
});

// 6. On startup: POST to process.env.BACKEND_URL/instance/ready
async function notifyBackendReady() {
  if (!BACKEND_URL) return;
  try {
    await axios.post(`${BACKEND_URL}/instance/ready`, {}, {
      headers: { 'x-agent-secret': AGENT_SECRET }
    });
    console.log('Notified backend instance is ready');
  } catch (e) {
    console.error('Could not notify backend:', e.message);
    setTimeout(notifyBackendReady, 5000);
  }
}

// 7. Heartbeat: every 10 seconds POST to BACKEND_URL/session/heartbeat
setInterval(async () => {
  if (!BACKEND_URL) return;
  try {
    let activeStreams = 0;
    try {
      const res = await axios.get('http://localhost:47990/api/clients', {
        auth: { username: 'admin', password: SUNSHINE_PASS },
        timeout: 2000
      });
      activeStreams = res.data?.clients?.length ?? 0;
    } catch (err) {
      activeStreams = 0;
    }

    await axios.post(`${BACKEND_URL}/instance/heartbeat`, {
      activeStreams,
      freeMemMB: Math.round(os.freemem() / 1024 / 1024)
    }, {
      headers: { 'x-agent-secret': AGENT_SECRET },
      timeout: 5000
    });
  } catch (e) { 
    /* silent */ 
  }
}, 10_000);

// 8. Spot interruption poller: every 5 seconds
setInterval(async () => {
  if (!BACKEND_URL) return;
  try {
    const res = await axios.get(
      'http://169.254.169.254/latest/meta-data/spot/termination-time',
      { timeout: 1000 }
    );
    // If 200 response: handle spot interruption
    if (res.status === 200) {
      await axios.post(`${BACKEND_URL}/instance/interruption`, {}, {
        headers: { 'x-agent-secret': AGENT_SECRET }
      });
    }
  } catch {
    /* 404 = safe, no interruption scheduled */ 
  }
}, 5000);

// 9. Memory alert: every 60 seconds check os.freemem()
setInterval(async () => {
  if (!BACKEND_URL) return;
  const freeMemMB = Math.round(os.freemem() / 1024 / 1024);
  if (freeMemMB < 1500) {
    try {
      await axios.post(`${BACKEND_URL}/instance/alert`, {
        type: 'LOW_MEMORY',
        freeMemMB
      }, { 
        headers: { 'x-agent-secret': AGENT_SECRET } 
      });
    } catch(err) {
      // silent
    }
  }
}, 60_000);
