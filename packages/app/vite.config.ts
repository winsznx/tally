import { defineConfig } from 'vite';
import topLevelAwait from 'vite-plugin-top-level-await';
import wasm from 'vite-plugin-wasm';

export default defineConfig({
  plugins: [wasm(), topLevelAwait()],
  build: { target: 'esnext' },
  optimizeDeps: { exclude: ['@nimiq/core'] },
  worker: { format: 'es', plugins: () => [wasm(), topLevelAwait()] },
  server: { host: true, port: 5174 },
});
