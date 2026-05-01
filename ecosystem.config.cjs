const path = require('node:path');
const os = require('node:os');

const zylosDir = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const dataDir = path.join(zylosDir, 'components', 'dashboard');

module.exports = {
  apps: [
    {
      name: 'zylos-dashboard',
      script: 'src/index.js',
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
        ZYLOS_DIR: zylosDir,
        DASHBOARD_PORT: process.env.DASHBOARD_PORT || '3470'
      },
      out_file: path.join(dataDir, 'logs', 'out.log'),
      error_file: path.join(dataDir, 'logs', 'error.log'),
      max_restarts: 10,
      restart_delay: 5000,
      watch: [path.join(dataDir, 'config.json')],
      ignore_watch: ['node_modules', 'public', 'docs']
    }
  ]
};
