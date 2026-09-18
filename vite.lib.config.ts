import { defineConfig } from 'vite'
import { resolve } from 'node:path'

/**
 * Library build for npm publish.
 * three / fflate stay external — consumers provide three (peer) and fflate (dep).
 */
export default defineConfig({
  // Do not copy public/ (demo models) into the npm package
  publicDir: false,
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2020',
    sourcemap: true,
    minify: 'esbuild',
    // Inline original UI icons / dial art so npm package is self-contained
    assetsInlineLimit: 8 * 1024 * 1024,
    lib: {
      entry: {
        'mivo-model-viewer': resolve(__dirname, 'src/index.ts'),
        'mivo-model-viewer-core': resolve(__dirname, 'src/core/index.ts')
      },
      formats: ['es']
    },
    rollupOptions: {
      external: (id) =>
        id === 'three' ||
        id.startsWith('three/') ||
        id === 'fflate' ||
        id.startsWith('fflate/'),
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name][extname]'
      }
    }
  }
})
