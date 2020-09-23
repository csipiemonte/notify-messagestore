module.exports = {
  apps : [{
    name: 'messagestore',
    cwd: '~/notify/messagestore/src',
    script: './messagestore.js',
    args: '',
    exec_mode:'cluster',
    instances: 1,
    autorestart: true,
    watch: true,
    max_memory_restart: '150M'
  }]
};
