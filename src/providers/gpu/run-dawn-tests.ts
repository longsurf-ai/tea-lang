// Purpose: Run the real Dawn integration gate with the same Node 22 discovery policy as the GPU CLI.

import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {findNode22Executable} from './node-host';

const node = findNode22Executable();
if (node === null) {
  console.error(
    'tea: GPU tests require Node 22; install it or set TEA_GPU_NODE to its executable',
  );
  process.exit(1);
}

const root = fileURLToPath(new URL('../../..', import.meta.url));
const tests = [
  join(root, 'src/runtime/gpu/dawn.integration.ts'),
  join(root, 'tests/examples.gpu.integration.ts'),
];
const result = spawnSync(
  node,
  ['--import', 'tsx', '--test', '--test-concurrency=1', ...tests],
  {
    cwd: root,
    stdio: 'inherit',
  },
);
if (result.error !== undefined) {
  throw result.error;
}
if (result.signal !== null) {
  console.error(`tea: Node GPU test host exited with signal ${result.signal}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
