import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { uiSecurityHeaders, uiSecurityPlugin } from './server/ui-security.ts';

export default defineConfig({
  plugins: [react(), uiSecurityPlugin()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    cors: false,
    headers: uiSecurityHeaders,
    proxy: { '/api': { target: 'http://127.0.0.1:3001', changeOrigin: false } },
  },
  preview: { host: '127.0.0.1', cors: false, headers: uiSecurityHeaders },
});
