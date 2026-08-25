// Purpose: Execute one generated ModuleCode invocation as an Effect state
// transition over explicit committed State, Intermediate, and Input values.

import {Effect} from 'effect';
import {Storage} from '../ir/node';
import {fatal} from '../base/print';
import {unimplemented} from '../base/unimplemented';
import type {
  CollectionEntries,
  CollectionMutation,
  CollectionMutationOperation,
  CollectionOperation,
  Frame,
  ModuleCode,
  Runtime,
} from './module-abi';
import type {EffectEmission, DenseEmission} from './output';
import {ExecutionError} from './errors';
import type {Heap, HeapTransaction, StorageRef} from './heap';
import {isHistoryOffset} from './ring';
import {CollectionRuntime} from './collections';
import {StructStorageRuntime} from './struct-storage';
import type {
  FrameState,
  Input,
  Intermediate,
  IntermediateFrame,
  IntermediateLocal,
  LocalState,
  RingState,
  RootState,
  State,
  StateMachine,
  StateUpdate,
} from './state-machine';
import type {ValueLayoutRegistry, LayoutId} from './value-layout';
import {
  isArrayValue,
  isMapValue,
  isMatrixValue,
  isStructRef,
  isTupleValue,
  type EffectValue,
  type Value,
} from './value';

const DEFAULT_MAX_COLLECTION_ELEMENTS = 100_000;

export type TeaStateUpdate = StateUpdate<
  State,
  Intermediate,
  Input,
  readonly DenseEmission[],
  EffectEmission,
  ExecutionError
>;

export type TeaStateMachine = StateMachine<
  State,
  Intermediate,
  Input,
  readonly DenseEmission[],
  EffectEmission,
  ExecutionError
>;

export function stateMachine(
  module: ModuleCode,
  params: readonly Value[],
  layouts: ValueLayoutRegistry,
  heap: Heap,
  maxCollectionElements = DEFAULT_MAX_COLLECTION_ELEMENTS,
): TeaStateMachine {
  const structs = new StructStorageRuntime(heap, layouts);
  const collections = new CollectionRuntime(
    heap,
    layouts,
    maxCollectionElements,
    structs,
  );
  return {
    initialState: {
      root: initialRoot(module),
    },
    initialIntermediate: {
      root: initialIntermediateFrame(module, 0, true),
      heap,
    },
    update: stateUpdate(module, params, layouts, structs, collections),
  };
}

function stateUpdate(
  module: ModuleCode,
  params: readonly Value[],
  layouts: ValueLayoutRegistry,
  structs: StructStorageRuntime,
  collections: CollectionRuntime,
): TeaStateUpdate {
  return (state, intermediate, input) =>
    Effect.suspend(() => {
      try {
        return Effect.succeed(
          new SSMRuntime(
            module,
            params,
            layouts,
            state,
            intermediate,
            input,
            structs,
            collections,
          ).run(),
        );
      } catch (error) {
        if (error instanceof ExecutionError) {
          return Effect.fail(error);
        }
        return Effect.die(error);
      }
    });
}

interface WorkspaceLocal {
  readonly state: LocalState;
  readonly intermediate: IntermediateLocal | null;
  value: Value;
  initialized: boolean;
  initialization: Value | null;
}

interface WorkspaceFrame extends Frame {
  readonly kind: 'frame';
  readonly fid: number;
  readonly state: FrameState;
  readonly intermediate: IntermediateFrame;
  readonly locals: WorkspaceLocal[];
  readonly subs: (WorkspaceFrame | null)[];
  active: boolean;
}

class SSMRuntime implements Runtime {
  private readonly rootFrame: WorkspaceFrame;
  private readonly outputs = new Map<number, Value[]>();
  private readonly effects: EffectEmission[] = [];
  private transaction: HeapTransaction | null = null;

  constructor(
    private readonly module: ModuleCode,
    private readonly params: readonly Value[],
    private readonly layouts: ValueLayoutRegistry,
    private readonly state: Readonly<State>,
    private readonly intermediate: Readonly<Intermediate>,
    private readonly input: Input,
    private readonly structs: StructStorageRuntime,
    private readonly collections: CollectionRuntime,
  ) {
    this.validateInput();
    this.rootFrame = this.openFrame(0, state.root, intermediate.root, true);
  }

  run() {
    const transaction = this.intermediate.heap.beginTransaction('state-update');
    this.transaction = transaction;
    let committed = false;
    try {
      this.module.main(this, this.rootFrame);
      const result = {
        state: {root: this.finishRoot()},
        intermediate: {
          root: this.finishIntermediateFrame(this.rootFrame),
          heap: this.intermediate.heap,
        },
        output: [...this.outputs.entries()].map(([outputId, channels]) => ({
          outputId,
          channels,
        })),
        effects: this.effects,
      };
      const roots = this.heapRoots(result.state, result.intermediate);
      transaction.prepareCommit(roots).commit();
      committed = true;
      this.transaction = null;
      this.intermediate.heap.collect(roots);
      return result;
    } catch (error) {
      if (!committed) transaction.abort();
      this.transaction = null;
      throw error;
    }
  }

  series(sid: number, offset: number): number {
    const value = this.inputValue(
      'series',
      sid,
      offset,
      NaN,
      this.module.manifest.series.length,
    );
    if (typeof value !== 'number') {
      return fatal(`series ${sid} produced a non-number value`);
    }
    return value;
  }

  builtin(bid: number, offset: number): Value {
    const spec = this.module.manifest.builtin[bid];
    if (spec === undefined) return fatal(`unknown builtin ${bid}`);
    return this.inputValue(
      'builtins',
      bid,
      offset,
      this.layouts.empty(spec.layout),
      this.module.manifest.builtin.length,
    );
  }

  request(rid: number, offset: number): Value {
    const spec = this.module.manifest.requests[rid];
    if (spec === undefined) return fatal(`unknown request ${rid}`);
    return this.inputValue(
      'requests',
      rid,
      offset,
      this.layouts.empty(spec.layout),
      this.module.manifest.requests.length,
    );
  }

  param(pid: number): Value {
    const value = this.params[pid];
    return value === undefined ? fatal(`unknown parameter ${pid}`) : value;
  }

  root(): Frame {
    return this.rootFrame;
  }

  frame(fr: Frame, slot: number): Frame {
    const parent = fr as WorkspaceFrame;
    const spec = this.frameLayout(parent.fid).subs[slot];
    if (spec === undefined) {
      return fatal(`frame ${parent.fid} has no call-site slot ${slot}`);
    }
    let child = parent.subs[slot];
    if (child === null) {
      const state =
        parent.state.subs[slot] ?? initialFrame(this.module, spec.fid, false);
      const intermediate =
        parent.intermediate.subs[slot] ??
        initialIntermediateFrame(this.module, spec.fid, false);
      child = this.openFrame(spec.fid, state, intermediate, true);
      parent.subs[slot] = child;
    }
    child.active = true;
    return child;
  }

  read(fr: Frame, slot: number, offset: number): Value {
    const frame = fr as WorkspaceFrame;
    const local = frame.locals[slot];
    const spec = this.frameLayout(frame.fid).locals[slot];
    if (local === undefined || spec === undefined) {
      return fatal(`read from unknown frame ${frame.fid} slot ${slot}`);
    }
    const empty = this.layouts.empty(spec.layout);
    if (!isHistoryOffset(offset)) return empty;
    if (offset === 0) return local.value;
    return local.state.ring.values[offset - 1] ?? empty;
  }

  write(fr: Frame, slot: number, value: Value): void {
    const frame = fr as WorkspaceFrame;
    const local = frame.locals[slot];
    const spec = this.frameLayout(frame.fid).locals[slot];
    if (local === undefined || spec === undefined) {
      return fatal(`write to unknown frame ${frame.fid} slot ${slot}`);
    }
    this.layouts.assertValue(spec.layout, value, 'State write');
    local.value = value;
  }

  needsInit(fr: Frame, slot: number): boolean {
    const frame = fr as WorkspaceFrame;
    const local = frame.locals[slot];
    const spec = this.frameLayout(frame.fid).locals[slot];
    if (
      local === undefined ||
      spec === undefined ||
      (spec.storage !== Storage.Var && spec.storage !== Storage.Varip)
    ) {
      return fatal(
        `needsInit requires a persistent slot; frame ${frame.fid} slot ${slot}`,
      );
    }
    return !local.initialized;
  }

  initialize(fr: Frame, slot: number, value: Value): void {
    const frame = fr as WorkspaceFrame;
    const local = frame.locals[slot];
    const spec = this.frameLayout(frame.fid).locals[slot];
    if (
      local === undefined ||
      spec === undefined ||
      (spec.storage !== Storage.Var && spec.storage !== Storage.Varip)
    ) {
      return fatal(
        `initialize requires a persistent slot; frame ${frame.fid} slot ${slot}`,
      );
    }
    if (local.initialized) {
      return fatal(`frame ${frame.fid} slot ${slot} is already initialized`);
    }
    this.layouts.assertValue(spec.layout, value, 'State initialization');
    local.value = value;
    local.initialized = true;
    if (spec.storage === Storage.Var && !local.state.initialized) {
      local.initialization = value;
    }
  }

  emit(oid: number, channel: number, value: Value): void {
    const spec = this.module.manifest.outputs[oid];
    if (spec === undefined || spec.channels[channel] === undefined) {
      return fatal(`emit to unknown output ${oid} channel ${channel}`);
    }
    if (
      isStructRef(value) ||
      isArrayValue(value) ||
      isMatrixValue(value) ||
      isMapValue(value) ||
      isTupleValue(value)
    ) {
      return fatal('aggregate values cannot cross an output channel in V1');
    }
    let channels = this.outputs.get(oid);
    if (channels === undefined) {
      channels = new Array<Value>(spec.channels.length).fill(NaN);
      this.outputs.set(oid, channels);
    }
    channels[channel] = value;
  }

  emitEffect(effectId: number, payload: Value): void {
    if (this.module.manifest.effects[effectId] === undefined) {
      return fatal(`effect emission references unknown effect ${effectId}`);
    }
    if (
      typeof payload !== 'number' &&
      typeof payload !== 'string' &&
      typeof payload !== 'boolean' &&
      payload !== null
    ) {
      return unimplemented('state update: aggregate effect payload', payload);
    }
    this.effects.push({effectId, payload: payload as EffectValue});
  }

  requestFor(_rid: number, _symbol: Value, _timeframe: Value): Value {
    return unimplemented('state update: dynamic request');
  }

  historyDepth(_offset: number): number {
    return unimplemented('state update: bind history depth');
  }

  bindDepth(_fid: number, _slot: number, _bars: number): void {
    unimplemented('state update: bind local depth');
  }

  bindSeriesDepth(_sid: number, _bars: number): void {
    unimplemented('state update: bind series depth');
  }

  bindBuiltinDepth(_bid: number, _bars: number): void {
    unimplemented('state update: bind builtin depth');
  }

  bindOutput(_oid: number, _argName: string, _value: Value): void {
    unimplemented('state update: bind output');
  }

  bindParamActive(_pid: number, _active: Value): void {
    unimplemented('state update: bind parameter active');
  }

  bindRequestOptions(
    _rid: number,
    _gaps: Value,
    _lookahead: Value,
    _ignoreInvalidSymbol: Value,
    _calcBarsCount: Value,
  ): void {
    unimplemented('state update: bind request options');
  }

  bindRequest(_rid: number, _symbol: Value, _timeframe: Value): void {
    unimplemented('state update: bind request');
  }

  newStruct(layout: LayoutId, fields: readonly Value[]): StorageRef<unknown> {
    return this.structs.newStruct(this.mustTransaction(), layout, fields);
  }

  requireStruct(value: Value, layout: LayoutId): StorageRef<unknown> {
    return this.structs.requireStruct(value, layout);
  }

  structField(value: Value, ownerLayout: LayoutId, index: number): Value {
    return this.structs.field(value, ownerLayout, index);
  }

  storeStructField(
    value: Value,
    ownerLayout: LayoutId,
    index: number,
    replacement: Value,
  ): void {
    this.structs.storeField(
      this.mustTransaction(),
      value,
      ownerLayout,
      index,
      replacement,
    );
  }

  callCollection(
    operation: CollectionOperation,
    resultLayout: LayoutId,
    args: readonly Value[],
  ): Value {
    return this.collections.call(
      this.mustTransaction(),
      operation,
      resultLayout,
      args,
    );
  }

  mutateCollection(
    operation: CollectionMutationOperation,
    collectionLayout: LayoutId,
    receiver: Value,
    args: readonly Value[],
  ): CollectionMutation {
    return this.collections.mutate(
      this.mustTransaction(),
      operation,
      collectionLayout,
      receiver,
      args,
    );
  }

  collectionEntries(value: Value): CollectionEntries {
    return this.collections.entries(value);
  }

  private mustTransaction(): HeapTransaction {
    return this.transaction ?? fatal('aggregate operation outside StateUpdate');
  }

  private heapRoots(
    state: State,
    intermediate: Intermediate,
  ): StorageRef<unknown>[] {
    const roots: StorageRef<unknown>[] = [];
    const visit = (layout: LayoutId, value: Value) =>
      this.layouts.visitStorageRefs(layout, value, ref => roots.push(ref));

    state.root.builtins.forEach((ring, bid) => {
      const spec = this.module.manifest.builtin[bid]!;
      ring.values.forEach(value => visit(spec.layout, value));
    });
    state.root.requests.forEach((ring, rid) => {
      const spec = this.module.manifest.requests[rid]!;
      ring.values.forEach(value => visit(spec.layout, value));
    });
    this.visitFrameState(state.root, 0, visit);
    this.visitIntermediateFrame(intermediate.root, 0, visit);
    return roots;
  }

  private visitFrameState(
    frame: FrameState,
    fid: number,
    visit: (layout: LayoutId, value: Value) => void,
  ): void {
    const layout = this.frameLayout(fid);
    frame.locals.forEach((local, slot) => {
      const spec = layout.locals[slot]!;
      local.ring.values.forEach(value => visit(spec.layout, value));
    });
    frame.subs.forEach((sub, slot) => {
      if (sub !== null) {
        this.visitFrameState(sub, layout.subs[slot]!.fid, visit);
      }
    });
  }

  private visitIntermediateFrame(
    frame: IntermediateFrame,
    fid: number,
    visit: (layout: LayoutId, value: Value) => void,
  ): void {
    const layout = this.frameLayout(fid);
    frame.locals.forEach((local, slot) => {
      if (local !== null) visit(layout.locals[slot]!.layout, local.value);
    });
    frame.subs.forEach((sub, slot) => {
      if (sub !== null) {
        this.visitIntermediateFrame(sub, layout.subs[slot]!.fid, visit);
      }
    });
  }

  private validateInput(): void {
    if (this.input.series.length !== this.module.manifest.series.length) {
      throw new ExecutionError(
        'VALUE_LAYOUT_MISMATCH',
        `input has ${this.input.series.length} series values, expected ${this.module.manifest.series.length}`,
      );
    }
    if (this.input.builtins.length !== this.module.manifest.builtin.length) {
      throw new ExecutionError(
        'VALUE_LAYOUT_MISMATCH',
        `input has ${this.input.builtins.length} builtin values, expected ${this.module.manifest.builtin.length}`,
      );
    }
    if (this.input.requests.length !== this.module.manifest.requests.length) {
      throw new ExecutionError(
        'VALUE_LAYOUT_MISMATCH',
        `input has ${this.input.requests.length} request values, expected ${this.module.manifest.requests.length}`,
      );
    }
    this.input.series.forEach((value, sid) => {
      if (typeof value !== 'number') {
        throw new ExecutionError(
          'VALUE_LAYOUT_MISMATCH',
          `series ${sid} is not numeric`,
        );
      }
    });
    this.input.builtins.forEach((value, bid) => {
      this.layouts.assertValue(
        this.module.manifest.builtin[bid]!.layout,
        value,
        `builtin ${bid}`,
      );
    });
    this.input.requests.forEach((value, rid) => {
      this.layouts.assertValue(
        this.module.manifest.requests[rid]!.layout,
        value,
        `request ${rid}`,
      );
    });
  }

  private inputValue(
    field: keyof Input,
    id: number,
    offset: number,
    empty: Value,
    count: number,
  ): Value {
    if (!Number.isSafeInteger(id) || id < 0 || id >= count) {
      return fatal(`unknown ${field} input ${id}`);
    }
    if (!isHistoryOffset(offset)) return empty;
    if (offset === 0) return this.input[field][id] ?? empty;
    return this.state.root[field][id]?.values[offset - 1] ?? empty;
  }

  private openFrame(
    fid: number,
    state: FrameState,
    intermediate: IntermediateFrame,
    active: boolean,
  ): WorkspaceFrame {
    const layout = this.frameLayout(fid);
    if (
      state.locals.length !== layout.locals.length ||
      state.subs.length !== layout.subs.length ||
      intermediate.locals.length !== layout.locals.length ||
      intermediate.subs.length !== layout.subs.length
    ) {
      return fatal(`state topology disagrees with frame ${fid}`);
    }
    return {
      kind: 'frame',
      fid,
      state,
      intermediate,
      active: active || state.active || intermediate.active,
      locals: layout.locals.map((spec, slot) => {
        const local = state.locals[slot]!;
        const current = intermediate.locals[slot];
        const persistent =
          spec.storage === Storage.Var || spec.storage === Storage.Varip;
        return {
          state: local,
          intermediate: current,
          value:
            spec.storage === Storage.Varip && current !== null
              ? current.value
              : spec.storage === Storage.Var && local.initialized
                ? (local.ring.values[0] ?? this.layouts.empty(spec.layout))
                : spec.storage === Storage.Var && current !== null
                  ? current.value
                  : this.layouts.empty(spec.layout),
          initialized:
            current?.initialized ?? (persistent && local.initialized),
          initialization:
            spec.storage === Storage.Var && !local.initialized
              ? (current?.value ?? null)
              : null,
        };
      }),
      subs: layout.subs.map(() => null),
    };
  }

  private finishFrame(frame: WorkspaceFrame): FrameState {
    const layout = this.frameLayout(frame.fid);
    return {
      active: frame.active,
      locals: frame.locals.map((local, slot) => {
        const spec = layout.locals[slot]!;
        const keep = localRetention(spec.storage, spec.depth);
        return {
          ring: commitRing(local.state.ring, local.value, keep),
          initialized:
            (spec.storage === Storage.Var || spec.storage === Storage.Varip) &&
            local.initialized,
        };
      }),
      subs: frame.subs.map((sub, slot) =>
        sub === null ? (frame.state.subs[slot] ?? null) : this.finishFrame(sub),
      ),
    };
  }

  private finishRoot(): RootState {
    const frame = this.finishFrame(this.rootFrame);
    return {
      ...frame,
      series: this.finishInputRings(
        'series',
        this.state.root.series,
        this.module.manifest.series,
      ),
      builtins: this.finishInputRings(
        'builtins',
        this.state.root.builtins,
        this.module.manifest.builtin,
      ),
      requests: this.finishInputRings(
        'requests',
        this.state.root.requests,
        this.module.manifest.requests,
      ),
    };
  }

  private finishInputRings(
    field: keyof Input,
    rings: readonly RingState[],
    specs: readonly {readonly depth: Parameters<typeof depthRetention>[0]}[],
  ): readonly RingState[] {
    if (rings.length !== specs.length) {
      return fatal(`${field} ring topology disagrees with the manifest`);
    }
    return rings.map((ring, id) =>
      commitRing(
        ring,
        this.input[field][id]!,
        depthRetention(specs[id]!.depth),
      ),
    );
  }

  private finishIntermediateFrame(frame: WorkspaceFrame): IntermediateFrame {
    const layout = this.frameLayout(frame.fid);
    return {
      active: frame.active,
      locals: frame.locals.map((local, slot) => {
        const spec = layout.locals[slot]!;
        if (
          spec.storage === Storage.Varip ||
          (spec.storage === Storage.Var &&
            !local.state.initialized &&
            local.initialization !== null)
        ) {
          return {
            value:
              spec.storage === Storage.Varip
                ? local.value
                : local.initialization!,
            initialized: local.initialized,
          };
        }
        return null;
      }),
      subs: frame.subs.map((sub, slot) =>
        sub === null
          ? (frame.intermediate.subs[slot] ?? null)
          : this.finishIntermediateFrame(sub),
      ),
    };
  }

  private frameLayout(fid: number) {
    const layout = this.module.manifest.frames[fid];
    return layout === undefined ? fatal(`unknown frame layout ${fid}`) : layout;
  }
}

function initialFrame(
  module: ModuleCode,
  fid: number,
  active: boolean,
): FrameState {
  const layout = module.manifest.frames[fid];
  if (layout === undefined) return fatal(`unknown frame layout ${fid}`);
  return {
    active,
    locals: layout.locals.map(() => ({
      ring: {values: []},
      initialized: false,
    })),
    subs: layout.subs.map(() => null),
  };
}

function initialRoot(module: ModuleCode): RootState {
  return {
    ...initialFrame(module, 0, true),
    series: module.manifest.series.map(() => ({values: []})),
    builtins: module.manifest.builtin.map(() => ({values: []})),
    requests: module.manifest.requests.map(() => ({values: []})),
  };
}

function initialIntermediateFrame(
  module: ModuleCode,
  fid: number,
  active: boolean,
): IntermediateFrame {
  const layout = module.manifest.frames[fid];
  if (layout === undefined) return fatal(`unknown frame layout ${fid}`);
  return {
    active,
    locals: layout.locals.map(() => null),
    subs: layout.subs.map(() => null),
  };
}

function localRetention(
  storage: string,
  depth: Parameters<typeof depthRetention>[0],
): number {
  const keep = depthRetention(depth);
  return storage === Storage.Var || storage === Storage.Varip
    ? Math.max(1, keep)
    : keep;
}

function commitRing(ring: RingState, value: Value, keep: number): RingState {
  return {
    values: keep === 0 ? [] : [value, ...ring.values].slice(0, keep),
  };
}

function depthRetention(
  depth: ModuleCode['manifest']['series'][number]['depth'],
) {
  switch (depth.kind) {
    case 'none':
      return 0;
    case 'const':
    case 'capped':
      return isHistoryOffset(depth.bars) ? depth.bars : 0;
    case 'bound':
      return unimplemented('state update: bound history depth');
  }
}
