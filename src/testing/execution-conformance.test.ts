import type {Module} from '../runtime/module-binding';
// Purpose: Fail-closed execution conformance harness — every committed case runs through compile, load, bind, runAll, and the CLI trace formatter against independently reviewed, hash-pinned references.

import {existsSync, readdirSync, readFileSync, statSync} from 'node:fs';
import {dirname, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, test} from 'vitest';
import {formatPos} from '../base/pos';
import {traceDatum, traceDeclaration} from '../cli/output';
import {compile} from '../compiler';
import type {Datum} from '../runtime/output';

import {OutputCapture} from './output';
import {loadModule} from '../runtime/load';
import {csvStream, executeTestModule} from './batch';
import {
  type CorpusCase,
  type ExpectedBinding,
  type ExpectedEmission,
  type ExpectedReference,
  parseDeviations,
  parseManifest,
  parseReference,
  readJson,
  sha256,
} from './execution-conformance-schema';

const EXECUTION_ROOT = join(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../tests/fixtures/execution',
);
const CONFORMANCE_TIME_NOW = 1_700_000_000_000;

function allFiles(root: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (statSync(path).isDirectory()) {
      found.push(...allFiles(path));
    } else {
      found.push(relative(EXECUTION_ROOT, path).replaceAll('\\', '/'));
    }
  }
  return found.sort();
}

class ConformanceSink extends OutputCapture {
  readonly traceLines: string[] = [];

  override declare(declaration: Module['outputs']): void {
    super.declare(declaration);
    this.traceLines.push(...traceDeclaration(declaration));
  }

  override publish(publication: Datum): void {
    super.publish(publication);
    this.traceLines.push(...traceDatum(publication, this.schema));
  }
}

function expectFiniteOrNa(value: unknown, label: string): void {
  if (typeof value === 'number') {
    expect(
      Number.isFinite(value) || Number.isNaN(value),
      `${label} must be finite or na`,
    ).toBe(true);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, i) => expectFiniteOrNa(entry, `${label}[${i}]`));
    return;
  }
  if (value instanceof Map) {
    [...value].forEach((entry, i) => expectFiniteOrNa(entry, `${label}[${i}]`));
  } else if (value !== null && typeof value === 'object') {
    Object.entries(value).forEach(([name, entry]) =>
      expectFiniteOrNa(entry, `${label}.${name}`),
    );
  }
}

function expectSinkFiniteOrNa(sink: ConformanceSink, label: string): void {
  sink.emissions.forEach((emission, i) => {
    emission.channels.forEach((value, channel) =>
      expectFiniteOrNa(value, `${label}.emissions[${i}].channels[${channel}]`),
    );
  });
  sink.effectEmissions.forEach((effect, i) =>
    expectFiniteOrNa(effect.payload, `${label}.effects[${i}].payload`),
  );
}

function expectInputs(
  actual: Module['parameters'],
  expected: ExpectedBinding['inputs'],
  label: string,
): void {
  actual.forEach((input, i) =>
    expectFiniteOrNa(input.value, `${label}.inputs[${i}].value`),
  );
  expect(
    actual.map(({value, active, enumType, ...spec}) => ({
      spec: {
        ...spec,
        enumType:
          enumType === null
            ? null
            : {
                name: enumType.name,
                members: enumType.members,
              },
      },
      value,
      active,
    })),
    `${label}.inputs`,
  ).toEqual(expected);
}

function expectValue(
  actual: unknown,
  expected: ExpectedEmission['value'],
  channelType: string,
  tolerance: ExpectedReference['tolerance'],
  label: string,
): void {
  if (expected === null) {
    if (channelType === 'int' || channelType === 'float') {
      expect(typeof actual, label).toBe('number');
      expect(Number.isNaN(actual as number), label).toBe(true);
    } else {
      expect(actual, label).toBeNull();
    }
    return;
  }
  if (typeof expected === 'number') {
    expect(typeof actual, label).toBe('number');
    const n = actual as number;
    expect(Number.isFinite(n), label).toBe(true);
    const limit =
      tolerance.absolute +
      tolerance.relative * Math.max(Math.abs(expected), Math.abs(n));
    expect(Math.abs(n - expected), label).toBeLessThanOrEqual(limit);
    return;
  }
  expect(actual, label).toEqual(expected);
}

async function runCase(entry: CorpusCase): Promise<{
  readonly reference: ExpectedReference;
  readonly sink: ConformanceSink;
}> {
  for (const [name, path, expected] of [
    ['source', entry.source, entry.sha256.source],
    ['data', entry.data, entry.sha256.data],
    ['reference', entry.reference, entry.sha256.reference],
  ] as const) {
    expect(sha256(join(EXECUTION_ROOT, path)), `${entry.id} ${name} hash`).toBe(
      expected,
    );
  }
  const reference = parseReference(
    await readJson(join(EXECUTION_ROOT, entry.reference)),
    entry.reference,
  );
  const referenceDirectory = dirname(join(EXECUTION_ROOT, entry.reference));
  for (const document of reference.oracle.references) {
    if (document.startsWith('https://') || document.startsWith('http://')) {
      expect(() => new URL(document), `${entry.id} oracle URL`).not.toThrow();
      continue;
    }
    expect(
      existsSync(resolve(referenceDirectory, document)),
      `${entry.id} oracle reference '${document}' must exist`,
    ).toBe(true);
  }
  if (entry.kind === 'differential') {
    expect(
      reference.oracle.kind,
      `${entry.id} must use an independent oracle`,
    ).not.toBe('tea-contract');
  }
  const result = compile([resolve(EXECUTION_ROOT, entry.source)]);
  if (!result.ok) {
    throw new Error(
      `${entry.id} did not compile:\n${result.errors
        .map(error => `${formatPos(error.pos)}: ${error.msg}`)
        .join('\n')}`,
    );
  }
  const module = loadModule(result.source);
  const sink = new ConformanceSink();
  const primary = reference.bindings[0];
  const data = readFileSync(join(EXECUTION_ROOT, entry.data), 'utf8');
  const requests = Object.fromEntries(
    module.requests.map(request => [
      request.name,
      csvStream(data, request.context?.calcBarsCount || undefined),
    ]),
  );
  const completed = await executeTestModule(module, {
    params: primary === undefined ? {} : Object.fromEntries(primary.params),
    stream: csvStream(data),
    requests,
    sink,
    timeNow: CONFORMANCE_TIME_NOW,
  });
  if (primary !== undefined) {
    expectInputs(
      completed.inputs,
      primary.inputs,
      `${entry.id}.${primary.name}`,
    );
  }
  for (const scenario of reference.bindings.slice(1)) {
    const scenarioSink = new ConformanceSink();
    const rebound = await executeTestModule(module, {
      params: Object.fromEntries(scenario.params),
      stream: csvStream(data),
      requests,
      sink: scenarioSink,
      timeNow: CONFORMANCE_TIME_NOW,
    });
    expectInputs(
      rebound.inputs,
      scenario.inputs,
      `${entry.id}.${scenario.name}`,
    );
    expectSinkFiniteOrNa(scenarioSink, `${entry.id}.${scenario.name}`);
  }

  expect(completed.indices, `${entry.id} index count`).toBe(
    reference.rows.length,
  );
  const setFields = sink.fields.filter(
    field => field.metadata.get('tea:write') === 'set',
  );
  expect(
    setFields.map(field => ({
      name: field.name,
      type: field.metadata.get('tea:type'),
    })),
    `${entry.id} named output declarations`,
  ).toEqual(reference.outputs);

  expect(
    reference.rows.map(row => row.row),
    `${entry.id} dense rows`,
  ).toEqual(Array.from({length: completed.indices}, (_, row) => row));
  const expectedEmissions = reference.rows.flatMap(row =>
    row.emissions.map(emission => ({row: row.row, ...emission})),
  );
  expect(sink.emissions.length, `${entry.id} emission count`).toBe(
    expectedEmissions.length,
  );
  expectedEmissions.forEach((expected, i) => {
    const actual = sink.emissions[i];
    if (actual === undefined)
      throw new Error(`${entry.id} emission ${i} is missing`);
    const field = sink.fields[actual.outputId]!;
    expect(
      {
        row: actual.row,
        name: field.name,
        provisional: actual.provisional,
      },
      `${entry.id} emission ${i} identity`,
    ).toEqual({
      row: expected.row,
      name: expected.name,
      provisional: expected.provisional,
    });
    expect(actual.channels.length).toBe(1);
    expectValue(
      actual.channels[0],
      expected.value,
      field.metadata.get('tea:type')!,
      reference.tolerance,
      `${entry.id} row ${expected.row} column ${expected.name}`,
    );
  });

  expect(sink.traceLines.length, `${entry.id} trace line count`).toBe(
    sink.fields.length * (reference.rows.length + 1),
  );
  expectSinkFiniteOrNa(sink, entry.id);
  return {reference, sink};
}

describe('execution conformance corpus', () => {
  test('color references require exact RGBA byte records', () => {
    const reference = {
      version: 1,
      oracle: {kind: 'tea-contract', description: 'RGBA bytes', references: []},
      tolerance: {absolute: 0, relative: 0},
      outputs: [{name: 'color', type: 'color'}],
      rows: [
        {
          row: 0,
          emissions: [
            {name: 'color', provisional: false, value: null as unknown},
          ],
        },
      ],
      deviations: [],
    };
    const emission = reference.rows[0].emissions[0];
    for (const value of [null, {r: 255, g: 82, b: 82, a: 255}]) {
      emission.value = value;
      expect(
        parseReference(reference, 'color').rows[0].emissions[0].value,
      ).toEqual(value);
    }
    for (const value of [
      '#FF5252',
      {r: 255, g: 82, b: 82},
      {r: 255, g: 82, b: 82, a: 256},
      {r: 255, g: 82, b: 82, a: -1},
      {r: 255, g: 82, b: 82, a: 0.5},
      {r: 255, g: 82, b: 82, a: NaN},
      {r: 255, g: 82, b: 82, a: 255, extra: true},
    ]) {
      emission.value = value;
      expect(() => parseReference(reference, 'color')).toThrow();
    }
  });

  test('raw finite-or-na checks distinguish numeric values from strings', () => {
    expectFiniteOrNa(['Infinity', '-Infinity', NaN, [0]], 'nested');
    expect(() => expectFiniteOrNa(Infinity, 'positive')).toThrow(
      'positive must be finite or na',
    );
    expect(() => expectFiniteOrNa(-Infinity, 'negative')).toThrow(
      'negative must be finite or na',
    );
  });

  // This compiles and executes the entire corpus, not one unit-sized case.
  test('every hash-pinned case compiles, binds, executes, and matches its reference', async () => {
    const manifest = parseManifest(
      await readJson(join(EXECUTION_ROOT, 'manifest.json')),
    );
    expect(manifest.cases.length).toBeGreaterThan(0);
    expect(manifest.cases.some(entry => entry.kind === 'compile-through')).toBe(
      true,
    );
    expect(manifest.cases.some(entry => entry.kind === 'differential')).toBe(
      true,
    );

    const declaredFiles = [
      'manifest.json',
      manifest.deviations.path,
      ...manifest.cases.flatMap(entry => [
        entry.source,
        entry.data,
        entry.reference,
      ]),
    ].sort();
    expect(allFiles(EXECUTION_ROOT), 'execution corpus inventory').toEqual(
      declaredFiles,
    );
    const ledgerPath = join(EXECUTION_ROOT, manifest.deviations.path);
    expect(sha256(ledgerPath), 'deviation ledger hash').toBe(
      manifest.deviations.sha256,
    );
    const deviations = parseDeviations(await readJson(ledgerPath));
    const byId = new Map(deviations.map(entry => [entry.id, entry]));
    const uses = new Map<string, number>();

    for (const entry of manifest.cases) {
      const {reference} = await runCase(entry);
      const unique = new Set(reference.deviations);
      expect(
        unique.size,
        `${entry.id} deviation references must be unique`,
      ).toBe(reference.deviations.length);
      for (const id of reference.deviations) {
        const deviation = byId.get(id);
        if (deviation === undefined) {
          throw new Error(`${entry.id} references unknown deviation '${id}'`);
        }
        expect(deviation.caseId, `deviation '${id}' case owner`).toBe(entry.id);
        uses.set(id, (uses.get(id) ?? 0) + 1);
      }
    }
    for (const deviation of deviations) {
      expect(
        uses.get(deviation.id),
        `deviation '${deviation.id}' must be used exactly once`,
      ).toBe(1);
    }
  }, 15_000);
});
