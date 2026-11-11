module.exports = {
  apps: [{
    name: 'optimizely-dashboard',
    cwd: __dirname,
    script: 'server.js',
    instances: 1,
    exec_mode: 'fork',
    watch: false,
    autorestart: true,
    restart_delay: 3000,
    max_memory_restart: '512M',
    env: {
      NODE_ENV: 'production',
      DASHBOARD_PORT: '17821',
      DASHBOARD_PUBLIC_URL: 'https://usifhqtsagrqt01.melaleuca.net/campaign-monitor/'
    }
  }]
};
