import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  root: 'client',
  plugins: [react()],
  build: { outDir: '../dist/client', emptyOutDir: true },
  server: { host: '127.0.0.1', hmr: { host: '127.0.0.1' }, fs: { strict: true, allow: [resolve('client'), resolve('shared'), resolve('node_modules')] } },
});
