// Purpose: Exact provider-side trailing-range projection over an immutable ProviderContext; runtime repeats the clamp defensively at its own trust boundary.

import type {ProviderContext, RangeDemand} from '../../runtime/abi';

export function projectProviderRange(
  context: ProviderContext,
  range: RangeDemand,
): ProviderContext {
  if (range.kind === 'full' || range.bars >= context.rows) {
    return context;
  }
  const start = context.rows - range.bars;
  const rows = range.bars;
  const axis = context.axis;
  return {
    rows,
    axis:
      axis === null
        ? null
        : {
            time: row => axis.time(start + row),
            closeTime: row => axis.closeTime(start + row),
          },
    series(id) {
      const data = context.series(id);
      return data === null
        ? null
        : {length: rows, at: row => data.at(start + row)};
    },
    builtinValue: source => context.builtinValue(source),
  };
}
