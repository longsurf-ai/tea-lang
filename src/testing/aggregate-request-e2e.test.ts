// Purpose: Compile-to-runtime coverage for aggregate request results sharing Heap storage across child completion, parent merge, and history.

import {join} from 'node:path';
import {describe, expect, test} from 'bun:test';
import {formatPos} from '../base/pos';
import {compile} from '../compile';
import {csvContext} from '../providers/data/csv';
import {
  RUNTIME_ABI_VERSION,
  type DataProvider,
  type OutputSink,
  type ProviderContext,
  type Value,
} from '../runtime/abi';
import {bind} from '../runtime/js-runtime';
import {loadModule} from '../runtime/load';

const SOURCE = join(
  import.meta.dir,
  '../../tests/fixtures/requests/aggregate-result.tea',
);

const CONTEXT_ORDER_SOURCE = join(
  import.meta.dir,
  '../../tests/fixtures/requests/context-evaluation-order.tea',
);

const MUTABLE_METHOD_SUSPENSION_SOURCE = join(
  import.meta.dir,
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

function contexts(
  values: Readonly<Record<string, ProviderContext>>,
): DataProvider {
  return {
    resolveContext: symbol =>
      Promise.resolve(
        values[symbol] ?? {
          error: 'unknownSymbol' as const,
          detail: `no context '${symbol}'`,
        },
      ),
  };
}

describe('aggregate requests end to end', () => {
  test('a keep-zero child result remains live in parent current and history views', async () => {
    const result = compile([SOURCE]);
    if (!result.ok) {
      throw new Error(
        result.errors
          .map(error => `${formatPos(error.pos)}: ${error.msg}`)
          .join('\n'),
      );
    }

    const module = loadModule(result.js);
    expect(module.abi).toBe(RUNTIME_ABI_VERSION);
    const request = module.manifest.requests[0];
    const child = module.requests[0];
    if (request === undefined || child === undefined) {
      throw new Error('fixture did not lower one request edge');
    }
    expect(request.depth).toEqual({kind: 'const', bars: 1});
    const childResult = child.manifest.frames[0]?.locals[request.resultSlot];
    expect(childResult).toMatchObject({
      depth: {kind: 'none'},
      layout: request.layout,
    });
    expect(module.aggregateLayouts.layouts[request.layout]).toMatchObject({
      kind: 'struct',
      name: 'ChildSnapshot',
    });

    const sink = new Sink();
    const bound = await bind(module, {
      params: {},
      provider: contexts({
        '': csvContext(PRIMARY),
        X: csvContext(CHILD),
      }),
      sink,
      timeNow: 0,
      // The child allocates three struct bodies and their three array backings.
      // The parent can read all of them only if the merged view owns the six
      // refs in the shared Heap.
      maxHeapStorageCells: 6,
    });
    await bound.runAll();

    const rows = Array.from({length: bound.rows}, (_, row) =>
      sink.emissions
        .filter(emission => emission.row === row)
        .sort((a, b) => a.oid - b.oid)
        .map(emission => emission.channels[0]),
    );
    expect(rows).toEqual([
      [-1, -1, -1, -1],
      [100, -1, 0, -1],
      [100, 100, 0, 0],
      [101, 100, 1, 0],
      [101, 101, 1, 1],
      [102, 101, 2, 1],
    ]);
    expect(sink.emissions.every(emission => !emission.provisional)).toBeTrue();
    bound.dispose();
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
    expect(module.manifest.requests[0]?.dynamic).toBeTrue();

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
    // Y and X each suspend on first discovery. The shared receiver body keeps
    // completed mutations, but neither aborted attempt may reach the caller.
    const valuesFor = (oid: number): readonly Value[] =>
      sink.emissions
        .filter(emission => emission.oid === oid)
        .map(emission => emission.channels[0]);
    expect(valuesFor(1)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(valuesFor(2)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(sink.emissions.every(emission => !emission.provisional)).toBeTrue();
    bound.dispose();
  });
});
