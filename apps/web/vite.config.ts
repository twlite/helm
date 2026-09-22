import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // Streamdown is a peer-based React package. Explicit deduplication keeps
    // Vite from loading a second React module through pnpm's nested links.
    dedupe: ['react', 'react-dom'],
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.HELM_SERVER_URL ?? 'http://127.0.0.1:8787',
        changeOrigin: true,
        ws: true,
      },
    },
  },
  preview: {
    port: 4173,
  },
});
