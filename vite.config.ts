import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // just-bash's browser bundle imports node:zlib for gzip commands —
      // give it the fflate-backed shim instead
      'node:zlib': fileURLToPath(new URL('./src/shell/zlib-shim.ts', import.meta.url)),
    },
  },
  server: {
    // README, all e2e scripts and the preview probes agree on :5199 —
    // pin it so plain `pnpm dev` lands there instead of vite's :5173
    port: 5199,
    fs: { allow: ['..'] },
  },
  worker: { format: 'es' },
})
