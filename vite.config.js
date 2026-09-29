import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: {
    extensions: ['.js', '.jsx', '.json'],
  },
  server: {
    port: 5173,
    proxy: process.env.AOG_API_PROXY
      ? { '/api': { target: process.env.AOG_API_PROXY, changeOrigin: true } }
      : undefined,
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
