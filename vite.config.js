import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';

const examplesDir = path.resolve('./examples');
const htmlInputs = Object.fromEntries(
  fs
    .readdirSync(examplesDir)
    .filter((name) => name.endsWith('.html'))
    .map((name) => [name.replace(/\.html$/, ''), path.resolve(examplesDir, name)]),
);

export default defineConfig({
  root: examplesDir,
  base: './',
  publicDir: path.resolve('./data'),
  resolve: {
    alias: {
      '3d-tiles-rendererjs-3dgs-plugin': path.resolve('./src/index.ts'),
    },
  },
  server: {
    open: '/index.html',
    fs: {
      allow: [path.resolve('.')],
    },
  },
  build: {
    outDir: path.resolve('./examples/bundle'),
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: htmlInputs,
    },
  },
});
