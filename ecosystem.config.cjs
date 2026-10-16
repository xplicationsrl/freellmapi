module.exports = {
  apps: [{
    name: 'freellmapi',
    cwd: __dirname + '/server',
    script: 'dist/index.js',
    interpreter: require('os').homedir() + '/.local/node22/bin/node',
    env: { NODE_ENV: 'production' },
    max_memory_restart: '1G',
  }],
};
