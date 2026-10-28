// PM2: `pm2 start ecosystem.config.cjs`. Оба процесса читают .env из папки проекта.
const fs = require('fs');
const path = require('path');

const cwd = __dirname;
const envFile = path.join(cwd, '.env');
const envText = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
// Релеер запускается, только если у него есть Telegram-сессия.
const hasRelayerSession = /^TG_USER_SESSION=\S+/m.test(envText) || fs.existsSync(path.join(cwd, 'tg-user.session'));

const common = {
  cwd,
  node_args: '--env-file=.env',
  autorestart: true,
  max_restarts: 50,
  restart_delay: 2000,
  max_memory_restart: '700M',
  time: true,
};

module.exports = {
  apps: [
    { ...common, name: 'giftpep-api', script: 'server.js' },
    ...(hasRelayerSession ? [{ ...common, name: 'giftpep-relayer', script: 'relayer.js' }] : []),
  ],
};
