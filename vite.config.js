import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: '0.0.0.0',
    allowedHosts: ['.e2b.app'],
  },
  preview: {
    host: '0.0.0.0',
    allowedHosts: ['.e2b.app'],
  },
  // The PDF renderer is loaded only when exporting, so keep its larger chunk separate.
  build: {
    chunkSizeWarningLimit: 1000,
  },
});
