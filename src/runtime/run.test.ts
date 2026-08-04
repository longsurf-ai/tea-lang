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
