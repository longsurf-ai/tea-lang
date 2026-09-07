import type {Module} from '../runtime/module-binding';
// Purpose: Visual output values use ordinary call evaluation; binding retains only parameter/request/history facts.

import {describe, expect, test} from 'vitest';
import {mustBuild} from '../noder/testing';
import {Schema} from 'apache-arrow';
import {executeTestProgram, finiteStream} from '../testing/batch';
import {OutputCapture} from '../testing/output';
import {generate} from './codegen';

import type {Scalar} from '../runtime/value';
import {loadModule} from '../runtime/load';

describe('ordinary visual output evaluation', () => {
  test('captures named arguments in source order and applies ordinary defaults', async () => {
    const program = mustBuild(`
struct Counter
    int value
    int next() =>
        this.value += 1
        this.value
    color nextColor() =>
        this.value += 1
        color.red
counter = Counter.new(0)
p = plot("p", color=counter.nextColor(), series=counter.next())
q = plot("q", counter.next())
emit "count" counter.value
`);
    const sink = new OutputCapture();
    await executeTestProgram(program, {
      stream: finiteStream(new Schema([]), [{}]),
      sink,
      timeNow: 0,
    });
    expect(sink.publications[0]).toMatchObject({
      p: {series: 2, linewidth: 1},
      q: {series: 3, title: '', linewidth: 1},
      count: 3,
    });
    expect(sink.fields.map(field => field.name)).toEqual(['p', 'q', 'count']);
  });
});

test('binding clears all late facts before a missing-context read or incomplete parameters', () => {
  const source = generate(
    mustBuild(
      [
        'length = input.int(2, minval=0)',
        'enabled = input.bool(true)',
        'weight = input.int(2, active=enabled)',
        'stock = syminfo.type == "stock"',
        'remote = request.security("X", "D", close, fill=stock ? "sparse" : "carry", calc_bars_count=length)',
        'value = close + 0.0',
        'emit "output0" value[length]',
        'emit "output1" remote[length]',
        'emit "output2" close[length]',
        'emit "type" syminfo.type[length]',
      ].join('\n'),
    ),
  );
  // The loader normally captures this callback and supplies its own mutable
  // copy. Exercise the raw artifact here to inspect a failed calculation.
  const raw = loadModule(source);
  const calculate = (
    raw as unknown as {
      calculate: (
        module: Module,
        context?: ReadonlyMap<number, Scalar>,
      ) => void;
    }
  ).calculate as (
    module: Module,
    context?: ReadonlyMap<number, Scalar>,
  ) => void;
  const depths = () => [
    ...raw.inputs.series.map(input => input.depth),
    ...raw.inputs.builtins.map(input => input.depth),
    ...raw.state.frames.flatMap(frame =>
      frame.locals.map(local => local.depth),
    ),
    ...raw.requests.map(request => request.depth),
  ];
  const late = depths().map(depth => depth.kind === 'bound');
  expect(late.filter(Boolean).length).toBeGreaterThanOrEqual(4);
  const active = raw.parameters.map(parameter => parameter.active === null);
  raw.parameters.forEach(parameter =>
    Object.assign(parameter, {value: parameter.defaultValue}),
  );
  const bid = raw.inputs.builtins.findIndex(
    input => input.source.field === 'type',
  );
  calculate(raw, new Map([[bid, 'stock']]));
  depths().forEach((depth, index) => {
    if (late[index]) expect(depth).toEqual({kind: 'const', bars: 2});
  });
  expect(raw.requests[0].context?.fill).toBe('sparse');
  Object.assign(raw.parameters[0], {value: 7});
  expect(() => calculate(raw, new Map())).toThrow('not bind-visible');
  depths().forEach((depth, index) => {
    if (late[index]) expect(depth).toEqual({kind: 'bound'});
  });
  raw.parameters.forEach((parameter, index) => {
    if (active[index]) expect(parameter.active).toBeNull();
  });
  expect(raw.requests[0].context).toBeNull();
  Object.assign(raw.parameters[0], {value: undefined});
  expect(() => calculate(raw, new Map())).not.toThrow();
  expect(raw.requests[0].context).toBeNull();
});
