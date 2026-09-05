// Purpose: Execute one generated JSModule invocation as an Effect state
// transition over explicit committed State, Intermediate, and StepInput values.

import {Effect} from 'effect';
import {Storage} from '../../ir/node';
import {DataType, type Field} from 'apache-arrow';
import {fatal} from '../../base/print';
import {unimplemented} from '../../base/unimplemented';
import {
  isHistoryOffset,
  type CollectionEntries,
  type CollectionMutation,
  type CollectionMutationOperation,
  type CollectionOperation,
  type Frame,
  type JSModule,
  type RuntimeContext,
} from '../module-abi';
import type {EffectEmission, DenseEmission} from '../output';
import {ExecutionError} from '../errors';
import type {Heap, HeapTransaction, Ref} from './heap';
import {CollectionRuntime} from './collections';
import {StructStorageRuntime} from './struct-storage';
import type {
  FrameState,
  Intermediate,
  IntermediateFrame,
  IntermediateLocal,
  LocalState,
  HistoryState,
  RootState,
  State,
  StateMachine,
  StateUpdate,
  StepInput,
} from './state-machine';
import type {ValueLayoutRegistry, LayoutId} from '../value-layout';
import {
  isArrayValue,
  isMapValue,
  isMatrixValue,
  isStructRef,
  isTupleValue,
  type Value,
} from '../value';

const DEFAULT_MAX_COLLECTION_ELEMENTS = 100_000;

export type TeaStateUpdate = StateUpdate<
  State,
  Intermediate,
  StepInput,
  readonly DenseEmission[],
  EffectEmission,
  ExecutionError
>;

export type TeaStateMachine = StateMachine<
  State,
  Intermediate,
  StepInput,
  readonly DenseEmission[],
  EffectEmission,
  ExecutionError
>;

export function stateMachine(
  module: JSModule,
  layouts: ValueLayoutRegistry,
  heap: Heap,
  maxCollectionElements = DEFAULT_MAX_COLLECTION_ELEMENTS,
): TeaStateMachine {
  validateIoSchemas(module, layouts);
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
    },
    update: stateUpdate(module, layouts, heap, structs, collections),
  };
}

function stateUpdate(
  module: JSModule,
  layouts: ValueLayoutRegistry,
  heap: Heap,
  structs: StructStorageRuntime,
  collections: CollectionRuntime,
): TeaStateUpdate {
  return (state, intermediate, input) =>
    Effect.suspend(() => {
      try {
        // Collection is legal only at the transition boundary, before a new
        // transaction begins. The supplied State and Intermediate are the
        // owner's actual retained values; a candidate produced by this update
        // may still be rejected by a provisional step.
        heap.replaceRoots(
          discoverRoots(module, layouts, structs, state, intermediate),
        );
        heap.collect();
        return Effect.succeed(
          new RuntimeOperations(
            module,
            layouts,
            heap,
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

class RuntimeOperations implements RuntimeContext {
  private readonly rootFrame: WorkspaceFrame;
  private readonly outputs = new Map<number, unknown[]>();
  private readonly effects: EffectEmission[] = [];
  private transaction: HeapTransaction | null = null;
  private requestValues: readonly Value[] = [];

  constructor(
    private readonly module: JSModule,
    private readonly layouts: ValueLayoutRegistry,
    private readonly heap: Heap,
    private readonly state: Readonly<State>,
    private readonly intermediate: Readonly<Intermediate>,
    private readonly input: StepInput,
    private readonly structs: StructStorageRuntime,
    private readonly collections: CollectionRuntime,
  ) {
    this.validateInput();
    this.rootFrame = this.openFrame(0, state.root, intermediate.root, true);
  }

  run() {
    const transaction = this.heap.begin('state-update');
    this.transaction = transaction;
    let committed = false;
    try {
      this.requestValues = this.input.requests.map((value, rid) => {
        const spec = this.module.manifest.requests[rid]!;
        return spec.merge.mode === 'sample'
          ? value
          : this.collections.call(
              transaction,
              'array.from',
              spec.layout,
              value as readonly Value[],
            );
      });
      this.module.main(this, this.rootFrame);
      const result = {
        state: {root: this.finishRoot()},
        intermediate: {
          root: this.finishIntermediateFrame(this.rootFrame),
        },
        rootValues: this.rootFrame.locals.map(local => local.value),
        output: [...this.outputs.entries()].map(([outputId, channels]) => ({
          outputId,
          channels,
        })),
        effects: this.effects,
      };
      transaction.commit();
      committed = true;
      this.transaction = null;
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
    if (!Number.isFinite(value) && !Number.isNaN(value)) {
      return fatal(`input series ${sid} returned a non-finite value`);
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
    const parameter = this.module.manifest.params[pid];
    if (parameter === undefined || !Object.hasOwn(parameter, 'value')) {
      return fatal(`unknown parameter ${pid}`);
    }
    return parameter.value as Value;
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
    return local.state.history.values[offset - 1] ?? empty;
  }

  write(fr: Frame, slot: number, value: Value): void {
    const frame = fr as WorkspaceFrame;
    const local = frame.locals[slot];
    const spec = this.frameLayout(frame.fid).locals[slot];
    if (local === undefined || spec === undefined) {
      return fatal(`write to unknown frame ${frame.fid} slot ${slot}`);
    }
    this.structs.assertValue(
      spec.layout,
      value,
      'State write',
      this.mustTransaction(),
    );
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
    this.structs.assertValue(
      spec.layout,
      value,
      'State initialization',
      this.mustTransaction(),
    );
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
    let channels = this.outputs.get(oid);
    if (channels === undefined) {
      channels = spec.channels.map(field =>
        field.nullable ? null : DataType.isBool(field.type) ? false : NaN,
      );
      this.outputs.set(oid, channels);
    }
    channels[channel] = this.snapshot(
      spec.layouts[channel],
      spec.channels[channel],
      value,
    );
  }

  emitEffect(effectId: number, payload: Value): void {
    const spec = this.module.manifest.effects[effectId];
    if (spec === undefined) {
      return fatal(`effect emission references unknown effect ${effectId}`);
    }
    const transaction = this.mustTransaction();
    this.structs.assertValue(
      spec.layout,
      payload,
      `effect ${effectId} payload`,
      transaction,
    );
    this.effects.push({
      effectId,
      payload: this.snapshot(spec.layout, spec.declaration.payload, payload),
    });
  }

  // Copy at the emission, not at the end of the step: later mutation must not
  // change an earlier event. Arrow fields describe the detached result while
  // runtime layouts locate the live values in the Heap.
  private snapshot(
    layoutId: LayoutId,
    field: Field,
    value: Value,
    active?: Set<object>,
  ): unknown {
    const transaction = this.mustTransaction();
    if (layoutId === -1)
      return value === null
        ? null
        : Object.freeze({kind: field.metadata.get('tea:name'), id: value});
    this.structs.assertValue(layoutId, value, 'output payload', transaction);
    if (value === null) {
      if (!field.nullable)
        throw new ExecutionError(
          'VALUE_LAYOUT_MISMATCH',
          'null output in a required Arrow field',
        );
      return null;
    }
    const layout = this.layouts.layout(layoutId);
    if (typeof value !== 'object') return value;
    active ??= new Set<object>();
    if (active.has(value))
      throw new ExecutionError(
        'VALUE_LAYOUT_MISMATCH',
        'cyclic output payload',
      );
    active.add(value);
    const copy = (id: LayoutId, child: Field, item: Value) =>
      this.snapshot(id, child, item, active);
    let result: unknown;
    switch (layout.kind) {
      case 'struct':
        result = Object.freeze(
          Object.fromEntries(
            layout.fields.map((member, i) => [
              member.name,
              copy(
                member.layout,
                field.type.children[i],
                this.structs.field(value, layoutId, i, transaction),
              ),
            ]),
          ),
        );
        break;
      case 'tuple':
        if (!isTupleValue(value)) return fatal('invalid output tuple');
        result = Object.freeze(
          Object.fromEntries(
            layout.elements.map((id, i) => [
              field.type.children[i].name,
              copy(id, field.type.children[i], value[i]),
            ]),
          ),
        );
        break;
      case 'array':
        if (!isArrayValue(value)) return fatal('invalid output array');
        result = Object.freeze(
          transaction
            .read(value.storage)
            .values.map(item =>
              copy(layout.element, field.type.children[0], item),
            ),
        );
        break;
      case 'matrix':
        if (!isMatrixValue(value)) return fatal('invalid output matrix');
        result = Object.freeze({
          rows: value.rows,
          columns: value.columns,
          values: Object.freeze(
            transaction
              .read(value.storage)
              .values.map(item =>
                copy(
                  layout.element,
                  field.type.children[2].type.children[0],
                  item,
                ),
              ),
          ),
        });
        break;
      case 'map': {
        if (!isMapValue(value)) return fatal('invalid output map');
        const [key, item] = field.type.children[0].type.children;
        result = new Map(
          transaction
            .read(value.storage)
            .entries.map(entry => [
              copy(layout.key, key, entry.key),
              copy(layout.value, item, entry.value),
            ]),
        );
        break;
      }
      case 'resource':
        result = Object.freeze({
          kind: layout.handle,
          id: (value as {id: number}).id,
        });
        break;
      default:
        return fatal('invalid output carrier');
    }
    active.delete(value);
    return result;
  }

  newStruct(layout: LayoutId, fields: readonly Value[]): Ref<unknown> {
    return this.structs.newStruct(this.mustTransaction(), layout, fields);
  }

  requireStruct(value: Value, layout: LayoutId): Ref<unknown> {
    return this.structs.requireStruct(value, layout, this.mustTransaction());
  }

  structField(value: Value, ownerLayout: LayoutId, index: number): Value {
    return this.structs.field(
      value,
      ownerLayout,
      index,
      this.mustTransaction(),
    );
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
    return this.collections.entries(value, this.mustTransaction());
  }

  private mustTransaction(): HeapTransaction {
    return (
      this.transaction ??
      fatal('struct or collection operation outside StateUpdate')
    );
  }

  private validateInput(): void {
    if (this.input.series.length !== this.module.manifest.series.length) {
      throw new ExecutionError(
        'VALUE_LAYOUT_MISMATCH',
        `step input has ${this.input.series.length} series values, expected ${this.module.manifest.series.length}`,
      );
    }
    if (this.input.builtins.length !== this.module.manifest.builtin.length) {
      throw new ExecutionError(
        'VALUE_LAYOUT_MISMATCH',
        `step input has ${this.input.builtins.length} builtin values, expected ${this.module.manifest.builtin.length}`,
      );
    }
    if (this.input.requests.length !== this.module.manifest.requests.length) {
      throw new ExecutionError(
        'VALUE_LAYOUT_MISMATCH',
        `step input has ${this.input.requests.length} request values, expected ${this.module.manifest.requests.length}`,
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
      this.structs.assertValue(
        this.module.manifest.builtin[bid]!.layout,
        value,
        `builtin ${bid}`,
      );
    });
    this.input.requests.forEach((value, rid) => {
      const spec = this.module.manifest.requests[rid]!;
      if (spec.merge.mode === 'sample') {
        this.structs.assertValue(spec.layout, value, `request ${rid}`);
        return;
      }
      if (!Array.isArray(value)) {
        throw new ExecutionError(
          'VALUE_LAYOUT_MISMATCH',
          `request ${rid} collect input is not an array`,
        );
      }
      const layout = this.layouts.layout(spec.layout);
      if (layout.kind !== 'array' || layout.element !== spec.resultLayout) {
        throw new ExecutionError(
          'VALUE_LAYOUT_MISMATCH',
          `request ${rid} collect layout does not match its result layout`,
        );
      }
      value.forEach((element, index) =>
        this.structs.assertValue(
          spec.resultLayout,
          element,
          `request ${rid} element ${index}`,
        ),
      );
    });
  }

  private inputValue(
    field: 'series' | 'builtins' | 'requests',
    id: number,
    offset: number,
    empty: Value,
    count: number,
  ): Value {
    if (!Number.isSafeInteger(id) || id < 0 || id >= count) {
      return fatal(`unknown ${field} input ${id}`);
    }
    if (!isHistoryOffset(offset)) return empty;
    if (offset === 0) {
      const values =
        field === 'requests' ? this.requestValues : this.input[field];
      return values[id] ?? empty;
    }
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
                ? (local.history.values[0] ?? this.layouts.empty(spec.layout))
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
          history: commitHistory(local.state.history, local.value, keep),
          initialized:
            (spec.storage === Storage.Var || spec.storage === Storage.Varip) &&
            local.initialized,
        };
      }),
      subs: frame.subs.map((sub, slot) => {
        if (sub !== null) return this.finishFrame(sub);
        const state = frame.state.subs[slot] ?? null;
        const intermediate = frame.intermediate.subs[slot] ?? null;
        if (!state?.active && !intermediate?.active) return state;
        const spec = layout.subs[slot]!;
        const skipped = this.openFrame(
          spec.fid,
          state ?? initialFrame(this.module, spec.fid, false),
          intermediate ??
            initialIntermediateFrame(this.module, spec.fid, false),
          false,
        );
        frame.subs[slot] = skipped;
        return this.finishFrame(skipped);
      }),
    };
  }

  private finishRoot(): RootState {
    const frame = this.finishFrame(this.rootFrame);
    return {
      ...frame,
      series: this.finishInputHistory(
        'series',
        this.state.root.series,
        this.module.manifest.series,
      ),
      builtins: this.finishInputHistory(
        'builtins',
        this.state.root.builtins,
        this.module.manifest.builtin,
      ),
      requests: this.finishInputHistory(
        'requests',
        this.state.root.requests,
        this.module.manifest.requests,
      ),
    };
  }

  private finishInputHistory(
    field: 'series' | 'builtins' | 'requests',
    histories: readonly HistoryState[],
    specs: readonly {readonly depth: Parameters<typeof depthRetention>[0]}[],
  ): readonly HistoryState[] {
    if (histories.length !== specs.length) {
      return fatal(`${field} history topology disagrees with the manifest`);
    }
    return histories.map((history, id) =>
      commitHistory(
        history,
        (field === 'requests' ? this.requestValues : this.input[field])[id]!,
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
  module: JSModule,
  fid: number,
  active: boolean,
): FrameState {
  const layout = module.manifest.frames[fid];
  if (layout === undefined) return fatal(`unknown frame layout ${fid}`);
  return {
    active,
    locals: layout.locals.map(() => ({
      history: {values: []},
      initialized: false,
    })),
    subs: layout.subs.map(() => null),
  };
}

function initialRoot(module: JSModule): RootState {
  return {
    ...initialFrame(module, 0, true),
    series: module.manifest.series.map(() => ({values: []})),
    builtins: module.manifest.builtin.map(() => ({values: []})),
    requests: module.manifest.requests.map(() => ({values: []})),
  };
}

function initialIntermediateFrame(
  module: JSModule,
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

function commitHistory(
  history: HistoryState,
  value: Value,
  keep: number,
): HistoryState {
  return {
    values: keep === 0 ? [] : [value, ...history.values].slice(0, keep),
  };
}

function depthRetention(
  depth: JSModule['manifest']['series'][number]['depth'],
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

function discoverRoots(
  module: JSModule,
  layouts: ValueLayoutRegistry,
  structs: StructStorageRuntime,
  state: Readonly<State>,
  intermediate: Readonly<Intermediate>,
): Ref<unknown>[] {
  const roots: Ref<unknown>[] = [];
  const visit = (layout: LayoutId, value: Value) => {
    structs.assertValue(layout, value, 'StateMachine retained value');
    layouts.visitRefs(layout, value, ref => roots.push(ref));
  };

  state.root.builtins.forEach((ring, bid) => {
    const spec = module.manifest.builtin[bid]!;
    ring.values.forEach(value => visit(spec.layout, value));
  });
  state.root.requests.forEach((ring, rid) => {
    const spec = module.manifest.requests[rid]!;
    ring.values.forEach(value => visit(spec.layout, value));
  });
  visitFrameState(module, state.root, 0, visit);
  visitIntermediateFrame(module, intermediate.root, 0, visit);
  return roots;
}

function visitFrameState(
  module: JSModule,
  frame: Readonly<FrameState>,
  fid: number,
  visit: (layout: LayoutId, value: Value) => void,
): void {
  const layout = frameLayout(module, fid);
  frame.locals.forEach((local, slot) => {
    const spec = layout.locals[slot]!;
    local.history.values.forEach(value => visit(spec.layout, value));
  });
  frame.subs.forEach((sub, slot) => {
    if (sub !== null) {
      visitFrameState(module, sub, layout.subs[slot]!.fid, visit);
    }
  });
}

function visitIntermediateFrame(
  module: JSModule,
  frame: Readonly<IntermediateFrame>,
  fid: number,
  visit: (layout: LayoutId, value: Value) => void,
): void {
  const layout = frameLayout(module, fid);
  frame.locals.forEach((local, slot) => {
    if (local !== null) visit(layout.locals[slot]!.layout, local.value);
  });
  frame.subs.forEach((sub, slot) => {
    if (sub !== null) {
      visitIntermediateFrame(module, sub, layout.subs[slot]!.fid, visit);
    }
  });
}

function frameLayout(module: JSModule, fid: number) {
  const layout = module.manifest.frames[fid];
  return layout === undefined ? fatal(`unknown frame layout ${fid}`) : layout;
}

function validateIoSchemas(
  module: JSModule,
  layouts: ValueLayoutRegistry,
): void {
  const active = new Set<number>();
  const validate = (id: number, field: Field): void => {
    if (id === -1 && field.metadata.get('tea:type') === 'output-ref') return;
    if (active.has(id)) return fatal('recursive output schema');
    active.add(id);
    const layout = layouts.layout(id);
    const type = field.type;
    const kind = field.metadata.get('tea:type');
    const bad = () =>
      fatal(`output layout ${id} disagrees with Arrow field '${field.name}'`);
    switch (layout.kind) {
      case 'number':
        if (
          !DataType.isFloat(type) ||
          (kind !== undefined && kind !== layout.numeric)
        )
          bad();
        break;
      case 'boolean':
        if (!DataType.isBool(type)) bad();
        break;
      case 'nullable-scalar':
        if (
          !DataType.isUtf8(type) ||
          (kind !== undefined && kind !== layout.scalar)
        )
          bad();
        break;
      case 'enum':
        if (
          !DataType.isUtf8(type) ||
          field.metadata.get('tea:typeId') !== layout.typeId ||
          field.metadata.get('tea:name') !== layout.name ||
          JSON.stringify(
            (
              JSON.parse(field.metadata.get('tea:members') ?? '[]') as {
                name: string;
              }[]
            ).map(member => member.name),
          ) !== JSON.stringify(layout.members)
        )
          bad();
        break;
      case 'struct':
        if (
          !DataType.isStruct(type) ||
          type.children.length !== layout.fields.length ||
          field.metadata.get('tea:typeId') !== layout.typeId ||
          field.metadata.get('tea:name') !== layout.name
        )
          bad();
        layout.fields.forEach((member, i) => {
          if (type.children[i]?.name !== member.name) bad();
          validate(member.layout, type.children[i]);
        });
        break;
      case 'tuple':
        if (
          !DataType.isStruct(type) ||
          type.children.length !== layout.elements.length
        )
          bad();
        layout.elements.forEach((child, i) =>
          validate(child, type.children[i]),
        );
        break;
      case 'array':
        if (!DataType.isList(type)) bad();
        validate(layout.element, type.children[0]);
        break;
      case 'matrix':
        if (
          !DataType.isStruct(type) ||
          type.children.length !== 3 ||
          !DataType.isList(type.children[2].type)
        )
          bad();
        validate(layout.element, type.children[2].type.children[0]);
        break;
      case 'map':
        if (!DataType.isMap(type)) bad();
        validate(layout.key, type.children[0].type.children[0]);
        validate(layout.value, type.children[0].type.children[1]);
        break;
      case 'resource':
        if (
          !DataType.isStruct(type) ||
          field.metadata.get('tea:name') !== layout.handle
        )
          bad();
        break;
    }
    active.delete(id);
  };
  module.manifest.outputs.forEach(output => {
    if (output.layouts.length !== output.channels.length)
      fatal('output descriptor count disagrees with Arrow schema');
    output.channels.forEach((field, i) => validate(output.layouts[i], field));
  });
  module.manifest.effects.forEach(effect =>
    validate(effect.layout, effect.declaration.payload),
  );
}
