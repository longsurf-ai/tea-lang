// Purpose: Run the pinned Mintlify CLI from the docs project directory.

import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '../..');
const DOCS_ROOT = path.join(ROOT, 'docs');
const executable = process.platform === 'win32' ? 'npx.cmd' : 'npx';

const major = Number.parseInt(process.versions.node.split('.')[0]!, 10);
if (major % 2 !== 0) {
  throw new Error(
    `Mintlify requires an LTS Node release; found ${process.version}. Use Node 20, 22, or 24.`,
  );
}

const child = spawn(
  executable,
  ['--yes', '--package=mint@4.2.812', '--', 'mint', ...process.argv.slice(2)],
  {
    cwd: DOCS_ROOT,
    env: {
      ...process.env,
      PATH: [path.dirname(process.execPath), process.env['PATH'] ?? ''].join(
        path.delimiter,
      ),
      DO_NOT_TRACK: process.env['DO_NOT_TRACK'] ?? '1',
    },
    stdio: 'inherit',
  },
);

child.on('error', error => {
  console.error(`tea docs: could not start Mintlify: ${error.message}`);
  process.exitCode = 1;
});

child.on('exit', (code, signal) => {
  if (signal !== null) {
    console.error(`tea docs: Mintlify stopped after signal ${signal}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});
