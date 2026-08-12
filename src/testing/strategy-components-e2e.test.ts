// Purpose: Compile-through execution coverage for the Tea-authored broker,
// portfolio, and strategy libraries using an explicit source registry.

import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, test} from 'bun:test';
import {newFileBase} from '../base/pos';
import {Errors} from '../base/print';
import {checkPackage} from '../checker/check';
import {generate} from '../codegen/codegen';
import type {Program} from '../ir/program';
import {TypeKind} from '../ir/type';
import {funcsOf} from '../ir/visit';
import {
  resolveImports,
  type PackageSource,
  type Registry,
} from '../loader/loader';
import {buildProgram} from '../noder/noder';
import {csvProvider} from '../providers/data/csv';
import type {EffectValue, OutputSink, Value} from '../runtime/abi';
import {bind} from '../runtime/js-runtime';
import {loadModule} from '../runtime/load';
import {parse} from '../syntax/syntax';

const LIBRARIES: Readonly<Record<string, string>> = {
  ta: readFileSync(join(import.meta.dir, '../lib/ta.tea'), 'utf8'),
  broker: readFileSync(join(import.meta.dir, '../lib/broker.tea'), 'utf8'),
  portfolio: readFileSync(
    join(import.meta.dir, '../lib/portfolio.tea'),
    'utf8',
  ),
  strategy: readFileSync(join(import.meta.dir, '../lib/strategy.tea'), 'utf8'),
};

const REGISTRY: Registry = (path: string): PackageSource | null => {
  const source = LIBRARIES[path];
  return source === undefined ? null : {filename: `lib/${path}.tea`, source};
};

interface Emission {
  readonly row: number;
  readonly oid: number;
  readonly channels: readonly Value[];
}

interface SparseEmission {
  readonly row: number;
  readonly effectId: number;
  readonly payload: EffectValue;
}

class Sink implements OutputSink {
  readonly emissions: Emission[] = [];
  readonly effects: SparseEmission[] = [];

  declare(): void {}

  publish(publication: Parameters<OutputSink['publish']>[0]): void {
    for (const output of publication.outputs) {
      this.emissions.push({
        row: publication.row,
        oid: output.outputId,
        channels: [...output.channels],
      });
    }
    for (const effect of publication.effects) {
      this.effects.push({
        row: publication.row,
        effectId: effect.effectId,
        payload: effect.payload,
      });
    }
  }
}

function compileComponents(source: string): {
  readonly program: Program;
  readonly js: string;
} {
  const errors = new Errors();
  const file = parse(
    newFileBase('strategy-components.tea'),
    source,
    (pos, msg) => errors.errorAt(pos, msg),
  );
  failOnErrors(errors);

  const checked = checkPackage(
    [file],
    errors,
    resolveImports([file], REGISTRY, []),
  );
  failOnErrors(errors);

  const program = buildProgram(checked, errors);
  failOnErrors(errors);
  const js = generate(program);
  return {program, js};
}

function failOnErrors(errors: Errors): void {
  if (errors.count === 0) {
    return;
  }
  throw new Error(
    errors
      .flushErrors()
      .map(
        error =>
          `${error.pos.base.filename}:${error.pos.line}:${error.pos.col}: ${error.msg}`,
      )
      .join('\n'),
  );
}

async function execute(source: string, csv: string) {
  const compiled = compileComponents(source);
  const sink = new Sink();
  const bound = await bind(loadModule(compiled.js), {
    params: {},
    provider: csvProvider(csv),
    sink,
    timeNow: 0,
  });
  await bound.runAll();
  bound.dispose();
  return {program: compiled.program, sink};
}

function valuesFor(sink: Sink, oid: number): readonly Value[] {
  return sink.emissions
    .filter(emission => emission.oid === oid)
    .sort((left, right) => left.row - right.row)
    .map(emission => emission.channels[0]);
}

function effectTimeline(
  program: Program,
  sink: Sink,
): readonly (readonly [number, string])[] {
  return sink.effects.map(emission => {
    const type = program.effects[emission.effectId]?.payloadType;
    if (type?.kind !== TypeKind.UserType) {
      throw new Error(`effect ${emission.effectId} has no nominal payload`);
    }
    return [emission.row, type.name] as const;
  });
}

function effectField(
  program: Program,
  sink: Sink,
  emissionIndex: number,
  ...path: readonly string[]
): EffectValue {
  const emission = sink.effects[emissionIndex];
  let type =
    emission === undefined
      ? undefined
      : program.effects[emission.effectId]?.payloadType;
  let value = emission?.payload;
  for (const name of path) {
    if (
      type?.kind !== TypeKind.UserType ||
      value === undefined ||
      typeof value !== 'object' ||
      value === null ||
      value.kind !== 'user-type'
    ) {
      throw new Error(`effect ${emissionIndex} cannot select '${name}'`);
    }
    const fieldIndex = type.fields.findIndex(field => field.name === name);
    const field = type.fields[fieldIndex];
    const fieldValue = value.fields[fieldIndex];
    if (field === undefined || fieldValue === undefined) {
      throw new Error(`effect ${emissionIndex} has no field '${name}'`);
    }
    type = field.type;
    value = fieldValue;
  }
  if (value === undefined) {
    throw new Error(`effect ${emissionIndex} has no payload`);
  }
  return value;
}

function expectNumbersClose(
  actual: readonly Value[],
  expected: readonly number[],
): void {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((value, index) => {
    expect(actual[index]).toBeCloseTo(value, 12);
  });
}

describe('Tea strategy components end to end', () => {
  test('keeps two configured strategy values isolated through scripted phases', async () => {
    const source = [
      'strategy("isolated component state")',
      'import broker',
      'import portfolio',
      'import strategy',
      'var primary = strategy.configure(broker.basic(), portfolio.basic(100.0))',
      'var secondary = strategy.configure(broker.basic(), portfolio.basic(100.0))',
      'primary.begin(open, bar_index)',
      'secondary.begin(open, bar_index)',
      'if bar_index == 0',
      '    primary.entry("Primary", strategy.Direction.long)',
      'if bar_index == 1',
      '    secondary.entry("Secondary", strategy.Direction.long)',
      'if bar_index == 2',
      '    primary.close("Primary")',
      '    secondary.close("Secondary")',
      'primary.end(close, barstate.islast)',
      'secondary.end(close, barstate.islast)',
      'plot(primary.cash())',
      'plot(primary.position_quantity())',
      'plot(primary.equity())',
      'plot(primary.realized_pnl())',
      'plot(float(primary.fill_count()))',
      'plot(secondary.cash())',
      'plot(secondary.position_quantity())',
      'plot(secondary.equity())',
      'plot(secondary.realized_pnl())',
      'plot(float(secondary.fill_count()))',
      'plot(primary.has_pending() ? 1 : 0)',
      'plot(secondary.has_pending() ? 1 : 0)',
    ].join('\n');
    const {program, sink} = await execute(
      source,
      ['open,close', '10,10', '20,20', '30,30', '40,40', ''].join('\n'),
    );

    expect(funcsOf(program).map(func => func.name)).toEqual(
      expect.arrayContaining([
        'Basic.on_open',
        'Basic.submit',
        'Basic.finish',
        'Basic.apply',
        'Basic.mark',
        'Strategy<Basic, Basic>.begin',
        'Strategy<Basic, Basic>.entry',
        'Strategy<Basic, Basic>.close',
        'Strategy<Basic, Basic>.end',
      ]),
    );
    expect(program.outputs[0]?.effect).toBe('strategy');
    expect(valuesFor(sink, 1)).toEqual([100, 0, 0, 200]);
    expect(valuesFor(sink, 2)).toEqual([0, 5, 5, 0]);
    expect(valuesFor(sink, 3)).toEqual([100, 100, 150, 200]);
    expect(valuesFor(sink, 4)).toEqual([0, 0, 0, 100]);
    expect(valuesFor(sink, 5)).toEqual([0, 1, 1, 2]);
    expectNumbersClose(valuesFor(sink, 6), [100, 100, 0, 400 / 3]);
    expectNumbersClose(valuesFor(sink, 7), [0, 0, 10 / 3, 0]);
    expectNumbersClose(valuesFor(sink, 8), [100, 100, 100, 400 / 3]);
    expectNumbersClose(valuesFor(sink, 9), [0, 0, 0, 100 / 3]);
    expect(valuesFor(sink, 10)).toEqual([0, 0, 1, 2]);
    expect(valuesFor(sink, 11)).toEqual([1, 0, 1, 0]);
    expect(valuesFor(sink, 12)).toEqual([0, 1, 1, 0]);
  });

  test('retains an entry submitted after begin until a later bar', async () => {
    const source = [
      'strategy("enforced next-open causality")',
      'import broker',
      'import portfolio',
      'import strategy',
      'var strat = strategy.configure(broker.basic(), portfolio.basic(100.0))',
      'strat.begin(open, bar_index)',
      'if bar_index == 0',
      '    strat.entry("Long", strategy.Direction.long)',
      'strat.end(close, barstate.islast)',
      'plot(strat.fill_count())',
      'plot(strat.cash())',
      'plot(strat.position_quantity())',
      'plot(strat.has_pending() ? 1 : 0)',
    ].join('\n');
    const {sink} = await execute(
      source,
      ['open,close', '10,10', '10,10', ''].join('\n'),
    );

    expect(valuesFor(sink, 1)).toEqual([0, 1]);
    expect(valuesFor(sink, 2)).toEqual([100, 0]);
    expect(valuesFor(sink, 3)).toEqual([0, 10]);
    expect(valuesFor(sink, 4)).toEqual([1, 0]);
  });

  test('marks but does not forcibly liquidate an open position at end of data', async () => {
    const source = [
      'strategy("open position at end of data")',
      'import broker',
      'import portfolio',
      'import strategy',
      'var strat = strategy.configure(broker.basic(), portfolio.basic(100.0))',
      'strat.begin(open, bar_index)',
      'if bar_index == 0',
      '    strat.entry("Long", strategy.Direction.long)',
      'strat.end(close, barstate.islast)',
      'plot(strat.cash())',
      'plot(strat.position_quantity())',
      'plot(strat.equity())',
      'plot(strat.realized_pnl())',
      'plot(strat.fill_count())',
      'plot(strat.round_trip_count())',
    ].join('\n');
    const {sink} = await execute(
      source,
      ['open,close', '10,10', '10,12', '15,15', ''].join('\n'),
    );

    expect(valuesFor(sink, 1)).toEqual([100, 0, 0]);
    expect(valuesFor(sink, 2)).toEqual([0, 10, 10]);
    expect(valuesFor(sink, 3)).toEqual([100, 120, 150]);
    expect(valuesFor(sink, 4)).toEqual([0, 0, 0]);
    expect(valuesFor(sink, 5)).toEqual([0, 1, 1]);
    expect(valuesFor(sink, 6)).toEqual([0, 0, 0]);
  });

  test('fills on the next open and applies slippage, fees, and round-trip accounting', async () => {
    const source = [
      'strategy("next-open accounting")',
      'import broker',
      'import portfolio',
      'import strategy',
      'var strat = strategy.configure(broker.basic(0.1, 0.1), portfolio.basic(121.0))',
      'strat.begin(open, bar_index)',
      'if bar_index == 0',
      '    strat.entry("Long", strategy.Direction.long)',
      'if bar_index == 1',
      '    strat.close("Long")',
      'strat.end(close, barstate.islast)',
      'plot(strat.cash())',
      'plot(strat.position_quantity())',
      'plot(strat.equity())',
      'plot(strat.realized_pnl())',
      'plot(strat.total_fees())',
      'plot(float(strat.fill_count()))',
      'plot(float(strat.round_trip_count()))',
      'plot(strat.max_drawdown())',
    ].join('\n');
    const {program, sink} = await execute(
      source,
      ['open,close', '10,10', '10,11', '20,18', ''].join('\n'),
    );

    expectNumbersClose(valuesFor(sink, 1), [121, 0, 162]);
    expectNumbersClose(valuesFor(sink, 2), [0, 10, 0]);
    expectNumbersClose(valuesFor(sink, 3), [121, 110, 162]);
    expectNumbersClose(valuesFor(sink, 4), [0, 0, 41]);
    expectNumbersClose(valuesFor(sink, 5), [0, 11, 29]);
    expect(valuesFor(sink, 6)).toEqual([0, 1, 2]);
    expect(valuesFor(sink, 7)).toEqual([0, 0, 1]);
    expect(valuesFor(sink, 8)[0]).toBe(0);
    expect(valuesFor(sink, 8)[1]).toBeCloseTo(11 / 121, 12);
    expect(valuesFor(sink, 8)[2]).toBeCloseTo(11 / 121, 12);
    expect(effectTimeline(program, sink)).toEqual([
      [0, 'OrderSubmitted'],
      [1, 'FillExecuted'],
      [1, 'OrderSubmitted'],
      [2, 'FillExecuted'],
    ]);
  });

  test('emits rejected and final-expiry events from Tea lifecycle code', async () => {
    const source = [
      'strategy("effect lifecycle")',
      'import broker',
      'import portfolio',
      'import strategy',
      'var strat = strategy.configure(broker.basic(), portfolio.basic(100.0))',
      'strat.begin(open, bar_index)',
      'if bar_index == 0',
      '    strat.entry("accepted", strategy.Direction.long)',
      '    strat.entry("rejected", strategy.Direction.long)',
      'if bar_index == 1',
      '    strat.close("exit")',
      '    strat.entry("rejected exit", strategy.Direction.long)',
      'if bar_index == 2',
      '    strat.entry("expires", strategy.Direction.long)',
      'strat.end(close, barstate.islast)',
    ].join('\n');
    const {program, sink} = await execute(
      source,
      ['open,close', '10,10', '10,10', '20,20', ''].join('\n'),
    );

    expect(effectTimeline(program, sink)).toEqual([
      [0, 'OrderSubmitted'],
      [0, 'OrderRejected'],
      [1, 'FillExecuted'],
      [1, 'OrderSubmitted'],
      [1, 'OrderRejected'],
      [2, 'FillExecuted'],
      [2, 'OrderSubmitted'],
      [2, 'OrderExpired'],
    ]);
    expect([
      effectField(program, sink, 0, 'order', 'commandId'),
      effectField(program, sink, 1, 'commandId'),
      effectField(program, sink, 2, 'fill', 'commandId'),
      effectField(program, sink, 3, 'order', 'commandId'),
      effectField(program, sink, 4, 'commandId'),
      effectField(program, sink, 5, 'fill', 'commandId'),
      effectField(program, sink, 6, 'order', 'commandId'),
      effectField(program, sink, 7, 'order', 'commandId'),
    ]).toEqual([
      'accepted',
      'rejected',
      'accepted',
      'exit',
      'rejected exit',
      'exit',
      'expires',
      'expires',
    ]);
  });

  test('lets the concrete broker report an invalid account state', async () => {
    const source = [
      'strategy("broker rejection ownership")',
      'import broker',
      'import portfolio',
      'import strategy',
      'var strat = strategy.configure(broker.basic(), portfolio.basic(100.0))',
      'strat.begin(open, bar_index)',
      'if bar_index == 0',
      '    strat.entry("first", strategy.Direction.long)',
      'if bar_index == 1',
      '    strat.entry("already long", strategy.Direction.long)',
      'strat.end(close, barstate.islast)',
    ].join('\n');
    const {program, sink} = await execute(
      source,
      ['open,close', '10,10', '10,10', '10,10', ''].join('\n'),
    );

    expect(effectTimeline(program, sink)).toEqual([
      [0, 'OrderSubmitted'],
      [1, 'FillExecuted'],
      [1, 'OrderSubmitted'],
      [2, 'OrderRejected'],
    ]);
    expect(effectField(program, sink, 3, 'commandId')).toBe('already long');
    expect(effectField(program, sink, 3, 'reason')).toBe('invalidAccountState');
  });

  test('turns SMA crossovers into next-open fills in the documented phase order', async () => {
    const source = [
      'strategy("SMA crossover lifecycle")',
      'import ta',
      'import broker',
      'import portfolio',
      'import strategy',
      'var strat = strategy.configure(broker.basic(), portfolio.basic(100.0))',
      'strat.begin(open, bar_index)',
      'fast = ta.sma(close, 2)',
      'slow = ta.sma(close, 3)',
      'enterLong = ta.crossover(fast, slow)',
      'exitLong = ta.crossunder(fast, slow)',
      'if enterLong',
      '    strat.entry("Long", strategy.Direction.long)',
      'if exitLong',
      '    strat.close("Long")',
      'strat.end(close, barstate.islast)',
      'plot(enterLong ? 1 : 0)',
      'plot(exitLong ? 1 : 0)',
      'plot(strat.cash())',
      'plot(strat.position_quantity())',
      'plot(strat.realized_pnl())',
      'plot(strat.fill_count())',
      'plot(strat.round_trip_count())',
    ].join('\n');
    const {sink} = await execute(
      source,
      [
        'open,close',
        '3,3',
        '2,2',
        '1,1',
        '2,2',
        '3,3',
        '2,2',
        '1,1',
        '1,1',
        '',
      ].join('\n'),
    );

    expect(valuesFor(sink, 1)).toEqual([0, 0, 0, 0, 1, 0, 0, 0]);
    expect(valuesFor(sink, 2)).toEqual([0, 0, 0, 0, 0, 0, 1, 0]);
    expect(valuesFor(sink, 3)).toEqual([100, 100, 100, 100, 100, 0, 0, 50]);
    expect(valuesFor(sink, 4)).toEqual([0, 0, 0, 0, 0, 50, 50, 0]);
    expect(valuesFor(sink, 5)).toEqual([0, 0, 0, 0, 0, 0, 0, -50]);
    expect(valuesFor(sink, 6)).toEqual([0, 0, 0, 0, 0, 1, 1, 2]);
    expect(valuesFor(sink, 7)).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
  });
});
