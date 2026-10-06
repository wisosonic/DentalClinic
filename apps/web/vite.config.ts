/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180, // 5173 is commonly taken by other Vite projects
    strictPort: true,
    // Listen on every network interface, so phones and other computers on the same network can open
    // http://<this computer's address>:5180 (the default would answer only on this computer).
    host: true,
    // Same-origin in development, as in production behind a reverse proxy: cookies just work.
    proxy: { '/api': 'http://localhost:4000' },
  },
  build: {
    rollupOptions: {
      output: {
        // Vendor code changes rarely, so it is split out and stays cached between releases.
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined;
          const inPackage = (...names: string[]) => names.some((n) => id.includes(`node_modules/${n}/`));
          if (inPackage('react', 'react-dom', 'react-router', 'react-router-dom', 'scheduler')) return 'react';
          if (inPackage('@mui', '@emotion')) return 'mui';
          if (inPackage('@reduxjs', 'redux', 'react-redux', 'reselect', 'immer')) return 'redux';
          if (inPackage('i18next', 'react-i18next')) return 'i18n';
          return undefined;
        },
      },
    },
  },
  preview: { host: true, port: 5180, strictPort: true, proxy: { '/api': 'http://localhost:4000' } },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    // jsdom rendering MUI dialogs and the SVG chart is slow under load; this is not a hung test.
    testTimeout: 60000,
  },
});
