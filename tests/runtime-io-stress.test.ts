// Purpose: Bounded CI cases and opt-in Arrow/Node workloads with independent values.
// TEA_STRESS=1 npm test -- tests/runtime-io-stress.test.ts
// Add TEA_STRESS_SCALAR=1 for one million scalar steps; pass Vitest's
// --execArgv=--expose-gc to sample V8 after collection in its worker.

import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {
  Binary,
  Field,
  Float64,
  List,
  Schema,
  Struct,
  Table,
  tableFromIPC,
  tableToIPC,
  vectorFromArray,
} from 'apache-arrow';
import {of, Subject} from 'rxjs';
import {test} from 'vitest';
import {i} from '../src/api/clock';
import {createNode, type Node} from '../src/api/node';
import {DataStream} from '../src/api/stream';
import {Errors} from '../src/base/print';
import {generate} from '../src/codegen/codegen';
import {compileToProgram} from '../src/compiler';
import {validateRecord} from '../src/runtime/io';
import {isRef, type HeapStats} from '../src/runtime/js/heap';
import {loadModule} from '../src/runtime/load';
import {outputFields, type Datum} from '../src/runtime/output';

const stress = process.env.TEA_STRESS === '1';
const seed = 0x51a7;
const prices = new Schema([new Field('close', new Float64(), false)]);
const mixed = [
  'type Sample',
  '    array<float> values',
  '    matrix<float> grid',
  '    map<string, float> labels',
  'var Sample saved = na',
  'values = array.from(close, close[2])',
  'grid = matrix.new<float>(0, 3, na)',
  'labels = map.new<string, float>()',
  'labels.put("price", close)',
  'sample = Sample.new(values, grid, labels)',
  'saved := sample',
  'emit "output0" sample',
  'emit.append "effect0" sample',
  'sample.values.push(42.0)',
  'emit.append "effect1" sample.values',
].join('\n');

function compile(source: string) {
  const errors = new Errors();
  const program = compileToProgram(
    [{filename: 'io-stress.tea', source}],
    errors,
  );
  assert.ok(
    program,
    errors
      .flushErrors()
      .map(error => error.msg)
      .join('\n'),
  );
  return loadModule(generate(program));
}

function random() {
  let state = seed;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

function detached(value: unknown): void {
  assert.equal(isRef(value), false, 'private Heap reference escaped');
  if (value === null || typeof value !== 'object') return;
  if (value instanceof Map) {
    for (const [key, item] of value) {
      detached(key);
      detached(item);
    }
  } else {
    assert.ok(
      Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype,
    );
    for (const item of Object.values(value)) detached(item);
  }
}

// Test-only inspection of the existing private Heap, not a new public metric API.
function heap(node: Node): HeapStats {
  return (
    node as unknown as {runtime: {heap: {stats(): HeapStats}}}
  ).runtime.heap.stats();
}

function report(
  name: string,
  started: number,
  count: number,
  details: object = {},
) {
  if (!stress) return;
  const elapsed = performance.now() - started;
  process.stdout.write(
    JSON.stringify({
      name,
      seed,
      node: process.version,
      count,
      milliseconds: Math.round(elapsed),
      perSecond: Math.round((count * 1000) / elapsed),
      ...details,
    }) + '\n',
  );
}

function runMixed(count: number, retainAll: boolean) {
  const started = performance.now();
  const node = createNode(compile(mixed));
  const source = new Subject<{close: number}>();
  node.bind(new DataStream(prices, source, i));
  const next = random();
  const history: number[] = [];
  const retained: {datum: Datum; expected: object}[] = [];
  let expected: Record<string, unknown> = {};
  let seen = 0;
  let failure: unknown;
  let completed = false;
  let warm: HeapStats | undefined;
  let final: HeapStats | undefined;
  let peakRss = 0;
  const v8Samples: number[] = [];
  node.to({
    next: datum => {
      assert.deepStrictEqual(datum, expected);
      seen += 1;
      if (retainAll || seen % Math.max(1, Math.floor(count / 128)) === 0) {
        detached(datum);
        retained.push({datum, expected});
      }
      if (
        seen === Math.min(64, count) ||
        seen === Math.floor(count / 2) ||
        seen === count
      ) {
        final = heap(node);
        warm ??= final;
        assert.ok(final.retainedCells > 0);
        assert.equal(final.committedCells, warm.committedCells);
        assert.equal(final.retainedCells, warm.retainedCells);
        assert.equal(final.retainedLogicalBytes, warm.retainedLogicalBytes);
        peakRss = Math.max(peakRss, process.memoryUsage().rss);
        if (globalThis.gc) {
          globalThis.gc();
          v8Samples.push(process.memoryUsage().heapUsed);
        }
      }
    },
    error: error => {
      failure = error;
    },
    complete: () => {
      completed = true;
    },
  });
  for (let index = 0; index < count && failure === undefined; index += 1) {
    const value =
      index % 17 === 0 ? NaN : index % 13 === 0 ? -0 : (next() % 100_000) / 16;
    const previous = history.length < 2 ? NaN : history[0];
    const sample = {
      values: [value, previous],
      grid: {rows: 0, columns: 3, values: []},
      labels: new Map([['price', value]]),
    };
    expected = {
      index,
      timed: false,
      provisional: false,
      output0: sample,
      effect0: [sample],
      effect1: [[value, previous, 42]],
    };
    source.next({close: value});
    history.push(value);
    if (history.length > 2) history.shift();
  }
  source.complete();
  node.dispose();
  if (failure !== undefined) throw failure;
  assert.equal(seen, count);
  assert.equal(completed, true);
  for (const row of retained) assert.deepStrictEqual(row.datum, row.expected);
  // Discarded values must not produce a sustained V8 increase. The precise
  // Tea Heap equality above is unconditional; this coarse host check needs GC.
  if (!retainAll && v8Samples.length === 3) {
    assert.ok(
      v8Samples[2] - v8Samples[1] < 16 * 1024 * 1024,
      'discarded results retained more than 16 MiB after warmup',
    );
  }
  report(retainAll ? 'retained-mixed' : 'discarded-mixed', started, count, {
    retainedRows: retained.length,
    heap: final,
    sampledPeakRssMiB: Math.round(peakRss / 1024 ** 2),
    v8HeapBytes: v8Samples.length
      ? v8Samples
      : 'unmeasured: pass Vitest --execArgv=--expose-gc',
  });
  return retained.length;
}

test('mixed Node values match an eager oracle and fixed live Heap reaches a plateau', () => {
  runMixed(stress ? 100_000 : 128, false);
}, 120_000);

test('retained mixed results remain exact after subsequent steps and disposal', () => {
  const count = stress ? 4_096 : 32;
  assert.equal(runMixed(count, true), count);
}, 120_000);

test('interleaved declarations retain all events in per-column order', () => {
  const started = performance.now();
  const count = stress ? 10_000 : 64;
  const node = createNode(
    compile(
      `for index = 0 to ${count / 2 - 1}\n    emit.append "effect0" index\n    emit.append "effect1" -index`,
    ),
  );
  node.bind(new DataStream(new Schema([]), of({}), i));
  let result: Datum | undefined;
  let failure: unknown;
  node.to({
    next: datum => {
      result = datum;
    },
    error: error => {
      failure = error;
    },
  });
  node.dispose();
  if (failure !== undefined) throw failure;
  assert.ok(result);
  const first = result.effect0 as number[];
  const second = result.effect1 as number[];
  assert.equal(first.length + second.length, count);
  for (let index = 0; index < count / 2; index += 1) {
    assert.equal(first[index], index);
    assert.equal(second[index], -index);
  }
  detached(result);
  report('interleaved-events', started, count);
});

test('independent bindings preserve source schemas and parameter-derived history', () => {
  const started = performance.now();
  const module = compile(
    'lag = input.int(1, minval=0)\nemit "output0" close[lag]',
  );
  const count = stress ? 1_000 : 16;
  const rows = Array.from({length: 8}, (_, close) => ({close}));
  for (let index = 0; index < count; index += 1) {
    const lag = index % 8;
    const copy = module.clone();
    const node = createNode(copy).bind({lag});
    assert.equal(node.module, copy);
    const source = new Subject<{close: number}>();
    node.bind(new DataStream(prices, source, i));
    let seen = 0;
    let failure: unknown;
    node.to({
      next: datum => {
        assert.deepStrictEqual(datum.output0, seen < lag ? NaN : seen - lag);
        seen += 1;
      },
      error: error => {
        failure = error;
      },
    });
    outputFields(copy.outputs.schema)[0].metadata.set('tea:type', 'forged');
    for (const row of rows) source.next(row);
    source.complete();
    node.dispose();
    if (failure !== undefined) throw failure;
    assert.equal(seen, rows.length);
    assert.equal(copy.parameters[0].value, lag);
    assert.equal(module.parameters[0].value, undefined);
    assert.equal(
      outputFields(module.outputs.schema)[0].metadata.get('tea:type'),
      'float',
    );
  }
  report('independent-bindings', started, count);
}, 120_000);

test('Tea map publication normalizes zero keys and retains NaN values', () => {
  const node = createNode(
    compile(
      [
        'values = map.new<float, float>()',
        'values.put(close, 1.0)',
        'values.put(0.0, 2.0)',
        'values.put(1.0, float(na))',
        'emit "output0" values',
      ].join('\n'),
    ),
  );
  node.bind(new DataStream(prices, of({close: -0}), i));
  let result: Datum | undefined;
  let failure: unknown;
  node.to({
    next: datum => {
      result = datum;
    },
    error: error => {
      failure = error;
    },
  });
  node.dispose();
  if (failure !== undefined) throw failure;
  assert.ok(result);
  assert.deepStrictEqual(
    result.output0,
    new Map([
      [0, 2],
      [1, NaN],
    ]),
  );
  detached(result);
});

test('a failed step publishes neither its early output nor its early effect', () => {
  const node = createNode(
    compile(
      [
        'values = array.from(close)',
        'emit "output0" values',
        'emit.append "effect0" values',
        'values.get(2)',
      ].join('\n'),
    ),
  );
  node.bind(new DataStream(prices, of({close: 1}), i));
  const publications: Datum[] = [];
  let failure: unknown;
  node.to({
    next: datum => publications.push(datum),
    error: error => {
      failure = error;
    },
  });
  node.dispose();
  assert.ok(failure);
  assert.deepStrictEqual(publications, []);
});

test('large list and binary buffers survive standard Arrow IPC', () => {
  const started = performance.now();
  for (const [length, bytes] of [
    [0, 0],
    [1, 1],
    [1_024, 1_024],
    [65_536, 1_048_576],
  ]) {
    const values = Array.from({length}, (_, index) =>
      index % 11 === 0 ? NaN : index % 7 === 0 ? -0 : index,
    );
    const binary = Uint8Array.from(
      {length: bytes},
      (_, index) => (index * 31) & 255,
    );
    const fields = new Schema([
      new Field(
        'values',
        new List(new Field('item', new Float64(), false)),
        false,
      ),
      new Field('binary', new Binary(), false),
    ]);
    validateRecord(fields, {values, binary});
    const table = new Table(fields, {
      values: vectorFromArray([values], fields.fields[0].type),
      binary: vectorFromArray([binary], fields.fields[1].type),
    });
    const row = tableFromIPC(tableToIPC(table)).get(0)!;
    assert.deepStrictEqual(Array.from(row.values), values);
    assert.deepStrictEqual(row.binary, binary);
  }
  report('large-arrow-payloads', started, 4, {
    maxList: 65_536,
    maxBinaryBytes: 1_048_576,
  });
});

test('seeded nested values round-trip through Arrow to depth 32', () => {
  const started = performance.now();
  const next = random();
  const count = stress ? 10_000 : 24;
  for (let index = 0; index < count; index += 1) {
    const leaf =
      index % 3 === 0
        ? Uint8Array.of(next() & 255, next() & 255)
        : index % 3 === 1
          ? NaN
          : -0;
    let field: Field = new Field(
      'value',
      leaf instanceof Uint8Array ? new Binary() : new Float64(),
      false,
    );
    let value: unknown = leaf;
    const path: boolean[] = [];
    for (let depth = next() % 33; depth > 0; depth -= 1) {
      const list = next() % 2 === 0;
      path.push(list);
      field = new Field(
        'value',
        list ? new List(field) : new Struct([field]),
        false,
      );
      value = list ? [value] : {value};
    }
    const schema = new Schema([field]);
    validateRecord(schema, {value});
    const table = new Table(schema, {
      value: vectorFromArray([value], field.type),
    });
    let actual = tableFromIPC(tableToIPC(table)).get(0)!.value;
    for (const list of path.reverse()) {
      if (list) {
        assert.equal(actual.length, 1);
        actual = actual.get(0);
      } else actual = actual.value;
    }
    assert.deepStrictEqual(actual, leaf);
  }
  report('nested-arrow-values', started, count, {maxDepth: 32});
}, 120_000);

test('scalar Node execution keeps one result per input', () => {
  const started = performance.now();
  const count = process.env.TEA_STRESS_SCALAR === '1' ? 1_000_000 : 256;
  const node = createNode(compile('emit "output0" close + 1'));
  const source = new Subject<{close: number}>();
  node.bind(new DataStream(prices, source, i));
  let seen = 0;
  let failure: unknown;
  node.to({
    next: datum => {
      assert.deepStrictEqual(datum.output0, (seen % 256) + 1);
      seen += 1;
    },
    error: error => {
      failure = error;
    },
  });
  for (let index = 0; index < count && failure === undefined; index += 1)
    source.next({close: index % 256});
  source.complete();
  node.dispose();
  if (failure !== undefined) throw failure;
  assert.equal(seen, count);
  report('scalar-steps', started, count);
}, 120_000);
