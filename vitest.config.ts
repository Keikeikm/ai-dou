import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: { projects: [
    { test: { name: 'server', include: ['tests/*.test.ts'], environment: 'node' } },
    { esbuild: { jsx: 'automatic' }, test: { name: 'client', include: ['tests/client/**/*.test.ts', 'tests/client/**/*.test.tsx'], environment: 'jsdom' } },
  ] },
});
