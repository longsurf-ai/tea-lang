import type {Module} from '../runtime/module-binding';
// Purpose: Output bind lowering preserves source evaluation order while assembling canonical host arguments.

import {describe, expect, test} from 'vitest';
import {buildText, mustBuild} from '../noder/testing';
import {generate} from './codegen';

import type {Scalar} from '../runtime/value';
import {loadModule} from '../runtime/load';

const SOURCE = [
  'indicator("output bind order")',
  'colors = matrix.new<color>()',
  'values = array.new<int>()',
  'plot(color = colors.get(0, 0), series = values.first())',
].join('\n');

describe('output bind evaluation order', () => {
  test('rejects aggregate-dependent declaration arguments before loading', () => {
    const result = buildText(SOURCE);

    expect(result.program).toBeNull();
    expect(result.errors.map(error => error.msg)).toContain(
      'module configuration must depend only on constants, scalar parameters, and non-allocating simple expressions',
    );
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
        'plot(value[length], title="Value", linewidth=weight)',
        'plot(remote[length])',
        'plot(close[length])',
        'output(syminfo.type[length], kind="type", args={})',
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
  const args = raw.outputs.declarations.map(output => output.args === null);
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
  expect(raw.outputs.declarations[0].args).toContainEqual({
    name: 'title',
    value: 'Value',
  });
  expect(raw.outputs.declarations[0].args).toContainEqual({
    name: 'linewidth',
    value: 2,
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
  raw.outputs.declarations.forEach((output, index) => {
    if (args[index]) expect(output.args).toBeNull();
  });
  expect(raw.requests[0].context).toBeNull();
  Object.assign(raw.parameters[0], {value: undefined});
  expect(() => calculate(raw, new Map())).not.toThrow();
  expect(raw.requests[0].context).toBeNull();
});
