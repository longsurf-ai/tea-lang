import type {Module} from '../module-binding';
// Purpose: One bound program's typed values and synchronous transaction lifecycle.

import {fatal} from '../../base/print';

import {requireConcreteModule} from '../module-binding';
import {outputFields} from '../output';
import type {Stored} from '../value';
import {StorageTypes} from '../storage-types';
import {ArenaHeap} from './heap';
import {StructStorageRuntime} from './struct-storage';
import {CollectionRuntime} from './collections';
import {
  Step,
  initialRoot,
  initialIntermediateFrame,
  discoverRoots,
  validateIoSchemas,
  type RootState,
  type IntermediateFrame,
  type WorkspaceFrame,
  type StepInput,
} from './state-update';
import {Input, Series} from './series';
import {Value, capture, unwrap} from './value';

export type {StepInput} from './state-update';

/** Named local bindings and independent written call sites in one frame. */
export interface Frame<L extends object = object, C extends object = object> {
  readonly locals: L;
  readonly calls: C;
}

/** Detached output cells from one accepted attempt. */
export interface StepResult {
  readonly outputs: readonly unknown[];
  readonly provisional: boolean;
}

/**
 * The execution owner for one bound module. Generated programs specialize its
 * four property types; storage mechanics and transactions stay in this library.
 *
 * @example `new Context(module).step({series: [10], builtins: [], requests: [],
 * provisional: false})` evaluates one synchronized row. Separate Contexts own
 * separate histories and Heaps, even when their executable code is shared.
 */
export class Context<
  P extends object = object,
  I extends object = object,
  S extends Frame = Frame,
  O extends object = object,
> {
  readonly params: P;
  readonly inputs: I;
  readonly outputs: O;
  /** @internal Physical descriptors are never a second I/O schema. */
  readonly layouts: StorageTypes;
  private readonly heap = new ArenaHeap();
  private readonly structs: StructStorageRuntime;
  private readonly collections: CollectionRuntime;
  private committed: RootState;
  private intermediate: IntermediateFrame;
  private active: Step | null = null;
  private frames = new Map<WorkspaceFrame, Frame>();
  private rootValues: readonly Stored[] | null = null;
  private disposed = false;
  private readonly module: Module;

  constructor(module: Module) {
    requireConcreteModule(module);
    this.module = module.clone();
    Object.freeze(module);
    this.layouts = new StorageTypes(this.module.state.layout);
    validateIoSchemas(this.module, this.layouts);
    this.structs = new StructStorageRuntime(this.heap, this.layouts);
    this.collections = new CollectionRuntime(
      this.heap,
      this.layouts,
      100_000,
      this.structs,
    );
    this.committed = initialRoot(this.module);
    this.intermediate = initialIntermediateFrame(this.module, 0, true);
    this.params = Object.fromEntries(
      this.module.parameters.map(parameter => [
        parameter.name,
        new Value(
          parameter.value!,
          parameter.type === 'enum'
            ? (parameter.enumType!.typeId ?? parameter.enumType!.name)
            : parameter.type === 'source'
              ? 'string'
              : parameter.type,
        ),
      ]),
    ) as P;
    this.inputs = {
      series: Object.fromEntries(
        this.module.inputs.series.map((input, id) => [
          input.name ??
            input.id ??
            this.module.parameters.find(p => p.seriesSid === id)!.name,
          new Input(
            offset => new Value(this.storage.series(id, offset), 'float'),
          ),
        ]),
      ),
      builtins: Object.fromEntries(
        this.module.inputs.builtins.map((input, id) => [
          `${input.source.domain}.${input.source.field}`,
          new Input(offset =>
            this.capture(this.storage.builtin(id, offset), input.layout),
          ),
        ]),
      ),
      children: Object.fromEntries(
        this.module.requests.map((request, id) => [
          request.name,
          new Input(offset =>
            this.capture(this.storage.request(id, offset), request.layout),
          ),
        ]),
      ),
    } as I;
    this.outputs = Object.fromEntries(
      outputFields(this.module.outputs.schema).map((field, id) => [
        field.name,
        field.metadata.get('tea:write') === 'append'
          ? {
              append: (value: Value<unknown>) =>
                this.storage.append(id, unwrap(value)),
            }
          : {
              set: (value: Value<unknown>) =>
                this.storage.emit(id, unwrap(value)),
            },
      ]),
    ) as O;
  }

  /** Root state is accessible only while main is executing. */
  get state(): S {
    return this.frame(this.storage.rootFrame) as S;
  }

  /** @internal Typed value methods use the current concrete storage owner. */
  get storage(): Step {
    if (this.active === null)
      return fatal('runtime value used outside an active step');
    return this.active;
  }

  /** @internal Attach the correct semantic kind and owner to a stored carrier. */
  capture<T, K extends string = string>(
    value: Stored,
    layout: number,
  ): Value<T, K> {
    return capture<T, K>(this, value, layout);
  }

  private frame(frame: WorkspaceFrame): Frame {
    const existing = this.frames.get(frame);
    if (existing !== undefined) return existing;
    const template = this.module.state.frames[frame.fid];
    const locals = Object.fromEntries(
      template.locals.map((local, slot) => [
        local.name ?? `local${slot}`,
        new Series(
          offset =>
            this.capture(this.storage.read(frame, slot, offset), local.layout),
          value => this.storage.write(frame, slot, unwrap(value)),
          () => this.storage.needsInit(frame, slot),
          value => this.storage.initialize(frame, slot, unwrap(value)),
        ),
      ]),
    );
    const calls = Object.create(null) as Record<string, Frame>;
    const result = {locals, calls};
    this.frames.set(frame, result);
    template.subs.forEach((child, slot) =>
      Object.defineProperty(calls, child.name ?? `call${slot}`, {
        enumerable: true,
        get: () => this.frame(this.storage.frame(frame, slot)),
      }),
    );
    return result;
  }

  /**
   * Accept one attempt atomically. Main may return normally at any point; an
   * exception aborts its writes and output. Final attempts advance history;
   * successful provisional attempts retain the existing varip/Heap behavior.
   * @example Call with provisional true, then false for the same logical row.
   */
  step(input: StepInput): StepResult {
    this.assertLive();
    if (this.active !== null)
      return fatal('a Context cannot execute a nested step');
    this.heap.replaceRoots(
      discoverRoots(
        this.module,
        this.layouts,
        this.structs,
        this.committed,
        this.intermediate,
      ),
    );
    this.heap.collect();
    this.frames = new Map();
    const step = new Step(
      this.module,
      this.layouts,
      this.heap,
      this.committed,
      this.intermediate,
      input,
      this.structs,
      this.collections,
    );
    this.active = step;
    try {
      const result = step.run(() => this.module.main(this));
      this.rootValues = result.rootValues;
      this.intermediate = result.intermediate;
      if (!input.provisional) this.committed = result.state;
      return {outputs: result.output, provisional: input.provisional};
    } finally {
      this.active = null;
      this.frames.clear();
    }
  }

  /** @internal A request result is valid until this Context's next step. */
  readResult(slot: number, layout: number): Stored {
    this.assertLive();
    const local = this.module.state.frames[0]?.locals[slot];
    if (local?.layout !== layout)
      return fatal(`invalid request result slot ${slot}`);
    const value = this.rootValues?.[slot];
    if (value === undefined)
      return fatal(`request result ${slot} is unavailable before step`);
    this.layouts.assertValue(layout, value, 'request result');
    return value;
  }

  /** Release this execution's storage; repeated disposal is harmless. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.heap.dispose();
    this.frames.clear();
  }
  private assertLive(): void {
    if (this.disposed) fatal('Context is disposed');
  }
}
