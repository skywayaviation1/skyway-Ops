import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { devApiPlugin } from './vite-dev-api-plugin.js';

export default defineConfig({
  plugins: [react(), devApiPlugin()],
  resolve: {
    extensions: ['.js', '.jsx', '.json'],
  },
  server: {
    port: 5173,
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
