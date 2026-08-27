// Purpose: Concrete Pine contextual values derived from public Node inputs.

import {BindError} from '../runtime/errors';
import type {BuiltinSpec, JSModule} from '../runtime/module-abi';
import type {Value} from '../runtime/value';
import {ValueLayoutRegistry} from '../runtime/value-layout';

/** Creates the concrete Pine builtin supplier installed on public Tea Nodes. */
export function pineBuiltinSupplier(now: () => number = Date.now) {
  let timeNow: number | null = null;
  const layouts = new WeakMap<object, ValueLayoutRegistry>();
  return (
    _path: readonly number[],
    module: JSModule,
    index: number,
    indices: number | null,
    datum: Readonly<Record<string, unknown>>,
  ): readonly Value[] => {
    if (timeNow === null) {
      timeNow = now();
      if (!Number.isSafeInteger(timeNow)) {
        throw new BindError('Pine timenow must be an exact epoch-ms integer');
      }
    }
    let registry = layouts.get(module.layout);
    if (registry === undefined) {
      registry = new ValueLayoutRegistry(module.layout);
      layouts.set(module.layout, registry);
    }
    return module.manifest.builtin.map(spec =>
      builtinValue(spec, index, indices, datum, timeNow!, registry),
    );
  };
}

function builtinValue(
  spec: BuiltinSpec,
  index: number,
  indices: number | null,
  datum: Readonly<Record<string, unknown>>,
  timeNow: number,
  layouts: ValueLayoutRegistry,
): Value {
  layouts.layout(spec.layout);
  const source = spec.source;
  let value: Value;
  switch (source.domain) {
    case 'time':
      switch (source.field) {
        case 'time':
          value = eventTime(datum.time, 'time');
          break;
        case 'time_close':
          value = eventTime(datum.time_close, 'time_close');
          break;
        case 'timenow':
          value = timeNow;
          break;
      }
      break;
    case 'bar':
      value =
        source.field === 'bar_index'
          ? index
          : finiteIndices(indices, 'last_bar_index') - 1;
      break;
    case 'barstate':
      switch (source.field) {
        case 'isfirst':
          value = index === 0;
          break;
        case 'islast':
          value = index === finiteIndices(indices, 'barstate.islast') - 1;
          break;
        case 'isrealtime':
          value = false;
          break;
        case 'ishistory':
        case 'isconfirmed':
        case 'isnew':
          value = true;
          break;
      }
      break;
    case 'syminfo':
    case 'timeframe':
      value = layouts.empty(spec.layout);
      break;
  }
  layouts.assertValue(spec.layout, value, `builtin '${builtinName(spec)}'`);
  return value;
}

function eventTime(value: unknown, field: 'time' | 'time_close'): number {
  if (value === undefined || value === null) {
    throw new BindError(
      `Pine ${field} requires an exact bigint epoch-ms input`,
    );
  }
  if (typeof value !== 'bigint') {
    throw new BindError(
      `Pine ${field} requires an exact bigint epoch-ms input`,
    );
  }
  const time = Number(value);
  if (!Number.isSafeInteger(time) || BigInt(time) !== value) {
    throw new BindError(`Pine ${field} must be an exact epoch-ms integer`);
  }
  return time;
}

function finiteIndices(indices: number | null, builtin: string): number {
  if (indices === null) {
    throw new BindError(
      `Pine builtin '${builtin}' requires a finite DataStream indices count`,
    );
  }
  return indices;
}

function builtinName(spec: BuiltinSpec): string {
  const source = spec.source;
  switch (source.domain) {
    case 'time':
    case 'bar':
      return source.field;
    case 'barstate':
    case 'syminfo':
    case 'timeframe':
      return `${source.domain}.${source.field}`;
  }
}
