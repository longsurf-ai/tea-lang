// A compiled program imports the packaged runtime without the Tea frontend.

import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {transformSync} from 'esbuild';
import {compile} from '../src/compiler';

const directory = mkdtempSync(
  fileURLToPath(new URL('../tests/.package-', import.meta.url)),
);
try {
  const source = join(directory, 'program.tea');
  writeFileSync(
    source,
    'length = input.int(2)\nvar float total = 0\ntotal += close * length\nplot(total)',
  );
  const compiled = compile([source]);
  assert.equal(compiled.ok, true);
  if (!compiled.ok) throw new Error('package fixture did not compile');
  const artifact = join(directory, 'program.mjs');
  writeFileSync(
    artifact,
    transformSync(compiled.source, {
      loader: 'ts',
      format: 'esm',
      target: 'node20.19',
    }).code,
  );
  const runner = join(directory, 'run.mjs');
  writeFileSync(
    runner,
    `
import assert from 'node:assert/strict';
import {Context, Module} from 'tea/runtime';
import program from './program.mjs';
assert.ok(program instanceof Module);
assert.equal(program.bind({length: 3}), program);
assert.equal(program.parameters[0].value, 3);
assert.equal(program.ready(), true);
assert.equal(program.outputs.schema.fields.at(-1).name, 'output0');
let fail = true;
const checked = new Module(program, context => {
  program.main(context);
  if (fail) throw new Error('abort');
}).bind();
const context = new Context(checked);
const input = {series: [2], builtins: [], requests: [], provisional: false};
assert.throws(() => context.step(input), /abort/);
fail = false;
assert.equal(context.step(input).outputs[0].series, 6);
assert.equal(context.step(input).outputs[0].series, 12);
context.dispose();
assert.throws(() => context.step(input), /disposed/);
`,
  );
  const result = spawnSync(process.execPath, [runner], {encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr || result.stdout);
} finally {
  rmSync(directory, {recursive: true, force: true});
}
