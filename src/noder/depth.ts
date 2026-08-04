// Purpose: Depth resolution pass — walks every HistRead and annotates each place's HistoryDepth so the runtime can size every buffer at bind time; dynamic offsets resolve to an explicit cap.

import {
  DepthKind,
  IrKind,
  PlaceKind,
  type HistoryDepth,
  type HistReadExpr,
  type IrExpr,
} from '../ir/node';
import {fatal} from '../base/print';
import type {Program} from '../ir/program';
import {IntType, Qualifier, qualifierLE} from '../ir/type';
import {histReadsOf} from '../ir/visit';

// The engine default for dynamic offsets without an explicit declaration cap
// (Pine's max_bars_back default).
export const DEFAULT_MAX_BARS_BACK = 500;

// Whatever a place resolves through, it carries a mutable depth field.
interface DepthCarrier {
  depth: HistoryDepth;
}

interface Demand {
  maxConst: number;
  bound: IrExpr[];
  dynamic: boolean;
  pos: HistReadExpr['pos'];
}

// First-cut merge rules (refined by interval analysis later, per docs/ir.md):
// all-const offsets take their maximum; a single bind-time offset stays a
// bound expression; any dynamic offset — or a mix that cannot be maximized
// statically — falls back to the declaration cap.
export function resolveDepths(program: Program): void {
  const demands = new Map<DepthCarrier, Demand>();
  for (const read of histReadsOf(program)) {
    if (read.offset === null) {
      continue; // a current-bar read materializes no buffer
    }
    const carrier = carrierOf(read);
    let demand = demands.get(carrier);
    if (demand === undefined) {
      demand = {maxConst: 0, bound: [], dynamic: false, pos: read.pos};
      demands.set(carrier, demand);
    }
    const offset = read.offset;
    if (offset.kind === IrKind.Const && typeof offset.value === 'number') {
      demand.maxConst = Math.max(demand.maxConst, offset.value);
    } else if (
      qualifierLE(offset.qualifier, Qualifier.Simple) &&
      bindEvaluable(offset)
    ) {
      demand.bound.push(offset);
    } else {
      demand.dynamic = true;
    }
  }

  const cap = declarationCap(program);
  for (const [carrier, demand] of demands) {
    carrier.depth = finalize(demand, cap);
  }
}

function carrierOf(read: HistReadExpr): DepthCarrier {
  const place = read.place;
  switch (place.kind) {
    case PlaceKind.Name:
      return place.name;
    case PlaceKind.Param:
      return place.param;
    case PlaceKind.Series:
      return place.series;
    case PlaceKind.Request:
      return place.request;
  }
}

function finalize(demand: Demand, cap: number): HistoryDepth {
  if (demand.dynamic || (demand.bound.length > 0 && demand.maxConst > 0)) {
    return {
      kind: DepthKind.Capped,
      bars: {
        kind: IrKind.Const,
        pos: demand.pos,
        type: IntType,
        qualifier: Qualifier.Const,
        value: cap,
      },
    };
  }
  if (demand.bound.length === 1) {
    return {kind: DepthKind.Bound, expr: demand.bound[0]};
  }
  if (demand.bound.length > 1) {
    // Multiple bind-time offsets cannot be maximized statically; the cap
    // covers them. (A bind-time max() expression is a possible refinement.)
    return {
      kind: DepthKind.Capped,
      bars: {
        kind: IrKind.Const,
        pos: demand.pos,
        type: IntType,
        qualifier: Qualifier.Const,
        value: cap,
      },
    };
  }
  if (demand.maxConst > 0) {
    return {kind: DepthKind.Const, bars: demand.maxConst};
  }
  return {kind: DepthKind.None};
}

// indicator(max_bars_back=N) declares the cap; the engine default otherwise.
// OutputDecl.effect holds the native's NAME (indicator/strategy), not its
// effect class.
function declarationCap(program: Program): number {
  for (const output of program.outputs) {
    if (output.effect !== 'indicator' && output.effect !== 'strategy') {
      continue;
    }
    const declared = output.staticArgs.find(a => a.name === 'max_bars_back');
    if (declared !== undefined && typeof declared.value === 'number') {
      return declared.value;
    }
  }
  return DEFAULT_MAX_BARS_BACK;
}

// A bound depth expression runs in the module's init section, which has no
// frame: only constants, scalar param reads, and pure combinations qualify.
// Anything touching a frame slot (even const-qualified function params —
// their values are per call site) falls back to the cap.
function bindEvaluable(e: IrExpr): boolean {
  switch (e.kind) {
    case IrKind.Const:
      return true;
    case IrKind.HistRead:
      return e.place.kind === PlaceKind.Param && e.offset === null;
    case IrKind.Binary:
      return bindEvaluable(e.x) && bindEvaluable(e.y);
    case IrKind.Unary:
      return bindEvaluable(e.x);
    case IrKind.Cond:
      return (
        bindEvaluable(e.cond) && bindEvaluable(e.then) && bindEvaluable(e.else)
      );
    case IrKind.CallNative:
      return e.args.every(bindEvaluable);
    default:
      return false;
  }
}

// Referenced to keep the import stable if rules above change.
void fatal;
