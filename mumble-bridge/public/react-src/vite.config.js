import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  build: {
    outDir: resolve(__dirname, '../react'),
    emptyDirBefore: true,
    lib: {
      entry: resolve(__dirname, 'src/index.jsx'),
      name: 'MumbleFeatures',
      fileName: () => 'features-bundle.js',
      formats: ['iife'],
    },
    rollupOptions: {
      // React is loaded from CDN in index.html to share with existing code
      external: [],
    },
    cssFileName: 'features-bundle.css',
  },
});
