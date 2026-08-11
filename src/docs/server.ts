// Purpose: Serve packaged Docusaurus output on loopback for the tea docs command.

import {realpath, stat} from 'node:fs/promises';
import {isAbsolute, join, relative, resolve, sep} from 'node:path';
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

function plain(message: string, status: number, allow?: string): Response {
  return new Response(message, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      ...(allow === undefined ? {} : {Allow: allow}),
    },
  });
}

function response(
  request: Request,
  file: string,
  path: string,
  status = 200,
): Response {
  const asset = Bun.file(file);
  const headers = {
    'Cache-Control':
      status === 200 && path.startsWith('/assets/')
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
    'Content-Length': String(asset.size),
    'Content-Type': asset.type,
    'X-Content-Type-Options': 'nosniff',
  };
  if (request.method === 'HEAD') return new Response(null, {status, headers});
  return new Response(asset, {status, headers});
}

async function openBrowser(url: string): Promise<unknown> {
  const {default: open} = await import('open');
  return open(url);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function startDocsServer(options: DocsServerOptions) {
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

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port,
    async fetch(request) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return plain('Method not allowed', 405, 'GET, HEAD');
      }

      const url = new URL(request.url);
      const path = decodePath(url.pathname);
      if (path === null) return plain('Bad request', 400);

      const file = await route(root, path);
      if (file !== null) return response(request, file, path);

      const notFound = await findFile(root, '404.html');
      if (notFound === null) return plain('Not found', 404);
      return response(request, notFound, path, 404);
    },
  });

  const url = String(server.url);
  options.print(`Tea documentation: ${url}`);
  if (options.open === false) return server;

  try {
    await (options.opener ?? openBrowser)(url);
  } catch (error) {
    options.warn(
      `tea: could not open the documentation browser: ${message(error)}`,
    );
  }
  return server;
}
