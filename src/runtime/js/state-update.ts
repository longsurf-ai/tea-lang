import type {Module} from '../module-binding';
// Purpose: Execute one generated Module invocation as an Effect state
// transition over explicit committed State, Intermediate, and StepInput values.

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
import type {Heap, HeapTransaction, Ref} from './heap';
import {CollectionRuntime} from './collections';
import {StructStorageRuntime} from './struct-storage';
import type {StorageTypes} from '../storage-types';
import {
  isArrayValue,
  isMapValue,
  isMatrixValue,
  isStructRef,
  isTupleValue,
  type Stored,
} from '../value';

const DEFAULT_MAX_COLLECTION_ELEMENTS = 100_000;

/** One synchronized external update passed to Context.step(). */
export interface StepInput {
  readonly series: readonly Stored[];
  readonly builtins: readonly Stored[];
  readonly requests: readonly Stored[];
  readonly provisional: boolean;
}

// Committed Tea state. Every time-addressed binding owns explicit newest-first
// history.

export interface RootState extends FrameState {
  readonly series: readonly (readonly Stored[])[];
  readonly builtins: readonly (readonly Stored[])[];
  readonly requests: readonly (readonly Stored[])[];
}

export interface FrameState {
  readonly active: boolean;
  readonly locals: readonly LocalState[];
  readonly subs: readonly (FrameState | null)[];
}

export interface LocalState {
  readonly history: readonly Stored[];
  readonly initialized: boolean;
}

// State with exactly one live copy across provisional and committed updates.

export interface IntermediateFrame {
  readonly active: boolean;
  readonly locals: readonly (IntermediateLocal | null)[];
  readonly subs: readonly (IntermediateFrame | null)[];
}

export interface IntermediateLocal {
  readonly value: Stored;
  readonly initialized: boolean;
}

interface WorkspaceLocal {
  readonly state: LocalState;
  readonly intermediate: IntermediateLocal | null;
  value: Stored;
  initialized: boolean;
  // undefined means absent; null is a valid retained initializer.
  initialization: Stored | undefined;
}

export interface WorkspaceFrame {
  readonly kind: 'frame';
  readonly fid: number;
  readonly state: FrameState;
  readonly intermediate: IntermediateFrame;
  readonly locals: WorkspaceLocal[];
  readonly subs: (WorkspaceFrame | null)[];
  active: boolean;
}

export class Step {
  readonly rootFrame: WorkspaceFrame;
  private readonly fields: readonly Field[];
  private readonly outputs: unknown[];
  private readonly written = new Set<number>();
  private transaction: HeapTransaction | null = null;
  private requestValues: readonly Stored[] = [];

  constructor(
    private readonly module: Module,
    private readonly layouts: StorageTypes,
    private readonly heap: Heap,
    private readonly state: Readonly<RootState>,
    private readonly intermediate: Readonly<IntermediateFrame>,
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
    this.rootFrame = this.openFrame(0, state, intermediate, true);
  }

  run(main: () => void) {
    using transaction = this.heap.begin('state-update');
    this.transaction = transaction;
    try {
      this.requestValues = this.input.requests.map((value, rid) => {
        const spec = this.module.requests[rid]!;
        return spec.mode === 'sample'
          ? value
          : this.collections.call(
              transaction,
              'array.from',
              spec.layout,
              value as readonly Stored[],
            );
      });
      main();
      const result = {
        state: this.finishRoot(),
        intermediate: this.finishIntermediateFrame(this.rootFrame),
        rootValues: this.rootFrame.locals.map(local => local.value),
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
      this.layouts.empty(spec.layout),
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
      this.layouts.empty(spec.layout),
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

  root(): WorkspaceFrame {
    return this.rootFrame;
  }

  frame(fr: WorkspaceFrame, slot: number): WorkspaceFrame {
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

  read(fr: WorkspaceFrame, slot: number, offset: number): Stored {
    const frame = fr as WorkspaceFrame;
    const local = frame.locals[slot];
    const spec = this.frameLayout(frame.fid).locals[slot];
    if (local === undefined || spec === undefined) {
      return fatal(`read from unknown frame ${frame.fid} slot ${slot}`);
    }
    const empty = this.layouts.empty(spec.layout);
    if (!isHistoryOffset(offset)) return empty;
    if (offset === 0) return local.value;
    return local.state.history[offset - 1] ?? empty;
  }

  write(fr: WorkspaceFrame, slot: number, value: Stored): void {
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

  needsInit(fr: WorkspaceFrame, slot: number): boolean {
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

  initialize(fr: WorkspaceFrame, slot: number, value: Stored): void {
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

  emit(output: number, value: Stored): void {
    const field = this.fields[output];
    const spec = this.module.outputs.declarations[output];
    if (field?.metadata.get('tea:write') !== 'set')
      return fatal(`unknown set output ${output}`);
    if (this.written.has(output))
      return fatal(`duplicate emit to output '${field.name}'`);
    const detached = this.snapshot(spec.layout, field, value);
    this.written.add(output);
    this.outputs[output] = detached;
  }

  append(output: number, payload: Stored): void {
    const field = this.fields[output];
    const spec = this.module.outputs.declarations[output];
    if (field?.metadata.get('tea:write') !== 'append')
      return fatal(`unknown append output ${output}`);
    const value = this.snapshot(spec.layout, field.type.children[0], payload);
    (this.outputs[output] as unknown[]).push(value);
  }

  // Copy at the emission, not at the end of the step: later mutation must not
  // change an earlier event. Arrow fields describe the detached result while
  // runtime layouts locate the live values in the Heap.
  private snapshot(
    layoutId: number,
    field: Field,
    value: Stored,
    active?: Set<object>,
  ): unknown {
    const transaction = this.mustTransaction();
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
    const copy = (id: number, child: Field, item: Stored) =>
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

  newStruct(layout: number, fields: readonly Stored[]): Ref<unknown> {
    return this.structs.newStruct(this.mustTransaction(), layout, fields);
  }

  requireStruct(value: Stored, layout: number): Ref<unknown> {
    return this.structs.requireStruct(value, layout, this.mustTransaction());
  }

  structField(value: Stored, ownerLayout: number, index: number): Stored {
    return this.structs.field(
      value,
      ownerLayout,
      index,
      this.mustTransaction(),
    );
  }

  storeStructField(
    value: Stored,
    ownerLayout: number,
    index: number,
    replacement: Stored,
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
    resultLayout: number,
    args: readonly Stored[],
  ): Stored {
    return this.collections.call(
      this.mustTransaction(),
      operation,
      resultLayout,
      args,
    );
  }

  mutateCollection(
    operation: CollectionMutationOperation,
    collectionLayout: number,
    receiver: Stored,
    args: readonly Stored[],
  ): CollectionMutation {
    return this.collections.mutate(
      this.mustTransaction(),
      operation,
      collectionLayout,
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
      fatal('struct or collection operation outside StateUpdate')
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
    this.input.builtins.forEach((value, bid) => {
      this.structs.assertValue(
        this.module.inputs.builtins[bid]!.layout,
        value,
        `builtin ${bid}`,
      );
    });
    this.input.requests.forEach((value, rid) => {
      const spec = this.module.requests[rid]!;
      if (spec.mode === 'sample') {
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
                ? (local.history[0] ?? this.layouts.empty(spec.layout))
                : spec.storage === Storage.Var && current !== null
                  ? current.value
                  : this.layouts.empty(spec.layout),
          initialized:
            current?.initialized ?? (persistent && local.initialized),
          initialization:
            spec.storage === Storage.Var && !local.initialized
              ? current?.value
              : undefined,
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
            local.initialization !== undefined)
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

export function initialIntermediateFrame(
  module: Module,
  fid: number,
  active: boolean,
): IntermediateFrame {
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

export function discoverRoots(
  module: Module,
  layouts: StorageTypes,
  structs: StructStorageRuntime,
  state: Readonly<RootState>,
  intermediate: Readonly<IntermediateFrame>,
): Ref<unknown>[] {
  const roots: Ref<unknown>[] = [];
  const visit = (layout: number, value: Stored) => {
    structs.assertValue(layout, value, 'StateMachine retained value');
    layouts.visitRefs(layout, value, ref => roots.push(ref));
  };

  state.builtins.forEach((ring, bid) => {
    const spec = module.inputs.builtins[bid]!;
    ring.forEach(value => visit(spec.layout, value));
  });
  state.requests.forEach((ring, rid) => {
    const spec = module.requests[rid]!;
    ring.forEach(value => visit(spec.layout, value));
  });
  visitFrameState(module, state, 0, visit);
  visitIntermediateFrame(module, intermediate, 0, visit);
  return roots;
}

function visitFrameState(
  module: Module,
  frame: Readonly<FrameState>,
  fid: number,
  visit: (layout: number, value: Stored) => void,
): void {
  const layout = frameLayout(module, fid);
  frame.locals.forEach((local, slot) => {
    const spec = layout.locals[slot]!;
    local.history.forEach(value => visit(spec.layout, value));
  });
  frame.subs.forEach((sub, slot) => {
    if (sub !== null) {
      visitFrameState(module, sub, layout.subs[slot]!.fid, visit);
    }
  });
}

function visitIntermediateFrame(
  module: Module,
  frame: Readonly<IntermediateFrame>,
  fid: number,
  visit: (layout: number, value: Stored) => void,
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

function frameLayout(module: Module, fid: number) {
  const layout = module.state.frames[fid];
  return layout === undefined ? fatal(`unknown frame layout ${fid}`) : layout;
}

export function validateIoSchemas(module: Module, layouts: StorageTypes): void {
  const active = new Set<number>();
  const validate = (id: number, field: Field): void => {
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
  const fields = outputFields(module.outputs.schema);
  if (fields.length !== module.outputs.declarations.length)
    fatal('output schema and declarations disagree');
  module.outputs.declarations.forEach((output, id) => {
    const field = fields[id];
    const value =
      field.metadata.get('tea:write') === 'append'
        ? field.type.children[0]
        : field;
    validate(output.layout, value);
  });
}
