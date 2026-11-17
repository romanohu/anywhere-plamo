import { defineConfig } from 'vite';

export default defineConfig({
  root: 'gui/web',
  build: { outDir: '../../dist', emptyOutDir: true },
});
