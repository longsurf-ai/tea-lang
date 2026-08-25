// Purpose: Public Node contract and private RxJS/Effect lifecycle implementation.

import {Cause, Effect, Either, Exit} from 'effect';
import {
  concatMap,
  finalize,
  map,
  Observable,
  of,
  share,
  Subject,
  Subscription,
} from 'rxjs';
import {fatal} from '../base/print';
import {JSRuntime, type StepResult} from '../runtime/js-runtime';
import {
  moduleBindings,
  withModuleBindings,
  withRequestModule,
} from '../runtime/module-binding';
import type {JSModule, ModuleBinding} from '../runtime/module-abi';
import {bindModule} from './binding';
import type {Sink} from './sink';
import {DataStream} from './stream';
import {sync} from './sync';

type Datum = Readonly<Record<string, unknown>>;

export type BindingInput =
  | DataStream<unknown>
  | Readonly<Record<string, unknown>>
  | Readonly<Record<string, DataStream<unknown>>>;

/**
 * A Node is the public API for embedding a Tea program into a host application.
 */
export interface Node {
  /**
   * Returns the Node's current immutable generated-module snapshot.
   *
   * @example `node.module.manifest.params`
   */
  readonly module: JSModule;

  /**
   * Applies parameter or stream bindings and returns this mutable Node.
   *
   * @example `node.bind({length: 20})`
   */
  bind(input: BindingInput): Node;

  /**
   * Reports whether this Node and all request children can execute.
   *
   * @example `if (node.ready()) node.to(sink)`
   */
  ready(): boolean;

  /**
   * Starts execution or attaches a later sink to the existing execution.
   *
   * @example `const subscription = node.to(sink)`
   */
  to(sink: Sink<StepResult>): Subscription;

  /**
   * Cancels owned execution resources; repeated calls have no effect.
   *
   * @example `node.dispose()`
   */
  dispose(): void;
}

/** Private mutable owner behind the stable public Node identity. */
class TeaNode implements Node {
  private _module: JSModule;
  private data: Observable<Datum> | null;
  private requests: TeaNode[];
  private readonly results = new Subject<StepResult>();
  private runtime: JSRuntime | null = null;
  private connection: Subscription | null = null;
  private started = false;
  private disposed = false;

  /**
   * Creates one Node owner and recursively mirrors its request-module tree.
   *
   * @example `new TeaNode(rootModule)` creates children for
   * `rootModule.requests`.
   */
  constructor(
    module: JSModule,
    data: Observable<Datum> | null = null,
    requests?: readonly TeaNode[],
  ) {
    this.data = data;
    this.requests = requests
      ? [...requests]
      : module.requests.map(request => new TeaNode(request));
    this._module = module;
  }

  /**
   * Exposes the current immutable module while keeping replacement private.
   *
   * @example `node.module.ready()` inspects the current snapshot.
   */
  get module(): JSModule {
    return this.snapshot();
  }

  /**
   * Runs the internal binding Effect behind the synchronous public API.
   *
   * @example `node.bind(stream).bind({length: 20})`
  */
  bind(input: BindingInput): Node {
    if (this.disposed) throw new Error('Node is disposed');
    if (this.started) {
      throw new Error('Node cannot bind after execution has started');
    }
    const operation =
      input instanceof DataStream
        ? this.bindStreams(input)
        : Object.values(input).every(value => value instanceof DataStream)
          ? this.bindStreams(
              input as Readonly<Record<string, DataStream<unknown>>>,
            )
          : this.bindParameters(input);
    const result = Effect.runSync(Effect.either(operation));
    if (Either.isLeft(result)) throw result.left;
    return this;
  }

  /**
   * Checks readiness recursively rather than trusting only the root module.
   *
   * @example A root with a missing request-child `close` stream returns false.
   */
  ready(): boolean {
    return (
      this._module.ready() &&
      this.requests.every(request => request.ready())
    );
  }

  /**
   * Runs execution setup internally and returns the RxJS sink subscription.
   *
   * @example `node.to(firstSink); node.to(lateSink)` shares one runtime.
  */
  to(sink: Sink<StepResult>): Subscription {
    if (this.disposed) throw new Error('Node is disposed');
    if (this.started) return this.results.subscribe(sink);
    if (!this.ready()) {
      throw new Error(
        `Node is missing bindings: ${this._module
          .remaining()
          .map(binding => binding.name)
          .join(', ')}`,
      );
    }
    const module = this.snapshot();
    if (module.manifest.builtin.length !== 0) {
      throw new Error('Node builtin input wiring is not implemented yet');
    }
    if (module.manifest.requests.length !== 0) {
      throw new Error(
        'Node request execution requires time and finality semantics that DataStream does not provide',
      );
    }

    const sinkSubscription = this.results.subscribe(sink);
    let runtime: JSRuntime;
    try {
      runtime = new JSRuntime(module);
    } catch (error) {
      sinkSubscription.unsubscribe();
      throw error;
    }
    this.runtime = runtime;
    this.started = true;

    const seriesNames = moduleBindings(module)
      .filter(
        (binding): binding is Extract<ModuleBinding, {kind: 'series'}> =>
          binding.kind === 'series',
      )
      .map(binding => binding.name);
    const inputData = this.data ?? of(Object.freeze({}) as Datum);

    const connection = new Subscription();
    this.connection = connection;
    connection.add(
      inputData
        .pipe(
          concatMap(datum => this.stepDatum(runtime, seriesNames, datum)),
          finalize(() => runtime.dispose()),
        )
        .subscribe({
          next: result => this.results.next(result),
          error: error => this.results.error(error),
          complete: () => this.results.complete(),
        }),
    );
    return sinkSubscription;
  }

  /**
   * Runs idempotent cleanup without exposing Effect in the public contract.
   *
  * @example Calling `node.dispose()` twice performs one teardown.
  */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.connection?.unsubscribe();
    this.runtime?.dispose();
    this.requests.forEach(request => request.dispose());
    this.results.complete();
  }

  /**
   * Applies scalar parameter values and propagates the new module tree.
   *
   * @example `{length: 20}` updates the root and every request child's copy of
   * the compilation-global `length` parameter.
   */
  private bindParameters(
    input: Readonly<Record<string, unknown>>,
  ): Effect.Effect<void, Error> {
    const self = this;
    return Effect.gen(function* () {
      const before = self.seriesNames();
      const assignments = Object.entries(input).map(([name, value]) => ({
        kind: 'parameter' as const,
        name,
        value,
      }));
      const module = yield* bindModule(self.snapshot(), assignments);
      self.updateModule(module);
      if (JSON.stringify(before) !== JSON.stringify(self.seriesNames())) {
        self.data = null;
      }
    });
  }

  /**
   * Binds this Node's streams, then recursively fans request streams to children.
   *
   * @example `{close: root, SPY: child}` binds `close` here and passes `SPY`
   * to every request child whose concrete symbol is `SPY`.
   */
  private bindStreams(
    input:
      | DataStream<unknown>
      | Readonly<Record<string, DataStream<unknown>>>,
  ): Effect.Effect<void, Error> {
    const self = this;
    return Effect.gen(function* () {
      if (input instanceof DataStream) {
        const names = self._module
          .remaining()
          .filter(binding => binding.kind === 'series')
          .map(binding => binding.name);
        const assignments = names.map(name => ({
          kind: 'series' as const,
          name,
        }));
        const module = yield* bindModule(self.snapshot(), assignments);
        self.updateModule(module);
        self.data = self.combineData(
          self.data,
          self.sourceData(input.asObservable(), names),
        );
        return;
      }

      const known = new Set(self.seriesNames());
      self.requestStreamKeys(known);
      for (const name of Object.keys(input)) {
        if (!known.has(name)) {
          return yield* Effect.fail(
            new Error(
              `no bind-known root series or static request child matches '${name}'`,
            ),
          );
        }
      }

      const root = Object.entries(input).filter(([name]) =>
        self.seriesNames().includes(name),
      );
      if (root.length !== 0) {
        const assignments = root.map(([name]) => ({
          kind: 'series' as const,
          name,
        }));
        const data = root.reduce<Observable<Datum> | null>(
          (combined, [name, stream]) =>
            self.combineData(
              combined,
              self.sourceData(stream.asObservable(), [name]),
            ),
          null,
        );
        const module = yield* bindModule(self.snapshot(), assignments);
        self.updateModule(module);
        self.data = self.combineData(self.data, data);
      }

      yield* self.bindRequestStreams(input);
    });
  }

  /**
   * Recursively binds streams selected by each request child's context symbol.
   *
   * @example Two `SPY` request children both receive the same `input.SPY`
   * stream; a nested `QQQ` child is reached by the recursive call.
   */
  private bindRequestStreams(
    input: Readonly<Record<string, DataStream<unknown>>>,
  ): Effect.Effect<void, Error> {
    const self = this;
    return Effect.gen(function* () {
      for (let requestId = 0; requestId < self.requests.length; requestId++) {
        const child = self.requests[requestId]!;
        const symbol = self._module.manifest.requests[requestId]?.context?.symbol;
        const stream = symbol === undefined ? undefined : input[symbol];
        if (stream !== undefined) yield* child.bindStreams(stream);
        yield* child.bindRequestStreams(input);
      }
    });
  }

  /**
   * Updates each Node from the corresponding module in a newly bound tree.
   *
   * @example Changing request symbol `X` to `Y` updates that child module and
   * clears the stream previously selected by `X`.
   */
  private updateModule(module: JSModule): void {
    const requests = module.requests.map((request, requestId) => {
      const child = this.requests[requestId];
      if (child === undefined) return new TeaNode(request);
      const previous = this._module.manifest.requests[requestId]?.context;
      const current = module.manifest.requests[requestId]?.context;
      child.updateModule(request);
      if (JSON.stringify(previous ?? null) !== JSON.stringify(current ?? null)) {
        child.clearStreams();
      }
      return child;
    });
    this._module = module;
    this.requests = requests;
  }

  /**
   * Adds every recursively bindable request symbol to a caller-owned set.
   *
   * @example A root request for `SPY` with nested `QQQ` adds both keys.
   * @param keys - The set populated with concrete request symbols.
   */
  private requestStreamKeys(keys: Set<string>): void {
    this._module.manifest.requests.forEach(request => {
      if (request.context !== null && request.context !== undefined) {
        keys.add(request.context.symbol);
      }
    });
    this.requests.forEach(child => child.requestStreamKeys(keys));
  }

  /**
   * Clears this Node's data and series markers recursively.
   *
   * @example After request symbol `X` becomes `Y`, the previous `X` child
   * cannot remain ready through its old `close` marker.
   */
  private clearStreams(): void {
    this.data = null;
    const bindings = moduleBindings(this._module).map(binding =>
      binding.kind === 'series'
        ? Object.freeze({...binding, supplied: false})
        : binding,
    );
    this._module = withModuleBindings(this._module, bindings);
    this.requests.forEach(child => child.clearStreams());
  }

  /**
   * Builds one recursive module snapshot from the current Node tree.
   *
   * @example `node.module` attaches each `requests[rid].module` only when the
   * caller asks for the complete generated-module tree.
   */
  private snapshot(): JSModule {
    if (this.requests.length !== this._module.requests.length) {
      return fatal('TeaNode request state disagrees with JSModule requests');
    }
    return this.requests.reduce(
      (parent, child, requestId) => {
        const childModule = child.snapshot();
        return parent.requests[requestId] === childModule
          ? parent
          : withRequestModule(parent, requestId, childModule);
      },
      this._module,
    );
  }

  /**
   * Returns every named series binding owned directly by this Node.
   *
   * @example A module evaluating `close + open` returns `["close", "open"]`.
   */
  private seriesNames(): readonly string[] {
    return moduleBindings(this._module)
      .filter(binding => binding.kind === 'series')
      .map(binding => binding.name);
  }

  /**
   * Projects source emissions into the named fields required by this Node.
   *
   * @example Scalar emissions with names `["close"]` become `{close: value}`;
   * record emissions must already contain every requested name.
   */
  private sourceData(
    source: Observable<unknown>,
    names: readonly string[],
  ): Observable<Datum> {
    return source.pipe(
      map(value => {
        if (this.isRecord(value)) {
          return Object.freeze(
            Object.fromEntries(
              names.map(name => {
                if (!Object.hasOwn(value, name)) {
                  throw new Error(
                    `source value does not provide series '${name}'`,
                  );
                }
                return [name, value[name]];
              }),
            ),
          );
        }
        if (names.length === 1) return Object.freeze({[names[0]!]: value});
        throw new Error(`source value does not provide series '${names[0]}'`);
      }),
      share(),
    );
  }

  /**
   * Synchronizes new data with the Node's existing data Observable.
   *
   * @example `{close: 10}` combined with `{open: 9}` emits
   * `{close: 10, open: 9}` once both sides are available.
   */
  private combineData(
    current: Observable<Datum> | null,
    next: Observable<Datum> | null,
  ): Observable<Datum> | null {
    if (current === null) return next;
    if (next === null) return current;
    return current.pipe(
      sync(next, (right, buffered) => {
        const left = buffered[0];
        return left === undefined
          ? undefined
          : [Object.freeze({...left, ...right}), 1];
      }),
    );
  }

  /**
   * Narrows a source emission to a non-null, non-array record.
   *
   * @example `{close: 1}` is a record; `1`, `null`, and `[1]` are not.
   */
  private isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  /**
   * Converts one synchronized field into the runtime's numeric series domain.
   *
   * @example `undefined` becomes `NaN`, `10` stays `10`, and `"10"` throws.
   */
  private numericSeries(value: unknown): number {
    if (value === undefined) return Number.NaN;
    if (typeof value !== 'number') {
      throw new TypeError('Tea series input must be numeric');
    }
    return value;
  }

  /**
   * Adapts one `JSRuntime.step()` Effect into a cancelable one-value Observable.
   *
   * @example Unsubscribing before completion invokes the callback canceler;
   * a successful step emits one `StepResult` and completes.
   */
  private stepDatum(
    runtime: JSRuntime,
    seriesNames: readonly string[],
    datum: Datum,
  ): Observable<StepResult> {
    return new Observable(subscriber => {
      const cancel = Effect.runCallback(
        runtime.step({
          series: seriesNames.map(name => this.numericSeries(datum[name])),
          builtins: [],
          requests: [],
          provisional: false,
        }),
        {
          onExit: exit =>
            Exit.match(exit, {
              onSuccess: value => {
                subscriber.next(value);
                subscriber.complete();
              },
              onFailure: cause => subscriber.error(Cause.squash(cause)),
            }),
        },
      );
      return () => cancel();
    });
  }
}

/**
 * Creates the private implementation behind the public `Node` interface.
 *
 * @example `createNode(loadModule(js))` returns a Node with mirrored request
 * children and no active runtime.
 */
export function createNode(module: JSModule): Node {
  return new TeaNode(module);
}
