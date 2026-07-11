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
const cookieParser = require('cookie-parser');
const { createProxyMiddleware } = require('http-proxy-middleware');
app.use(cookieParser());

const BACKEND_URL = process.env.BACKEND_URL;
const AGENT_SECRET = process.env.AGENT_SECRET;
const SUNSHINE_PASS = process.env.SUNSHINE_PASS;
const SESSION_ID_FILE = 'C:\\agent\\SunshineAgent\\current_session.txt';
const AUTH_KEY_FILE = 'C:\\agent\\SunshineAgent\\stream_auth.txt';

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
  const { steamId, sessionId, streamAuthKey } = req.body;
  if (!steamId || !sessionId) {
    return res.status(400).json({ error: 'steamId and sessionId required' });
  }

  // Write session ID and streamAuthKey for reference and proxy auth
  try {
    fs.writeFileSync(SESSION_ID_FILE, sessionId);
    if (streamAuthKey) {
      fs.writeFileSync(AUTH_KEY_FILE, streamAuthKey);
    }
  } catch (err) {
    console.error('Error writing session data:', err);
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
    exec(`taskkill /F /IM "${gameExe}"`, () => { });
  }

  // Kill Steam overlay
  exec('taskkill /F /IM GameOverlayUI.exe 2>nul', () => { });

  // Clean temp files
  exec('del /Q /F "%TEMP%\\*" 2>nul', () => { });

  try {
    fs.writeFileSync(SESSION_ID_FILE, '');
    fs.writeFileSync(AUTH_KEY_FILE, '');
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
    const https = require('https');
    // Forward PIN to Sunshine REST API over HTTPS, ignoring self-signed cert
    await axios.post('https://localhost:47990/api/pin', { pin, client: 'NoclipWeb' }, {
      auth: { username: 'admin', password: SUNSHINE_PASS },
      timeout: 5000,
      httpsAgent: new https.Agent({ rejectUnauthorized: false })
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

// ==========================================
// STREAM AUTH & PROXY SERVER (Port 8080)
// ==========================================
// API routes above will match first. Anything else falls through to the Stream Auth.

// Authentication Middleware
app.use((req, res, next) => {
  let activeKey = '';
  try {
    activeKey = fs.readFileSync(AUTH_KEY_FILE, 'utf-8').trim();
  } catch (err) { }

  // If no session is active, block everything
  if (!activeKey) {
    return res.status(401).send('No active session.');
  }

  // 1. Check if token is in query (used for initial iframe load)
  if (req.query.sessionKey) {
    if (req.query.sessionKey === activeKey) {
      // Set cookie and redirect to remove token from URL
      res.cookie('stream_auth', req.query.sessionKey, {
        httpOnly: true,
        sameSite: 'none',
        secure: true,
        maxAge: 4 * 60 * 60 * 1000 // 4 hours
      });
      const url = new URL(req.originalUrl, `https://${req.headers.host}`);
      url.searchParams.delete('sessionKey');
      return res.redirect(url.pathname + url.search);
    }
    return res.status(401).send('Invalid session key in query.');
  }

  // 2. Check if token is in cookie (used for all subsequent assets & APIs & WebSockets)
  if (req.cookies.stream_auth === activeKey) {
    return next();
  }

  return res.status(401).send('Unauthorized Access 401');
});

// Proxy to the isolated moonlight-web-stream server running on 8081
const proxy = createProxyMiddleware({
  target: 'http://127.0.0.1:8081',
  changeOrigin: true,
  ws: true,
  logLevel: 'error',
  onProxyReq: (proxyReq, req, res) => {
    // Automatically log the user in as 'admin' in moonlight-web-stream
    proxyReq.setHeader('X-Forwarded-User', 'admin');
  }
});

app.use('/', proxy);

// Configure moonlight-web-stream to listen on 127.0.0.1:8081 and start Proxy
const MOONLIGHT_CONFIG_PATH = 'C:\\package(moonlight)\\config.json';
try {
  // First, kill any existing web-server.exe so port 8080 is freed
  exec('taskkill /F /IM web-server.exe 2>nul', () => {

    // Now start the proxy on port 8080
    const proxyServer = app.listen(8080, '0.0.0.0', () => {
      console.log('Agent & Stream Proxy listening on port 8080');
      notifyBackendReady();
    });

    proxyServer.on('upgrade', (req, socket, head) => {
      let activeKey = '';
      try {
        activeKey = fs.readFileSync(AUTH_KEY_FILE, 'utf-8').trim();
      } catch (err) { }

      if (!activeKey) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      let cookies = {};
      if (req.headers.cookie) {
        req.headers.cookie.split(';').forEach(cookie => {
          const parts = cookie.split('=');
          cookies[parts[0].trim()] = (parts[1] || '').trim();
        });
      }

      if (cookies.stream_auth !== activeKey) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
    });

    // Finally, robustly update config and start web-server.exe on 8081
    try {
      let mlConfig = { web_server: { bind_address: '127.0.0.1:8081' } };
      if (fs.existsSync(MOONLIGHT_CONFIG_PATH)) {
        try {
          const mlConfigRaw = fs.readFileSync(MOONLIGHT_CONFIG_PATH, 'utf-8');
          mlConfig = JSON.parse(mlConfigRaw);
        } catch (e) {
          console.error('Error parsing config, using defaults');
        }
      }
      if (!mlConfig.web_server) mlConfig.web_server = {};
      mlConfig.web_server.bind_address = '127.0.0.1:8081';
      mlConfig.web_server.forwarded_header = {
        username_header: 'X-Forwarded-User',
        auto_create_missing_user: true
      };
      fs.writeFileSync(MOONLIGHT_CONFIG_PATH, JSON.stringify(mlConfig, null, 4));
      console.log('Updated moonlight config to bind to 127.0.0.1:8081');
    } catch (err) {
      console.error('Failed to write moonlight config:', err.message);
    }

    // Start web-server.exe robustly using spawn to capture logs
    setTimeout(() => {
      const { spawn } = require('child_process');
      const webServer = spawn('C:\\package(moonlight)\\web-server.exe', ['--bind-address', '127.0.0.1:8081'], {
        cwd: 'C:\\package(moonlight)'
      });

      webServer.stdout.on('data', (data) => console.log('[web-server]', data.toString().trim()));
      webServer.stderr.on('data', (data) => console.error('[web-server ERROR]', data.toString().trim()));
      webServer.on('error', (err) => console.error('[web-server FATAL ERROR]', err));
      webServer.on('close', (code) => console.log(`[web-server] exited with code ${code}`));

      console.log('Started web-server.exe on 127.0.0.1:8081');
      
      // Auto-Pairing Logic (wait 5s for discovery)
      setTimeout(async () => {
        try {
          const authHeaders = { headers: { 'X-Forwarded-User': 'admin' } };
          const hostsRes = await axios.get('http://127.0.0.1:8081/api/hosts', authHeaders);
          
          // Delete ALL unusable hosts to prevent HTTPS cert issues and zombie hosts
          let existingPairedHostId = null;
          if (hostsRes.data && hostsRes.data.hosts) {
            for (const h of hostsRes.data.hosts) {
              let isReallyPaired = false;
              if (h.paired === 'Paired') {
                try {
                  const appsRes = await axios.get(`http://127.0.0.1:8081/api/apps?host_id=${h.host_id}`, authHeaders);
                  if (appsRes.data && appsRes.data.apps && appsRes.data.apps.length > 0) isReallyPaired = true;
                } catch (e) {}
              }
              
              if (isReallyPaired) {
                 existingPairedHostId = h.host_id;
                 continue; // Keep perfectly good paired hosts!
              }
              await axios.delete(`http://127.0.0.1:8081/api/host?host_id=${h.host_id}`, authHeaders).catch(()=>{});
            }
          }
          
          let hostId = existingPairedHostId;
          
          // Manually add host on HTTP port if we don't have a perfectly working paired host
          if (!hostId) {
            const addRes = await axios.post('http://127.0.0.1:8081/api/host', { address: '127.0.0.1', http_port: 47989 }, authHeaders);
            hostId = addRes.data.host.host_id;
          }
          
          let isPaired = !!existingPairedHostId;

          if (!isPaired) {
            console.log(`[Auto-Pair] Host ${hostId} is not paired or has a stale certificate. Re-adding...`);
            
            // WE MUST DELETE THE HOST IF IT EXISTS!
            // If we don't delete it, moonlight-web-stream retains the old client certificate.
            // When it calls `/api/pair`, it will hit Sunshine with the OLD certificate, 
            // and Sunshine will reject it with 401 Unauthorized before pairing even starts!
            if (hostId) {
                await axios.delete(`http://127.0.0.1:8081/api/host?host_id=${hostId}`, authHeaders).catch(()=>{});
            }
            
            // Add a fresh host (this generates a clean slate with no client certificate)
            const addRes = await axios.post('http://127.0.0.1:8081/api/host', { address: '127.0.0.1', http_port: 47989 }, authHeaders);
            hostId = addRes.data.host.host_id;

            console.log(`[Auto-Pair] Fresh host added with ID ${hostId}. Requesting PIN...`);
            const pairRes = await axios.post('http://127.0.0.1:8081/api/pair', { host_id: hostId }, {
              ...authHeaders,
              responseType: 'stream'
            });

            pairRes.data.on('data', async (chunk) => {
              const text = chunk.toString().trim();
              if (!text) return;
              
              // Streams can send multiple JSON chunks separated by newlines
              const lines = text.split('\\n');
              for (const line of lines) {
                if (!line.trim()) continue;
                try {
                  const parsed = JSON.parse(line.trim());
                  if (parsed.Pin) {
                    console.log(`[Auto-Pair] Got PIN: ${parsed.Pin}. Waiting 2 seconds for pair request to initialize...`);
                    setTimeout(async () => {
                      const https = require('https');
                      try {
                        const res = await axios.post('https://localhost:47990/api/pin', { pin: parsed.Pin }, {
                          auth: { username: 'admin', password: SUNSHINE_PASS || '20216401523' },
                          timeout: 5000,
                          httpsAgent: new https.Agent({ rejectUnauthorized: false })
                        });
                        console.log(`[Auto-Pair] Successfully sent PIN to Sunshine (Status ${res.status})!`);
                      } catch (e) {
                        console.error('[Auto-Pair] Failed to send PIN:', e.message);
                      }
                    }, 2000);
                  } else if (parsed.Paired) {
                    console.log(`[Auto-Pair] SUCCESS! Moonlight Web Stream officially completed pairing with Sunshine!`);
                  } else if (parsed.PairError) {
                    console.log(`[Auto-Pair] ERROR! Moonlight Web Stream pairing process failed or timed out!`);
                  }
                } catch (e) {
                  console.error('[Auto-Pair] Stream parse error:', e.message, line);
                }
              }
            });
          } else {
            console.log('[Auto-Pair] Host is already paired.');
          }
        } catch (e) {
          console.error('[Auto-Pair] Failed:', e.message);
        }
      }, 5000);

    }, 1500);
  });
} catch (err) {
  console.error('Failed to execute proxy startup sequence:', err.message);
}


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
    } catch (err) {
      // silent
    }
  }
}, 60_000);
