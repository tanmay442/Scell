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
    fs: { allow: ['..'] },
  },
  worker: { format: 'es' },
})
