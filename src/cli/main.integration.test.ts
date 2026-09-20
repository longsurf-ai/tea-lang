import {spawn, spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, test} from 'vitest';
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-languageserver/node';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '../..');
const MAIN = join(ROOT, 'src/main.ts');
const SOURCE = join(ROOT, 'tests/fixtures/cli/parameter-report.tea');
const DATA = join(ROOT, 'tests/fixtures/cli/data.csv');

type Result = Readonly<{
  status: number | null;
  stdout: string;
  stderr: string;
}>;

function invokeCli(...args: readonly string[]): Result {
  const result = spawnSync(
    process.env['TEA_TEST_NODE'] ?? 'node',
    ['--import', import.meta.resolve('tsx'), MAIN, ...args],
    {cwd: ROOT, encoding: 'utf8'},
  );
  return {status: result.status, stdout: result.stdout, stderr: result.stderr};
}

function cli(...args: readonly string[]): string {
  const result = invokeCli(...args);
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

describe('CLI Batch Recipe', () => {
  test('help exposes only the concrete command surface', () => {
    const result = invokeCli('--help');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('run');
    expect(result.stdout).toContain('build');
    expect(result.stdout).toContain('parse');
    expect(result.stdout).toContain('docs');
    expect(result.stdout).toContain('lsp');
    expect(result.stdout).not.toMatch(/^\s+execute\b/m);
    expect(result.stdout).not.toMatch(/^\s+sweep\b/m);
    expect(result.stderr).toBe('');
  });

  test('run binds a CSV DataStream and source parameters', () => {
    const output = cli('run', SOURCE, '-i', DATA, '-scale', '3');
    expect(output).toContain('# System');
    expect(output).toMatch(/^indices\s+2$/m);
    expect(output).toMatch(/^compilation\s+\d+\.\d{2} ms$/m);
    expect(output).toMatch(/^execution\s+\d+\.\d{2} ms$/m);
    expect(output).toContain('# Parameters');
    expect(output).toContain('scale');
    expect(output).toContain('# Outputs');
    expect(output).toContain('output0');
    expect(output).toContain('effect0');
    expect(output).toContain('{"value":6}');
  });

  test('run preserves negative values and long parameter names', () => {
    const output = cli(
      'run',
      SOURCE,
      '-i',
      DATA,
      '-scale',
      '-0.5',
      '--initial_cash',
      '2',
    );
    expect(output).toContain('scale');
    expect(output).toContain('-0.5');
    expect(output).toContain('initial_cash');
    expect(output).toContain('{"value":1.5}');
  });

  test('expected failures are concise and do not expose stacks', () => {
    const result = invokeCli('run', SOURCE, '-i', DATA, '--missing', '1');
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("tea: unknown parameter option '--missing'\n");
    expect(result.stderr).not.toContain('\n    at ');
  });
  test('reports semantic parameter failures from module.bind without a stack', () => {
    const result = invokeCli('run', SOURCE, '-i', DATA, '--scale', '5');
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("tea: parameter 'scale' above maxval 4\n");
    expect(result.stderr).not.toContain('\n    at ');
  });
});

// Every byte of `stdout` as `Content-Length` frames. Anything else in the
// stream, such as a stray print, fails the header match.
function protocolMessages(stdout: Buffer): {id?: number; method?: string}[] {
  const messages = [];
  for (let offset = 0; offset < stdout.length; ) {
    const headerEnd = stdout.indexOf('\r\n\r\n', offset);
    const header = stdout.subarray(offset, Math.max(headerEnd, offset));
    const length = /^Content-Length: (\d+)$/.exec(header.toString('latin1'));
    expect(length, `not a protocol header: '${header}'`).not.toBeNull();
    const body = headerEnd + 4;
    offset = body + Number(length?.[1]);
    messages.push(JSON.parse(stdout.subarray(body, offset).toString('utf8')));
  }
  return messages;
}

describe('tea lsp', () => {
  test('serves a session over stdio and writes only protocol bytes', async () => {
    const child = spawn(
      process.env['TEA_TEST_NODE'] ?? 'node',
      ['--import', import.meta.resolve('tsx'), MAIN, 'lsp', '--stdio'],
      {cwd: ROOT},
    );
    const stdout: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    const exited = once(child, 'exit');
    const client = createMessageConnection(
      new StreamMessageReader(child.stdout),
      new StreamMessageWriter(child.stdin),
    );
    // Bytes the reader cannot frame end the test here, not at its timeout.
    const unframed = new Promise<never>((_, reject) => {
      client.onError(([error]) => reject(error));
    });
    client.listen();

    const uri = 'file:///charts/fast.tea';
    const session = async (): Promise<unknown> => {
      const initialized = await client.sendRequest('initialize', {
        processId: null,
        rootUri: null,
        capabilities: {},
      });
      expect(initialized).toMatchObject({capabilities: {hoverProvider: true}});
      await client.sendNotification('initialized', {});
      await client.sendNotification('textDocument/didOpen', {
        textDocument: {
          uri,
          languageId: 'tea',
          version: 1,
          text: 'fast = ta.ema(close, 9)\n',
        },
      });
      const hover = await client.sendRequest('textDocument/hover', {
        textDocument: {uri},
        position: {line: 0, character: 0},
      });
      expect(hover).toMatchObject({
        contents: {value: '```tea\nseries float fast\n```'},
      });
      await client.sendRequest('shutdown');
      await client.sendNotification('exit');
      return (await exited)[0];
    };
    try {
      expect(await Promise.race([session(), unframed])).toBe(0);
    } finally {
      client.dispose();
      child.kill();
    }
    // initialize, hover and shutdown were answered. A slow machine may also
    // reach the diagnostics debounce before the exit.
    expect(
      protocolMessages(Buffer.concat(stdout))
        .map(message => message.id ?? message.method)
        .filter(said => said !== 'textDocument/publishDiagnostics'),
    ).toEqual([0, 1, 2]);
  }, 30_000);
});
