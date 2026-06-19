// pm2 process model for the RecruitAssist monorepo.
//   recruitassist-api    — Fastify HTTP+WS+SSE on :8787 (tsx, not the broken `node --loader tsx`)
//   recruitassist-worker — BullMQ worker (post-call chain, kb-ingest, etc.)
//   recruitassist-web    — Vite-built SPA served by `vite preview` on :8084
// Postgres(pgvector) + Redis run as Docker containers (docker-compose.yml).
// Env for api/worker is loaded by each app from the root .env via dotenv;
// the web's VITE_* vars are baked at build time (also from the root .env).
const ROOT = __dirname;
const NODE_BIN = '/home/ubuntu/.nvm/versions/node/v24.15.0/bin';

module.exports = {
  apps: [
    {
      name: 'recruitassist-api',
      cwd: `${ROOT}/apps/api`,
      script: `${ROOT}/node_modules/.bin/tsx`,
      args: 'src/index.ts',
      interpreter: 'none',
      env: { PATH: `${NODE_BIN}:${process.env.PATH}` },
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
    },
    {
      name: 'recruitassist-worker',
      cwd: `${ROOT}/apps/worker`,
      script: `${ROOT}/node_modules/.bin/tsx`,
      args: 'src/index.ts',
      interpreter: 'none',
      env: { PATH: `${NODE_BIN}:${process.env.PATH}` },
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
    },
    {
      name: 'recruitassist-web',
      cwd: `${ROOT}/apps/web`,
      script: `${ROOT}/apps/web/node_modules/.bin/vite`,
      args: 'preview --port 8084 --host 0.0.0.0',
      interpreter: 'none',
      env: { PATH: `${NODE_BIN}:${process.env.PATH}`, WEB_PORT: '8084' },
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
    },
  ],
};
