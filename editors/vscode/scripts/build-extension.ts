// Purpose: Bundle the activated extension and stage the pinned offline Plotly asset.

import {copyFileSync, mkdirSync} from 'node:fs';
import {resolve} from 'node:path';

const extensionRoot = resolve(import.meta.dir, '..');
const repositoryRoot = resolve(extensionRoot, '../..');
const outputDirectory = resolve(extensionRoot, 'dist');
const mediaDirectory = resolve(extensionRoot, 'media');

mkdirSync(outputDirectory, {recursive: true});
mkdirSync(mediaDirectory, {recursive: true});

const build = await Bun.build({
  entrypoints: [resolve(extensionRoot, 'src/extension.ts')],
  outdir: outputDirectory,
  target: 'node',
  format: 'cjs',
  external: ['vscode'],
  sourcemap: 'none',
});

if (!build.success) {
  for (const message of build.logs) console.error(message);
  process.exit(1);
}

const plotlyDirectory = resolve(
  repositoryRoot,
  'node_modules/plotly.js-gl3d-dist-min',
);
copyFileSync(
  resolve(plotlyDirectory, 'plotly-gl3d.min.js'),
  resolve(mediaDirectory, 'plotly-gl3d.min.js'),
);
copyFileSync(
  resolve(plotlyDirectory, 'LICENSE'),
  resolve(mediaDirectory, 'plotly.LICENSE.txt'),
);
