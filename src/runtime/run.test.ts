// Purpose: Execution tests — hand-checked numeric vectors as ground truth, plus golden traces over the deterministic csv fixture; regenerate with UPDATE_GOLDENS=1 bun test.

import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, test} from 'bun:test';
import {generate} from '../codegen/codegen';
import {captureSink, configureLog, logConfig} from '../base/log';
import {buildText, mustBuild} from '../noder/testing';
import {csvContext, csvProvider} from '../providers/data/csv';
import {TraceSink} from '../providers/sinks/trace-sink';
import {BindError, RequestError, type DataProvider, type Value} from './abi';
import {bind} from './js-runtime';
import {loadModule} from './load';

const TESTDATA = join(import.meta.dir, '../../tests/fixtures');
const UPDATE = process.env['UPDATE_GOLDENS'] === '1';

async function runSource(
  src: string,
  csv: string,
  params: Record<string, Value> = {},
  provider: DataProvider | null = null,
): Promise<string[]> {
  const program = mustBuild(src);
  const js = generate(program);
  const module = loadModule(js);
  const lines: string[] = [];
  const sink = new TraceSink(line => lines.push(line));
  const bound = await bind(module, {
    params,
    provider: provider ?? csvProvider(csv),
    sink,
    timeNow: 1_800_000_000_000,
  });
  await bound.runAll();
  return lines;
}

// A multi-context provider from csv payloads — '' is the primary context,
// other keys answer request symbols.
function csvContexts(byId: Record<string, string>): DataProvider {
  const parsed = new Map(
    Object.entries(byId).map(([id, text]) => [id, csvContext(text)]),
  );
  return {
    resolveContext: symbol =>
      Promise.resolve(
        parsed.get(symbol) ?? {
          error: 'unknownSymbol' as const,
          detail: `no context '${symbol}'`,
        },
      ),
  };
}

function seriesCsv(values: readonly number[]): string {
  return `close${chr10()}${values.join(chr10())}${chr10()}`;
}

function chr10(): string {
  return String.fromCharCode(10);
}

describe('hand-checked vectors', () => {
  test('same-iteration collection aliases isolate mutations in both write orders', async () => {
    const lines = await runSource(
      [
        'leftFirst = array.from(0)',
        'leftFirstPeer = leftFirst',
        'leftFirst.push(1)',
        'leftFirstPeer.push(2)',
        'plot(leftFirst.get(1))',
        'plot(leftFirstPeer.get(1))',
        'peerFirst = array.from(0)',
        'peerFirstPeer = peerFirst',
        'peerFirstPeer.push(3)',
        'peerFirst.push(4)',
        'plot(peerFirst.get(1))',
        'plot(peerFirstPeer.get(1))',
      ].join(chr10()),
      seriesCsv([1]),
    );
    expect(lines.filter(line => !line.startsWith('#'))).toEqual([
      '0 0 1',
      '0 1 2',
      '0 2 4',
      '0 3 3',
    ]);
  });

  test('nested receiver writeback preserves an argument-side sibling write', async () => {
    const lines = await runSource(
      [
        'type Holder',
        '    array<int> values',
        '    int marker',
        '    int setMarker(int value) =>',
        '        this.marker := value',
        '        this.marker',
        'holder = Holder.new(array.from(1), 2)',
        'holder.values.push(holder.setMarker(9))',
        'plot(holder.values.get(1))',
        'plot(holder.marker)',
      ].join(chr10()),
      seriesCsv([1]),
    );
    expect(lines.filter(line => !line.startsWith('#'))).toEqual([
      '0 0 9',
      '0 1 9',
    ]);
  });

  test('eager ternary retains and executes an unselected fallible operand', async () => {
    await expect(
      runSource(
        ['value = true ? 1 : array.new<int>().first()', 'plot(value)'].join(
          chr10(),
        ),
        seriesCsv([1]),
      ),
    ).rejects.toThrow('EMPTY_COLLECTION');
  });

  test('ta.sma matches hand-computed values', async () => {
    const lines = await runSource(
      'plot(ta.sma(close, 2))',
      seriesCsv([2, 4, 6, 8]),
    );
    expect(lines.slice(1)).toEqual(['0 0 na', '1 0 3', '2 0 5', '3 0 7']);
  });

  test('ta.ema matches hand-computed values', async () => {
    // alpha = 2 / (3 + 1) = 0.5
    const lines = await runSource(
      'plot(ta.ema(close, 3))',
      seriesCsv([2, 4, 6]),
    );
    expect(lines.slice(1)).toEqual(['0 0 2', '1 0 3', '2 0 4.5']);
  });

  test('ta.change and history offsets', async () => {
    const lines = await runSource(
      'plot(ta.change(close))',
      seriesCsv([5, 8, 6]),
    );
    expect(lines.slice(1)).toEqual(['0 0 na', '1 0 3', '2 0 -2']);
  });

  test('negative and na history offsets never read future or undefined values', async () => {
    const lines = await runSource(
      [
        'int missing = na',
        'value = close',
        'value := close',
        'plot(close[-1])',
        'plot(close[missing])',
        'plot(value[missing])',
      ].join(chr10()),
      seriesCsv([10, 20]),
    );
    const rows = lines.filter(line => !line.startsWith('#'));
    expect(rows).toHaveLength(6);
    expect(rows.every(line => line.endsWith(' na'))).toBe(true);
  });

  test('an unsafe computed offset cannot erase a valid demand on the same carrier', async () => {
    const lines = await runSource(
      [
        'valid = input.int(2)',
        'invalid = input.int(9007199254740991) + 1',
        'base = close * 1',
        'plot(base[valid])',
        'plot(base[invalid])',
      ].join(chr10()),
      seriesCsv([10, 20, 30]),
    );
    expect(lines.filter(line => line.startsWith('2 '))).toEqual([
      '2 0 10',
      '2 1 na',
    ]);
  });

  test('a computed input alias sizes history beyond the dynamic cap', async () => {
    const values = Array.from({length: 1002}, (_, index) => index + 1);
    const lines = await runSource(
      [
        'identity(int value) => value',
        'len = input.int(1000)',
        'alias = identity(len) + 0',
        'base = close * 1',
        'plot(base[alias])',
      ].join(chr10()),
      seriesCsv(values),
    );
    const rows = lines.filter(line => !line.startsWith('#'));
    expect(rows.slice(-2)).toEqual(['1000 0 1', '1001 0 2']);
  });

  test('input UDF offsets and stencil-local aliases size history per call-site max', async () => {
    const values = Array.from({length: 1002}, (_, index) => index + 1);
    const direct = await runSource(
      [
        'offset(int value) => value',
        'len = input.int(1000)',
        'base = close * 1',
        'plot(base[offset(len)])',
      ].join(chr10()),
      seriesCsv(values),
    );
    expect(direct.filter(line => !line.startsWith('#')).slice(-2)).toEqual([
      '1000 0 1',
      '1001 0 2',
    ]);

    const stencil = await runSource(
      [
        'sample(int length) =>',
        `${String.fromCharCode(9)}alias = length + 0`,
        `${String.fromCharCode(9)}base = close * 1`,
        `${String.fromCharCode(9)}base[alias]`,
        'plot(sample(input.int(2)))',
        'plot(sample(input.int(1000)))',
      ].join(chr10()),
      seriesCsv(values),
    );
    const rows = stencil.filter(line => !line.startsWith('#'));
    expect(rows.slice(-4)).toEqual([
      '1000 0 999',
      '1000 1 1',
      '1001 0 1000',
      '1001 1 2',
    ]);

    const nested = await runSource(
      [
        'offset(int value) => value',
        'sample(int length) =>',
        `${String.fromCharCode(9)}base = close * 1`,
        `${String.fromCharCode(9)}base[length]`,
        'plot(sample(offset(input.int(1000))))',
      ].join(chr10()),
      seriesCsv(values),
    );
    expect(nested.filter(line => !line.startsWith('#')).slice(-2)).toEqual([
      '1000 0 1',
      '1001 0 2',
    ]);

    const inner = await runSource(
      [
        'offset(int value) => value',
        'sample(int length) =>',
        `${String.fromCharCode(9)}base = close * 1`,
        `${String.fromCharCode(9)}base[offset(length)]`,
        'plot(sample(input.int(1000)))',
      ].join(chr10()),
      seriesCsv(values),
    );
    expect(inner.filter(line => !line.startsWith('#')).slice(-2)).toEqual([
      '1000 0 1',
      '1001 0 2',
    ]);

    const block = await runSource(
      [
        'enabled = input.bool(true)',
        'value = if enabled',
        `${String.fromCharCode(9)}alias = input.int(1000) + 0`,
        `${String.fromCharCode(9)}base = close * 1`,
        `${String.fromCharCode(9)}base[alias]`,
        'else',
        `${String.fromCharCode(9)}na`,
        'plot(value)',
      ].join(chr10()),
      seriesCsv(values),
    );
    expect(block.filter(line => !line.startsWith('#')).slice(-2)).toEqual([
      '1000 0 1',
      '1001 0 2',
    ]);
  });

  test('dynamic offsets cannot truncate larger input or const demands', async () => {
    const values = Array.from({length: 1201}, (_, index) => index + 1);
    const lines = await runSource(
      [
        'length = input.int(1000)',
        'base = close * 1',
        'other = close * 1',
        'plot(base[length])',
        'plot(base[bar_index % 2])',
        'plot(other[1200])',
        'plot(other[bar_index % 2])',
      ].join(chr10()),
      seriesCsv(values),
    );
    expect(lines.filter(line => line.startsWith('1200 '))).toEqual([
      '1200 0 201',
      '1200 1 1201',
      '1200 2 1',
      '1200 3 1201',
    ]);
  });

  test('subject switch uses na-aware equality for nullable values', async () => {
    const lines = await runSource(
      [
        'color missing = na',
        'choice = switch missing',
        '    na => 1',
        '    => 2',
        'plot(choice)',
      ].join(chr10()),
      seriesCsv([1]),
    );
    expect(lines.filter(line => !line.startsWith('#'))).toEqual(['0 0 2']);
  });

  test('simple context builtins execute per row, not during bind', async () => {
    const context = csvContext('close\n1\n2');
    const provider: DataProvider = {
      resolveContext: () =>
        Promise.resolve({
          ...context,
          builtinValue: source =>
            source.domain === 'timeframe' && source.field === 'multiplier'
              ? 5
              : undefined,
        }),
    };
    const lines = await runSource(
      'plot(timeframe.multiplier)',
      'close\n1\n2',
      {},
      provider,
    );
    expect(lines.slice(1)).toEqual(['0 0 5', '1 0 5']);
  });

  test('ta.hma rounds the square-root window length', async () => {
    // For a linear ramp, hma(7) is the input when the final window is
    // round(sqrt(7)) = 3. floor(sqrt(7)) = 2 would emit one row earlier and
    // every aligned value would be 28 too high. Multiples of 84 keep the hand
    // calculation exact.
    const lines = await runSource(
      'plot(ta.hma(close, 7))',
      seriesCsv([84, 168, 252, 336, 420, 504, 588, 672, 756, 840]),
    );
    expect(lines.filter(line => !line.startsWith('#'))).toEqual([
      '0 0 na',
      '1 0 na',
      '2 0 na',
      '3 0 na',
      '4 0 na',
      '5 0 na',
      '6 0 na',
      '7 0 na',
      '8 0 756',
      '9 0 840',
    ]);
  });

  test('var accumulation via ta.cum', async () => {
    const lines = await runSource('plot(ta.cum(close))', seriesCsv([1, 2, 3]));
    expect(lines.slice(1)).toEqual(['0 0 1', '1 0 3', '2 0 6']);
  });

  test('user functions with defaults execute', async () => {
    const lines = await runSource(
      [
        'clamp(float value, float lo = 3.0, float hi = 5.0) =>',
        String.fromCharCode(9) + 'math.min(math.max(value, lo), hi)',
        'plot(clamp(close))',
      ].join(chr10()),
      seriesCsv([1, 4, 9]),
    );
    expect(lines.slice(1)).toEqual(['0 0 3', '1 0 4', '2 0 5']);
  });

  test('persistent local initialization observes the current call argument', async () => {
    const lines = await runSource(
      [
        'first(float value) =>',
        `${String.fromCharCode(9)}var float captured = value`,
        `${String.fromCharCode(9)}captured`,
        'plot(first(close))',
      ].join(chr10()),
      seriesCsv([10, 20, 30]),
    );
    expect(lines.slice(1)).toEqual(['0 0 10', '1 0 10', '2 0 10']);
  });

  test('an unreached persistent declaration initializes on first later entry', async () => {
    const lines = await runSource(
      [
        'first_when(float value, bool enabled) =>',
        `${String.fromCharCode(9)}if enabled`,
        `${String.fromCharCode(9)}${String.fromCharCode(9)}var float captured = value`,
        `${String.fromCharCode(9)}${String.fromCharCode(9)}captured`,
        `${String.fromCharCode(9)}else`,
        `${String.fromCharCode(9)}${String.fromCharCode(9)}na`,
        'plot(first_when(close, bar_index > 0))',
      ].join(chr10()),
      seriesCsv([10, 20, 30]),
    );
    expect(lines.slice(1)).toEqual(['0 0 na', '1 0 20', '2 0 20']);
  });

  test('persistent initialization is independent per written call site', async () => {
    const lines = await runSource(
      [
        'first(float value) =>',
        `${String.fromCharCode(9)}var float captured = value`,
        `${String.fromCharCode(9)}captured`,
        'plot(first(close))',
        'plot(first(close * 10))',
      ].join(chr10()),
      seriesCsv([2, 4]),
    );
    expect(lines.filter(line => !line.startsWith('#'))).toEqual([
      '0 0 2',
      '0 1 20',
      '1 0 2',
      '1 1 20',
    ]);
  });

  test('repeated execution of one call site initializes once', async () => {
    const lines = await runSource(
      [
        'first(int value) =>',
        `${String.fromCharCode(9)}var int captured = value`,
        `${String.fromCharCode(9)}captured`,
        'sum = 0',
        'for i = 1 to 3',
        `${String.fromCharCode(9)}sum += first(i)`,
        'plot(sum)',
      ].join(chr10()),
      seriesCsv([1]),
    );
    expect(lines.slice(1)).toEqual(['0 0 3']);
  });

  test('numeric ranges evaluate bounds once and terminate without a trip cap', async () => {
    const lines = await runSource(
      [
        'indicator("range semantics")',
        'type Counter',
        '    int calls',
        '    int mark(int value) =>',
        '        this.calls := this.calls + 1',
        '        value',
        'var Counter counter = Counter.new(0)',
        'positive = for i = counter.mark(1) to counter.mark(5) by counter.mark(1)',
        '    if i == 2',
        '        continue',
        '    if i == 4',
        '        break',
        '    i * 10',
        'defaulted = for i = 1 to 3',
        '    i',
        'negative = for i = 3 to 1 by -1',
        '    i',
        'mutatedCount = 0',
        'for i = 0 to 10',
        '    mutatedCount += 1',
        '    if i == 1',
        '        i := 8',
        'zero = input.int(0)',
        'empty = for i = 1 to 3 by zero',
        '    i',
        'stalled = for i = 100000000000000000000.0 to 100000000000000000000.0 by 1.0',
        '    i',
        'plot(positive)',
        'plot(defaulted)',
        'plot(negative)',
        'plot(mutatedCount)',
        'plot(empty)',
        'plot(stalled)',
        'plot(counter.calls)',
        'plot(close)',
      ].join(chr10()),
      seriesCsv([1]),
    );

    expect(lines.filter(line => !line.startsWith('#'))).toEqual([
      '0 1 30',
      '0 2 3',
      '0 3 1',
      '0 4 4',
      '0 5 na',
      '0 6 100000000000000000000',
      '0 7 3',
      '0 8 1',
    ]);
  });

  test('an active skipped frame advances parameter history by bar', async () => {
    const lines = await runSource(
      [
        'previous(float value) => value[1]',
        'sample = if bar_index != 1',
        `${String.fromCharCode(9)}previous(close)`,
        'else',
        `${String.fromCharCode(9)}na`,
        'plot(sample)',
      ].join(chr10()),
      seriesCsv([10, 20, 30, 40]),
    );
    expect(lines.slice(1)).toEqual(['0 0 na', '1 0 na', '2 0 na', '3 0 30']);
  });
});

describe('determinism', () => {
  test('generation is stable and free of impure sources', async () => {
    const program = mustBuild('plot(ta.ema(close, 9))');
    const a = generate(program);
    const b = generate(program);
    expect(a).toBe(b);
    expect(a.includes('Date.')).toBe(false);
    expect(a.includes('Math.random')).toBe(false);
  });
});

describe('requests end to end', () => {
  // Primary: 6 daily bars (span 1). Child 'X': 3 two-day bars closing at
  // t=2,4,6 — lookahead_off surfaces each child value on the parent bar
  // where the child bar closes.
  const primaryCsv = [
    'time,close',
    '0,1',
    '1,2',
    '2,3',
    '3,4',
    '4,5',
    '5,6',
    '',
  ].join(chr10());
  const childCsv = ['time,close', '0,10', '2,20', '4,30', ''].join(chr10());

  test('request.security merges a child context onto the parent axis', async () => {
    const lines = await runSource(
      ['r = request.security("X", "D", close)', 'plot(r)', 'plot(r[1])'].join(
        chr10(),
      ),
      '',
      {},
      csvContexts({'': primaryCsv, X: childCsv}),
    );
    expect(lines.slice(2)).toEqual([
      '0 0 na',
      '0 1 na',
      '1 0 10',
      '1 1 na',
      '2 0 10',
      '2 1 10',
      '3 0 20',
      '3 1 10',
      '4 0 20',
      '4 1 20',
      '5 0 30',
      '5 1 20',
    ]);
  });

  test('an input param crosses into the capture (compilation-global params)', async () => {
    const lines = await runSource(
      [
        'scale = input.float(10.0)',
        'plot(request.security("X", "D", close * scale))',
      ].join(chr10()),
      '',
      {},
      csvContexts({'': primaryCsv, X: childCsv}),
    );
    expect(lines.slice(1)).toEqual([
      '0 0 na',
      '1 0 100',
      '2 0 100',
      '3 0 200',
      '4 0 200',
      '5 0 300',
    ]);
  });

  test('a scalar input declared inside a request capture is compilation-global', async () => {
    const lines = await runSource(
      'plot(request.security("X", "D", close * input.float(2.0, "Scale")))',
      '',
      {},
      csvContexts({'': primaryCsv, X: childCsv}),
    );
    expect(lines.slice(1)).toEqual([
      '0 0 na',
      '1 0 20',
      '2 0 20',
      '3 0 40',
      '4 0 40',
      '5 0 60',
    ]);
  });

  test('a request inside a UDF binds a computed global input alias statically', async () => {
    const lines = await runSource(
      [
        'indicator("t", dynamic_requests=false)',
        'identity(string value) => value',
        'sym = input.string("X")',
        'alias = identity(sym) + ""',
        'fetch() => request.security(alias, "D", close)',
        'plot(fetch())',
      ].join(chr10()),
      '',
      {},
      csvContexts({'': primaryCsv, X: childCsv}),
    );
    expect(lines.filter(line => !line.startsWith('#'))).toEqual([
      '0 1 na',
      '1 1 10',
      '2 1 10',
      '3 1 20',
      '4 1 20',
      '5 1 30',
    ]);
  });

  test('a corrupt or shuffled time axis is a BindError, never silent na', async () => {
    const src = 'plot(request.security("X", "D", close))';
    // Blank time cell in the parent axis.
    expect(() =>
      runSource(
        src,
        '',
        {},
        csvContexts({
          '': ['time,close', '0,1', ',2', '2,3', ''].join(chr10()),
          X: childCsv,
        }),
      ),
    ).toThrow('invalid time axis');
    // A shuffled child axis trips the close-before-open check (next-open
    // closeTime convention), a duplicated timestamp the monotonicity check.
    expect(() =>
      runSource(
        src,
        '',
        {},
        csvContexts({
          '': primaryCsv,
          X: ['time,close', '2,30', '0,10', '3,40', ''].join(chr10()),
        }),
      ),
    ).toThrow('invalid time axis');
    expect(() =>
      runSource(
        src,
        '',
        {},
        csvContexts({
          '': primaryCsv,
          X: ['time,close', '0,10', '0,20', '2,30', ''].join(chr10()),
        }),
      ),
    ).toThrow('not strictly increasing');
  });

  test('the captured expression computes with state inside the child context', async () => {
    const lines = await runSource(
      'plot(request.security("X", "D", ta.change(close)))',
      '',
      {},
      csvContexts({'': primaryCsv, X: childCsv}),
    );
    // Child ta.change: na, 10, 10 — merged on child-bar closes.
    expect(lines.slice(1)).toEqual([
      '0 0 na',
      '1 0 na',
      '2 0 na',
      '3 0 10',
      '4 0 10',
      '5 0 10',
    ]);
  });
});

describe('the input family end to end', () => {
  test('extended inputs bind, and the manifest carries UI metadata', async () => {
    const src = [
      'indicator("inputs", max_labels_count=200, calc_bars_count=5000)',
      'len = input.int(5, "Length", minval=1, step=2, display=display.none)',
      'session = input.session("0930-1600", "Session", group="Times", inline="a", tooltip="rth", confirm=true, display=display.data_window)',
      'lvl = input.price(500.0, "Level", "price tip")',
      't0 = input.time(1704067200000, "Start", "time tip")',
      'note = input.text_area("hello", "Note", "note tip")',
      'shade = input.color(color.new(color.blue, 90), "Shade")',
      'plot(lvl)',
    ].join(chr10());
    const js = generate(mustBuild(src));
    const module = loadModule(js);
    const byName = new Map(module.manifest.params.map(p => [p.name, p]));
    const session = byName.get('session');
    expect(session?.control).toBe('session');
    expect(session?.type).toBe('string');
    expect(session?.group).toBe('Times');
    expect(session?.inline).toBe('a');
    expect(session?.tooltip).toBe('rth');
    expect(session?.confirm).toBe(true);
    expect(session?.display).toBe('data_window');
    const lenConstraints = byName.get('len')?.constraints;
    expect(lenConstraints?.kind).toBe('range');
    expect(lenConstraints?.kind === 'range' ? lenConstraints.step : null).toBe(
      2,
    );
    expect(byName.get('len')?.display).toBe('none');
    expect(byName.get('lvl')?.control).toBe('price');
    expect(byName.get('lvl')?.type).toBe('float');
    expect(byName.get('lvl')?.tooltip).toBe('price tip');
    expect(byName.get('lvl')?.display).toBe('all');
    expect(byName.get('t0')?.control).toBe('time');
    expect(byName.get('t0')?.type).toBe('int');
    expect(byName.get('t0')?.tooltip).toBe('time tip');
    expect(byName.get('t0')?.display).toBe('none');
    expect(byName.get('note')?.control).toBe('text_area');
    expect(byName.get('note')?.tooltip).toBe('note tip');
    expect(byName.get('note')?.display).toBe('none');
    // The folded color.new default lands as a plain const hex+alpha.
    expect(byName.get('shade')?.defaultValue).toBe('#2196F31A');
    const indicator = module.manifest.outputs[0];
    expect(indicator.staticArgs).toContainEqual({
      name: 'max_labels_count',
      value: 200,
    });
    expect(indicator.staticArgs).toContainEqual({
      name: 'calc_bars_count',
      value: 5000,
    });

    // And the whole thing executes with defaults: an input-qualified plot
    // arg is a BIND arg — delivered once at declare, not emitted per row.
    const lines: string[] = [];
    const sink = new TraceSink(line => lines.push(line));
    const bound = await bind(module, {
      params: {},
      provider: csvProvider(seriesCsv([1, 2])),
      sink,
      timeNow: 1_800_000_000_000,
    });
    await bound.runAll();
    expect(lines.some(line => line.includes('bound{series=500}'))).toBe(true);
  });

  test('color.rgb folds at compile time and executes at runtime', async () => {
    const lines = await runSource(
      [
        'c = input.color(color.rgb(33, 150, 243, 20), "C")',
        'plot(close, color=color.rgb(255, 109, 0))',
      ].join(chr10()),
      seriesCsv([1]),
    );
    expect(lines.length).toBeGreaterThan(0);
  });

  test('na propagates through color arithmetic, fold and runtime alike', async () => {
    const lines = await runSource(
      [
        // Series path: the helper sees a null color on na bars.
        'c = close > 2 ? color.blue : na',
        'plot(close, color=color.new(c, 50))',
        // Fold path: a const na folds to na, not a crash.
        'k = color.new(na, 90)',
        'plot(close, color=k)',
        // Component na through color.rgb.
        'r = close > 2 ? 255 : na',
        'plot(close, color=color.rgb(r, 0, 0))',
      ].join(chr10()),
      seriesCsv([1, 3]),
    );
    // Row 0 (close=1): the series color channels are na; the const-na
    // color folded all the way into the declare line. Row 1 (close=3)
    // carries real colors ((100-50)*2.55 rounds to 0x7F in IEEE).
    expect(lines.some(l => l.includes('color=na'))).toBe(true);
    expect(lines).toContain('0 0 1 na');
    expect(lines).toContain('0 2 1 na');
    expect(lines).toContain('1 0 3 #2196F37F');
    expect(lines).toContain('1 2 3 #FF0000');
  });

  test('computed const NaN becomes canonical na before color folding', async () => {
    const src = [
      'plot(close, color=color.new(color.blue, math.sqrt(-1)))',
      'plot(close, color=color.rgb(math.sqrt(-1), 0, 0))',
      'plot(close, color=color.new(color.blue, math.exp(1000) - math.exp(1000)))',
    ].join(chr10());
    const program = mustBuild(src);
    const module = loadModule(generate(program));
    expect(module.manifest.outputs[0].staticArgs).toContainEqual({
      name: 'color',
      value: null,
    });
    expect(module.manifest.outputs[1].staticArgs).toContainEqual({
      name: 'color',
      value: null,
    });
    expect(module.manifest.outputs[2].staticArgs).toContainEqual({
      name: 'color',
      value: null,
    });
    expect(JSON.stringify(module.manifest)).not.toContain('NAN');

    const lines = await runSource(src, seriesCsv([1]));
    expect(lines.filter(line => line.includes('color=na')).length).toBe(3);
    expect(lines.join('\n')).not.toContain('NAN');
  });

  test('one color, one string: opaque forms are canonical and equal', async () => {
    // Both comparisons fold to const true, so `x ? 1 : 0` folds to the
    // static arg series=1 on the declare lines.
    const lines = await runSource(
      [
        'same = color.rgb(255, 0, 0) == color.rgb(255, 0, 0, 0)',
        'stripped = color.new(color.rgb(255, 0, 0, 40), 0) == color.rgb(255, 0, 0)',
        'plot(same ? 1 : 0)',
        'plot(stripped ? 1 : 0)',
      ].join(chr10()),
      seriesCsv([1]),
    );
    expect(lines.filter(l => l.includes('series=1')).length).toBe(2);
  });

  test('const out-of-range color arguments fail loudly', () => {
    const {program, errors} = buildText(
      'plot(close, color=color.new(color.blue, 150))',
    );
    expect(program).toBeNull();
    expect(errors.some(e => e.msg.includes('between 0 and 100'))).toBe(true);
    const rgb = buildText('plot(close, color=color.rgb(300, 0, 0))');
    expect(rgb.program).toBeNull();
    expect(rgb.errors.some(e => e.msg.includes('between 0 and 255'))).toBe(
      true,
    );
  });

  test("input.price's third positional argument is tooltip, not options", async () => {
    const js = generate(
      mustBuild(
        'lvl = input.price(1.5, "Level", "click the chart")\nplot(lvl)',
      ),
    );
    const module = loadModule(js);
    expect(module.manifest.params[0].tooltip).toBe('click the chart');
  });

  test('input.source rejects a non-source default', () => {
    const {program, errors} = buildText('x = input.source(42)\nplot(x)');
    expect(program).toBeNull();
    expect(errors.some(e => e.msg.includes('built-in source'))).toBe(true);
  });

  test('input.enum keeps nominal metadata and active recomputes per bind', async () => {
    const source = [
      'enum Mode',
      `${String.fromCharCode(9)}fast = "Fast"`,
      `${String.fromCharCode(9)}slow = "Slow"`,
      'passthrough(value) => value',
      'enabled = input.bool(true, "Enabled")',
      'enabledAlias = enabled and true',
      'mode = input.enum(Mode.fast, "Mode", options=[Mode.fast, Mode.slow], active=enabledAlias and passthrough(enabled))',
      'width = enabled ? 2 : 1',
      'plot(str.tostring(mode) == "Slow" ? 1 : 0, linewidth=width)',
    ].join(chr10());
    const module = loadModule(generate(mustBuild(source)));
    const bindWith = (params: Record<string, unknown>) =>
      bind(module, {
        params,
        provider: csvProvider(seriesCsv([1])),
        sink: new TraceSink(() => {}),
        timeNow: 1_800_000_000_000,
      });

    const disabled = await bindWith({enabled: false, mode: 'slow'});
    const disabledMode = disabled.inputs.find(
      input => input.spec.name === 'mode',
    );
    expect(disabledMode?.value).toBe('slow');
    expect(disabledMode?.active).toBe(false);
    expect(disabledMode?.spec.enumType).toEqual({
      name: 'Mode',
      members: [
        {name: 'fast', title: 'Fast'},
        {name: 'slow', title: 'Slow'},
      ],
    });
    const lines: string[] = [];
    const titled = await bind(module, {
      params: {enabled: false, mode: 'slow'},
      provider: csvProvider(seriesCsv([1])),
      sink: new TraceSink(line => lines.push(line)),
      timeNow: 1_800_000_000_000,
    });
    await titled.runAll();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('bound{series=1 linewidth=1}');

    const enabled = await bindWith({enabled: true});
    expect(
      enabled.inputs.find(input => input.spec.name === 'mode')?.active,
    ).toBe(true);
    await expect(bindWith({enabled: false, mode: 'missing'})).rejects.toThrow(
      BindError,
    );
  });

  test('local and UDF inputs extract once with collision-free identities', async () => {
    const source = [
      'choose(bool positive) =>',
      '    if positive',
      '        value = input.int(2, "Positive")',
      '        value',
      '    else',
      '        value = input.int(3, "Nonpositive")',
      '        value',
      'gate = input.bool(true, "Gate")',
      'branch = if gate',
      '    value = input.int(4)',
      '    value',
      'else',
      '    0',
      'plot(choose(close > 0) + branch)',
    ].join(chr10());
    const module = loadModule(generate(mustBuild(source)));
    const names = module.manifest.params.map(param => param.name);
    expect(new Set(names).size).toBe(4);
    expect(names.filter(name => name.startsWith('input@'))).toHaveLength(3);
    expect(
      module.manifest.params.find(param => param.name === 'gate'),
    ).toBeDefined();
    expect(
      module.manifest.params.find(param => param.title === 'value')?.name,
    ).toStartWith('input@');

    const byTitle = new Map(
      module.manifest.params.map(param => [param.title, param.name]),
    );
    const params = {
      [byTitle.get('Positive')!]: 20,
      [byTitle.get('Nonpositive')!]: 30,
      [byTitle.get('value')!]: 40,
    };
    const lines: string[] = [];
    const bound = await bind(module, {
      params,
      provider: csvProvider(seriesCsv([-1, 1])),
      sink: new TraceSink(line => lines.push(line)),
      timeNow: 1_800_000_000_000,
    });
    await bound.runAll();
    expect(lines.slice(1)).toEqual(['0 0 70', '1 0 60']);
  });
});

describe('dynamic requests end to end', () => {
  const primaryCsv = [
    'time,close',
    '0,1',
    '1,2',
    '2,3',
    '3,4',
    '4,5',
    '5,6',
    '',
  ].join(chr10());
  const contextX = ['time,close', '0,10', '2,20', '4,30', ''].join(chr10());
  const contextY = ['time,close', '0,100', '2,200', '4,300', ''].join(chr10());

  test('a series symbol switches pairs per row; history is parent-row-indexed', async () => {
    const lines = await runSource(
      [
        'r = request.security(close > 3 ? "X" : "Y", "D", close)',
        'plot(r)',
        'plot(r[1])',
      ].join(chr10()),
      '',
      {},
      csvContexts({'': primaryCsv, X: contextX, Y: contextY}),
    );
    // Rows 0-2 ask Y (close 1,2,3), rows 3-5 ask X (close 4,5,6). The
    // history channel reads the result ring: the previous ROW's value,
    // whichever pair served it — including across the switch.
    expect(lines.slice(2)).toEqual([
      '0 0 na',
      '0 1 na',
      '1 0 100',
      '1 1 na',
      '2 0 100',
      '2 1 100',
      '3 0 20',
      '3 1 100',
      '4 0 20',
      '4 1 20',
      '5 0 30',
      '5 1 20',
    ]);
  });

  test('suspended executions vanish: var and varip each count every row once', async () => {
    const lines = await runSource(
      [
        'var n = 0',
        'varip m = 0',
        'n := n + 1',
        'm := m + 1',
        'r = request.security(close > 3 ? "X" : "Y", "D", close)',
        'plot(n + m)',
        'plot(r)',
      ].join(chr10()),
      '',
      {},
      csvContexts({'': primaryCsv, X: contextX, Y: contextY}),
    );
    // Two discovery suspensions happen (row 0 pair Y, row 3 pair X); if the
    // aborted executions leaked, n+m would jump at those rows.
    const counters = lines.slice(2).filter(l => l.includes(' 0 '));
    expect(counters).toEqual([
      '0 0 2',
      '1 0 4',
      '2 0 6',
      '3 0 8',
      '4 0 10',
      '5 0 12',
    ]);
  });

  test('history-only reads still execute the request (materialized name)', async () => {
    // No offset-0 plot at all: the write at the declaration is the
    // execution, so history is well-defined instead of silently na.
    const lines = await runSource(
      [
        'r = request.security(close > 3 ? "X" : "Y", "D", close)',
        'plot(r[1])',
      ].join(chr10()),
      '',
      {},
      csvContexts({'': primaryCsv, X: contextX, Y: contextY}),
    );
    expect(lines.slice(1)).toEqual([
      '0 0 na',
      '1 0 na',
      '2 0 100',
      '3 0 100',
      '4 0 20',
      '5 0 20',
    ]);
  });

  test('direct history and explicit [0] on a dynamic request', async () => {
    const lines = await runSource(
      [
        'plot(request.security(close > 3 ? "X" : "Y", "D", close)[1])',
        'plot(request.security(close > 3 ? "X" : "Y", "D", close)[0])',
      ].join(chr10()),
      '',
      {},
      csvContexts({'': primaryCsv, X: contextX, Y: contextY}),
    );
    expect(lines.slice(2)).toEqual([
      '0 0 na',
      '0 1 na',
      '1 0 na',
      '1 1 100',
      '2 0 100',
      '2 1 100',
      '3 0 100',
      '3 1 20',
      '4 0 20',
      '4 1 20',
      '5 0 20',
      '5 1 30',
    ]);
  });

  test('a request inside a function gets one edge per instance', async () => {
    const lines = await runSource(
      [
        'f(string s) =>',
        String.fromCharCode(9) + 'request.security(s, "D", close)',
        'a = f(close > 3 ? "X" : "Y")',
        'b = f("Y")',
        'plot(a)',
        'plot(b)',
      ].join(chr10()),
      '',
      {},
      csvContexts({'': primaryCsv, X: contextX, Y: contextY}),
    );
    expect(lines.slice(2)).toEqual([
      '0 0 na',
      '0 1 na',
      '1 0 100',
      '1 1 100',
      '2 0 100',
      '2 1 100',
      '3 0 20',
      '3 1 200',
      '4 0 20',
      '4 1 200',
      '5 0 30',
      '5 1 300',
    ]);
  });

  test('an unknown dynamic pair under ignore_invalid_symbol is na and warned', async () => {
    const {sink: logSink, events} = captureSink();
    const original = logConfig();
    configureLog({level: 'warn', sink: logSink});
    try {
      const lines = await runSource(
        [
          'sym = close > 3 ? "MISSING" : "Y"',
          'plot(request.security(sym, "D", close, ignore_invalid_symbol=true))',
        ].join(chr10()),
        '',
        {},
        csvContexts({'': primaryCsv, Y: contextY}),
      );
      expect(lines.slice(1)).toEqual([
        '0 0 na',
        '1 0 100',
        '2 0 100',
        '3 0 na',
        '4 0 na',
        '5 0 na',
      ]);
      const warned = events.filter(event => event.level === 'warn');
      expect(warned.length).toBe(1);
      expect(warned[0].fields['symbol']).toBe('MISSING');
    } finally {
      configureLog(original);
    }
  });

  test('an unknown dynamic pair without the flag is a RequestError', async () => {
    expect(() =>
      runSource(
        'plot(request.security(close > 3 ? "MISSING" : "Y", "D", close))',
        '',
        {},
        csvContexts({'': primaryCsv, Y: contextY}),
      ),
    ).toThrow(RequestError);
  });

  test('dynamic_requests=false rejects series context args', () => {
    const {program, errors} = buildText(
      [
        'indicator("t", dynamic_requests=false)',
        'plot(request.security(close > 3 ? "X" : "Y", "D", close))',
      ].join(chr10()),
    );
    expect(program).toBeNull();
    expect(errors.some(e => e.msg.includes('dynamic_requests=true'))).toBe(
      true,
    );
  });
});

describe('golden traces', () => {
  const cases = [
    {script: 'macd.tea', golden: 'run/macd.golden'},
    {script: 'run/coverage.tea', golden: 'run/coverage.golden'},
  ];
  for (const {script, golden} of cases) {
    test(script, async () => {
      const src = readFileSync(join(TESTDATA, script), 'utf8');
      const csv = readFileSync(join(TESTDATA, 'run/data.csv'), 'utf8');
      const lines = await runSource(src, csv);
      const dump = `${lines.join(chr10())}${chr10()}`;
      const goldenPath = join(TESTDATA, golden);
      if (UPDATE) {
        writeFileSync(goldenPath, dump);
        return;
      }
      if (!existsSync(goldenPath)) {
        throw new Error(`missing golden ${goldenPath}; run UPDATE_GOLDENS=1`);
      }
      expect(dump).toBe(readFileSync(goldenPath, 'utf8'));
    });
  }
});
