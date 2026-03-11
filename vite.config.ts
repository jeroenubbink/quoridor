import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    // Some NDK/nostr-tools deps reference `global` — map it to globalThis
    global: 'globalThis',
  },
})
