import type {Module} from '../module-binding';
// Purpose: One atomic execution attempt over retained history and intermediate values.

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
  type Depth,
} from '../module-abi';
import {outputFields} from '../output';
import {ExecutionError} from '../errors';
import {Color} from '../color';
import type {Heap, HeapTransaction, Ref} from './heap';
import {CollectionRuntime} from './collections';
import {StructStorageRuntime} from './struct-storage';
import {Value, unwrap} from './value';
import {validateValue} from '../io';
import {
  isArrayValue,
  isMapValue,
  isMatrixValue,
  isStructRef,
  isTupleValue,
  visitValueRefs,
  type Stored,
} from '../value';

/** One synchronized external update passed to Context.step(). */
export interface StepInput {
  readonly series: readonly Stored[];
  readonly builtins: readonly Stored[];
  readonly requests: readonly (Stored | readonly Stored[])[];
  readonly provisional: boolean;
}

/** Committed local/call state plus the root's synchronized input histories. */
export interface RootState extends FrameState {
  readonly series: readonly (readonly Stored[])[];
  readonly builtins: readonly (readonly Stored[])[];
  readonly requests: readonly (readonly Stored[])[];
}

/**
 * Retained state of one written call. `fid` selects its static definition;
 * separate calls can share that definition while retaining different histories.
 * `active` records whether the call has ever executed, so skipped calls still
 * advance their histories on a final step.
 * @example Two calls to an accumulator share a fid but each retains its own total.
 */
export interface FrameState {
  readonly fid: number;
  readonly active: boolean;
  readonly locals: readonly LocalState[];
  readonly subs: readonly (FrameState | null)[];
}

/** A binding's committed newest-first history and persistent initialization flag. */
export interface LocalState {
  readonly history: readonly Stored[];
  readonly initialized: boolean;
}

/**
 * Accepted values carried between provisional attempts: varip values and the
 * first initializer of a var whose row has not committed yet.
 * @example A provisional `varip total += 1` starts the next attempt from that sum.
 */
export interface IntermediateState {
  readonly active: boolean;
  readonly locals: readonly (IntermediateLocal | null)[];
  readonly subs: readonly (IntermediateState | null)[];
}

export interface IntermediateLocal {
  readonly value: Stored;
  readonly initialized: boolean;
}

/**
 * One transaction attempt. Local writes are keyed by retained binding identity;
 * reads consult this write set before persistence rules and committed history.
 * Called frames open lazily. No mutable copy of the state tree is constructed.
 *
 * Outputs and next histories are prepared before the sole Heap commit. A failed
 * attempt discards these maps and buffered outputs; Context adopts the prepared
 * histories only after success.
 * @example Writing total from 10 to 12 makes later reads return 12 while a failed
 * attempt leaves the retained total at 10.
 */
export class Step {
  readonly rootFrame: FrameState;
  private readonly writes = new Map<
    LocalState,
    {
      value: Stored;
      initialized: boolean;
      /** undefined is absent; null is a valid first-var initializer. */
      initialValue: Stored | undefined;
    }
  >();
  private readonly opened = new Map<FrameState, IntermediateState>();
  private readonly children = new Map<FrameState, Map<number, FrameState>>();
  private readonly activated = new Set<FrameState>();
  private readonly fields: readonly Field[];
  private readonly outputs: unknown[];
  private readonly written = new Set<number>();
  private transaction: HeapTransaction | null = null;
  private requestValues: readonly Stored[] = [];

  constructor(
    private readonly module: Module,
    private readonly heap: Heap,
    private readonly state: Readonly<RootState>,
    private readonly intermediate: Readonly<IntermediateState>,
    private readonly input: StepInput,
    private readonly structs: StructStorageRuntime,
    private readonly collections: CollectionRuntime,
  ) {
    this.input = {
      ...input,
      builtins: input.builtins.map((value, id) => {
        const spec = module.inputs.builtins[id];
        return spec?.constant && Object.hasOwn(spec, 'value')
          ? spec.value!
          : value;
      }),
    };
    this.fields = outputFields(module.outputs.schema);
    this.outputs = this.fields.map(field =>
      field.metadata.get('tea:write') === 'append' ? [] : null,
    );
    this.validateInput();
    this.rootFrame = this.openFrame(state, intermediate, true);
  }

  run(main: () => void) {
    using transaction = this.heap.begin('state-update');
    this.transaction = transaction;
    try {
      this.requestValues = this.input.requests.map((value, rid) => {
        const spec = this.module.requests[rid]!;
        return spec.mode === 'sample'
          ? (value as Stored)
          : (this.collections.call(
              transaction,
              'array.from',
              spec.empty,
              (value as readonly unknown[]).map(item =>
                spec.resultEmpty.withStored(
                  item instanceof Value ? unwrap(item) : (item as Stored),
                ),
              ),
            ).value as Stored);
      });
      main();
      const result = {
        state: this.finishRoot(),
        intermediate: this.finishIntermediateState(this.rootFrame),
        rootValues: this.rootFrame.locals.map((_, slot) =>
          this.current(this.rootFrame, slot),
        ),
        output: Object.freeze(
          this.outputs.map(value =>
            typeof value === 'object' && value !== null
              ? Object.freeze(value)
              : value,
          ),
        ),
      };
      transaction.commit();
      this.transaction = null;
      return result;
    } finally {
      this.transaction = null;
    }
  }

  series(sid: number, offset: number): number {
    const value = this.inputValue(
      'series',
      sid,
      offset,
      NaN,
      this.module.inputs.series.length,
    );
    if (typeof value !== 'number') {
      return fatal(`series ${sid} produced a non-number value`);
    }
    if (!Number.isFinite(value) && !Number.isNaN(value)) {
      return fatal(`input series ${sid} returned a non-finite value`);
    }
    return value;
  }

  builtin(bid: number, offset: number): Stored {
    const spec = this.module.inputs.builtins[bid];
    if (spec === undefined) return fatal(`unknown builtin ${bid}`);
    return this.inputValue(
      'builtins',
      bid,
      offset,
      spec.empty.value as Stored,
      this.module.inputs.builtins.length,
    );
  }

  request(rid: number, offset: number): Stored {
    const spec = this.module.requests[rid];
    if (spec === undefined) return fatal(`unknown request ${rid}`);
    return this.inputValue(
      'requests',
      rid,
      offset,
      spec.empty.value as Stored,
      this.module.requests.length,
    );
  }

  param(pid: number): Stored {
    const parameter = this.module.parameters[pid];
    if (parameter === undefined || !Object.hasOwn(parameter, 'value')) {
      return fatal(`unknown parameter ${pid}`);
    }
    return parameter.value as Stored;
  }

  root(): FrameState {
    return this.rootFrame;
  }

  frame(parent: FrameState, slot: number): FrameState {
    return this.openChild(parent, slot, true);
  }

  private openChild(
    parent: FrameState,
    slot: number,
    activate: boolean,
  ): FrameState {
    const spec = this.frameLayout(parent.fid).subs[slot];
    if (spec === undefined) {
      return fatal(`frame ${parent.fid} has no call-site slot ${slot}`);
    }
    let siblings = this.children.get(parent);
    let child = siblings?.get(slot);
    if (child === undefined) {
      const state =
        parent.subs[slot] ?? initialFrame(this.module, spec.fid, false);
      const intermediate =
        this.carry(parent).subs[slot] ??
        initialIntermediateState(this.module, spec.fid, false);
      child = this.openFrame(state, intermediate, activate);
      if (!siblings) this.children.set(parent, (siblings = new Map()));
      siblings.set(slot, child);
    }
    if (activate) this.activated.add(child);
    return child;
  }

  read(frame: FrameState, slot: number, offset: number): Stored {
    const local = frame.locals[slot];
    const spec = this.frameLayout(frame.fid).locals[slot];
    if (local === undefined || spec === undefined) {
      return fatal(`read from unknown frame ${frame.fid} slot ${slot}`);
    }
    const empty = spec.empty.value as Stored;
    if (!isHistoryOffset(offset)) return empty;
    if (offset === 0) return this.current(frame, slot);
    return local.history[offset - 1] ?? empty;
  }

  write(frame: FrameState, slot: number, value: Value<unknown>): void {
    const local = frame.locals[slot];
    const spec = this.frameLayout(frame.fid).locals[slot];
    if (local === undefined || spec === undefined) {
      return fatal(`write to unknown frame ${frame.fid} slot ${slot}`);
    }
    if (!spec.empty.sameType(value))
      throw new ExecutionError(
        'VALUE_LAYOUT_MISMATCH',
        'state write has a different type',
      );
    spec.empty.assertStored(unwrap(value), this.mustTransaction());
    const pending = this.writes.get(local);
    if (pending) pending.value = unwrap(value);
    else
      this.writes.set(local, {
        value: unwrap(value),
        initialized: this.initialized(frame, slot),
        initialValue: this.initialValue(frame, slot),
      });
  }

  needsInit(frame: FrameState, slot: number): boolean {
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
    return !this.initialized(frame, slot);
  }

  initialize(frame: FrameState, slot: number, value: Value<unknown>): void {
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
    if (this.initialized(frame, slot)) {
      return fatal(`frame ${frame.fid} slot ${slot} is already initialized`);
    }
    if (!spec.empty.sameType(value))
      throw new ExecutionError(
        'VALUE_LAYOUT_MISMATCH',
        'initializer has a different type',
      );
    spec.empty.assertStored(unwrap(value), this.mustTransaction());
    this.writes.set(local, {
      value: unwrap(value),
      initialized: true,
      initialValue:
        spec.storage === Storage.Var && !local.initialized
          ? unwrap(value)
          : undefined,
    });
  }

  emit(output: number, value: Value<unknown>): void {
    const field = this.fields[output];
    if (field?.metadata.get('tea:write') !== 'set')
      return fatal(`unknown set output ${output}`);
    if (this.written.has(output))
      return fatal(`duplicate emit to output '${field.name}'`);
    const detached = this.snapshot(field, value);
    validateValue(field, detached);
    this.written.add(output);
    this.outputs[output] = detached;
  }

  append(output: number, payload: Value<unknown>): void {
    const field = this.fields[output];
    if (field?.metadata.get('tea:write') !== 'append')
      return fatal(`unknown append output ${output}`);
    const value = this.snapshot(field.type.children[0], payload);
    validateValue(field.type.children[0], value);
    (this.outputs[output] as unknown[]).push(value);
  }

  /** Detach through the sole Arrow schema at the moment of emission. */
  private snapshot(
    field: Field,
    item: Stored | Value<unknown>,
    active = new Set<object>(),
  ): unknown {
    const value = item instanceof Value ? unwrap(item) : item;
    const bad = (): never => {
      throw new ExecutionError(
        'VALUE_LAYOUT_MISMATCH',
        `output '${field.name}' does not match its Arrow field`,
      );
    };
    if (value === null) {
      if (!field.nullable) bad();
      return null;
    }
    const expected = field.metadata.get('tea:typeId');
    if (expected && item instanceof Value && item.kind !== expected) bad();
    if (typeof value !== 'object') return value;
    if (active.has(value)) return bad();
    active.add(value);
    const type = field.type;
    const copy = (child: Field, value: Stored | Value<unknown>) =>
      this.snapshot(child, value, active);
    let result: unknown;
    if (value instanceof Color)
      result = Object.freeze({r: value.r, g: value.g, b: value.b, a: value.a});
    else if (isStructRef(value)) {
      if (!DataType.isStruct(type)) return bad();
      const body = this.mustTransaction().read(value) as Record<
        string,
        Value<unknown>
      >;
      result = Object.freeze(
        Object.fromEntries(
          type.children.map(child => {
            const value = body[child.name];
            if (!(value instanceof Value)) return bad();
            return [child.name, copy(child, value)];
          }),
        ),
      );
    } else if (isArrayValue(value)) {
      if (!DataType.isList(type)) return bad();
      result = Object.freeze(
        this.mustTransaction()
          .read(value.storage)
          .values.map(item => copy(type.children[0], item)),
      );
    } else if (isMatrixValue(value)) {
      if (!DataType.isStruct(type) || type.children.length !== 3) return bad();
      result = Object.freeze({
        rows: value.rows,
        columns: value.columns,
        values: Object.freeze(
          this.mustTransaction()
            .read(value.storage)
            .values.map(item => copy(type.children[2].type.children[0], item)),
        ),
      });
    } else if (isMapValue(value)) {
      if (!DataType.isMap(type)) return bad();
      const [key, item] = type.children[0].type.children;
      result = new Map(
        this.mustTransaction()
          .read(value.storage)
          .entries.map(entry => [
            copy(key, entry.key),
            copy(item, entry.value),
          ]),
      );
    } else if (isTupleValue(value)) {
      if (!DataType.isStruct(type) || type.children.length !== value.length)
        return bad();
      result = Object.freeze(
        Object.fromEntries(
          type.children.map((child, i) => [child.name, copy(child, value[i])]),
        ),
      );
    } else if ('handle' in value && 'id' in value) {
      result = Object.freeze({kind: value.handle, id: value.id});
    } else return bad();
    active.delete(value);
    return result;
  }

  newStruct<T extends object>(body: T, byteSize: number): Ref<T> {
    return this.structs.newStruct(this.mustTransaction(), body, byteSize);
  }

  requireStruct(value: Stored, ctor: Function): Ref<object> {
    return this.structs.requireStruct(value, ctor, this.mustTransaction());
  }

  structField(
    value: Stored,
    ctor: Function,
    name: string,
    empty: Value<unknown>,
  ): Value<unknown> {
    return this.structs.field(value, ctor, name, empty, this.mustTransaction());
  }

  storeStructField(
    value: Stored,
    ctor: Function,
    name: string,
    replacement: Value<unknown>,
  ): void {
    this.structs.storeField(
      this.mustTransaction(),
      value,
      ctor,
      name,
      replacement,
    );
  }

  callCollection(
    operation: CollectionOperation,
    result: Value<unknown>,
    args: readonly Value<unknown>[],
  ): Value<unknown> {
    return this.collections.call(
      this.mustTransaction(),
      operation,
      result,
      args,
    );
  }

  mutateCollection(
    operation: CollectionMutationOperation,
    receiver: Value<unknown>,
    args: readonly Value<unknown>[],
  ): CollectionMutation {
    return this.collections.mutate(
      this.mustTransaction(),
      operation,
      receiver,
      args,
    );
  }

  collectionEntries(value: Stored): CollectionEntries {
    return this.collections.entries(value, this.mustTransaction());
  }

  private mustTransaction(): HeapTransaction {
    return (
      this.transaction ??
      fatal('managed operation outside an active transaction')
    );
  }

  private validateInput(): void {
    if (this.input.series.length !== this.module.inputs.series.length) {
      throw new ExecutionError(
        'VALUE_LAYOUT_MISMATCH',
        `step input has ${this.input.series.length} series values, expected ${this.module.inputs.series.length}`,
      );
    }
    if (this.input.builtins.length !== this.module.inputs.builtins.length) {
      throw new ExecutionError(
        'VALUE_LAYOUT_MISMATCH',
        `step input has ${this.input.builtins.length} builtin values, expected ${this.module.inputs.builtins.length}`,
      );
    }
    if (this.input.requests.length !== this.module.requests.length) {
      throw new ExecutionError(
        'VALUE_LAYOUT_MISMATCH',
        `step input has ${this.input.requests.length} request values, expected ${this.module.requests.length}`,
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
    this.input.builtins.forEach((value, id) =>
      this.module.inputs.builtins[id].empty.assertStored(value, this.heap),
    );
    this.input.requests.forEach((value, id) => {
      const request = this.module.requests[id];
      if (request.mode === 'sample')
        request.empty.assertStored(value as Stored, this.heap);
      else {
        if (!Array.isArray(value))
          throw new ExecutionError(
            'VALUE_LAYOUT_MISMATCH',
            'collect request requires an array',
          );
        for (const item of value)
          request.resultEmpty.assertStored(
            item instanceof Value ? unwrap(item) : (item as Stored),
            this.heap,
          );
      }
    });
  }

  private inputValue(
    field: 'series' | 'builtins' | 'requests',
    id: number,
    offset: number,
    empty: Stored,
    count: number,
  ): Stored {
    if (!Number.isSafeInteger(id) || id < 0 || id >= count) {
      return fatal(`unknown ${field} input ${id}`);
    }
    if (!isHistoryOffset(offset)) return empty;
    if (offset === 0) {
      const values =
        field === 'requests' ? this.requestValues : this.input[field];
      return values[id] ?? empty;
    }
    return this.state[field][id][offset - 1] ?? empty;
  }

  private openFrame(
    state: FrameState,
    intermediate: IntermediateState,
    active: boolean,
  ): FrameState {
    const fid = state.fid;
    const layout = this.frameLayout(fid);
    if (
      state.locals.length !== layout.locals.length ||
      state.subs.length !== layout.subs.length ||
      intermediate.locals.length !== layout.locals.length ||
      intermediate.subs.length !== layout.subs.length
    ) {
      return fatal(`state topology disagrees with frame ${fid}`);
    }
    this.opened.set(state, intermediate);
    if (active || state.active || intermediate.active)
      this.activated.add(state);
    return state;
  }

  private carry(frame: FrameState): IntermediateState {
    return (
      this.opened.get(frame) ?? fatal('frame is not open in this transaction')
    );
  }

  /** Read-your-writes, otherwise the binding's value at the start of this attempt. */
  private current(frame: FrameState, slot: number): Stored {
    const local = frame.locals[slot];
    const pending = this.writes.get(local);
    if (pending) return pending.value;
    const spec = this.frameLayout(frame.fid).locals[slot];
    const carried = this.carry(frame).locals[slot];
    const empty = spec.empty.value as Stored;
    return spec.storage === Storage.Varip && carried !== null
      ? carried.value
      : spec.storage === Storage.Var && local.initialized
        ? (local.history[0] ?? empty)
        : spec.storage === Storage.Var && carried !== null
          ? carried.value
          : empty;
  }

  private initialized(frame: FrameState, slot: number): boolean {
    const local = frame.locals[slot];
    const storage = this.frameLayout(frame.fid).locals[slot].storage;
    return (
      this.writes.get(local)?.initialized ??
      this.carry(frame).locals[slot]?.initialized ??
      ((storage === Storage.Var || storage === Storage.Varip) &&
        local.initialized)
    );
  }

  private initialValue(frame: FrameState, slot: number): Stored | undefined {
    const local = frame.locals[slot];
    const pending = this.writes.get(local);
    if (pending) return pending.initialValue;
    return this.frameLayout(frame.fid).locals[slot].storage === Storage.Var &&
      !local.initialized
      ? this.carry(frame).locals[slot]?.value
      : undefined;
  }

  private finishFrame(frame: FrameState): FrameState {
    const layout = this.frameLayout(frame.fid);
    return {
      fid: frame.fid,
      active: this.activated.has(frame),
      locals: frame.locals.map((local, slot) => {
        const spec = layout.locals[slot]!;
        const keep = localRetention(spec.storage, spec.depth);
        return {
          history: commitHistory(
            local.history,
            this.current(frame, slot),
            keep,
          ),
          initialized:
            (spec.storage === Storage.Var || spec.storage === Storage.Varip) &&
            this.initialized(frame, slot),
        };
      }),
      subs: frame.subs.map((state, slot) => {
        const child = this.children.get(frame)?.get(slot);
        if (child) return this.finishFrame(child);
        const intermediate = this.carry(frame).subs[slot] ?? null;
        if (!state?.active && !intermediate?.active) return state;
        return this.finishFrame(this.openChild(frame, slot, false));
      }),
    };
  }

  private finishRoot(): RootState {
    const frame = this.finishFrame(this.rootFrame);
    return {
      ...frame,
      series: this.finishInputHistory(
        'series',
        this.state.series,
        this.module.inputs.series,
      ),
      builtins: this.finishInputHistory(
        'builtins',
        this.state.builtins,
        this.module.inputs.builtins,
      ),
      requests: this.finishInputHistory(
        'requests',
        this.state.requests,
        this.module.requests,
      ),
    };
  }

  private finishInputHistory(
    field: 'series' | 'builtins' | 'requests',
    histories: readonly (readonly Stored[])[],
    specs: readonly {readonly depth: Parameters<typeof depthRetention>[0]}[],
  ): readonly (readonly Stored[])[] {
    if (histories.length !== specs.length) {
      return fatal(`${field} history topology disagrees with the module`);
    }
    return histories.map((history, id) =>
      commitHistory(
        history,
        (field === 'requests' ? this.requestValues : this.input[field])[id]!,
        depthRetention(specs[id]!.depth),
      ),
    );
  }

  private finishIntermediateState(frame: FrameState): IntermediateState {
    const layout = this.frameLayout(frame.fid);
    return {
      active: this.activated.has(frame),
      locals: frame.locals.map((local, slot) => {
        const spec = layout.locals[slot]!;
        const initialValue = this.initialValue(frame, slot);
        if (
          spec.storage === Storage.Varip ||
          (spec.storage === Storage.Var &&
            !local.initialized &&
            initialValue !== undefined)
        ) {
          return {
            value:
              spec.storage === Storage.Varip
                ? this.current(frame, slot)
                : initialValue!,
            initialized: this.initialized(frame, slot),
          };
        }
        return null;
      }),
      subs: frame.subs.map((_, slot) => {
        const child = this.children.get(frame)?.get(slot);
        return child
          ? this.finishIntermediateState(child)
          : (this.carry(frame).subs[slot] ?? null);
      }),
    };
  }

  private frameLayout(fid: number) {
    const layout = this.module.state.frames[fid];
    return layout === undefined ? fatal(`unknown frame layout ${fid}`) : layout;
  }
}

function initialFrame(
  module: Module,
  fid: number,
  active: boolean,
): FrameState {
  const layout = module.state.frames[fid];
  if (layout === undefined) return fatal(`unknown frame layout ${fid}`);
  return {
    fid,
    active,
    locals: layout.locals.map(() => ({
      history: [],
      initialized: false,
    })),
    subs: layout.subs.map(() => null),
  };
}

export function initialRoot(module: Module): RootState {
  return {
    ...initialFrame(module, 0, true),
    series: module.inputs.series.map(() => []),
    builtins: module.inputs.builtins.map(() => []),
    requests: module.requests.map(() => []),
  };
}

export function initialIntermediateState(
  module: Module,
  fid: number,
  active: boolean,
): IntermediateState {
  const layout = module.state.frames[fid];
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
  history: readonly Stored[],
  value: Stored,
  keep: number,
): readonly Stored[] {
  return keep === 0 ? [] : [value, ...history].slice(0, keep);
}

function depthRetention(depth: Depth) {
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

/** Enumerate managed identities already present in retained values. */
export function discoverRoots(
  state: Readonly<RootState>,
  intermediate: Readonly<IntermediateState>,
): Ref<unknown>[] {
  const roots: Ref<unknown>[] = [];
  const visit = (value: Stored) =>
    visitValueRefs(value, ref => roots.push(ref));
  for (const histories of [state.builtins, state.requests])
    for (const history of histories) history.forEach(visit);
  const history = (frame: FrameState): void => {
    frame.locals.forEach(local => local.history.forEach(visit));
    frame.subs.forEach(child => {
      if (child) history(child);
    });
  };
  const carry = (frame: IntermediateState): void => {
    frame.locals.forEach(local => {
      if (local) visit(local.value);
    });
    frame.subs.forEach(child => {
      if (child) carry(child);
    });
  };
  history(state);
  carry(intermediate);
  return roots;
}
