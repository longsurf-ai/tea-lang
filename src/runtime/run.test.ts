// Purpose: Execution tests — hand-checked numeric vectors as ground truth, plus golden traces over the deterministic csv fixture; regenerate with UPDATE_GOLDENS=1 bun test.

import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, test} from 'bun:test';
import {DEFAULT_COMPILE_CONFIG} from '../base/config';
import {Errors} from '../base/print';
import {generate} from '../codegen/codegen';
import {mustBuild} from '../noder/testing';
import {csvProvider} from '../providers/data/csv';
import {TraceSink} from '../providers/sinks/trace-sink';
import type {Value} from './abi';
import {bind} from './kernel';
import {loadModule} from './load';

const TESTDATA = join(import.meta.dir, '../../testdata');
const UPDATE = process.env['UPDATE_GOLDENS'] === '1';

function runSource(
  src: string,
  csv: string,
  params: Record<string, Value> = {},
): string[] {
  const program = mustBuild(src);
  const js = generate(program, DEFAULT_COMPILE_CONFIG, new Errors());
  const module = loadModule(js);
  const lines: string[] = [];
  const sink = new TraceSink(line => lines.push(line));
  const bound = bind(module, {params, provider: csvProvider(csv), sink});
  bound.runAll();
  return lines;
}

function seriesCsv(values: readonly number[]): string {
  return `close${chr10()}${values.join(chr10())}${chr10()}`;
}

function chr10(): string {
  return String.fromCharCode(10);
}

describe('hand-checked vectors', () => {
  test('ta.sma matches hand-computed values', () => {
    const lines = runSource('plot(ta.sma(close, 2))', seriesCsv([2, 4, 6, 8]));
    expect(lines.slice(1)).toEqual(['0 0 na', '1 0 3', '2 0 5', '3 0 7']);
  });

  test('ta.ema matches hand-computed values', () => {
    // alpha = 2 / (3 + 1) = 0.5
    const lines = runSource('plot(ta.ema(close, 3))', seriesCsv([2, 4, 6]));
    expect(lines.slice(1)).toEqual(['0 0 2', '1 0 3', '2 0 4.5']);
  });

  test('ta.change and history offsets', () => {
    const lines = runSource('plot(ta.change(close))', seriesCsv([5, 8, 6]));
    expect(lines.slice(1)).toEqual(['0 0 na', '1 0 3', '2 0 -2']);
  });

  test('var accumulation via ta.cum', () => {
    const lines = runSource('plot(ta.cum(close))', seriesCsv([1, 2, 3]));
    expect(lines.slice(1)).toEqual(['0 0 1', '1 0 3', '2 0 6']);
  });

  test('user functions with defaults execute', () => {
    const lines = runSource(
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
  test('generation is stable and free of impure sources', () => {
    const program = mustBuild('plot(ta.ema(close, 9))');
    const a = generate(program, DEFAULT_COMPILE_CONFIG, new Errors());
    const b = generate(program, DEFAULT_COMPILE_CONFIG, new Errors());
    expect(a).toBe(b);
    expect(a.includes('Date.')).toBe(false);
    expect(a.includes('Math.random')).toBe(false);
  });
});

describe('golden traces', () => {
  const cases = [
    {script: 'macd.tea', golden: 'run/macd.golden'},
    {script: 'run/coverage.tea', golden: 'run/coverage.golden'},
  ];
  for (const {script, golden} of cases) {
    test(script, () => {
      const src = readFileSync(join(TESTDATA, script), 'utf8');
      const csv = readFileSync(join(TESTDATA, 'run/data.csv'), 'utf8');
      const lines = runSource(src, csv);
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
