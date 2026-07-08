const { Service } = require('node-windows');
const path = require('path');

// Registers agent/index.js as a Windows Service using node-windows.
const svc = new Service({
  name: 'CloudGamingAgent',
  description: 'Cloud gaming platform agent service',
  script: path.join(__dirname, 'index.js'),
  env: [
    { name: 'BACKEND_URL', value: process.env.BACKEND_URL || 'https://api.yourdomain.com' },
    { name: 'AGENT_SECRET', value: process.env.AGENT_SECRET || 'your-secret-here' },
    { name: 'SUNSHINE_PASS', value: process.env.SUNSHINE_PASS || 'sunshine-admin-pass' }
  ]
});

svc.on('install', () => {
  console.log('Service installed successfully, starting now...');
  svc.start();
});

svc.install();
