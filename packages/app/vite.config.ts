import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import topLevelAwait from 'vite-plugin-top-level-await';
import wasm from 'vite-plugin-wasm';

export default defineConfig({
  plugins: [react(), wasm(), topLevelAwait()],
  build: { target: 'esnext', sourcemap: true },
  optimizeDeps: { exclude: ['@nimiq/core'] },
  worker: { format: 'es', plugins: () => [wasm(), topLevelAwait()] },
  server: { host: true, port: 5174 },
});
