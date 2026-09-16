// Purpose: Lock the production dependency seams shared by compiler targets and runtimes.

import {existsSync, readdirSync, readFileSync} from 'node:fs';
import {dirname, extname, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {expect, test} from 'vitest';
import ts from 'typescript';

const SOURCE_ROOT = fileURLToPath(new URL('../src/', import.meta.url));

function productionSources(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, {withFileTypes: true})) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...productionSources(path));
    } else if (
      entry.isFile() &&
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.integration.ts')
    ) {
      files.push(path);
    }
  }
  return files;
}

const repositoryTextExtensions = new Set([
  '.cjs',
  '.js',
  '.json',
  '.md',
  '.mjs',
  '.sh',
  '.tea',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
]);

const ignoredRepositoryDirectories = new Set([
  '.codex',
  '.docusaurus',
  '.git',
  '.obsidian',
  'build',
  'dist',
  'node_modules',
  'plans', // Git-ignored local design notes are not repository tooling.
]);

function repositoryTextFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, {withFileTypes: true})) {
    if (entry.isDirectory() && ignoredRepositoryDirectories.has(entry.name)) {
      continue;
    }
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...repositoryTextFiles(path));
    } else if (entry.isFile() && repositoryTextExtensions.has(extname(path))) {
      files.push(path);
    }
  }
  return files;
}

function localTargets(source: string): string[] {
  return ts
    .preProcessFile(readFileSync(source, 'utf8'), true, true)
    .importedFiles.map(file => file.fileName)
    .filter(specifier => specifier.startsWith('.'))
    .map(specifier =>
      resolve(dirname(source), specifier).replace(/\.[cm]?[jt]s$/, ''),
    );
}

function importsInto(
  sources: readonly string[],
  targetRoot: string,
): readonly string[] {
  return sources.flatMap(source =>
    localTargets(source)
      .filter(target => isWithin(target, targetRoot))
      .map(
        target =>
          `${relative(SOURCE_ROOT, source)} -> ${relative(SOURCE_ROOT, target)}`,
      ),
  );
}

function isWithin(target: string, root: string): boolean {
  const path = relative(root, target);
  return path === '' || !path.startsWith('..');
}

test('runtime does not depend on codegen implementation', () => {
  const runtime = resolve(SOURCE_ROOT, 'runtime');
  const codegen = resolve(SOURCE_ROOT, 'codegen');
  expect(importsInto(productionSources(runtime), codegen)).toEqual([]);
});

test('runtime implementation modules bypass their public ABI facade', () => {
  const runtime = resolve(SOURCE_ROOT, 'runtime');
  const facade = resolve(runtime, 'abi');
  const facadeImports = productionSources(runtime)
    .filter(source => source !== `${facade}.ts`)
    .flatMap(source =>
      localTargets(source)
        .filter(target => target === facade)
        .map(
          sourceTarget =>
            `${relative(SOURCE_ROOT, source)} -> ${relative(SOURCE_ROOT, sourceTarget)}`,
        ),
    );
  expect(facadeImports).toEqual([]);
});

test('codegen imports narrow runtime contracts instead of the public facade', () => {
  const runtime = resolve(SOURCE_ROOT, 'runtime');
  const codegen = resolve(SOURCE_ROOT, 'codegen');
  const facade = resolve(runtime, 'abi');
  const codegenFacadeImports = productionSources(codegen).flatMap(source =>
    localTargets(source)
      .filter(target => target === facade)
      .map(
        target =>
          `${relative(SOURCE_ROOT, source)} -> ${relative(SOURCE_ROOT, target)}`,
      ),
  );
  expect(codegenFacadeImports).toEqual([]);
});

test('GPU artifact contract is neutral and shared by producer and consumer', () => {
  const codegen = resolve(SOURCE_ROOT, 'codegen');
  const runtime = resolve(SOURCE_ROOT, 'runtime');
  const contract = resolve(SOURCE_ROOT, 'gpu/contract');
  const parameters = resolve(runtime, 'params');
  const contractSource = `${contract}.ts`;

  const contractTargets = localTargets(contractSource);
  expect(
    contractTargets.filter(
      target =>
        isWithin(target, codegen) ||
        (isWithin(target, runtime) && target !== parameters),
    ),
  ).toEqual([]);
  expect(
    productionSources(codegen).some(source =>
      localTargets(source).includes(contract),
    ),
  ).toBe(true);
  expect(
    productionSources(runtime).some(source =>
      localTargets(source).includes(contract),
    ),
  ).toBe(true);
});

test('main is only the executable shell for the CLI', () => {
  const filename = resolve(SOURCE_ROOT, 'main.ts');
  const text = readFileSync(filename, 'utf8');
  expect(text.split('\n')[0]).toBe('#!/usr/bin/env -S node --import tsx');
  expect(localTargets(filename)).toEqual([resolve(SOURCE_ROOT, 'cli/cli')]);
  expect(text.match(/process\.exitCode\s*=/g)).toHaveLength(1);
  expect(text).not.toContain('commander');
  expect(text).not.toContain('compiler');
  expect(text).not.toContain('runtime');
});

test('CLI coordination owns no mutable module-level state or process exit', () => {
  const filename = resolve(SOURCE_ROOT, 'cli/cli.ts');
  const text = readFileSync(filename, 'utf8');
  const source = ts.createSourceFile(
    filename,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const mutable = source.statements.flatMap(statement => {
    if (
      !ts.isVariableStatement(statement) ||
      (statement.declarationList.flags & ts.NodeFlags.Const) !== 0
    ) {
      return [];
    }
    return statement.declarationList.declarations.map(declaration =>
      declaration.name.getText(source),
    );
  });
  expect(mutable).toEqual([]);
  expect(text).not.toContain('.parseAsync(');
  expect(text).not.toContain('process.exit(');
  expect(text).not.toContain('process.exitCode');
});

test('repository tooling uses only Node and npm', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const legacyRuntime = ['b', 'un'].join('');
  const legacyWord = new RegExp(`\\b${legacyRuntime}\\b`, 'i');
  const violations = repositoryTextFiles(root).flatMap(filename => {
    const source = readFileSync(filename, 'utf8');
    return legacyWord.test(source) ? [relative(root, filename)] : [];
  });

  expect(existsSync(resolve(root, `${legacyRuntime}.lock`))).toBe(false);
  expect(violations).toEqual([]);
});

test('type names describe values rather than resolution history', () => {
  const violations: string[] = [];
  for (const filename of productionSources(SOURCE_ROOT)) {
    const source = ts.createSourceFile(
      filename,
      readFileSync(filename, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node): void => {
      if (
        (ts.isInterfaceDeclaration(node) ||
          ts.isTypeAliasDeclaration(node) ||
          ts.isClassDeclaration(node) ||
          ts.isEnumDeclaration(node)) &&
        node.name?.text.includes('Resolved')
      ) {
        violations.push(
          `${relative(SOURCE_ROOT, filename)}: ${node.name.text}`,
        );
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect(violations).toEqual([]);
});
