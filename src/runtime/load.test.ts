// In-memory execution loads the same TypeScript that builds write to disk.

import {expect, test} from 'vitest';
import {generate} from '../codegen/codegen';
import {mustBuild} from '../noder/testing';
import {Module} from './index';
import {loadModule} from './load';

test('loads a TypeScript module synchronously and keeps binding mutable', () => {
  const module = loadModule(
    generate(mustBuild('length = input.int(2)\nemit "output0" close * length')),
  );
  expect(module).toBeInstanceOf(Module);
  expect(module.bind({length: 3})).toBe(module);
  expect(module.parameters[0]!.value).toBe(3);
  expect(module.ready()).toBe(true);
});

test('requires a runtime module default export', () => {
  expect(() =>
    loadModule('export default {ready() { return true; }};'),
  ).toThrow('must export a runtime Module');
  expect(() =>
    loadModule('import fs from "node:fs"; export default fs;'),
  ).toThrow("cannot import 'node:fs'");
});

test('rejects the prior runtime ABI before using its output layout', () => {
  const source = generate(mustBuild('emit "price" close'));
  expect(() => loadModule(source.replace(/abi:\s*12/, 'abi: 11'))).toThrow(
    /ABI/,
  );
});
