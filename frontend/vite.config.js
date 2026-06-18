import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite dev server proxies API + WebSocket traffic to the FastAPI backend (port 5000),
// so the React app can call /api, /assist, /transcript, /stream the same way the
// backend serves them in production.
// Production builds live under https://mrr-process-tracker.joulestowatts.com/ai-interview-agent/
// (Caddy strips the prefix before proxying to FastAPI), hence the prod-only base.
export default defineConfig(({ mode }) => ({
  base: mode === 'production' ? '/ai-interview-agent/' : '/',
  plugins: [react()],
  server: {
    port: 5173,
    host: '0.0.0.0',
    proxy: {
      '/api':        { target: 'http://localhost:5000', changeOrigin: true },
      '/assist':     { target: 'http://localhost:5000', changeOrigin: true },
      '/transcript': { target: 'http://localhost:5000', changeOrigin: true },
      '/health':     { target: 'http://localhost:5000', changeOrigin: true },
      '/stream':     { target: 'ws://localhost:5000',   ws: true, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
}));
