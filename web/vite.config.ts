import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// The dashboard is served by the backend under /app (same origin, B2). In development Vite
// forwards the API calls to the local backend, so the browser still sees a single origin.
const api = process.env.SINFONIA_API ?? 'http://localhost:3000';
const proxied = ['/auth', '/practices', '/compliance', '/members', '/readyz'];

export default defineConfig({
  base: '/app/',
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: Object.fromEntries(proxied.map((path) => [path, { target: api, changeOrigin: false }])),
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.tsx', 'src/**/*.test.ts'],
    setupFiles: ['./src/test/setup.ts'],
  },
});
