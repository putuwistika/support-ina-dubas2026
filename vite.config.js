import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    proxy: {
      '/api': {
        target: 'https://voteqrisbali.com',
        changeOrigin: true,
        secure: true,
      },
      '/event': {
        target: 'https://voteqrisbali.com',
        changeOrigin: true,
        secure: true,
      },
    },
  },
})
