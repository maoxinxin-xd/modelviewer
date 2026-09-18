import { defineConfig } from 'vite'

// Demo（dev + GitHub Pages）。库构建见 vite.lib.config.ts
export default defineConfig({
  server: {
    port: 5174,
    host: true
  },
  build: {
    target: 'es2020',
    sourcemap: true,
    // Pages 与 npm dist/ 分离，避免覆盖库产物
    outDir: 'dist-demo',
    emptyOutDir: true
  }
})
