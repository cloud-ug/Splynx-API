import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Override for LAN/remote dev with VITE_API_HOST (e.g. http://10.12.11.30:4000)
      '/api': process.env.VITE_API_HOST || 'http://localhost:4000',
    },
  },
});
