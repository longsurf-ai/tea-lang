// In-memory execution loads the same TypeScript that builds write to disk.

import {expect, test} from 'vitest';
import {generate} from '../codegen/codegen';
import {mustBuild} from '../noder/testing';
import {Module} from './index';
import {loadModule} from './load';

test('loads a TypeScript module synchronously and keeps binding mutable', () => {
  const module = loadModule(
    generate(mustBuild('length = input.int(2)\nplot(close * length)')),
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
