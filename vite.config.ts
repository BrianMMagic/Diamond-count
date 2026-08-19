import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// The app is 100% client-side. `base: './'` keeps it deployable from any
// sub-path (GitHub Pages, a static bucket, or opened through a local server).
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  worker: {
    format: 'es',
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
