// Purpose: Bundle the Node experiment while transforming TypeGPU functions into WGSL metadata.

import {fileURLToPath} from 'node:url';

import typegpu from 'unplugin-typegpu/vite';
import {defineConfig} from 'vite';

export default defineConfig({
  plugins: [typegpu()],
  build: {
    emptyOutDir: true,
    outDir: 'dist',
    ssr: fileURLToPath(new URL('./src/cli.ts', import.meta.url)),
    target: 'node22',
    rollupOptions: {
      external: ['webgpu'],
      output: {
        entryFileNames: 'cli.js',
      },
    },
  },
});
