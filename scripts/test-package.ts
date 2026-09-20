// A compiled program imports the packaged runtime without the Tea frontend.

import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {transformSync} from 'esbuild';
import ts from 'typescript';
import {compile} from 'tea/compiler';

const directory = mkdtempSync(
  fileURLToPath(new URL('../tests/.package-', import.meta.url)),
);
try {
  const consumer = join(directory, 'consumer.ts');
  writeFileSync(
    consumer,
    `
import {createNode, DataStream, tea, type Datum, type Node} from 'tea';
import {Module, Schema, Field, Float64, type Scalar} from 'tea/runtime';
import {compileToProgram} from 'tea/compiler';
import {Errors} from 'tea/base/print';
import {generate} from 'tea/codegen/codegen';
import {loadModule} from 'tea/runtime/load';
import {pineBuiltinSupplier} from 'tea/extension/pine';
import type {GpuExecution} from 'tea/runtime/gpu';
import type {CompiledWgslProgram} from 'tea/codegen/wgsl';
import {of} from 'rxjs';
const errors = new Errors();
const ir = compileToProgram([{filename: 'consumer.tea', source: 'emit "value" close'}], errors);
if (!ir) throw new Error('Compilation failed');
const module: Module = loadModule(generate(ir)).bind();
const node: Node = createNode(module, pineBuiltinSupplier());
const scalar: Scalar = 1;
const stream = new DataStream(new Schema([new Field('close', new Float64(), false)]), of({close: scalar}));
node.bind(stream).to({next: (row: Datum) => console.log(row.index)});
tea\`emit "value" 1\`.ready();
export type Gpu = readonly [GpuExecution, CompiledWgslProgram];
`,
  );
  const checkedConsumer = ts.createProgram([consumer], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noUncheckedIndexedAccess: true,
    noEmit: true,
    skipLibCheck: true,
    types: ['node'],
  });
  const diagnostics = ts.getPreEmitDiagnostics(checkedConsumer);
  assert.deepEqual(
    diagnostics.map(diagnostic =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    ),
    [],
  );
  const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url));
  assert.deepEqual(
    checkedConsumer
      .getSourceFiles()
      .filter(
        file => !file.isDeclarationFile && file.fileName.startsWith(sourceRoot),
      )
      .map(file => file.fileName),
    [],
  );
  const source = join(directory, 'program.tea');
  writeFileSync(
    source,
    'length = input.int(2)\nvar float total = 0\ntotal += close * length\nemit "output0" total',
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
import {createNode, DataStream, tea} from 'tea';
import {loadModule} from 'tea/runtime/load';
import {Schema, Field, Float64} from 'apache-arrow';
import {of} from 'rxjs';
import unbound from './program.mjs';
assert.ok(unbound instanceof Module);
assert.ok(tea\`emit "value" 1\`.module instanceof Module);
const loaded = loadModule(${JSON.stringify(compiled.source)}).bind({length: 3});
assert.ok(loaded instanceof Module);
const observed = [];
createNode(loaded).bind(new DataStream(new Schema([new Field('close', new Float64(), false)]), of({close: 2}))).to({next: row => observed.push(row.output0)});
assert.deepEqual(observed, [6]);
const program = unbound.bind({length: 3});
assert.notEqual(program, unbound);
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
assert.equal(context.step(input).outputs[0], 6);
assert.equal(context.step(input).outputs[0], 12);
context.dispose();
assert.throws(() => context.step(input), /disposed/);
`,
  );
  const result = spawnSync(process.execPath, [runner], {encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr || result.stdout);
} finally {
  rmSync(directory, {recursive: true, force: true});
}
