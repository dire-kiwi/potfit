import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiPort = Number(process.env.POTFIT_PORT ?? 5174);
// Proxy to the address the API listens on. Not "localhost", which can resolve
// to ::1 while the API is on 127.0.0.1. Wildcard binds are reachable on loopback.
const apiHost = process.env.POTFIT_HOST || '127.0.0.1';
const apiTarget = ['0.0.0.0', '::'].includes(apiHost) ? '127.0.0.1' : apiHost.includes(':') ? `[${apiHost}]` : apiHost;

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.POTFIT_WEB_PORT ?? 5173),
    proxy: {
      // changeOrigin stays off so the API sees the browser's localhost Host header.
      '/api': { target: `http://${apiTarget}:${apiPort}`, changeOrigin: false },
    },
  },
  worker: { format: 'es' },
  // three.js alone is most of the bundle; splitting it buys nothing for a local tool.
  build: { chunkSizeWarningLimit: 1500 },
});
