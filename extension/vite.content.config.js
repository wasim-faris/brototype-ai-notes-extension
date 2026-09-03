// Build #2: the content script.
// Content scripts are injected as CLASSIC scripts - they cannot use import/export
// at runtime. So this is bundled separately into one self-contained IIFE file.
import { defineConfig } from 'vite'
import { resolve } from 'node:path'

export default defineConfig({
  // Same flag as the app build: development-only diagnostics are compiled out
  // of a release content script.
  define: { __DEV_BUILD__: JSON.stringify(process.env.__BUILD_IS_DEV !== 'false') },
  build: {
    outDir: process.env.__BUILD_OUT_DIR || 'dist',
    emptyOutDir: false, // build #1 already emptied it; don't wipe its output
    sourcemap: process.env.__BUILD_IS_DEV !== 'false',
    lib: {
      entry: resolve(import.meta.dirname, 'src/content/index.js'),
      name: 'BrototypeAiNotes',
      formats: ['iife'],
      fileName: () => 'content.js',
    },
  },
})
