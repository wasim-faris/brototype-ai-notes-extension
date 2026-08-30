// Build #1: the parts of the extension that are allowed to be ES modules.
// The app page is a normal HTML page, and an MV3 service worker can declare
// "type": "module", so both can share code through imports.
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  plugins: [react()],
  // The backend this build talks to, decided by build.js (see src/lib/env.js).
  // A release build contains only its own https URL - no development literal.
  define: {
    __BACKEND_URL__: JSON.stringify(process.env.__BUILD_BACKEND_URL || 'http://localhost:8787'),
    __DEV_BUILD__: JSON.stringify(process.env.__BUILD_IS_DEV !== 'false'),
  },
  build: {
    outDir: process.env.__BUILD_OUT_DIR || 'dist',
    emptyOutDir: true,
    // Chrome DevTools can read the extension source when something breaks.
    // Off for a release: the store package should carry only what runs.
    sourcemap: process.env.__BUILD_IS_DEV !== 'false',
    // Vite normally injects <link rel="modulepreload" crossorigin> hints. Inside
    // an extension page the real module request is not a CORS request, so the
    // preload never matches, Chrome discards it, and every chunk logs two
    // warnings on chrome://extensions. The imports still resolve at runtime -
    // the hints were only ever a network optimisation for the web.
    modulePreload: false,
    rollupOptions: {
      input: {
        // One app page serves the side panel, the detached window and the
        // options page - a single UI instead of a popup plus a settings tab.
        app: resolve(import.meta.dirname, 'app.html'),
        worker: resolve(import.meta.dirname, 'src/background/worker.js'),
      },
      output: {
        // manifest.json references these by name, so they must not be hashed.
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
        // Without this the React chunk inherits the name of whichever module
        // pulled it in first - it was called "styles-<hash>.js", which is
        // actively confusing when you are reading an error log.
        manualChunks: (id) => (id.includes('node_modules') ? 'vendor' : undefined),
      },
    },
  },
})
