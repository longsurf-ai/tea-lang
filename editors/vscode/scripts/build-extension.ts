// Purpose: Bundle the activated extension and stage the pinned offline Plotly asset.

import {copyFileSync, mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {build} from 'esbuild';

async function main(): Promise<void> {
  const extensionRoot = resolve(__dirname, '..');
  const repositoryRoot = resolve(extensionRoot, '../..');
  const outputDirectory = resolve(extensionRoot, 'dist');
  const mediaDirectory = resolve(extensionRoot, 'media');

  mkdirSync(outputDirectory, {recursive: true});
  mkdirSync(mediaDirectory, {recursive: true});

  await build({
    entryPoints: [resolve(extensionRoot, 'src/extension.ts')],
    outdir: outputDirectory,
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    external: ['vscode'],
    sourcemap: false,
    logLevel: 'info',
  });

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
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
