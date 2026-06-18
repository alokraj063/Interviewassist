module.exports = {
  apps: [
    {
      name: 'interview-backend',
      cwd: '/home/ubuntu/Interviewassist/backend',
      script: '.venv/bin/python',
      args: 'server.py',
      interpreter: 'none',
      env: {
        PORT: '5000',
      },
      autorestart: true,
      max_restarts: 10,
      restart_delay: 2000,
    },
    {
      name: 'interview-frontend',
      cwd: '/home/ubuntu/Interviewassist/frontend',
      script: 'node_modules/.bin/vite',
      args: '--port 5173 --strictPort',
      interpreter: 'none',
      autorestart: true,
      max_restarts: 10,
      restart_delay: 2000,
    },
  ],
};
