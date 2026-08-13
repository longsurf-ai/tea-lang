// Purpose: Serve one self-contained sweep view and its pinned Plotly asset on loopback.

import {createReadStream, statSync} from 'node:fs';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import {createRequire} from 'node:module';
import type {AddressInfo} from 'node:net';
import type {SweepResult} from '../reporting/sweep';
import {createSweepRendererModel, type SweepRenderer} from './renderer';
import {PLOTLY_ASSET_PATH} from './plotly';
import {projectSweepScene, type SweepViewSpec} from './sweep';

const require = createRequire(import.meta.url);
const PLOTLY_FILE = require.resolve('plotly.js-gl3d-dist-min');
const PLOTLY_BYTES = statSync(PLOTLY_FILE).size;
const MAX_SCENE_REQUEST_BYTES = 64 * 1024;

type Opener = (url: string) => Promise<unknown>;

export interface SweepViewerOptions {
  readonly port?: number;
  readonly open?: boolean;
  readonly opener?: Opener;
  readonly print?: (message: string) => void;
  readonly warn?: (message: string) => void;
}

export interface SweepViewer {
  readonly url: string;
  close(): Promise<void>;
}

export async function startSweepViewer(
  result: SweepResult,
  renderer: SweepRenderer,
  options: SweepViewerOptions = {},
): Promise<SweepViewer> {
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`invalid sweep viewer port: ${port}`);
  }
  const document = renderer.document(createSweepRendererModel(result));
  const server = createServer((request, response) => {
    void serveRequest(request, response, result, document).catch(error => {
      if (!response.headersSent) {
        json(response, 500, {error: message(error)});
      } else {
        response.destroy(error instanceof Error ? error : undefined);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}/`;
  options.print?.(`Tea sweep view: ${url}`);
  if (options.open !== false) {
    try {
      await (options.opener ?? openBrowser)(url);
    } catch (error) {
      options.warn?.(`tea: could not open the sweep viewer: ${message(error)}`);
    }
  }
  return {url, close: () => closeServer(server)};
}

async function serveRequest(
  request: IncomingMessage,
  response: ServerResponse,
  result: SweepResult,
  document: ReturnType<SweepRenderer['document']>,
): Promise<void> {
  const path = safePath(request.url);
  if (path === null) return plain(response, 400, 'Bad request');
  if (path === '/') {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return plain(response, 405, 'Method not allowed', 'GET, HEAD');
    }
    return body(response, request.method, document.contentType, document.body);
  }
  if (path === PLOTLY_ASSET_PATH) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return plain(response, 405, 'Method not allowed', 'GET, HEAD');
    }
    response.writeHead(200, {
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Content-Length': PLOTLY_BYTES,
      'Content-Type': 'text/javascript; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
    });
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    createReadStream(PLOTLY_FILE).pipe(response);
    return;
  }
  if (path === '/scene') {
    if (request.method !== 'POST') {
      return plain(response, 405, 'Method not allowed', 'POST');
    }
    if (!request.headers['content-type']?.startsWith('application/json')) {
      return json(response, 415, {error: 'scene request must be JSON'});
    }
    const raw = await readRequest(request, MAX_SCENE_REQUEST_BYTES);
    if (raw === null) {
      return json(response, 413, {error: 'scene request is too large'});
    }
    try {
      const spec = JSON.parse(raw) as SweepViewSpec;
      return json(response, 200, projectSweepScene(result, spec));
    } catch (error) {
      return json(response, 400, {error: message(error)});
    }
  }
  return plain(response, 404, 'Not found');
}

async function readRequest(
  request: IncomingMessage,
  limit: number,
): Promise<string | null> {
  const declared = Number(request.headers['content-length'] ?? 0);
  if (Number.isFinite(declared) && declared > limit) {
    request.resume();
    return null;
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.byteLength;
    if (bytes > limit) {
      request.resume();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function safePath(raw: string | undefined): string | null {
  try {
    const url = new URL(raw ?? '/', 'http://127.0.0.1');
    const path = decodeURIComponent(url.pathname);
    return path.includes('\0') || path.includes('\\') ? null : path;
  } catch {
    return null;
  }
}

function body(
  response: ServerResponse,
  method: string | undefined,
  contentType: string,
  value: string,
): void {
  response.writeHead(200, {
    'Cache-Control': 'no-store',
    'Content-Security-Policy':
      "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data: blob:",
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(value),
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(method === 'HEAD' ? undefined : value);
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const encoded = JSON.stringify(value);
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(encoded),
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(encoded);
}

function plain(
  response: ServerResponse,
  status: number,
  value: string,
  allow?: string,
): void {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    ...(allow === undefined ? {} : {Allow: allow}),
  });
  response.end(value);
}

async function openBrowser(url: string): Promise<unknown> {
  const {default: open} = await import('open');
  return open(url);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close(error => (error === undefined ? resolve() : reject(error)));
  });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
