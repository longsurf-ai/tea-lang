// Purpose: Fail-closed execution conformance harness — every committed case runs through compile, load, bind, runAll, and TraceSink against independently reviewed, hash-pinned references.

import {existsSync, readdirSync, readFileSync, statSync} from 'node:fs';
import {dirname, join, relative, resolve} from 'node:path';
import {describe, expect, test} from 'bun:test';
import {formatPos} from '../base/pos';
import {compile} from '../compile';
import {csvProvider} from '../providers/data/csv';
import {TraceSink} from '../providers/sinks/trace-sink';
import type {BoundInput, EffectValue, OutputSink, Value} from '../runtime/abi';
import {isEffectUserTypeValue} from '../runtime/abi';
import {bind} from '../runtime/js-runtime';
import {loadModule} from '../runtime/load';
import {
  type CorpusCase,
  type ExpectedBinding,
  type ExpectedReference,
  type JsonScalar,
  parseDeviations,
  parseManifest,
  parseReference,
  readJson,
  sha256,
} from './execution-conformance-schema';

const EXECUTION_ROOT = join(import.meta.dir, '../../tests/fixtures/execution');
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

class ConformanceSink implements OutputSink {
  readonly traceLines: string[] = [];
  readonly trace = new TraceSink(line => this.traceLines.push(line));
  declared: Parameters<OutputSink['declare']>[0]['outputs'] = [];
  declaredEffects: Parameters<OutputSink['declare']>[0]['effects'] = [];
  readonly emissions: {
    readonly row: number;
    readonly oid: number;
    readonly channels: readonly Value[];
    readonly provisional: boolean;
  }[] = [];
  readonly effects: {
    readonly row: number;
    readonly effectId: number;
    readonly payload: EffectValue;
    readonly provisional: boolean;
  }[] = [];

  declare(declaration: Parameters<OutputSink['declare']>[0]): void {
    this.declared = declaration.outputs;
    this.declaredEffects = declaration.effects;
    this.trace.declare(declaration);
  }

  publish(publication: Parameters<OutputSink['publish']>[0]): void {
    for (const output of publication.outputs) {
      this.emissions.push({
        row: publication.row,
        oid: output.outputId,
        channels: [...output.channels],
        provisional: publication.provisional,
      });
    }
    for (const effect of publication.effects) {
      this.effects.push({
        row: publication.row,
        effectId: effect.effectId,
        payload: effect.payload,
        provisional: publication.provisional,
      });
    }
    this.trace.publish(publication);
  }
}

function expectFiniteOrNa(value: Value | EffectValue, label: string): void {
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
  const effectValue = value as EffectValue;
  if (isEffectUserTypeValue(effectValue)) {
    effectValue.fields.forEach((entry, i) =>
      expectFiniteOrNa(entry, `${label}.fields[${i}]`),
    );
  }
}

function expectSinkFiniteOrNa(sink: ConformanceSink, label: string): void {
  sink.declared.forEach((output, oid) => {
    output.spec.staticArgs.forEach((arg, i) =>
      expectFiniteOrNa(arg.value, `${label}.outputs[${oid}].staticArgs[${i}]`),
    );
    output.boundArgs.forEach((arg, i) =>
      expectFiniteOrNa(arg.value, `${label}.outputs[${oid}].boundArgs[${i}]`),
    );
  });
  sink.emissions.forEach((emission, i) => {
    emission.channels.forEach((value, channel) =>
      expectFiniteOrNa(value, `${label}.emissions[${i}].channels[${channel}]`),
    );
  });
  sink.effects.forEach((effect, i) =>
    expectFiniteOrNa(effect.payload, `${label}.effects[${i}].payload`),
  );
}

function expectInputs(
  actual: readonly BoundInput[],
  expected: ExpectedBinding['inputs'],
  label: string,
): void {
  actual.forEach((input, i) =>
    expectFiniteOrNa(input.value, `${label}.inputs[${i}].value`),
  );
  expect(actual, `${label}.inputs`).toEqual(expected);
}

function expectValue(
  actual: Value,
  expected: JsonScalar,
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
  expect(actual, label).toBe(expected);
}

function expectArgs(
  actual: readonly {readonly name: string; readonly value: Value}[],
  expected: readonly (readonly [string, JsonScalar])[],
  label: string,
): void {
  expect(actual.length, `${label}.length`).toBe(expected.length);
  expected.forEach(([name, value], i) => {
    expect(actual[i]?.name, `${label}[${i}].name`).toBe(name);
    const actualValue = actual[i]?.value;
    if (actualValue === undefined) {
      throw new Error(`${label}[${i}] is missing`);
    }
    expectValue(
      actualValue,
      value,
      typeof value,
      {absolute: 0, relative: 0},
      label,
    );
  });
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
  const module = loadModule(result.js);
  const sink = new ConformanceSink();
  const primary = reference.bindings[0];
  const bound = await bind(module, {
    params: primary === undefined ? {} : Object.fromEntries(primary.params),
    provider: csvProvider(
      readFileSync(join(EXECUTION_ROOT, entry.data), 'utf8'),
    ),
    sink,
    timeNow: CONFORMANCE_TIME_NOW,
  });
  if (primary !== undefined) {
    expectInputs(bound.inputs, primary.inputs, `${entry.id}.${primary.name}`);
  }
  for (const scenario of reference.bindings.slice(1)) {
    const scenarioSink = new ConformanceSink();
    const rebound = await bind(module, {
      params: Object.fromEntries(scenario.params),
      provider: csvProvider(
        readFileSync(join(EXECUTION_ROOT, entry.data), 'utf8'),
      ),
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
  await bound.runAll();

  expect(bound.rows, `${entry.id} row count`).toBe(reference.rows.length);
  expect(sink.declared.length, `${entry.id} output count`).toBe(
    reference.outputs.length,
  );
  reference.outputs.forEach((expected, oid) => {
    expect(expected.oid, `${entry.id} dense oid`).toBe(oid);
    const actual = sink.declared[oid];
    if (actual === undefined) {
      throw new Error(`${entry.id} output ${oid} is missing`);
    }
    expect(actual.spec.effect, `${entry.id} output ${oid} effect`).toBe(
      expected.effect,
    );
    expectArgs(
      actual.spec.staticArgs,
      expected.staticArgs,
      `${entry.id} output ${oid} staticArgs`,
    );
    expectArgs(
      actual.boundArgs,
      expected.boundArgs,
      `${entry.id} output ${oid} boundArgs`,
    );
    expect(
      actual.spec.channels.map(channel => [channel.name, channel.type]),
      `${entry.id} output ${oid} channels`,
    ).toEqual(expected.channels.map(([name, type]) => [name, type]));
  });

  expect(
    reference.rows.map(row => row.row),
    `${entry.id} dense rows`,
  ).toEqual(Array.from({length: bound.rows}, (_, row) => row));
  const expectedEmissions = reference.rows.flatMap(row =>
    row.emissions.map(emission => ({row: row.row, ...emission})),
  );
  expect(sink.emissions.length, `${entry.id} emission count`).toBe(
    expectedEmissions.length,
  );
  expectedEmissions.forEach((expected, i) => {
    const actual = sink.emissions[i];
    if (actual === undefined) {
      throw new Error(`${entry.id} emission ${i} is missing`);
    }
    expect(
      {row: actual.row, oid: actual.oid, provisional: actual.provisional},
      `${entry.id} emission ${i} identity`,
    ).toEqual({
      row: expected.row,
      oid: expected.oid,
      provisional: expected.provisional,
    });
    expect(
      actual.channels.length,
      `${entry.id} emission ${i} channel count`,
    ).toBe(expected.channels.length);
    expected.channels.forEach((value, channel) => {
      const output = sink.declared[expected.oid];
      const channelType = output?.spec.channels[channel]?.type;
      if (channelType === undefined) {
        throw new Error(
          `${entry.id} emission ${i} refers to a missing channel`,
        );
      }
      const actualValue = actual.channels[channel];
      if (actualValue === undefined) {
        throw new Error(
          `${entry.id} emission ${i} channel ${channel} is missing`,
        );
      }
      expectValue(
        actualValue,
        value,
        channelType,
        reference.tolerance,
        `${entry.id} row ${expected.row} oid ${expected.oid} channel ${channel}`,
      );
    });
  });

  expect(sink.traceLines.length, `${entry.id} TraceSink line count`).toBe(
    reference.outputs.length +
      sink.declaredEffects.length +
      expectedEmissions.length +
      sink.effects.length,
  );
  expectSinkFiniteOrNa(sink, entry.id);
  return {reference, sink};
}

describe('execution conformance corpus', () => {
  test('raw finite-or-na checks distinguish numeric values from strings', () => {
    expectFiniteOrNa(['Infinity', '-Infinity', NaN, [0]], 'nested');
    expect(() => expectFiniteOrNa(Infinity, 'positive')).toThrow(
      'positive must be finite or na',
    );
    expect(() => expectFiniteOrNa(-Infinity, 'negative')).toThrow(
      'negative must be finite or na',
    );
  });

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
  });
});
