import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The console is a plain SPA served on the site port (3000); the gateway keeps
 * port 8080 to itself.
 *
 * Everything under /v1 and /healthz is proxied to the real server rather than
 * mocked, so the pages develop against the same JSON they get in production.
 * In production the built assets can be served by the gateway itself (set
 * WEB_DIST), which makes it one origin and no CORS at all.
 */
const API_TARGET = process.env.VITE_API_TARGET ?? 'http://127.0.0.1:8080';

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.PORT ?? 3000),
    host: true,
    // The Niteshift preview reaches the dev server through an external
    // hostname; without this Vite rejects the Host header.
    allowedHosts: ['.preview.niteshift.dev', 'localhost'],
    proxy: {
      '/v1': { target: API_TARGET, changeOrigin: true },
      '/healthz': { target: API_TARGET, changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
