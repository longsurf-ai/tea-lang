// Purpose: Verify tea docs serves only packaged static documentation on loopback.

import {mkdir, mkdtemp, rm, symlink, writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, test} from 'bun:test';
import {startDocsServer, type DocsServerOptions} from './server';

describe('startDocsServer', () => {
  let root = '';
  let server: Awaited<ReturnType<typeof startDocsServer>> | undefined;
  let printed: string[];
  let warnings: string[];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tea-docs-'));
    await writeFile(join(root, 'index.html'), '<html>Tea docs</html>');
    await writeFile(join(root, '404.html'), '<html>Missing</html>');
    printed = [];
    warnings = [];
  });

  afterEach(async () => {
    await server?.stop(true);
    server = undefined;
    if (root !== '') await rm(root, {recursive: true, force: true});
  });

  async function start(options: Partial<DocsServerOptions> = {}) {
    server = await startDocsServer({
      root,
      port: 0,
      open: false,
      print: line => printed.push(line),
      warn: line => warnings.push(line),
      ...options,
    });
    return server;
  }

  test('serves Docusaurus pages and static assets with correct metadata', async () => {
    await mkdir(join(root, 'language-guide'), {recursive: true});
    await mkdir(join(root, 'assets'), {recursive: true});
    await writeFile(
      join(root, 'language-guide', 'index.html'),
      '<html>Language guide</html>',
    );
    await writeFile(join(root, 'assets', 'main.123.js'), 'const tea = true;');
    await writeFile(join(root, 'sitemap.xml'), '<urlset></urlset>');
    await writeFile(join(root, 'assets', 'font.woff2'), new Uint8Array([1, 2]));

    const docs = await start();
    expect(docs.hostname).toBe('127.0.0.1');
    expect(docs.port).toBeGreaterThan(0);
    expect(printed).toEqual([`Tea documentation: ${String(docs.url)}`]);
    expect(warnings).toEqual([]);

    const page = await fetch(new URL('/language-guide?source=test', docs.url));
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toBe('text/html;charset=utf-8');
    expect(page.headers.get('cache-control')).toBe('no-cache');
    expect(await page.text()).toBe('<html>Language guide</html>');

    const script = await fetch(new URL('/assets/main.123.js', docs.url));
    expect(script.status).toBe(200);
    expect(script.headers.get('content-type')).toBe(
      'text/javascript;charset=utf-8',
    );
    expect(script.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable',
    );
    expect(script.headers.get('x-content-type-options')).toBe('nosniff');

    const xml = await fetch(new URL('/sitemap.xml', docs.url));
    expect(xml.headers.get('content-type')).toBe('application/xml');
    const font = await fetch(new URL('/assets/font.woff2', docs.url));
    expect(font.headers.get('content-type')).toBe('font/woff2');

    const head = await fetch(new URL('/language-guide/', docs.url), {
      method: 'HEAD',
    });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expect(head.headers.get('content-length')).toBe(
      String('<html>Language guide</html>'.length),
    );
  });

  test('returns the Docusaurus 404 page without a homepage fallback', async () => {
    const docs = await start();

    for (const path of ['/missing-page', '/assets/missing.js']) {
      const result = await fetch(new URL(path, docs.url));
      expect(result.status).toBe(404);
      expect(result.headers.get('cache-control')).toBe('no-cache');
      expect(await result.text()).toBe('<html>Missing</html>');
    }

    const result = await fetch(new URL('/', docs.url), {method: 'POST'});
    expect(result.status).toBe(405);
    expect(result.headers.get('allow')).toBe('GET, HEAD');
  });

  test('rejects traversal, backslashes, NUL bytes, and escaped symlinks', async () => {
    const outside = `${root}-outside.txt`;
    await writeFile(outside, 'secret');
    await symlink(outside, join(root, 'escape.txt'));
    const docs = await start();

    for (const path of [
      '/%2e%2e%2fsecret.txt',
      '/nested%5csecret.txt',
      '/bad%00path',
    ]) {
      const result = await fetch(new URL(path, docs.url));
      expect(result.status).toBe(400);
      expect(await result.text()).not.toContain('secret');
    }

    const escaped = await fetch(new URL('/escape.txt', docs.url));
    expect(escaped.status).toBe(404);
    expect(await escaped.text()).not.toContain('secret');
    await rm(outside, {force: true});
  });

  test('opens the actual server URL and tolerates browser failures', async () => {
    const opened: string[] = [];
    const docs = await start({
      open: true,
      opener: async url => {
        opened.push(url);
        throw new Error('browser unavailable');
      },
    });

    expect(opened).toEqual([String(docs.url)]);
    expect(warnings).toEqual([
      'tea: could not open the documentation browser: browser unavailable',
    ]);
    expect((await fetch(docs.url)).status).toBe(200);
  });

  test('does not open a browser when opening is disabled', async () => {
    let calls = 0;
    await start({
      open: false,
      opener: async () => {
        calls++;
      },
    });
    expect(calls).toBe(0);
  });

  test('starts and serves through the Node-hosted source runtime', () => {
    const moduleUrl = new URL('./server.ts', import.meta.url).href;
    const script = `
      import {startDocsServer} from ${JSON.stringify(moduleUrl)};
      if ('Bun' in globalThis) throw new Error('expected the Node runtime');
      const docs = await startDocsServer({
        root: ${JSON.stringify(root)},
        port: 0,
        open: false,
        print() {},
        warn() {},
      });
      try {
        const response = await fetch(docs.url);
        console.log(JSON.stringify({
          hostname: docs.hostname,
          port: docs.port,
          url: String(docs.url),
          status: response.status,
          body: await response.text(),
        }));
      } finally {
        await docs.stop(true);
      }
    `;
    const result = spawnSync(
      process.env['TEA_TEST_NODE'] ?? 'node',
      [
        '--import',
        import.meta.resolve('tsx'),
        '--input-type=module',
        '--eval',
        script,
      ],
      {encoding: 'utf8'},
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      hostname: '127.0.0.1',
      port: expect.any(Number),
      url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/$/),
      status: 200,
      body: '<html>Tea docs</html>',
    });
  });

  test('fails before binding when the documentation build is missing', async () => {
    await rm(join(root, 'index.html'));

    expect(
      startDocsServer({
        root,
        port: 0,
        open: false,
        print: line => printed.push(line),
        warn: line => warnings.push(line),
      }),
    ).rejects.toThrow('Run "bun run docs:build"');
    expect(printed).toEqual([]);
  });
});
