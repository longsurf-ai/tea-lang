// Purpose: Pine Extension derives contextual values from public Node inputs.

import {of} from 'rxjs';
import {describe, expect, test} from 'vitest';
import {Field, Schema, TimestampMillisecond} from 'apache-arrow';
import {createNode, type Datum} from '../api/node';
import {i} from '../api/clock';
import {DataStream} from '../api/stream';
import {generate} from '../codegen/codegen';
import {mustBuild} from '../noder/testing';
import {loadModule} from '../runtime/load';
import {pineBuiltinSupplier} from './pine';

describe('Pine Extension', () => {
  test("derived executions do not reuse another run's captured timenow", async () => {
    let now = 100;
    const base = createNode(
      loadModule(generate(mustBuild('emit "output0" timenow'))).bind(),
      pineBuiltinSupplier(() => now),
    );
    const source = new DataStream(new Schema([]), of({}));
    const first = new DatumSink();
    base.bind(source).to(first);
    await first.completion;
    now = 200;
    const second = new DatumSink();
    base.bind(source).to(second);
    await second.completion;
    expect(values(first)).toEqual([[100]]);
    expect(values(second)).toEqual([[200]]);
  });

  test('derives bar index, times, and bar state from public input', async () => {
    let node = pineNode(
      [
        'emit "output0" time',
        'emit "output2" timenow',
        'emit "output3" bar_index',
        'emit "output4" barstate.isfirst ? 1 : 0',
      ].join('\n'),
      1_777_777_777_777,
    );
    node = node.bind(
      new DataStream(
        new Schema([new Field('time', new TimestampMillisecond(), false)]),
        of({time: 100n}, {time: 110n}, {time: 120n}),
      ),
    );
    const sink = new DatumSink();

    node.to(sink);
    await sink.completion;

    expect(values(sink)).toEqual([
      [100, 1_777_777_777_777, 0, 1],
      [110, 1_777_777_777_777, 1, 0],
      [120, 1_777_777_777_777, 2, 0],
    ]);
  });

  test('uses typed empty values when application metadata is absent', async () => {
    let node = pineNode(
      [
        'emit "output7" timeframe.multiplier',
        'emit "output8" timeframe.isdaily ? 1 : 0',
      ].join('\n'),
      0,
    );
    node = node.bind(new DataStream(new Schema([]), of({})));
    const sink = new DatumSink();

    node.to(sink);
    await sink.completion;

    expect(values(sink)).toEqual([[NaN, 0]]);
  });

  test('fixed context survives cloning and rebinding without fabricating first-bar history', async () => {
    const module = loadModule(
      generate(
        mustBuild(
          'gain = input.float(1)\nemit "output0" timeframe.multiplier[1] * gain',
        ),
      ),
    ).bind({gain: 2}, new Map([[0, 7]]));
    const rebound = module.clone().bind({gain: 1});
    expect(rebound.inputs.builtins[0]!.value).toBe(7);
    let node = createNode(
      rebound,
      pineBuiltinSupplier(() => 0),
    );
    node = node.bind(new DataStream(new Schema([]), of({}, {})));
    const sink = new DatumSink();
    node.to(sink);
    await sink.completion;
    expect(values(sink)).toEqual([[NaN], [7]]);
    expect(module.parameters[0]!.value).toBe(2);
  });

  test('requires exact bigint event time when time is demanded', async () => {
    let node = pineNode('emit "output10" time', 0);
    node = node.bind(new DataStream(new Schema([]), of({})));
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
    loaded.bind(),
    pineBuiltinSupplier(() => timeNow),
  );
}

function values(sink: DatumSink): readonly (readonly unknown[])[] {
  return sink.values.map(datum =>
    Object.entries(datum)
      .filter(([key, value]) => /^output\d+$/.test(key) && value !== null)
      .sort(([a], [b]) => Number(a.slice(6)) - Number(b.slice(6)))
      .map(([, value]) => value),
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
