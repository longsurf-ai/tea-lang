// Purpose: Serve packaged Docusaurus output on loopback for the tea docs command.

import {createReadStream} from 'node:fs';
import {realpath, stat} from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type {AddressInfo} from 'node:net';
import {extname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const DEFAULT_ROOT = fileURLToPath(
  new URL('../../website/build/', import.meta.url),
);

type Output = (message: string) => void;
type Opener = (url: string) => Promise<unknown>;

export interface DocsServerOptions {
  port?: number;
  root?: string;
  open?: boolean;
  opener?: Opener;
  print: Output;
  warn: Output;
}

export interface DocsServer {
  readonly hostname: string;
  readonly port: number;
  readonly url: URL;
  stop(force?: boolean): Promise<void>;
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.css': 'text/css;charset=utf-8',
  '.gif': 'image/gif',
  '.htm': 'text/html;charset=utf-8',
  '.html': 'text/html;charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript;charset=utf-8',
  '.json': 'application/json;charset=utf-8',
  '.map': 'application/json;charset=utf-8',
  '.mjs': 'text/javascript;charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain;charset=utf-8',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml',
};

function inside(root: string, file: string): boolean {
  const path = relative(root, file);
  return (
    path === '' ||
    (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  );
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw error;
  }
}

async function findFile(root: string, path: string): Promise<string | null> {
  const file = resolve(root, path.replace(/^\/+/, ''));
  if (!inside(root, file) || !(await isFile(file))) return null;

  const canonical = await realpath(file);
  if (!inside(root, canonical)) return null;
  return canonical;
}

function decodePath(path: string): string | null {
  try {
    const decoded = decodeURIComponent(path);
    if (
      decoded.includes('\0') ||
      decoded.includes('\\') ||
      decoded.split('/').includes('..')
    ) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

async function route(root: string, path: string): Promise<string | null> {
  if (path === '/') return findFile(root, 'index.html');

  const direct = path.endsWith('/') ? null : await findFile(root, path);
  if (direct !== null) return direct;
  return findFile(root, `${path.replace(/\/$/, '')}/index.html`);
}

function contentType(file: string): string {
  return (
    CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream'
  );
}

function plain(
  response: ServerResponse,
  message: string,
  status: number,
  allow?: string,
): void {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    ...(allow === undefined ? {} : {Allow: allow}),
  });
  response.end(message);
}

async function sendFile(
  request: IncomingMessage,
  response: ServerResponse,
  file: string,
  path: string,
  status = 200,
): Promise<void> {
  const asset = await stat(file);
  const headers = {
    'Cache-Control':
      status === 200 && path.startsWith('/assets/')
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
    'Content-Length': String(asset.size),
    'Content-Type': contentType(file),
    'X-Content-Type-Options': 'nosniff',
  };
  response.writeHead(status, headers);
  if (request.method === 'HEAD') {
    response.end();
    return;
  }

  const stream = createReadStream(file);
  stream.on('error', error => response.destroy(error));
  stream.pipe(response);
}

async function handleRequest(
  root: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    plain(response, 'Method not allowed', 405, 'GET, HEAD');
    return;
  }

  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const path = decodePath(url.pathname);
  if (path === null) {
    plain(response, 'Bad request', 400);
    return;
  }

  const file = await route(root, path);
  if (file !== null) {
    await sendFile(request, response, file, path);
    return;
  }

  const notFound = await findFile(root, '404.html');
  if (notFound === null) {
    plain(response, 'Not found', 404);
    return;
  }
  await sendFile(request, response, notFound, path, 404);
}

async function openBrowser(url: string): Promise<unknown> {
  const {default: open} = await import('open');
  return open(url);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function startDocsServer(
  options: DocsServerOptions,
): Promise<DocsServer> {
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid documentation server port: ${port}`);
  }

  const configuredRoot = resolve(options.root ?? DEFAULT_ROOT);
  let root: string;
  try {
    root = await realpath(configuredRoot);
  } catch {
    throw new Error(
      `Tea documentation assets are missing at ${join(configuredRoot, 'index.html')}. ` +
        'Run "bun run docs:build" from the Tea package or reinstall Tea.',
    );
  }

  if ((await findFile(root, 'index.html')) === null) {
    throw new Error(
      `Tea documentation assets are missing at ${join(configuredRoot, 'index.html')}. ` +
        'Run "bun run docs:build" from the Tea package or reinstall Tea.',
    );
  }

  const hostname = '127.0.0.1';
  const nodeServer = createServer((request, response) => {
    void handleRequest(root, request, response).catch(error => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      plain(response, 'Internal server error', 500);
    });
  });

  await new Promise<void>((accept, reject) => {
    const listening = () => {
      nodeServer.off('error', reject);
      accept();
    };
    nodeServer.once('error', reject);
    nodeServer.once('listening', listening);
    nodeServer.listen(port, hostname);
  });

  const address = nodeServer.address() as AddressInfo | null;
  if (address === null) {
    throw new Error(
      'Documentation server did not report its listening address',
    );
  }

  const url = new URL(`http://${hostname}:${address.port}/`);
  let stopped: Promise<void> | undefined;
  const server: DocsServer = {
    hostname,
    port: address.port,
    url,
    stop(force = false) {
      if (stopped !== undefined) {
        if (force) nodeServer.closeAllConnections();
        return stopped;
      }
      stopped = new Promise<void>((accept, reject) => {
        nodeServer.close(error => {
          if (error === undefined) accept();
          else reject(error);
        });
        if (force) nodeServer.closeAllConnections();
      });
      return stopped;
    },
  };

  options.print(`Tea documentation: ${String(url)}`);
  if (options.open === false) return server;

  try {
    await (options.opener ?? openBrowser)(String(url));
  } catch (error) {
    options.warn(
      `tea: could not open the documentation browser: ${message(error)}`,
    );
  }
  return server;
}
