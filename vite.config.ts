import { defineConfig } from 'vite';

export default defineConfig({
  base: '/Web3DRPG/',
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
});
