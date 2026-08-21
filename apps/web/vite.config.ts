import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const WEB_PORT = Number(process.env.ORBIT_WEB_PORT ?? 5173);
const API_PORT = process.env.ORBIT_API_PORT ?? '8787';
const API_TARGET = `http://localhost:${API_PORT}`;

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png', 'og-image.png'],
      manifest: {
        name: 'Orbit',
        short_name: 'Orbit',
        description: 'One workspace for every cloud drive you own.',
        theme_color: '#151824',
        background_color: '#eef1f6',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
  server: {
    port: WEB_PORT,
    strictPort: true,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
      '/auth': { target: API_TARGET, changeOrigin: true },
      '/health': { target: API_TARGET, changeOrigin: true },
      '/ws': { target: `ws://localhost:${API_PORT}`, ws: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        // three.js is only needed by the hero; keep it out of the app entry chunk.
        manualChunks: { three: ['three'] },
      },
    },
  },
});
