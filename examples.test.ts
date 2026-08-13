// Purpose: Keep the checked-in canonical strategy example executable through
// the public CPU path and eligible for the same Program's WGSL lowering.

import {describe, expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {Errors} from './src/base/print';
import {compileProgramToWgsl} from './src/codegen/wgsl';
import {compileToProgram} from './src/compile';
import {executeProgram} from './src/execute';
import {csvProvider} from './src/providers/data/csv';
import {MemorySink} from './src/providers/sinks/memory-sink';

const SOURCE = join(import.meta.dir, 'examples/ema-cross-strategy.tea');
const DATA = join(import.meta.dir, 'examples/ema-cross-bars.csv');

function compileExample() {
  const errors = new Errors();
  const program = compileToProgram([SOURCE], errors);
  if (program === null) {
    throw new Error(
      errors
        .flushErrors()
        .map(error => error.msg)
        .join('; '),
    );
  }
  expect(errors.count).toBe(0);
  return program;
}

describe('canonical EMA crossover example', () => {
  test('runs with default parameters on CPU', async () => {
    const sink = new MemorySink();
    const result = await executeProgram(
      compileExample(),
      [
        {
          params: {},
          provider: csvProvider(readFileSync(DATA, 'utf8')),
          sink,
          timeNow: 1_800_000_000_000,
        },
      ],
      {kind: 'cpu'},
    );

    expect(result.bindings[0]?.rows).toBe(43);
    expect(sink.publications).toHaveLength(43);
    expect(sink.effectEmissions).toHaveLength(8);

    const roundTrips = sink.outputs.findIndex(output =>
      output.spec.staticArgs.some(
        arg => arg.name === 'title' && arg.value === 'round trips',
      ),
    );
    expect(roundTrips).toBeGreaterThanOrEqual(0);
    expect(
      sink.emissions.find(
        emission => emission.row === 42 && emission.outputId === roundTrips,
      )?.channels,
    ).toEqual([2]);
  });

  test('is eligible for direct WGSL lowering', () => {
    const result = compileProgramToWgsl(compileExample());
    expect(result.status).toBe('compiled');
    if (result.status === 'compiled') {
      expect(result.artifact.module.source).not.toContain('ta.ema');
      expect(result.artifact.module.source).not.toContain('ta.crossover');
      expect(result.artifact.module.source).not.toContain('ta.crossunder');
    }
  });
});
