import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const WEB_PORT = Number(process.env.ORBIT_WEB_PORT ?? 5173);
const API_PORT = process.env.ORBIT_API_PORT ?? '8787';
const API_TARGET = `http://localhost:${API_PORT}`;

export default defineConfig({
  // pdf.js is imported dynamically, so Vite only discovers it the first time
  // someone opens a PDF - and re-optimising mid-session forces a full page
  // reload, which aborts whatever navigation was in flight. Pre-bundling it at
  // server start costs a moment once instead.
  optimizeDeps: { include: ['pdfjs-dist'] },
  plugins: [
    react(),
    VitePWA({
      /*
       * 'prompt', not 'autoUpdate'.
       *
       * autoUpdate installs the new build silently and hands it to the *next*
       * navigation, so a tab left open keeps running the bundle it loaded with
       * and nothing on screen says so - which reads as "the deploy did not
       * happen" when the deploy happened fine.
       *
       * 'prompt' is what makes onNeedRefresh fire, so UpdatePrompt can say a
       * new version is ready and let the reader choose the moment. A page that
       * refreshes itself mid-upload is worse than one a version behind.
       */
      registerType: 'prompt',
      // Without this the service worker only exists in a production build, so
      // the browser never offers to install the app while developing - and the
      // Install button could never be seen or tried locally.
      //
      // Off under Playwright: a service worker installing on first navigation
      // holds the `load` event open long enough for the suite to time out, and
      // then serves later navigations from its own cache, which is exactly the
      // kind of state a test run must not carry between cases.
      devOptions: { enabled: process.env.ORBIT_E2E !== 'true', type: 'module' },
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
      /*
       * A regex, and for the same reason as `/s` below: Vite matches a string
       * key by prefix, so '/auth' also caught `/authorize` - the app's own
       * OAuth consent screen - and handed it to the API, which answered with
       * its 404. Only in development, since production serves the two from
       * different origins and nothing proxies at all.
       */
      '^/auth(/|$)': { target: API_TARGET, changeOrigin: true },
      '/health': { target: API_TARGET, changeOrigin: true },
      /*
       * Share pages, and the QR image the share dialog embeds.
       *
       * Without this the dialog's <img> asks Vite for /s/<id>/qr, gets the SPA
       * index.html back, and shows a broken image - only in development, since
       * production serves both from one origin.
       *
       * A regex, not the string '/s'. Vite matches a string key by prefix, and
       * it serves its own modules from /src/ - so '/s' sent the entire
       * application to the API and left a blank page.
       */
      '^/s/': { target: API_TARGET, changeOrigin: true },
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
