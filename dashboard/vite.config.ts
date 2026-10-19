import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the API runs on :8080; in production the API serves this build (same origin).
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': 'http://localhost:8080', '/healthz': 'http://localhost:8080', '/readyz': 'http://localhost:8080' } },
  build: { outDir: 'dist', sourcemap: false },
});
