// Purpose: Protocol test of startLanguageServer — a JSON-RPC client drives one session over an in-memory stream pair: capabilities, debounced versioned diagnostics, every position query, tea/libraryText, watched files, close, a forced compiler defect, and a connection disposed under a pending debounce.

import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {PassThrough} from 'node:stream';
import {setTimeout as sleep} from 'node:timers/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {afterAll, expect, test, vi} from 'vitest';
import {
  createConnection,
  createMessageConnection,
  MessageType,
  StreamMessageReader,
  StreamMessageWriter,
  type CompletionItem,
  type Hover,
  type Location,
  type LogMessageParams,
  type PublishDiagnosticsParams,
  type RegistrationParams,
  type SignatureHelp,
} from 'vscode-languageserver/node';
import type {PackageSource} from '../loader/loader';
import {startLanguageServer} from './server';

const {DEFECT} = vi.hoisted(() => ({DEFECT: '// force a compiler defect'}));

// No user text makes the compiler throw, so the defect is injected: the
// server sees the real analyze() except on a source carrying the marker.
vi.mock('./analysis', async importOriginal => {
  const original = await importOriginal<typeof import('./analysis')>();
  const {fatal} = await import('../base/print');
  return {
    ...original,
    analyze: (input: PackageSource) =>
      input.source.includes(DEFECT)
        ? fatal('forced by the test')
        : original.analyze(input),
  };
});

const URI = 'file:///charts/fast.tea';
const BROKEN = 'fast = ta.ema(close, 9)\nplot("fast", fasst)\n';
const FIXED = 'fast = ta.ema(close, 9)\nplot("fast", fast)\n';
const UNDECLARED = {
  range: {start: {line: 1, character: 13}, end: {line: 1, character: 18}},
  severity: 1,
  source: 'tea',
  message: "undeclared name 'fasst'",
};

// One session: a client and a server joined by two in-memory streams.
function connect() {
  const toServer = new PassThrough();
  const toClient = new PassThrough();
  const server = createConnection(
    new StreamMessageReader(toServer),
    new StreamMessageWriter(toClient),
  );
  const client = createMessageConnection(
    new StreamMessageReader(toClient),
    new StreamMessageWriter(toServer),
  );
  startLanguageServer(server);
  client.listen();
  return {server, client};
}

const {server, client} = connect();
afterAll(() => {
  client.dispose();
  server.dispose();
});

const published: PublishDiagnosticsParams[] = [];
const logged: LogMessageParams[] = [];
const registered: RegistrationParams[] = [];
let onPublished = (_: PublishDiagnosticsParams): void => {};
client.onNotification(
  'textDocument/publishDiagnostics',
  (params: PublishDiagnosticsParams) => {
    published.push(params);
    onPublished(params);
  },
);
client.onNotification('window/logMessage', (params: LogMessageParams) => {
  logged.push(params);
});
client.onRequest('client/registerCapability', (params: RegistrationParams) => {
  registered.push(params);
  return null;
});

// The next publishDiagnostics; ask before sending what causes it.
function nextPublished(): Promise<PublishDiagnosticsParams> {
  return new Promise(resolve => {
    onPublished = resolve;
  });
}

function change(version: number, text: string): Promise<void> {
  return client.sendNotification('textDocument/didChange', {
    textDocument: {uri: URI, version},
    contentChanges: [{text}],
  });
}

const at = (line: number, character: number) => ({
  textDocument: {uri: URI},
  position: {line, character},
});

test('initialize advertises exactly the supported capabilities', async () => {
  const result = await client.sendRequest('initialize', {
    processId: null,
    rootUri: null,
    capabilities: {
      workspace: {didChangeWatchedFiles: {dynamicRegistration: true}},
    },
  });
  expect(result).toEqual({
    capabilities: {
      textDocumentSync: {openClose: true, change: 1},
      hoverProvider: true,
      definitionProvider: true,
      referencesProvider: true,
      completionProvider: {triggerCharacters: ['.']},
      signatureHelpProvider: {triggerCharacters: ['(', ',']},
    },
  });
});

test('initialized registers the .tea file watcher the client offered', async () => {
  await client.sendNotification('initialized', {});
  await vi.waitFor(() => expect(registered).toHaveLength(1));
  expect(registered[0].registrations).toMatchObject([
    {
      method: 'workspace/didChangeWatchedFiles',
      registerOptions: {watchers: [{globPattern: '**/*.tea'}]},
    },
  ]);
});

test('didOpen publishes diagnostics with the document version', async () => {
  const next = nextPublished();
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {uri: URI, languageId: 'tea', version: 1, text: BROKEN},
  });
  expect(await next).toEqual({
    uri: URI,
    version: 1,
    diagnostics: [UNDECLARED],
  });
});

test('changes are debounced to the latest version', async () => {
  const next = nextPublished();
  await change(2, BROKEN.replace('fasst', 'fas'));
  await change(3, FIXED);
  expect(await next).toEqual({uri: URI, version: 3, diagnostics: []});
});

test('hover answers with the type of the name', async () => {
  const result: Hover | null = await client.sendRequest(
    'textDocument/hover',
    at(1, 14),
  );
  expect(result).toEqual({
    contents: {kind: 'markdown', value: '```tea\nseries float fast\n```'},
    range: {start: {line: 1, character: 13}, end: {line: 1, character: 17}},
  });
});

test('definition of a local stays in the document', async () => {
  const result: Location[] = await client.sendRequest(
    'textDocument/definition',
    at(1, 14),
  );
  expect(result).toEqual([
    {
      uri: URI,
      range: {start: {line: 0, character: 0}, end: {line: 0, character: 4}},
    },
  ]);
});

test('definition in tea-lib is a tea-lib: location tea/libraryText can show', async () => {
  const result: Location[] = await client.sendRequest(
    'textDocument/definition',
    at(0, 11),
  );
  expect(result).toHaveLength(1);
  const [{uri, range}] = result;
  expect(uri).toBe('tea-lib:/ta.tea');

  const text: string | null = await client.sendRequest('tea/libraryText', {
    uri,
  });
  const line = text?.split('\n')[range.start.line];
  expect(line?.slice(range.start.character, range.end.character)).toBe('ema');
});

test('tea/libraryText answers null for anything but a shipped library', async () => {
  for (const uri of ['tea-lib:/missing.tea', 'tea-lib:/../base/pos.ts', URI]) {
    expect(await client.sendRequest('tea/libraryText', {uri})).toBeNull();
  }
});

test('references pair every range with the document URI', async () => {
  const result: Location[] = await client.sendRequest(
    'textDocument/references',
    {...at(0, 0), context: {includeDeclaration: true}},
  );
  expect(result).toEqual([
    {
      uri: URI,
      range: {start: {line: 0, character: 0}, end: {line: 0, character: 4}},
    },
    {
      uri: URI,
      range: {start: {line: 1, character: 13}, end: {line: 1, character: 17}},
    },
  ]);
});

test('completion after "ta." answers against text not yet analyzed', async () => {
  await change(4, `${FIXED}slow = ta.`);
  const items: CompletionItem[] = await client.sendRequest(
    'textDocument/completion',
    at(2, 10),
  );
  expect(items.find(item => item.label === 'sma')).toMatchObject({
    detail: 'sma(source, length)',
  });
  expect(items.map(item => item.label)).not.toContain('fast');
});

test('signatureHelp marks the active parameter', async () => {
  await change(5, `${FIXED}slow = ta.sma(close, `);
  const help: SignatureHelp | null = await client.sendRequest(
    'textDocument/signatureHelp',
    at(2, 21),
  );
  expect(help).toMatchObject({
    signatures: [{label: 'sma(source, length)'}],
    activeSignature: 0,
    activeParameter: 1,
  });
});

test('didChangeWatchedFiles republishes every open document', async () => {
  const settled = nextPublished();
  await change(6, FIXED);
  expect(await settled).toEqual({uri: URI, version: 6, diagnostics: []});

  const next = nextPublished();
  await client.sendNotification('workspace/didChangeWatchedFiles', {
    changes: [{uri: 'file:///charts/lib.tea', type: 2}],
  });
  expect(await next).toEqual({uri: URI, version: 6, diagnostics: []});
});

test('a compiler defect is logged, keeps the diagnostics and the session', async () => {
  const before = nextPublished();
  await change(7, BROKEN);
  expect(await before).toMatchObject({version: 7, diagnostics: [UNDECLARED]});

  await change(8, `${BROKEN}${DEFECT}\n`);
  expect(await client.sendRequest('textDocument/hover', at(0, 0))).toBeNull();
  expect(logged).toContainEqual({
    type: MessageType.Error,
    message: expect.stringContaining('forced by the test'),
  });
  // Past the debounce, version 8 has published nothing.
  await sleep(300);
  expect(published.at(-1)).toMatchObject({version: 7});

  const after = nextPublished();
  await change(9, FIXED);
  expect(await after).toEqual({uri: URI, version: 9, diagnostics: []});
});

test('a document of another scheme is analyzed under its URI', async () => {
  const uri = 'untitled:Untitled-1';
  const next = nextPublished();
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {uri, languageId: 'tea', version: 1, text: BROKEN},
  });
  expect(await next).toEqual({uri, version: 1, diagnostics: [UNDECLARED]});
  const result: Location[] = await client.sendRequest(
    'textDocument/definition',
    {textDocument: {uri}, position: {line: 0, character: 0}},
  );
  expect(result.map(location => location.uri)).toEqual([uri]);
});

test('definition in an imported file of the user is a file: location', async () => {
  const imports = join(
    fileURLToPath(new URL('.', import.meta.url)),
    '../../tests/fixtures/imports',
  );
  const entry = join(imports, 'strategies/entry.tea');
  const uri = pathToFileURL(entry).href;
  const next = nextPublished();
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'tea',
      version: 1,
      text: readFileSync(entry, 'utf8'),
    },
  });
  expect(await next).toEqual({uri, version: 1, diagnostics: []});
  // Line 5 of the entry: `upper = bands.upper(10.0, 2.0)`.
  const result: Location[] = await client.sendRequest(
    'textDocument/definition',
    {textDocument: {uri}, position: {line: 4, character: 15}},
  );
  expect(result.map(location => location.uri)).toEqual([
    pathToFileURL(join(imports, 'strategies/lib/bands.tea')).href,
  ]);
  // Closing clears the diagnostics; take that publication so the next test
  // does not see it.
  const cleared = nextPublished();
  await client.sendNotification('textDocument/didClose', {textDocument: {uri}});
  expect(await cleared).toEqual({uri, diagnostics: []});
});

test('didClose clears the diagnostics and forgets the document', async () => {
  const next = nextPublished();
  await client.sendNotification('textDocument/didClose', {
    textDocument: {uri: URI},
  });
  expect(await next).toEqual({uri: URI, diagnostics: []});
  expect(await client.sendRequest('textDocument/hover', at(1, 14))).toBeNull();
});

test('no version was published out of order, and coalesced ones never', () => {
  const versions = published.flatMap(params =>
    params.uri === URI && params.version !== undefined ? [params.version] : [],
  );
  expect(versions).toEqual([1, 3, 6, 6, 7, 9]);
});

test('a debounce pending when the host disposes the connection is dropped', async () => {
  const session = connect();
  await session.client.sendRequest('initialize', {
    processId: null,
    rootUri: null,
    capabilities: {},
  });
  await session.client.sendNotification('textDocument/didOpen', {
    textDocument: {uri: URI, languageId: 'tea', version: 1, text: BROKEN},
  });
  // A hover proves the server has the document, so its debounce is running.
  await session.client.sendRequest('textDocument/hover', at(0, 0));
  session.client.dispose();
  session.server.dispose();
  // An uncaught throw from the timer would fail this run.
  await sleep(300);
});
