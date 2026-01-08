import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api/chatbot': {
        target: 'https://primary-production-6722.up.railway.app',
        changeOrigin: true,
        secure: false,
        timeout: 30_000,
        proxyTimeout: 30_000,
        rewrite: (path) => path.replace(/^\/api\/chatbot/, '/webhook/ChatBot'),
      },
    },
  },
  optimizeDeps: {
    exclude: ['lucide-react'],
  },
});
