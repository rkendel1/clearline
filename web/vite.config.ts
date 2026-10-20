import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev: `npm run dev` in web/ proxies the API (default http://localhost:8080). Production: the API serves web/dist itself.
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', sourcemap: false, target: 'es2022' },
  server: { port: 5173, proxy: { '/api': process.env.CLEARLINE_URL ?? 'http://localhost:8080' } },
  test: { environment: 'node' },
});
