// Purpose: Build the JavaScript package entry and its compiler-owned Tea libraries.

import {copyFileSync, mkdirSync, readdirSync, rmSync} from 'node:fs';
import {build} from 'esbuild';

rmSync('dist', {force: true, recursive: true});
await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/loader/index.js',
  bundle: true,
  format: 'esm',
  packages: 'external',
  platform: 'node',
});

mkdirSync('dist/tea-lib', {recursive: true});
for (const filename of readdirSync('src/tea-lib')) {
  if (filename.endsWith('.tea')) {
    copyFileSync(`src/tea-lib/${filename}`, `dist/tea-lib/${filename}`);
  }
}
