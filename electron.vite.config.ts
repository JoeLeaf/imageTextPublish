import {defineConfig, externalizeDepsPlugin} from 'electron-vite';
import react from '@vitejs/plugin-react';
import {resolve} from 'node:path';
export default defineConfig({
  main: {plugins: [externalizeDepsPlugin()], build: {outDir: 'dist-electron/main', rollupOptions: {input: resolve('src/main/index.ts')}}},
  preload: {plugins: [externalizeDepsPlugin()], build: {outDir: 'dist-electron/preload', rollupOptions: {input: resolve('src/preload/index.ts'), output: {format: 'cjs', entryFileNames: 'index.cjs'}}}},
  renderer: {root: '.', plugins: [react()], build: {outDir: 'dist', rollupOptions: {input: resolve('index.html')}}}
});
