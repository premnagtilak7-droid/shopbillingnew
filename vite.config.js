import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // GenSpark previews use dynamic sandbox hostnames.
    allowedHosts: true,
  },
  build: {
    target: 'es2020',
  },
})
