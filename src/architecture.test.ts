// Purpose: Lock the production dependency seams shared by compiler targets and runtimes.

import {readdirSync, readFileSync} from 'node:fs';
import {dirname, join, relative, resolve} from 'node:path';
import {expect, test} from 'bun:test';
import ts from 'typescript';

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
          `${relative(import.meta.dir, source)} -> ${relative(import.meta.dir, target)}`,
      ),
  );
}

function isWithin(target: string, root: string): boolean {
  const path = relative(root, target);
  return path === '' || !path.startsWith('..');
}

test('runtime does not depend on codegen implementation', () => {
  const runtime = resolve(import.meta.dir, 'runtime');
  const codegen = resolve(import.meta.dir, 'codegen');
  expect(importsInto(productionSources(runtime), codegen)).toEqual([]);
});

test('runtime implementation modules bypass their public ABI facade', () => {
  const runtime = resolve(import.meta.dir, 'runtime');
  const facade = resolve(runtime, 'abi');
  const facadeImports = productionSources(runtime)
    .filter(source => source !== `${facade}.ts`)
    .flatMap(source =>
      localTargets(source)
        .filter(target => target === facade)
        .map(
          sourceTarget =>
            `${relative(import.meta.dir, source)} -> ${relative(import.meta.dir, sourceTarget)}`,
        ),
    );
  expect(facadeImports).toEqual([]);
});

test('codegen imports narrow runtime contracts instead of the public facade', () => {
  const runtime = resolve(import.meta.dir, 'runtime');
  const codegen = resolve(import.meta.dir, 'codegen');
  const facade = resolve(runtime, 'abi');
  const codegenFacadeImports = productionSources(codegen).flatMap(source =>
    localTargets(source)
      .filter(target => target === facade)
      .map(
        target =>
          `${relative(import.meta.dir, source)} -> ${relative(import.meta.dir, target)}`,
      ),
  );
  expect(codegenFacadeImports).toEqual([]);
});

test('GPU artifact contract is neutral and shared by producer and consumer', () => {
  const codegen = resolve(import.meta.dir, 'codegen');
  const runtime = resolve(import.meta.dir, 'runtime');
  const contract = resolve(import.meta.dir, 'gpu/contract');
  const schema = resolve(runtime, 'schema');
  const contractSource = `${contract}.ts`;

  const contractTargets = localTargets(contractSource);
  expect(
    contractTargets.filter(
      target =>
        isWithin(target, codegen) ||
        (isWithin(target, runtime) && target !== schema),
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

test('CLI wiring has no mutable module-level coordination state', () => {
  const filename = resolve(import.meta.dir, 'main.ts');
  const text = readFileSync(filename, 'utf8');
  expect(text.split('\n')[0]).toBe('#!/usr/bin/env -S node --import tsx');
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
});

test('type names describe values rather than resolution history', () => {
  const violations: string[] = [];
  for (const filename of productionSources(import.meta.dir)) {
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
          `${relative(import.meta.dir, filename)}: ${node.name.text}`,
        );
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect(violations).toEqual([]);
});
