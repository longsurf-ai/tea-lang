// Purpose: Keep native Dawn outside Bun by relaying GPU CLI verbs to an installed Node 22 host.

import {spawn, spawnSync} from 'node:child_process';
import {existsSync, readdirSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {GpuDeviceError} from './dawn';

const RELAY_ENV = 'TEA_GPU_RELAYED';

export function needsNodeGpuHost(args: readonly string[]): boolean {
  const verb = args[0];
  if (args.includes('--help') || args.includes('-h')) return false;
  return (
    (verb === 'sweep' && !args.includes('--cpu')) ||
    (verb === 'run' && args.includes('--gpu'))
  );
}

// Returns null when no relay is needed; otherwise the child CLI's exit code.
// The Bun parent performs no compilation, binding, or presentation work.
export async function relayGpuCliToNode(
  args: readonly string[],
  mainModuleUrl: string,
): Promise<number | null> {
  if (
    process.versions.bun === undefined ||
    process.env[RELAY_ENV] === '1' ||
    !needsNodeGpuHost(args)
  ) {
    return null;
  }
  const node = findNode22Executable();
  if (node === null) {
    throw new GpuDeviceError(
      'GPU execution requires Node 22; install it or set TEA_GPU_NODE to its executable (or pass --cpu)',
    );
  }
  return await new Promise<number>((resolve, reject) => {
    const child = spawn(
      node,
      ['--import', 'tsx', fileURLToPath(mainModuleUrl), ...args],
      {
        stdio: 'inherit',
        env: {...process.env, [RELAY_ENV]: '1'},
      },
    );
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal !== null) {
        reject(
          new GpuDeviceError(`Node GPU host exited with signal ${signal}`),
        );
        return;
      }
      resolve(code ?? 1);
    });
  });
}

export function findNode22Executable(): string | null {
  const configured = process.env['TEA_GPU_NODE'];
  const candidates = configured === undefined ? [] : [configured];
  candidates.push('/opt/homebrew/opt/node@22/bin/node');
  candidates.push('/usr/local/opt/node@22/bin/node');
  candidates.push(...nvmNode22Candidates());
  candidates.push('node');
  for (const candidate of candidates) {
    if (candidate !== 'node' && !existsSync(candidate)) continue;
    const result = spawnSync(candidate, ['--version'], {encoding: 'utf8'});
    if (result.status === 0 && /^v22\./.test(result.stdout.trim())) {
      return candidate;
    }
  }
  return null;
}

function nvmNode22Candidates(): string[] {
  const root = join(homedir(), '.nvm', 'versions', 'node');
  if (!existsSync(root)) return [];
  return readdirSync(root, {withFileTypes: true})
    .filter(entry => entry.isDirectory() && /^v22\./.test(entry.name))
    .map(entry => entry.name)
    .sort((left, right) =>
      right.localeCompare(left, undefined, {numeric: true}),
    )
    .map(version => join(root, version, 'bin', 'node'));
}
