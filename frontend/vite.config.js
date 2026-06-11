import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite dev server proxies API + WebSocket traffic to the FastAPI backend (port 3001),
// so the React app can call /api, /assist, /transcript, /stream the same way the
// backend serves them in production.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: 'localhost',
    proxy: {
      '/api':        { target: 'http://localhost:3001', changeOrigin: true },
      '/assist':     { target: 'http://localhost:3001', changeOrigin: true },
      '/transcript': { target: 'http://localhost:3001', changeOrigin: true },
      '/health':     { target: 'http://localhost:3001', changeOrigin: true },
      '/stream':     { target: 'ws://localhost:3001',   ws: true, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
