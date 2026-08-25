// Purpose: Evaluate the generated module's existing bind section into an
// immutable, context-free fact set for the step-based JavaScript runtime.

import type {
  DepthSpec,
  Frame,
  ModuleCode,
  Runtime,
  TeaModule,
} from './module-abi';
import type {BoundInput} from './binding';
import type {ExecutionDeclaration} from './output';
import {isHistoryOffset} from './ring';
import type {Value} from './value';

export interface BindingRetention {
  readonly frames: readonly (readonly number[])[];
  readonly series: readonly number[];
  readonly builtins: readonly number[];
  readonly requests: readonly number[];
}

export interface StaticRequestBinding {
  readonly requestId: number;
  readonly child: ModuleCode;
  readonly symbol: string;
  readonly timeframe: string;
  readonly options: {
    readonly gaps: boolean;
    readonly lookahead: boolean;
    readonly ignoreInvalidSymbol: boolean;
    readonly calcBarsCount: number;
  };
}

/** Immutable facts consumed when constructing the step-based runtime. */
export interface BoundModuleFacts {
  /** Generated code whose root manifest contains no unresolved bound depth. */
  readonly code: TeaModule;
  readonly params: readonly BoundInput[];
  readonly retention: BindingRetention;
  readonly declaration: ExecutionDeclaration;
  readonly requests: readonly StaticRequestBinding[];
}

export class ModuleBindingEvaluationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModuleBindingEvaluationError';
  }
}

/** Evaluate one already-generated module without acquiring runtime resources. */
export function evaluateModuleBinding(
  code: TeaModule,
  paramValues: readonly Value[],
): BoundModuleFacts {
  const evaluation = new ModuleBindEvaluation(code, paramValues);
  const operations = evaluation.operations();
  code.init(operations);
  code.bind(operations, evaluation.root());
  return evaluation.finish();
}

/** Freeze generated code before it becomes part of a BoundModule snapshot. */
export function freezeGeneratedModule(code: TeaModule): TeaModule {
  return deepFreeze(code);
}

const UNSET = Symbol('unset binding value');

class BindFrame implements Frame {
  readonly kind = 'frame' as const;
  readonly values: (Value | typeof UNSET)[];
  readonly initialized: boolean[];
  readonly subs: (BindFrame | null)[];

  constructor(
    readonly fid: number,
    localCount: number,
    subCount: number,
  ) {
    this.values = new Array(localCount).fill(UNSET);
    this.initialized = new Array(localCount).fill(false);
    this.subs = new Array(subCount).fill(null);
  }
}

// Compatibility evaluator for the current generated bind callback. It is a
// private implementation detail of evaluateModuleBinding, not another public
// runtime abstraction. A proxy rejects every execution-only Runtime method,
// so this class does not reproduce that interface or its execution semantics.
class ModuleBindEvaluation {
  private readonly runtimeOperations: Runtime;
  private readonly rootFrame: BindFrame;
  private readonly localDepths: (number | null)[][];
  private readonly seriesDepths: (number | null)[];
  private readonly builtinDepths: (number | null)[];
  private readonly requestDepths: (number | null)[];
  private readonly paramActive: boolean[];
  private readonly outputArgs: {name: string; value: Value}[][];
  private readonly requestOptions: (
    | StaticRequestBinding['options']
    | null
  )[];
  private readonly requestPairs: (
    | {readonly symbol: string; readonly timeframe: string}
    | null
  )[];

  constructor(
    private readonly code: TeaModule,
    private readonly paramValues: readonly Value[],
  ) {
    if (paramValues.length !== code.manifest.params.length) {
      throw new ModuleBindingEvaluationError(
        `expected ${code.manifest.params.length} parameter values, got ${paramValues.length}`,
      );
    }
    this.rootFrame = this.newFrame(0);
    this.localDepths = code.manifest.frames.map(frame =>
      frame.locals.map(local => staticRetention(local.depth)),
    );
    this.seriesDepths = code.manifest.series.map(series =>
      staticRetention(series.depth),
    );
    this.builtinDepths = code.manifest.builtin.map(builtin =>
      staticRetention(builtin.depth),
    );
    this.requestDepths = code.manifest.requests.map(request =>
      staticRetention(request.depth),
    );
    this.paramActive = code.manifest.params.map(() => true);
    this.outputArgs = code.manifest.outputs.map(() => []);
    this.requestOptions = code.manifest.requests.map(() => null);
    this.requestPairs = code.manifest.requests.map(() => null);
    this.runtimeOperations = new Proxy(this as unknown as Runtime, {
      get: (target, property) => {
        const operation = Reflect.get(target, property, target);
        if (operation === undefined) {
          return () => this.unsupported(String(property));
        }
        return typeof operation === 'function'
          ? operation.bind(this)
          : operation;
      },
    });
  }

  operations(): Runtime {
    return this.runtimeOperations;
  }

  finish(): BoundModuleFacts {
    const retention = deepFreeze({
      frames: this.localDepths.map((depths, fid) =>
        depths.map((depth, slot) =>
          requiredDepth(depth, `frame ${fid} slot ${slot}`),
        ),
      ),
      series: this.seriesDepths.map((depth, sid) =>
        requiredDepth(depth, `series ${sid}`),
      ),
      builtins: this.builtinDepths.map((depth, bid) =>
        requiredDepth(depth, `builtin ${bid}`),
      ),
      requests: this.requestDepths.map((depth, rid) =>
        requiredDepth(depth, `request ${rid}`),
      ),
    });

    const requests = this.code.manifest.requests.map((spec, requestId) => {
      if (spec.dynamic) {
        throw new ModuleBindingEvaluationError(
          `dynamic request ${requestId} is unsupported`,
        );
      }
      const pair = this.requestPairs[requestId];
      const options = this.requestOptions[requestId];
      const child = this.code.requests[requestId];
      if (pair === null || options === null || child === undefined) {
        throw new ModuleBindingEvaluationError(
          `static request ${requestId} has incomplete binding facts`,
        );
      }
      return {
        requestId,
        child,
        ...pair,
        options,
      } satisfies StaticRequestBinding;
    });

    const concreteCode = concreteModule(this.code, retention);
    return deepFreeze({
      code: concreteCode,
      params: this.code.manifest.params.map((spec, pid) => ({
        spec,
        value: this.paramValues[pid]!,
        active: this.paramActive[pid]!,
      })),
      retention,
      declaration: {
        outputs: this.code.manifest.outputs.map((spec, oid) => ({
          spec,
          boundArgs: this.outputArgs[oid]!,
        })),
        effects: this.code.manifest.effects.map(effect => effect.declaration),
      },
      requests,
    });
  }

  root(): Frame {
    return this.rootFrame;
  }

  frame(frame: Frame, slot: number): Frame {
    const parent = this.requireFrame(frame);
    const spec = this.frameLayout(parent.fid).subs[slot];
    if (spec === undefined) {
      throw new ModuleBindingEvaluationError(
        `binding frame ${parent.fid} has no subframe slot ${slot}`,
      );
    }
    let child = parent.subs[slot];
    if (child === null) {
      child = this.newFrame(spec.fid);
      parent.subs[slot] = child;
    }
    return child;
  }

  param(pid: number): Value {
    const value = this.paramValues[pid];
    if (value === undefined) {
      throw new ModuleBindingEvaluationError(`unknown parameter ${pid}`);
    }
    return value;
  }

  read(frame: Frame, slot: number, offset: number): Value {
    if (offset !== 0) {
      return this.unsupported('history reads');
    }
    const owner = this.requireFrame(frame);
    const value = owner.values[slot];
    if (value === undefined || value === UNSET) {
      throw new ModuleBindingEvaluationError(
        `binding read of uninitialized frame ${owner.fid} slot ${slot}`,
      );
    }
    return value;
  }

  write(frame: Frame, slot: number, value: Value): void {
    const owner = this.requireLocal(frame, slot);
    owner.values[slot] = value;
  }

  needsInit(frame: Frame, slot: number): boolean {
    const owner = this.requireLocal(frame, slot);
    return !owner.initialized[slot];
  }

  initialize(frame: Frame, slot: number, value: Value): void {
    const owner = this.requireLocal(frame, slot);
    owner.values[slot] = value;
    owner.initialized[slot] = true;
  }

  historyDepth(offset: number): number {
    return retentionForOffset(offset);
  }

  bindDepth(fid: number, slot: number, bars: number): void {
    const depths = this.localDepths[fid];
    if (depths === undefined || depths[slot] === undefined) {
      throw new ModuleBindingEvaluationError(
        `bound depth targets unknown frame ${fid} slot ${slot}`,
      );
    }
    this.reportDepth(depths, slot, bars, `frame ${fid} slot ${slot}`);
  }

  bindSeriesDepth(sid: number, bars: number): void {
    this.reportDepth(this.seriesDepths, sid, bars, `series ${sid}`);
  }

  bindBuiltinDepth(bid: number, bars: number): void {
    this.reportDepth(this.builtinDepths, bid, bars, `builtin ${bid}`);
  }

  bindOutput(oid: number, argName: string, value: Value): void {
    const args = this.outputArgs[oid];
    if (args === undefined) {
      throw new ModuleBindingEvaluationError(`unknown output ${oid}`);
    }
    args.push(deepFreeze({name: argName, value}));
  }

  bindParamActive(pid: number, active: Value): void {
    if (this.paramActive[pid] === undefined) {
      throw new ModuleBindingEvaluationError(`unknown parameter ${pid}`);
    }
    if (typeof active !== 'boolean') {
      throw new ModuleBindingEvaluationError(
        `parameter ${pid} active expression did not produce bool`,
      );
    }
    this.paramActive[pid] = active;
  }

  bindRequestOptions(
    rid: number,
    gaps: Value,
    lookahead: Value,
    ignoreInvalidSymbol: Value,
    calcBarsCount: Value,
  ): void {
    if (this.requestOptions[rid] === undefined) {
      throw new ModuleBindingEvaluationError(`unknown request ${rid}`);
    }
    if (
      typeof gaps !== 'boolean' ||
      typeof lookahead !== 'boolean' ||
      typeof ignoreInvalidSymbol !== 'boolean' ||
      typeof calcBarsCount !== 'number' ||
      !Number.isSafeInteger(calcBarsCount) ||
      calcBarsCount < 0
    ) {
      throw new ModuleBindingEvaluationError(
        `request ${rid} has invalid bound options`,
      );
    }
    this.requestOptions[rid] = deepFreeze({
      gaps,
      lookahead,
      ignoreInvalidSymbol,
      calcBarsCount,
    });
  }

  bindRequest(rid: number, symbol: Value, timeframe: Value): void {
    const spec = this.code.manifest.requests[rid];
    if (spec === undefined) {
      throw new ModuleBindingEvaluationError(`unknown request ${rid}`);
    }
    if (spec.dynamic) {
      throw new ModuleBindingEvaluationError(
        `dynamic request ${rid} is unsupported`,
      );
    }
    if (typeof symbol !== 'string' || typeof timeframe !== 'string') {
      throw new ModuleBindingEvaluationError(
        `request ${rid} symbol and timeframe must bind to strings`,
      );
    }
    this.requestPairs[rid] = deepFreeze({symbol, timeframe});
  }

  private newFrame(fid: number): BindFrame {
    const layout = this.frameLayout(fid);
    return new BindFrame(fid, layout.locals.length, layout.subs.length);
  }

  private frameLayout(fid: number) {
    const layout = this.code.manifest.frames[fid];
    if (layout === undefined) {
      throw new ModuleBindingEvaluationError(`unknown frame ${fid}`);
    }
    return layout;
  }

  private requireFrame(frame: Frame): BindFrame {
    if (!(frame instanceof BindFrame)) {
      throw new ModuleBindingEvaluationError('foreign binding frame');
    }
    return frame;
  }

  private requireLocal(frame: Frame, slot: number): BindFrame {
    const owner = this.requireFrame(frame);
    if (this.frameLayout(owner.fid).locals[slot] === undefined) {
      throw new ModuleBindingEvaluationError(
        `binding frame ${owner.fid} has no local slot ${slot}`,
      );
    }
    return owner;
  }

  private reportDepth(
    depths: (number | null)[],
    index: number,
    bars: number,
    label: string,
  ): void {
    if (depths[index] === undefined) {
      throw new ModuleBindingEvaluationError(
        `bound depth targets unknown ${label}`,
      );
    }
    if (depths[index] !== null) {
      throw new ModuleBindingEvaluationError(
        `${label} does not have a bound depth`,
      );
    }
    depths[index] = retentionForOffset(bars);
  }

  private unsupported(capability: string): never {
    throw new ModuleBindingEvaluationError(
      `binding expression requires ${capability}, which is unavailable before runtime`,
    );
  }
}

function staticRetention(depth: DepthSpec): number | null {
  switch (depth.kind) {
    case 'none':
      return 0;
    case 'const':
    case 'capped':
      return retentionForOffset(depth.bars);
    case 'bound':
      return null;
  }
}

function retentionForOffset(offset: number): number {
  return isHistoryOffset(offset) ? offset : 0;
}

function requiredDepth(depth: number | null, label: string): number {
  if (depth === null) {
    throw new ModuleBindingEvaluationError(
      `${label} did not report its bound history depth`,
    );
  }
  return depth;
}

function concreteModule(
  code: TeaModule,
  retention: BindingRetention,
): TeaModule {
  return deepFreeze({
    ...code,
    manifest: {
      ...code.manifest,
      frames: code.manifest.frames.map((frame, fid) => ({
        ...frame,
        locals: frame.locals.map((local, slot) => ({
          ...local,
          depth: concreteDepth(local.depth, retention.frames[fid]![slot]!),
        })),
      })),
      series: code.manifest.series.map((series, sid) => ({
        ...series,
        depth: concreteDepth(series.depth, retention.series[sid]!),
      })),
      builtin: code.manifest.builtin.map((builtin, bid) => ({
        ...builtin,
        depth: concreteDepth(builtin.depth, retention.builtins[bid]!),
      })),
      requests: code.manifest.requests.map((request, rid) => ({
        ...request,
        depth: concreteDepth(request.depth, retention.requests[rid]!),
      })),
    },
  });
}

function concreteDepth(original: DepthSpec, bars: number): DepthSpec {
  return original.kind === 'bound' ? {kind: 'const', bars} : original;
}

function deepFreeze<T>(value: T): T {
  if (
    value === null ||
    (typeof value !== 'object' && typeof value !== 'function') ||
    Object.isFrozen(value)
  ) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
