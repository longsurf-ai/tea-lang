// Purpose: Execution tests — hand-checked numeric vectors as ground truth, plus golden traces over the deterministic csv fixture; regenerate with UPDATE_GOLDENS=1 bun test.

import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, test} from 'bun:test';
import {DEFAULT_COMPILE_CONFIG} from '../base/config';
import {Errors} from '../base/print';
import {generate} from '../codegen/codegen';
import {captureSink, configureLog, logConfig} from '../base/log';
import {buildText, mustBuild} from '../noder/testing';
import {csvContext, csvProvider} from '../providers/data/csv';
import {TraceSink} from '../providers/sinks/trace-sink';
import {RequestError, type DataProvider, type Value} from './abi';
import {bind} from './js-runtime';
import {loadModule} from './load';

const TESTDATA = join(import.meta.dir, '../../testdata');
const UPDATE = process.env['UPDATE_GOLDENS'] === '1';

async function runSource(
  src: string,
  csv: string,
  params: Record<string, Value> = {},
  provider: DataProvider | null = null,
): Promise<string[]> {
  const program = mustBuild(src);
  const js = generate(program, DEFAULT_COMPILE_CONFIG, new Errors());
  const module = loadModule(js);
  const lines: string[] = [];
  const sink = new TraceSink(line => lines.push(line));
  const bound = await bind(module, {
    params,
    provider: provider ?? csvProvider(csv),
    sink,
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

  test('ta.hma rounds the square-root window length', async () => {
    // For a linear ramp, hma(7) is the input when the final window is
    // round(sqrt(7)) = 3. floor(sqrt(7)) = 2 would emit one row earlier and
    // every aligned value would be 28 too high. Multiples of 84 keep the hand
    // calculation exact.
    const lines = await runSource(
      'plot(ta.hma(close, 7))',
      seriesCsv([84, 168, 252, 336, 420, 504, 588, 672, 756, 840]),
    );
    expect(lines.slice(1)).toEqual([
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
});

describe('determinism', () => {
  test('generation is stable and free of impure sources', async () => {
    const program = mustBuild('plot(ta.ema(close, 9))');
    const a = generate(program, DEFAULT_COMPILE_CONFIG, new Errors());
    const b = generate(program, DEFAULT_COMPILE_CONFIG, new Errors());
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
    const js = generate(mustBuild(src), DEFAULT_COMPILE_CONFIG, new Errors());
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
    expect(byName.get('len')?.constraints?.step).toBe(2);
    expect(byName.get('len')?.display).toBe('none');
    expect(byName.get('lvl')?.control).toBe('price');
    expect(byName.get('lvl')?.type).toBe('float');
    expect(byName.get('lvl')?.tooltip).toBe('price tip');
    expect(byName.get('t0')?.control).toBe('time');
    expect(byName.get('t0')?.type).toBe('int');
    expect(byName.get('t0')?.tooltip).toBe('time tip');
    expect(byName.get('note')?.control).toBe('text_area');
    expect(byName.get('note')?.tooltip).toBe('note tip');
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
    const module = loadModule(
      generate(program, DEFAULT_COMPILE_CONFIG, new Errors()),
    );
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
      DEFAULT_COMPILE_CONFIG,
      new Errors(),
    );
    const module = loadModule(js);
    expect(module.manifest.params[0].tooltip).toBe('click the chart');
  });

  test('input.source rejects a non-source default', () => {
    const {program, errors} = buildText('x = input.source(42)\nplot(x)');
    expect(program).toBeNull();
    expect(errors.some(e => e.msg.includes('built-in source'))).toBe(true);
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
