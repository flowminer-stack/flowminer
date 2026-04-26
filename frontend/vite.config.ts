import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// When running inside docker compose (dev override), set
// VITE_API_PROXY_TARGET=http://backend:8000 so the Vite dev server's
// /api proxy lands on the backend container. Without docker, it
// defaults to http://localhost:8000.
const apiProxyTarget =
  process.env.VITE_API_PROXY_TARGET || 'http://localhost:8000';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: apiProxyTarget,
        changeOrigin: true,
      },
    },
  },
  build: {
    // Split heavy visualization libraries into their own chunks so the
    // initial load doesn't ship cytoscape + bpmn-js + recharts together.
    rollupOptions: {
      output: {
        manualChunks: {
          'cytoscape-chunk': ['cytoscape', 'cytoscape-dagre'],
          'charts-chunk': ['recharts'],
          'date-chunk': ['date-fns'],
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
        },
      },
    },
    chunkSizeWarningLimit: 800,
  },
});
