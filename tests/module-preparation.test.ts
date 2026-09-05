// Purpose: Mutable binding and explicit independent runs; TEA_STRESS=1 expands sizes.

import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {Field, Schema} from 'apache-arrow';
import {test} from 'vitest';
import {generate} from '../src/codegen/codegen';
import {IrKind, PlaceKind} from '../src/ir/node';
import type {Program} from '../src/ir/program';
import {mustBuild} from '../src/noder/testing';
import {loadModule} from '../src/runtime/load';
import {cloneModule, initializeModule} from '../src/runtime/module-binding';
import type {JSModule} from '../src/runtime/module-abi';
import {outputFields} from '../src/runtime/output';

type Raw = Parameters<typeof initializeModule>[0];
const stress = process.env.TEA_STRESS === '1';
const source = [
  'length = input.int(2, minval=0)',
  'enabled = input.bool(true)',
  'weight = input.int(3, minval=1, maxval=4, active=enabled)',
  'plot(close[length], linewidth=weight)',
  'hline(float(length))',
].join('\n');

function tree(module: JSModule): JSModule[] {
  return [module, ...module.requests.flatMap(request => tree(request.module))];
}

// Count actual generated calculations before the loader hides them behind bind.
function counted(raw: Raw, calls: number[]): Raw {
  const index = calls.push(0) - 1;
  return {
    ...raw,
    requests: raw.requests.map(request => ({
      ...request,
      module: counted(request.module, calls),
    })),
    bind(module, context) {
      calls[index] += 1;
      raw.bind(module, context);
    },
  };
}

function instrument(program: Program, calls: number[]): JSModule {
  return initializeModule(
    counted(new Function(generate(program))() as Raw, calls),
  );
}

function same(left: JSModule, right: JSModule): void {
  assert.deepStrictEqual(left.inputs, right.inputs);
  assert.deepStrictEqual(left.parameters, right.parameters);
  assert.deepStrictEqual(left.state, right.state);
  assert.deepStrictEqual(left.outputs, right.outputs);
  assert.deepStrictEqual(
    left.requests.map(({module: _, ...request}) => request),
    right.requests.map(({module: _, ...request}) => request),
  );
}

function report(name: string, started: number, count: number): void {
  if (stress)
    process.stdout.write(
      JSON.stringify({
        name,
        count,
        node: process.version,
        milliseconds: Math.round(performance.now() - started),
      }) + '\n',
    );
}
// Source currently permits only top-level requests. Compose its checked IR
// pieces to exercise the already-recursive artifact boundary, with distinct
// result Names in each Program; this does not add nested source syntax support.
function deepProgram(depth: number, contextual = false): Program {
  const base = mustBuild(
    [
      'length = input.int(2, minval=0)',
      'symbol = input.string("X")',
      `r = request.security(symbol, "D", close[${contextual ? 'syminfo.type == "stock" ? length : 1' : 'length'}])`,
      'plot(r)',
    ].join('\n'),
  );
  const edge = base.requests[0];
  const emission = base.body[0];
  const write = edge.child.body[0];
  assert.equal(emission.kind, IrKind.Emit);
  assert.equal(write.kind, IrKind.WriteName);
  if (emission.kind !== IrKind.Emit || write.kind !== IrKind.WriteName)
    throw new Error('request fixture shape changed');
  const read = emission.args[0];
  assert.equal(read.kind, IrKind.HistRead);
  if (read.kind !== IrKind.HistRead)
    throw new Error('request fixture read changed');
  let child = edge.child;
  let resultName = edge.resultName;
  for (let level = 1; level < depth; level += 1) {
    const request = {...edge, child, resultName};
    const name = {...edge.resultName};
    child = {
      ...edge.child,
      requests: [request],
      body: [
        {
          ...write,
          name,
          value: {...read, place: {kind: PlaceKind.Request, request}},
        },
      ],
    };
    resultName = name;
  }
  const request = {...edge, child, resultName};
  return {
    ...base,
    requests: [request],
    body: [
      {
        ...emission,
        args: [{...read, place: {kind: PlaceKind.Request, request}}],
      },
    ],
  };
}

test('module fields own requirements and bind fills usable defaults in place', () => {
  const module = loadModule(generate(mustBuild(source)));
  assert.equal(Object.hasOwn(module, 'manifest'), false);
  assert.ok(module.inputs.schema instanceof Schema);
  assert.ok(outputFields(module.outputs.schema)[0] instanceof Field);
  assert.deepStrictEqual(module.inputs.series[0].depth, {kind: 'bound'});
  const bound = module.bind({length: 4});
  assert.equal(bound.ready(), true);
  assert.deepStrictEqual(
    bound.parameters.map(parameter => parameter.value),
    [4, true, 3],
  );
  assert.deepStrictEqual(bound.inputs.series[0].depth, {
    kind: 'const',
    bars: 4,
  });
  assert.equal(bound, module);
  assert.equal(Object.hasOwn(bound.inputs.series[0], 'supplied'), false);
  assert.equal(Object.hasOwn(bound.parameters[0], 'bindable'), false);
  assert.deepStrictEqual(bound.remaining(), []);
});

test('independent copies bind history, activity and display values without leaks', () => {
  const started = performance.now();
  const count = stress ? 1_000 : 24;
  const calls: number[] = [];
  const original = instrument(mustBuild(source), calls);
  let prior: JSModule | undefined;
  for (let index = 0; index < count; index += 1) {
    const length = index % 16;
    const enabled = index % 2 === 0;
    const weight = (index % 4) + 1;
    calls.fill(0);
    const prepared = cloneModule(original).bind({length, enabled, weight});
    assert.deepStrictEqual(calls, [1]);
    assert.equal(prepared.ready(), true);
    assert.deepStrictEqual(prepared.inputs.series[0].depth, {
      kind: 'const',
      bars: length,
    });
    assert.equal(prepared.parameters[2].active, enabled);
    assert.deepStrictEqual(
      prepared.outputs.declarations.map(output => output.args),
      [[{name: 'linewidth', value: weight}], [{name: 'price', value: length}]],
    );
    outputFields(prepared.outputs.schema)[0].metadata.set(
      'test:owner',
      String(index),
    );
    assert.equal(
      outputFields(original.outputs.schema)[0].metadata.has('test:owner'),
      false,
    );
    if (prior) {
      assert.equal(prior.parameters[0].value, (index - 1) % 16);
      assert.equal(
        outputFields(prior.outputs.schema)[0].metadata.get('test:owner'),
        String(index - 1),
      );
    }
    prior = prepared;
  }
  assert.equal(
    original.parameters.every(parameter => !Object.hasOwn(parameter, 'value')),
    true,
  );
  report('independent-preparations', started, count);
});

test('wide requests calculate each module once and independent binding orders agree', () => {
  const started = performance.now();
  const width = stress ? 128 : 8;
  const calls: number[] = [];
  const module = instrument(
    mustBuild(
      [
        'length = input.int(2, minval=0)',
        'symbol = input.string("X")',
        ...Array.from(
          {length: width},
          (_, index) =>
            `r${index} = request.security(symbol, "D", close[length])`,
        ),
        `plot(open[length] + ${Array.from({length: width}, (_, index) => `r${index}`).join(' + ')})`,
      ].join('\n'),
    ),
    calls,
  );
  const prepared = cloneModule(module).bind({length: 7, symbol: 'NASDAQ:XYZ'});
  assert.deepStrictEqual(calls, Array(width + 1).fill(1));
  const forward = tree(
    cloneModule(module).bind({length: 7}).bind({symbol: 'NASDAQ:XYZ'}),
  );
  const backward = tree(
    cloneModule(module).bind({symbol: 'NASDAQ:XYZ'}).bind({length: 7}),
  );
  for (const [index, current] of tree(prepared).entries()) {
    same(current, forward[index]);
    same(current, backward[index]);
    assert.deepStrictEqual(
      current.parameters.map(parameter => parameter.value),
      [7, 'NASDAQ:XYZ'],
    );
    assert.deepStrictEqual(current.inputs.series[0].depth, {
      kind: 'const',
      bars: 7,
    });
    assert.deepStrictEqual(current.remaining(), []);
    if (index > 0) assert.equal(current.inputs.schema.fields[0].name, 'close');
  }
  assert.equal(
    tree(prepared).every(current => current.ready()),
    true,
  );
  assert.equal(
    prepared.requests.every(
      request => request.context?.symbol === 'NASDAQ:XYZ',
    ),
    true,
  );
  prepared.requests[0].module.inputs.schema.metadata.set('test:child', 'first');
  assert.equal(
    prepared.requests[1].module.inputs.schema.metadata.has('test:child'),
    false,
  );
  assert.equal(
    module.requests[0].module.inputs.schema.metadata.has('test:child'),
    false,
  );
  report('wide-preparation', started, width + 1);
});

test('deep artifacts retain global parameters, child requirements and schema ownership', () => {
  const started = performance.now();
  const depth = stress ? 32 : 4;
  const program = deepProgram(depth);
  const calls: number[] = [];
  const module = instrument(program, calls);
  assert.equal(generate(program), generate(program));
  const prepared = cloneModule(module).bind({length: 5, symbol: 'DEEP'});
  assert.deepStrictEqual(calls, Array(depth + 1).fill(1));
  const reversed = tree(
    cloneModule(module).bind({symbol: 'DEEP'}).bind({length: 5}),
  );
  const modules = tree(prepared);
  assert.equal(modules.length, depth + 1);
  for (const [index, current] of modules.entries()) {
    same(current, reversed[index]);
    assert.deepStrictEqual(
      current.parameters.map(parameter => parameter.value),
      [5, 'DEEP'],
    );
    assert.equal(current.state.layout, prepared.state.layout);
    assert.equal(
      current.requests.every(request => request.context?.symbol === 'DEEP'),
      true,
    );
  }
  const leaf = modules.at(-1)!;
  assert.deepStrictEqual(leaf.inputs.series[0].depth, {kind: 'const', bars: 5});
  assert.equal(leaf.inputs.schema.fields[0].name, 'close');
  cloneModule(leaf)
    .bind()
    .inputs.schema.fields[0].metadata.set('test:external', 'changed');
  assert.equal(
    leaf.inputs.schema.fields[0].metadata.has('test:external'),
    false,
  );
  assert.equal(
    tree(module).every(current =>
      current.parameters.every(parameter => !Object.hasOwn(parameter, 'value')),
    ),
    true,
  );
  report('deep-preparation', started, depth + 1);
});

test('child context stays private, survives parent rebinding, and never leaves stale history', () => {
  const module = loadModule(generate(deepProgram(stress ? 32 : 4, true)));
  const prepared = module.bind({length: 7, symbol: 'CONTEXT'});
  const modules = tree(prepared);
  const leaf = modules.at(-1)!;
  assert.deepStrictEqual(leaf.inputs.series[0].depth, {kind: 'bound'});
  assert.equal(leaf.ready(), false);
  const bid = leaf.inputs.builtins.findIndex(
    builtin => builtin.source.field === 'type',
  );
  assert.ok(bid >= 0);
  assert.throws(
    () => prepared.bind({}, new Map([[bid, 'stock']])),
    /not a fixed binding input/,
  );
  assert.equal(leaf.bind({}, new Map([[bid, 'stock']])), leaf);
  assert.deepStrictEqual(leaf.inputs.series[0].depth, {
    kind: 'const',
    bars: 7,
  });
  assert.equal(
    tree(prepared).every(current => current.ready()),
    true,
  );
  const updated = tree(prepared.bind({length: 11})).at(-1)!;
  assert.equal(updated, leaf);
  for (const [index, current] of tree(prepared).entries()) {
    assert.equal(current, modules[index]);
  }
  assert.deepStrictEqual(updated.inputs.series[0].depth, {
    kind: 'const',
    bars: 11,
  });
  assert.equal(updated.inputs.builtins[bid].value, 'stock');
});
