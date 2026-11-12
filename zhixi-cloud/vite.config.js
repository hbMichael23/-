import { defineConfig } from 'vite';

export default defineConfig({
  // 相对路径便于静态托管、Tauri 和 Capacitor 同时复用同一份 dist。
  base: './',
  server: {
    port: 5173,
    strictPort: true
  },
  preview: {
    port: 4173,
    strictPort: true
  },
  build: {
    outDir: 'dist',
    target: 'es2020',
    cssCodeSplit: false,
    sourcemap: false
  }
});
