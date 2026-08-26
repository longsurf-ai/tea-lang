// Purpose: Tea Program contract — the compiler's complete static description of a script; the runtime implements the Time Machine (buffers, copy-on-write, rollback) from this description.

import type {Pos} from '../base/pos';
import type {DataSeriesId, BuiltinSource} from './builtin';
import type {HistoryDepth, IrExpr, IrStmt, Name} from './node';
import type {ConstValue, Qualifier, Type} from './type';

// A user-tunable input (input.*): compile time extracts the declaration; the
// VALUE arrives from the runtime at bind time. input.source defaults are
// references to a series input (close), not constants — the param records
// the default CHOICE; the bound value is the runtime's series selection.
export const ParamDefaultKind = {
  Const: 'const',
  Series: 'series',
} as const;

export type ParamDefault =
  | {readonly kind: typeof ParamDefaultKind.Const; readonly value: ConstValue}
  | {
      readonly kind: typeof ParamDefaultKind.Series;
      readonly series: SeriesInput;
    };

export const ParamConstraintKind = {
  Range: 'range',
  Options: 'options',
} as const;

export type ParamConstraints =
  | {
      readonly kind: typeof ParamConstraintKind.Range;
      readonly minval: ConstValue | null;
      readonly maxval: ConstValue | null;
      readonly step: ConstValue | null;
    }
  | {
      readonly kind: typeof ParamConstraintKind.Options;
      readonly options: readonly [ConstValue, ...ConstValue[]];
    };

export type ParamDisplay = 'all' | 'none' | 'data_window' | 'status_line';

export interface ParamInput {
  // Identity: the binding name when the input call initializes a program-
  // scope declaration (`len = input.int(...)`), else `input@line:col`.
  readonly name: string;
  // Settings-UI label; null renders the name.
  readonly title: string | null;
  // Which input control built this param ('int', 'price', 'session',
  // 'auto' for bare input(), …) — UI fidelity; the VALUE type lives in
  // `type`.
  readonly control: string;
  readonly type: Type;
  readonly defaultValue: ParamDefault | null;
  readonly constraints: ParamConstraints | null;
  // Settings-UI layout and interaction metadata, straight from the call.
  readonly group: string | null;
  readonly inline: string | null;
  readonly tooltip: string | null;
  readonly confirm: boolean;
  readonly display: ParamDisplay;
  // input-qualified enablement evaluated after all parameter values bind.
  // The catalog default is represented explicitly as a const true node.
  readonly active: IrExpr;
  // History demanded on the bound value by the body (src[1] on an
  // input.source param reaches the runtime's chosen series). Annotated by
  // the depth pass; meaningful only for series-resulting params.
  depth: HistoryDepth;
}

// A numeric series in the Program's data context, provided by the runtime and
// bound by host id (close, volume, hl2, ...). Typed builtins live in
// BuiltinInput instead of widening this numeric data plane.
export interface SeriesInput {
  readonly id: DataSeriesId;
  readonly type: Type;
  readonly qualifier: Qualifier;
  // History demanded on this input by the body (close[500]); the runtime
  // sizes the buffer from this, exactly as for names. Annotated by the depth
  // pass.
  depth: HistoryDepth;
}

// @agent invariant: typed builtins remain distinct from numeric
// SeriesInput values. Each Program projection owns and depth-annotates its own
// carrier, including request-child Programs.
export interface BuiltinInput {
  readonly source: BuiltinSource;
  readonly type: Type;
  readonly qualifier: Qualifier;
  depth: HistoryDepth;
}

// A statically-declared effect channel (plot, hline, alertcondition, …):
// hoisted at compile time so the host knows every output before the first
// bar. Per-bar values arrive via EmitStmt writes.
export interface OutputDecl {
  readonly effect: string; // catalog primitive, e.g. 'plot', 'hline'
  readonly staticArgs: readonly {
    readonly name: string;
    readonly value: ConstValue;
  }[];
  // input-qualified declarative args (hline price, plot linewidth,
  // plotshape offset) plus output references (fill's plot/hline operands as
  // const OutputRef exprs): evaluated once in module.bind, delivered to the host
  // before the first bar.
  readonly bindArgs: readonly {
    readonly name: string;
    readonly expr: IrExpr;
  }[];
  // Canonical bindArgs indices in source evaluation order. Bind lowering
  // captures in this order, then reports values to the host by canonical name.
  readonly bindArgumentEvaluationOrder: readonly number[];
  readonly channels: readonly {readonly name: string; readonly type: Type}[];
}

// One statically-known sparse effect call site. Unlike OutputDecl, an effect
// has no dense row channel: each execution of its EmitEffectStmt appends one
// payload record, and repeated executions preserve source execution order.
export interface EffectDecl {
  readonly payloadType: Type;
  readonly payloadSchema: EffectValueSchema;
  readonly sourcePosition: Pos;
}

// Backend-neutral sparse-effect payload description. Nominal ids come from
// checker package/object identity; display names are presentation only.
export type EffectValueSchema =
  | {readonly kind: 'int' | 'float' | 'bool' | 'string' | 'color'}
  | {
      readonly kind: 'enum';
      readonly typeId: string;
      readonly displayName: string;
      readonly members: readonly {
        readonly name: string;
        readonly title: string;
      }[];
    }
  | {
      readonly kind: 'struct';
      readonly typeId: string;
      readonly displayName: string;
      readonly fields: readonly {
        readonly name: string;
        readonly value: EffectValueSchema;
      }[];
    };

// How a child Program's bars project onto the parent axis.
export const MergeMode = {
  Sample: 'sample',
  Collect: 'collect', // lower-timeframe array-per-bar
} as const;

export type MergeModeName = (typeof MergeMode)[keyof typeof MergeMode];

export interface MergePolicy {
  readonly mode: MergeModeName;
  readonly gaps: IrExpr;
  readonly lookahead: IrExpr;
  // Invalid symbols yield na instead of a runtime error.
  readonly ignoreInvalidSymbol: IrExpr;
  // Bind-resolvable bar-count limit for the child. Omitted calls carry an
  // explicit zero expression, which selects the full available range.
  readonly calcBarsCount: IrExpr;
}

// A request.* call site: its captured expression compiles as a child Program
// with its own context, axis, and rollback. Constants and direct ParamInputs
// may cross from the root; automatic computed-root dependency closure is
// staged and the checker rejects it meanwhile.
export interface RequestEdge {
  // The call site anchors noder post-pass support diagnostics.
  readonly pos: Pos;
  // Public Node binding identity: the direct top-level declaration target.
  readonly name: string;
  // Input/simple expressions form static contexts. Series-qualified context
  // expressions set `dynamic`, which currently fails closed at the noder
  // boundary before a Program can reach codegen or runtime.
  readonly symbol: IrExpr;
  readonly timeframe: IrExpr;
  // Canonical parent-context operand indices (0 = symbol, 1 = timeframe) in
  // source evaluation order. The captured expression is child-context code
  // and is deliberately absent from this parent schedule.
  readonly contextArgumentEvaluationOrder: readonly number[];
  // Canonical option indices (gaps=0, lookahead=1, ignore=2, bars=3) in
  // source evaluation order. Omitted defaults follow supplied options in
  // canonical order so module.bind evaluates each option exactly once.
  readonly optionArgumentEvaluationOrder: readonly number[];
  readonly merge: MergePolicy;
  // The designated result is a Name OF THE CHILD written each child bar.
  readonly resultName: Name;
  readonly captureType: Type;
  // Source-visible parent type: captureType for sample, array<captureType>
  // for collect.
  readonly resultType: Type;
  // Classified once by the noder, where the expression's owning frame is
  // still known. Downstream stages consume this fact instead of re-deriving
  // it after that ownership context has been erased.
  readonly dynamic: boolean;
  // History demanded on the merged result by the parent body. Annotated by
  // the depth pass.
  depth: HistoryDepth;
  readonly child: Program;
}

// One instantiation of a user (or prelude) function per concrete argument
// signature — Go-style stenciling, and instantiations are REAL functions:
// calls dispatch at runtime (inlining is at most a codegen optimization).
// Explicit params, a method's hidden receiver, and locals are ordinary Names:
// ownership is by declaration site, never by reachability — a program-frame
// `var` read only inside a function must still live in the program frame, so
// walking cannot discover ownership. An IrFunc's frame layout is its hidden
// receiver (for methods), explicit params, and locals plus one sub-frame per
// stateful call site in its body; each call site's slot selects its sub-frame,
// so two ma(close, 10) call sites own two frames (and two ema sub-frames
// within).
export interface IrFuncBase {
  readonly name: string;
  // Source-visible parameters only. A method receiver is never inserted into
  // this list, so named/default argument metadata cannot accidentally expose
  // the compiler-only receiver.
  readonly params: readonly Name[];
  // Names DECLARED in this instantiation's body (the binder's defs minus the
  // hidden receiver and explicit params), in source order.
  readonly locals: readonly Name[];
  readonly resultType: Type;
  readonly resultQualifier: Qualifier;
  readonly body: IrExpr;
}

// @agent invariant: the call-mode discriminator is the Program-level proof
// that free calls, read-only method calls, and shared-reference mutable method
// calls cannot be confused. Method receivers are hidden Names, distinct from
// every explicit param and local.
export interface FreeIrFunc extends IrFuncBase {
  readonly callMode: 'free';
}

export interface ConstMethodIrFunc extends IrFuncBase {
  readonly callMode: 'const-method';
  readonly receiver: Name;
}

export interface MutableMethodIrFunc extends IrFuncBase {
  readonly callMode: 'mutable-method';
  readonly receiver: Name;
}

export type IrFunc = FreeIrFunc | ConstMethodIrFunc | MutableMethodIrFunc;

// @agent invariant: one Program instance runs against exactly one context
// (one symbol × timeframe axis) and owns its names, bindings, and rollback;
// recursion — not multi-context Programs — is how requests compose. The
// Program is a pure static description: it never encodes buffer layouts, COW
// strategy, or any other Time Machine mechanics, which are runtime-owned.
// Field criterion: a Program declares its EXTERNAL NEEDS — params
// (bind-time values) and requests (child-Program contexts the runtime must
// resolve) — and its emissions (outputs), explicitly, even where derivable:
// binder, checker, and runtime read what the program needs from the world
// here, never by walking trees. Context builtins are not declarations:
// numeric and typed usage sets are projected by seriesInputsOf and
// builtinInputsOf for manifest publication. Composition internals (names,
// funcs, call-site slots) are visit.ts projections; the noder fills requests
// from the same reach walk.
export interface Program {
  // Declared Tea language version.
  readonly version: number;
  readonly params: readonly ParamInput[];
  readonly requests: readonly RequestEdge[];
  readonly outputs: readonly OutputDecl[];
  readonly effects: readonly EffectDecl[];
  // Reachable imported-package runtime globals in deterministic initializer
  // order. Each is an ordinary program-frame Name with a non-null init.
  readonly packageGlobals: readonly Name[];
  // Hoisted const/input/simple work, run once when bindings are known.
  readonly init: readonly IrStmt[];
  // The per-bar body — the inner loop of the bar-per-bar execution model.
  readonly body: readonly IrStmt[];
}
