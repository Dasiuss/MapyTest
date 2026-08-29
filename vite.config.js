import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  base: '/MapyTest/',
  plugins: [react()],
  build: {
    outDir: 'docs',
  },
  server: {
    hmr: false,
  },
})
