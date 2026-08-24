// PM2 ecosystem — NO secrets here. Secrets live in /etc/learning-core/env
// (mode 600, owned by the service user) and are loaded via env_file.
module.exports = {
  apps: [
    {
      name: 'learning-core',
      script: 'src/server.js',
      cwd: '/opt/learning-core',
      instances: 2,
      exec_mode: 'cluster',
      max_memory_restart: '512M',
      // Secrets are read by src/config.js from /etc/learning-core/env (600, service user).
      env: { NODE_ENV: 'production' },
    },
  ],
};
