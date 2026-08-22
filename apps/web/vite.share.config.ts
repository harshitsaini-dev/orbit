import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The share page's viewer, built on its own.
 *
 * Separate from the application build for two reasons: it is served by the API
 * rather than by whatever serves the workspace, and it has no service worker,
 * no router and no session - it is one file on one page for a stranger.
 *
 * It shares the components, though, which is the entire point: a shared PDF or
 * spreadsheet opens the way its owner sees it, from one implementation.
 */
export default defineConfig({
  plugins: [react()],
  // Chunks and the pdf.js worker are fetched relative to this, and the API
  // serves that path from the directory below.
  base: '/s/asset/',
  build: {
    outDir: '../server/public/share',
    emptyOutDir: true,
    sourcemap: true,
    // The server reads this to find the hashed entry file rather than guessing.
    manifest: true,
    rollupOptions: { input: 'src/share.tsx' },
  },
});
