// Purpose: Pine Extension derives contextual values from public Node inputs.

import {of} from 'rxjs';
import {describe, expect, test} from 'vitest';
import * as z from 'zod';
import {createNode, type Datum} from '../api/node';
import {i} from '../api/clock';
import {DataStream} from '../api/stream';
import {generate} from '../codegen/codegen';
import {mustBuild} from '../noder/testing';
import {loadModule} from '../runtime/load';
import {moduleBindings, withModuleBindings} from '../runtime/module-binding';
import {pineBuiltinSupplier} from './pine';

describe('Pine Extension', () => {
  test('derives finite indices, times, and bar state from public input', async () => {
    const node = pineNode(
      [
        'plot(time)',
        'plot(time_close)',
        'plot(timenow)',
        'plot(bar_index)',
        'plot(last_bar_index)',
        'plot(barstate.isfirst ? 1 : 0)',
        'plot(barstate.islast ? 1 : 0)',
      ].join('\n'),
      1_777_777_777_777,
    );
    node.bind(
      new DataStream(
        z.object({time: z.bigint(), time_close: z.bigint()}),
        of(
          {time: 100n, time_close: 110n},
          {time: 110n, time_close: 120n},
          {time: 120n, time_close: 130n},
        ),
        i,
        3,
      ),
    );
    const sink = new DatumSink();

    node.to(sink);
    await sink.completion;

    expect(values(sink)).toEqual([
      [100, 110, 1_777_777_777_777, 0, 2, 1, 0],
      [110, 120, 1_777_777_777_777, 1, 2, 0, 0],
      [120, 130, 1_777_777_777_777, 2, 2, 0, 1],
    ]);
  });

  test('uses typed empty values when application metadata is absent', async () => {
    const node = pineNode(
      ['plot(timeframe.multiplier)', 'plot(timeframe.isdaily ? 1 : 0)'].join(
        '\n',
      ),
      0,
    );
    node.bind(new DataStream(z.object({}), of({}), i, 1));
    const sink = new DatumSink();

    node.to(sink);
    await sink.completion;

    expect(values(sink)).toEqual([[NaN, 0]]);
  });

  test('requires finite indices only for extent-dependent builtins', async () => {
    const node = pineNode('plot(last_bar_index)', 0);
    node.bind(new DataStream(z.object({}), of({})));
    const sink = new DatumSink();

    node.to(sink);

    await expect(sink.completion).rejects.toThrow(
      "Pine builtin 'last_bar_index' requires a finite DataStream indices count",
    );
  });

  test('requires exact bigint event time when time is demanded', async () => {
    const node = pineNode('plot(time)', 0);
    node.bind(new DataStream(z.object({}), of({}), i, 1));
    const sink = new DatumSink();

    node.to(sink);

    await expect(sink.completion).rejects.toThrow(
      'Pine time requires an exact bigint epoch-ms input',
    );
  });
});

function pineNode(source: string, timeNow: number) {
  const loaded = loadModule(generate(mustBuild(source)));
  return createNode(
    withModuleBindings(loaded, moduleBindings(loaded)),
    pineBuiltinSupplier(() => timeNow),
  );
}

function values(sink: DatumSink): readonly (readonly unknown[])[] {
  return sink.values.map(datum =>
    [...datum.outputs]
      .sort((left, right) => left.outputId - right.outputId)
      .map(output => output.channels[0]),
  );
}

class DatumSink {
  readonly values: Datum[] = [];
  readonly completion: Promise<void>;
  private readonly resolve: () => void;
  private readonly reject: (error: unknown) => void;

  constructor() {
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    this.completion = new Promise<void>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    this.resolve = resolve;
    this.reject = reject;
  }

  next(value: Datum): void {
    this.values.push(value);
  }

  error(error: unknown): void {
    this.reject(error);
  }

  complete(): void {
    this.resolve();
  }
}
