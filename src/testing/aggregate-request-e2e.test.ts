// Purpose: Request-boundary coverage for isolated child Heaps, scalar transport, argument order, and suspension rollback.

import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, test} from 'vitest';
import {formatPos} from '../base/pos';
import {compile} from '../compile';
import {csvContext} from '../providers/data/csv';
import {type DataProvider, type OutputSink, type Value} from '../runtime/abi';
import {bind} from '../runtime/js-runtime';
import {loadModule} from '../runtime/load';

const SOURCE = join(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../tests/fixtures/requests/aggregate-result.tea',
);

const CONTEXT_ORDER_SOURCE = join(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../tests/fixtures/requests/context-evaluation-order.tea',
);

const MUTABLE_METHOD_SUSPENSION_SOURCE = join(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../tests/fixtures/requests/mutable-method-suspension.tea',
);

const PRIMARY = [
  'time,close',
  '0,1',
  '1,2',
  '2,3',
  '3,4',
  '4,5',
  '5,6',
  '',
].join('\n');

const CHILD = ['time,close', '0,10', '2,20', '4,30', ''].join('\n');

interface Emission {
  readonly row: number;
  readonly oid: number;
  readonly channels: readonly Value[];
  readonly provisional: boolean;
}

class Sink implements OutputSink {
  readonly emissions: Emission[] = [];

  declare(): void {}

  publish(publication: Parameters<OutputSink['publish']>[0]): void {
    for (const output of publication.outputs) {
      this.emissions.push({
        row: publication.row,
        oid: output.outputId,
        channels: [...output.channels],
        provisional: publication.provisional,
      });
    }
  }
}

describe('requests end to end', () => {
  test('a Heap-backed child result is rejected before lowering', () => {
    const result = compile([SOURCE]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('aggregate request unexpectedly compiled');
    expect(result.errors.map(error => error.msg)).toContain(
      'request expression cannot return ChildSnapshot; request results must be scalars or scalar-only tuples',
    );
  });

  test('named dynamic context arguments execute in source order', async () => {
    const result = compile([CONTEXT_ORDER_SOURCE]);
    if (!result.ok) {
      throw new Error(
        result.errors
          .map(error => `${formatPos(error.pos)}: ${error.msg}`)
          .join('\n'),
      );
    }

    const resolvedPairs: [string, string][] = [];
    const provider: DataProvider = {
      async resolveContext(symbol, timeframe) {
        resolvedPairs.push([symbol, timeframe]);
        if (symbol === '' && timeframe === '') {
          return csvContext(PRIMARY);
        }
        if (symbol === 'X' && timeframe === 'D') {
          return csvContext(CHILD);
        }
        return {
          error: 'unknownSymbol' as const,
          detail: `unexpected context '${symbol}' at '${timeframe}'`,
        };
      },
    };
    const sink = new Sink();
    const bound = await bind(loadModule(result.js), {
      params: {},
      provider,
      sink,
      timeNow: 0,
    });
    await bound.runAll();

    expect(resolvedPairs).toEqual([
      ['', ''],
      ['X', 'D'],
    ]);
    expect(
      sink.emissions
        .filter(emission => emission.oid === 2)
        .map(emission => emission.channels[0]),
    ).toEqual([2, 2, 2, 2, 2, 2]);
    bound.dispose();
  });

  test('a suspended mutable method rolls back in-place receiver mutation before retry', async () => {
    const result = compile([MUTABLE_METHOD_SUSPENSION_SOURCE]);
    if (!result.ok) {
      throw new Error(
        result.errors
          .map(error => `${formatPos(error.pos)}: ${error.msg}`)
          .join('\n'),
      );
    }

    const module = loadModule(result.js);
    expect(module.manifest.requests).toHaveLength(1);
    expect(module.manifest.requests[0]?.dynamic).toBe(true);

    const resolvedPairs: [string, string][] = [];
    const provider: DataProvider = {
      async resolveContext(symbol, timeframe) {
        resolvedPairs.push([symbol, timeframe]);
        if (symbol === '' && timeframe === '') {
          return csvContext(PRIMARY);
        }
        if ((symbol === 'X' || symbol === 'Y') && timeframe === 'D') {
          return csvContext(CHILD);
        }
        return {
          error: 'unknownSymbol' as const,
          detail: `unexpected context '${symbol}' at '${timeframe}'`,
        };
      },
    };
    const sink = new Sink();
    const bound = await bind(module, {
      params: {},
      provider,
      sink,
      timeNow: 0,
    });
    await bound.runAll();

    expect(resolvedPairs).toEqual([
      ['', ''],
      ['Y', 'D'],
      ['X', 'D'],
    ]);
    // Y and X each suspend on first discovery. The parent receiver body keeps
    // completed mutations, but neither aborted attempt may reach the caller.
    const valuesFor = (oid: number): readonly Value[] =>
      sink.emissions
        .filter(emission => emission.oid === oid)
        .map(emission => emission.channels[0]);
    expect(valuesFor(1)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(valuesFor(2)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(sink.emissions.every(emission => !emission.provisional)).toBe(true);
    bound.dispose();
  });
});
