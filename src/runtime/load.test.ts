// In-memory execution loads the same TypeScript that builds write to disk.

import {expect, test} from 'vitest';
import {generate} from '../codegen/codegen';
import {mustBuild} from '../noder/testing';
import {Module, RUNTIME_ABI_VERSION} from './index';
import {loadModule} from './load';

test('loads a TypeScript module synchronously and derives independent bindings', () => {
  const module = loadModule(
    generate(mustBuild('length = input.int(2)\nemit "output0" close * length')),
  );
  expect(module).toBeInstanceOf(Module);
  const bound = module.bind({length: 3});
  expect(bound).not.toBe(module);
  expect(bound.parameters[0]!.value).toBe(3);
  expect(bound.ready()).toBe(true);
  expect(module.parameters[0]!.value).toBeUndefined();
});

test('requires a runtime module default export', () => {
  expect(() =>
    loadModule('export default {ready() { return true; }};'),
  ).toThrow('must export a runtime Module');
  expect(() =>
    loadModule('import fs from "node:fs"; export default fs;'),
  ).toThrow("cannot import 'node:fs'");
});

test('rejects the prior runtime ABI before using its schemas', () => {
  const source = generate(mustBuild('emit "price" close'));
  const stale = source.replace(
    new RegExp(`abi:\\s*${RUNTIME_ABI_VERSION}`),
    `abi: ${RUNTIME_ABI_VERSION - 1}`,
  );
  expect(stale).not.toBe(source);
  expect(() => loadModule(stale)).toThrow(/ABI/);
});
