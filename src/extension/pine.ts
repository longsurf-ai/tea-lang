import type {Module} from '../runtime/module-binding';
// Purpose: Concrete Pine contextual values derived from public Node inputs.

import {BindError} from '../runtime/errors';
import type {Builtin} from '../runtime/module-abi';
import type {Stored} from '../runtime/value';

/**
 * Supply per-step Pine values from the Node's position, extent, and source time.
 * The first call captures timenow for the graph; absent symbol/timeframe metadata
 * uses the builtin's typed empty value. Runtime overlays any bound fixed values.
 * @example For a module containing only `plot(timenow)`,
 * `pineBuiltinSupplier(() => 1000)([], module, 0, 1, {})` returns `[1000]`.
 */
export function pineBuiltinSupplier(now: () => number = Date.now) {
  let timeNow: number | null = null;
  return (
    _path: readonly number[],
    module: Module,
    index: number,
    indices: number | null,
    datum: Readonly<Record<string, unknown>>,
  ): readonly Stored[] => {
    if (timeNow === null) {
      timeNow = now();
      if (!Number.isSafeInteger(timeNow)) {
        throw new BindError('Pine timenow must be an exact epoch-ms integer');
      }
    }
    return module.inputs.builtins.map(spec =>
      builtinValue(spec, index, indices, datum, timeNow!),
    );
  };
}

function builtinValue(
  spec: Builtin,
  index: number,
  indices: number | null,
  datum: Readonly<Record<string, unknown>>,
  timeNow: number,
): Stored {
  const source = spec.source;
  let value: Stored;
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
      value = spec.empty.value as Stored;
      break;
  }
  spec.empty.assertStored(value);
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
