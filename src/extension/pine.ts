import type {Module} from '../runtime/module-binding';
// Purpose: Concrete Pine contextual values derived from public Node inputs.

import {BindError} from '../runtime/errors';
import type {Builtin} from '../runtime/module-abi';
import type {Stored} from '../runtime/value';

/**
 * Supply per-step Pine values from the Node's position and source time.
 * Each attempt samples the supplied clock and live flag once; callers wanting
 * a fixed evaluation instant supply a constant function. Derived Nodes share
 * no clock memoization. Node gives one supplier to every request child, and
 * each child samples both callbacks at its own steps.
 * `barstate.isrealtime` reads the live flag and `barstate.ishistory` its
 * opposite. The default flag is false, so finite runs and `tea` template
 * Nodes report history; a live host calls `createNode` with its own flag.
 * Absent symbol/timeframe metadata uses the builtin's typed empty value.
 * Runtime overlays any bound fixed values.
 * @example For a module containing only `plot(timenow)`,
 * `pineBuiltinSupplier(() => 1000)([], module, 0, {})` returns `[1000]`.
 * `pineBuiltinSupplier(Date.now, () => live)` reports realtime bars once the
 * host sets `live`.
 */
export function pineBuiltinSupplier(
  now: () => number = Date.now,
  isRealtime: () => boolean = () => false,
) {
  return (
    _path: readonly number[],
    module: Module,
    index: number,
    datum: Readonly<Record<string, unknown>>,
  ): readonly Stored[] => {
    const timeNow = now();
    if (!Number.isSafeInteger(timeNow)) {
      throw new BindError('Pine timenow must be an exact epoch-ms integer');
    }
    const realtime = isRealtime();
    return module.inputs.builtins.map(spec =>
      builtinValue(spec, index, datum, timeNow, realtime),
    );
  };
}

function builtinValue(
  spec: Builtin,
  index: number,
  datum: Readonly<Record<string, unknown>>,
  timeNow: number,
  realtime: boolean,
): Stored {
  const source = spec.source;
  let value: Stored;
  switch (source.domain) {
    case 'time':
      switch (source.field) {
        case 'time':
          value = eventTime(datum.time, 'time');
          break;
        case 'timenow':
          value = timeNow;
          break;
      }
      break;
    case 'bar':
      value = index;
      break;
    case 'barstate':
      switch (source.field) {
        case 'isfirst':
          value = index === 0;
          break;
        case 'isrealtime':
          value = realtime;
          break;
        case 'ishistory':
          value = !realtime;
          break;
        case 'isconfirmed':
          value = datum.provisional !== true;
          break;
        case 'isnew':
          value = datum.firstAttempt !== false;
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

function eventTime(value: unknown, field: 'time'): number {
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
