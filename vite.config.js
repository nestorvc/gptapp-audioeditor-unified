import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  root: path.resolve(__dirname, 'src/widgets'),
  build: {
    outDir: path.resolve(__dirname, 'dist/widgets'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        'audio-editor': path.resolve(__dirname, 'src/widgets/components/audio-editor/index.jsx'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: '[name]-[hash].js',
        assetFileNames: (assetInfo) => {
          if (assetInfo.name && assetInfo.name.endsWith('.css')) {
            return '[name].css';
          }
          return '[name].[ext]';
        },
      },
    },
  },
  server: {
    port: 3000,
    open: false,
  },
});

