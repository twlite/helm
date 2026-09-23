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
  },
  preview: {
    port: 4173,
  },
});
