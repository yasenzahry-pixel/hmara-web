const { defineConfig } = require('vite');
const react = require('@vitejs/plugin-react');

module.exports = defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: true,
    proxy: {
      '/config': 'http://localhost:3000',
      '/info': 'http://localhost:3000',
      '/download': 'http://localhost:3000',
      '/downloads': 'http://localhost:3000',
      '/download-thumbnail': 'http://localhost:3000',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
