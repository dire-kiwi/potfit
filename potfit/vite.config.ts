import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiPort = Number(process.env.POTFIT_PORT ?? 5174);

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.POTFIT_WEB_PORT ?? 5173),
    proxy: {
      '/api': { target: `http://localhost:${apiPort}`, changeOrigin: false },
    },
  },
  worker: { format: 'es' },
  // three.js alone is most of the bundle; splitting it buys nothing for a local tool.
  build: { chunkSizeWarningLimit: 1500 },
});
