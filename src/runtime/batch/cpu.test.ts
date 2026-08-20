// Purpose: CPU batch is only ordered repetition of the ordinary bind/run lifecycle.

import {describe, expect, test} from 'vitest';
import {generate} from '../../codegen/codegen';
import {mustBuild} from '../../noder/testing';
import {csvProvider} from '../../providers/data/csv';
import {MemorySink} from '../../providers/sinks/memory-sink';
import {loadModule} from '../load';
import {runCpuBatch} from './cpu';

function module() {
  return loadModule(
    generate(
      mustBuild(
        [
          'indicator("batch")',
          'scale = input.float(1.0)',
          'var float total = 0.0',
          'total := total + close * scale',
          'plot(total)',
        ].join('\n'),
      ),
    ),
  );
}

describe('runCpuBatch', () => {
  test('runs ordinary bindings in caller order with isolated state and sinks', async () => {
    const first = new MemorySink();
    const second = new MemorySink();
    const results = await runCpuBatch(module(), [
      {
        params: {scale: 1},
        provider: csvProvider('close\n1\n2\n'),
        sink: first,
        timeNow: 1_800_000_000_000,
      },
      {
        params: {scale: 10},
        provider: csvProvider('close\n3\n4\n'),
        sink: second,
        timeNow: 1_800_000_000_000,
      },
    ]);

    expect(results.map(result => result.rows)).toEqual([2, 2]);
    expect(first.emissions.map(emission => emission.channels[0])).toEqual([
      1, 3,
    ]);
    expect(second.emissions.map(emission => emission.channels[0])).toEqual([
      30, 70,
    ]);
  });

  test('accepts an empty binding list', async () => {
    expect(await runCpuBatch(module(), [])).toEqual([]);
  });
});
