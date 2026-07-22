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

const path = require('path');
const SESSION_ID_FILE = path.join(__dirname, 'current_session.txt');
const AUTH_KEY_FILE = path.join(__dirname, 'stream_auth.txt');

const MOONLIGHT_DIR = 'C:\\package(moonlight)';
const MOONLIGHT_DATA_PATH = path.join(MOONLIGHT_DIR, 'data.json');
const MOONLIGHT_CONFIG_PATH = path.join(MOONLIGHT_DIR, 'config.json');
const MOONLIGHT_WEB_SERVER_EXE = path.join(MOONLIGHT_DIR, 'web-server.exe');

let awsInstanceId = process.env.INSTANCE_ID || os.hostname(); // Default fallback

// Fetch actual AWS Instance ID on boot via IMDSv2
async function fetchInstanceId() {
  if (process.env.INSTANCE_ID) {
    awsInstanceId = process.env.INSTANCE_ID;
    return;
  }

  let retries = 5;
  while (retries > 0) {
    try {
      // 1. Get IMDSv2 Token
      const tokenRes = await axios.put('http://169.254.169.254/latest/api/token', null, {
        headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '21600' },
        timeout: 2000
      });
      const token = tokenRes.data;

      // 2. Fetch instance-id with token
      const res = await axios.get('http://169.254.169.254/latest/meta-data/instance-id', {
        headers: { 'X-aws-ec2-metadata-token': token },
        timeout: 2000
      });

      if (res.data) {
        awsInstanceId = res.data.trim();
        console.log(`[AWS] Fetched Instance ID via IMDSv2: ${awsInstanceId}`);
        return;
      }
    } catch (err) {
      console.log(`[AWS] IMDSv2 fetch failed (${err.message}). Retries left: ${retries - 1}`);
    }
    retries--;
    if (retries > 0) await new Promise(r => setTimeout(r, 2000)); // wait 2s before retry
  }
  console.log(`[AWS] Could not fetch Instance ID after retries. Falling back to ${awsInstanceId}`);
}
fetchInstanceId();

// Global Uncaught Exception Handler
process.on('uncaughtException', (err) => {
  console.error('[CRASH] Uncaught Exception:', err.message);
  console.error(err.stack);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('[CRASH] Unhandled Rejection at:', promise, 'reason:', reason);
});

// Request Logger
app.use((req, res, next) => {
  console.log(`[HTTP] ${req.method} ${req.url}`);
  next();
});

// 1. auth middleware
function auth(req, res, next) {
  if (req.headers['x-agent-secret'] !== AGENT_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.set('trust proxy', 1);

// Global Permissive CORS for all endpoints (health checks, API, proxy)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, ngrok-skip-browser-warning, x-agent-secret');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Credentials', 'true'); // Added for cookies just in case

  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// 2. GET /health
app.get('/health', (req, res) => {
  res.json({
    alive: true,
    uptime: os.uptime(),
    freeMemMB: Math.round(os.freemem() / 1024 / 1024)
  });
});

// 2.5. GET /stream-health — check if Moonlight web-server (port 8081) is alive
app.get('/stream-health', auth, async (req, res) => {
  try {
    const r = await axios.get('http://127.0.0.1:8081/api/hosts', {
      headers: { 'X-Forwarded-User': 'admin' },
      timeout: 5000
    });
    res.json({ streamServerAlive: true, hosts: r.data?.hosts?.length || 0 });
  } catch (err) {
    res.json({ streamServerAlive: false, error: err.message });
  }
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

  // Only launch a game if steamId is not '0' (0 means we're just syncing keys for Playnite)
  if (steamId !== '0') {
    // Kill any running game first (clean state)
    exec('taskkill /F /IM GameOverlayUI.exe 2>nul', { windowsHide: true });

    // Launch game via Steam protocol
    exec(`"C:\\Program Files (x86)\\Steam\\steam.exe" -applaunch ${steamId} -fullscreen`, { windowsHide: true });
  }

  res.json({ status: 'launching', steamId, sessionId });
});

// 4. POST /stop
app.post('/stop', auth, (req, res) => {
  const { gameExe } = req.body;

  if (gameExe) {
    exec(`taskkill /F /IM "${gameExe}"`, { windowsHide: true }, () => { });
  }

  // Kill Steam overlay
  exec('taskkill /F /IM GameOverlayUI.exe 2>nul', { windowsHide: true }, () => { });

  // Clean temp files
  exec('del /Q /F "%TEMP%\\*" 2>nul', { windowsHide: true }, () => { });

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
    exec('taskkill /F /IM web-server.exe 2>nul', { windowsHide: true }, () => {
      setTimeout(() => {
        exec(
          `Start-Process "${MOONLIGHT_WEB_SERVER_EXE}" -ArgumentList "--bind-address 127.0.0.1:8081" -WorkingDirectory "${MOONLIGHT_DIR}" -WindowStyle Hidden`,
          { shell: 'powershell', windowsHide: true },
          (err) => {
            if (err) console.error('Failed to restart web-server.exe:', err.message);
            else console.log('web-server.exe restarted robustly on 8081.');
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

  // 1. Check if token is in query (used for initial iframe load & API fetch)
  if (req.query.sessionKey) {
    if (req.query.sessionKey === activeKey) {
      // Set cookie and proceed without redirecting (redirect breaks CORS AJAX fetch)
      res.cookie('stream_auth', req.query.sessionKey, {
        httpOnly: true,
        sameSite: 'none',
        secure: true,
        maxAge: 4 * 60 * 60 * 1000 // 4 hours
      });
      return next();
    }
    return res.status(401).send('Invalid session key in query.');
  }

  // 2. Check if token is in cookie (used for all subsequent assets & APIs & WebSockets)
  if (req.cookies.stream_auth === activeKey) {
    return next();
  }

  return res.status(401).send('Unauthorized Access 401');
});

app.get('/stream.html', async (req, res, next) => {
  try {
    const url = 'http://127.0.0.1:8081/stream.html' + (req._parsedUrl.search || '');
    const response = await axios.get(url, { responseType: 'text' });
    let html = response.data;
    const injection = `<script>
      if (!localStorage.getItem('moonlight.bitrate')) {
        localStorage.setItem('moonlight.bitrate', '15000');
        localStorage.setItem('moonlight.width', '1920');
        localStorage.setItem('moonlight.height', '1080');
      }
    </script>`;
    html = html.replace('</body>', injection + '</body>');
    res.send(html);
  } catch (err) {
    next();
  }
});

const proxy = createProxyMiddleware({
  target: 'http://127.0.0.1:8081',
  changeOrigin: true,
  ws: true,
  logLevel: 'error',
  onProxyReq: (proxyReq, req, res) => {
    // Automatically log the user in as 'admin' in moonlight-web-stream
    proxyReq.setHeader('X-Forwarded-User', 'admin');
  },
  onProxyReqWs: (proxyReq, req, socket, options, head) => {
    proxyReq.setHeader('X-Forwarded-User', 'admin');
  },
  onProxyRes: (proxyRes, req, res) => {
    // Strip iframe-blocking headers so Noclip can embed the stream!
    delete proxyRes.headers['x-frame-options'];
    delete proxyRes.headers['content-security-policy'];
    delete proxyRes.headers['cross-origin-embedder-policy'];
    delete proxyRes.headers['cross-origin-opener-policy'];
  },
  onError: (err, req, res) => {
    console.error('[Proxy Error]', err.message);
    if (!res.headersSent) {
      res.status(502).json({ error: 'Stream server not responding', detail: err.message });
    }
  }
});

app.use('/', proxy);

// Configure moonlight-web-stream to listen on 127.0.0.1:8081 and start Proxy

try {
  // First, kill any existing web-server.exe so port 8080 is freed
  exec('taskkill /F /IM web-server.exe 2>nul', { windowsHide: true }, () => {

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

      // Fallback: If third-party cookies are blocked, check the Referer header!
      // The iframe loads stream.html?sessionKey=... which initiates the WebSocket.
      let refererKey = null;
      if (req.headers.referer) {
        try {
          const url = new URL(req.headers.referer);
          refererKey = url.searchParams.get('sessionKey');
        } catch (e) { }
      }

      if (cookies.stream_auth !== activeKey && refererKey !== activeKey) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      // Forward WebSocket to HttpProxyMiddleware!
      proxy.upgrade(req, socket, head);
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

    // Start web-server.exe robustly using PowerShell (matches start_cloud_gaming.ps1)
    setTimeout(() => {
      exec(
        `Start-Process "${MOONLIGHT_WEB_SERVER_EXE}" -WorkingDirectory "${MOONLIGHT_DIR}" -WindowStyle Hidden`,
        { shell: 'powershell', windowsHide: true },
        (err) => {
          if (err) console.error('Failed to start web-server.exe via PowerShell:', err.message);
          else console.log('Started web-server.exe on 127.0.0.1:8081 via PowerShell');
        }
      );

      // Auto-Pairing Logic (wait 5s for discovery)
      setTimeout(async () => {
        try {
          const authHeaders = { headers: { 'X-Forwarded-User': 'admin' } };
          let hostsRes;
          try {
            hostsRes = await axios.get('http://127.0.0.1:8081/api/hosts', authHeaders);
          } catch (e) {
            console.error(`[Auto-Pair] Error fetching /api/hosts: ${e.message}`);
            throw e;
          }

          // Delete ALL unusable hosts to prevent HTTPS cert issues and zombie hosts
          let existingPairedHostId = null;
          if (hostsRes.data && hostsRes.data.hosts) {
            for (const h of hostsRes.data.hosts) {
              let isReallyPaired = false;
              if (h.paired === 'Paired') {
                try {
                  const appsRes = await axios.get(`http://127.0.0.1:8081/api/apps?host_id=${h.host_id}`, authHeaders);
                  if (appsRes.data && appsRes.data.apps && appsRes.data.apps.length > 0) isReallyPaired = true;
                } catch (e) {
                  console.error(`[Auto-Pair] Error fetching /api/apps for host ${h.host_id}: ${e.message}`);
                }
              }

              if (isReallyPaired) {
                existingPairedHostId = h.host_id;
                continue; // Keep perfectly good paired hosts!
              }
              await axios.delete(`http://127.0.0.1:8081/api/host?host_id=${h.host_id}`, authHeaders).catch(() => { });
            }
          } let hostId = existingPairedHostId;

          // Manually add host on HTTP port if we don't have a perfectly working paired host
          if (!hostId) {
            try {
              const addRes = await axios.post('http://127.0.0.1:8081/api/host', { address: '127.0.0.1', http_port: 47989 }, authHeaders);
              hostId = addRes.data.host.host_id;
            } catch (e) {
              console.error(`[Auto-Pair] Error POSTing /api/host: ${e.message}`);
              throw e;
            }
          }

          let isPaired = !!existingPairedHostId;

          if (!isPaired) {
            console.log(`[Auto-Pair] Host ${hostId} is not paired or has a stale certificate. Re-adding...`);

            if (hostId) {
              await axios.delete(`http://127.0.0.1:8081/api/host?host_id=${hostId}`, authHeaders).catch(() => { });
            }

            try {
              const addRes = await axios.post('http://127.0.0.1:8081/api/host', { address: '127.0.0.1', http_port: 47989 }, authHeaders);
              hostId = addRes.data.host.host_id;
            } catch (e) {
              console.error(`[Auto-Pair] Error POSTing fresh /api/host: ${e.message}`);
              throw e;
            }

            console.log(`[Auto-Pair] Fresh host added with ID ${hostId}. Requesting PIN...`);
            let pairRes;
            try {
              pairRes = await axios.post('http://127.0.0.1:8081/api/pair', { host_id: hostId }, {
                ...authHeaders,
                responseType: 'stream'
              });
            } catch (e) {
              console.error(`[Auto-Pair] Error POSTing /api/pair: ${e.message}`);
              throw e;
            }

            pairRes.data.on('data', async (chunk) => {
              const text = chunk.toString().trim();
              if (!text) return;

              const lines = text.split('\n');
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
      }, 2000);

    }, 1500);
  });
} catch (err) {
  console.error('Failed to execute proxy startup sequence:', err.message);
}


// 6. On startup: POST to process.env.BACKEND_URL/instance/ready
async function notifyBackendReady() {
  if (!BACKEND_URL) return;
  try {
    await axios.post(`${BACKEND_URL}/instance/ready`, {
      instanceId: awsInstanceId,
      agentUrl: process.env.NGROK_DOMAIN
    }, {
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
      instanceId: awsInstanceId,
      agentUrl: process.env.NGROK_DOMAIN,
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
      await axios.post(`${BACKEND_URL}/instance/interruption`, { instanceId: awsInstanceId }, {
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
        instanceId: awsInstanceId,
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
