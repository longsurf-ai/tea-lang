// Purpose: Execution tests — hand-checked numeric vectors as ground truth, plus golden traces over the deterministic csv fixture; regenerate with UPDATE_GOLDENS=1 bun test.

import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, test} from 'bun:test';
import {DEFAULT_COMPILE_CONFIG} from '../base/config';
import {Errors} from '../base/print';
import {generate} from '../codegen/codegen';
import {mustBuild} from '../noder/testing';
import {csvContext, csvProvider} from '../providers/data/csv';
import {TraceSink} from '../providers/sinks/trace-sink';
import type {DataProvider, Value} from './abi';
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
  bound.runAll();
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
