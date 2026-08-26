// Purpose: Public Node contract and private RxJS/Effect lifecycle implementation.

import {Cause, Effect, Either, Exit} from 'effect';
import {
  finalize,
  map,
  Observable,
  of,
  type Observer,
  Subject,
  Subscription,
} from 'rxjs';
import * as z from 'zod';
import {fatal} from '../base/print';
import {JSRuntime, type StepResult} from '../runtime/js/runtime';
import {moduleBindings, withRequestModule} from '../runtime/module-binding';
import type {JSModule, RequestSpec} from '../runtime/module-abi';
import type {Value} from '../runtime/value';
import {bindModule} from './binding';
import {i, timeframeClock, type Clock} from './clock';
import {DataStream} from './stream';
import {sync} from './sync';

/** One synchronized set of named values moving through the public pipeline. */
export type Datum = Readonly<Record<string, unknown>>;

/** One child input Datum paired with the Tea value computed from it. */
type RequestOutput = readonly [Datum, Value];

/** Decides whether one main Datum has enough child results to move forward. */
type RequestProjector = (
  datum: Datum,
  buffered: readonly RequestOutput[],
) => readonly [Datum, number] | undefined;

/** Values accepted by `Node.bind()`: parameters, one stream, or named streams. */
export type BindingInput =
  | DataStream<unknown>
  | Readonly<Record<string, unknown>>
  | Readonly<Record<string, DataStream<unknown>>>;

/**
 * A compiled Tea program that can be bound to streams and observed as output.
 *
 * The Node keeps one stable JavaScript identity while its immutable compiled
 * module is replaced during binding. It owns the input Observable graph, one
 * child Node per Tea request, and the runtime created when execution starts.
 */
export interface Node {
  /**
   * Returns the complete compiled module tree for the Node's current bindings.
   *
   * @example After `node.bind({length: 20})`, `node.module` contains that
   * parameter value in both the main module and any request child modules.
   */
  readonly module: JSModule;

  /**
   * Supplies parameter values or input streams without starting execution.
   *
   * @example `node.bind({length: 20})` supplies a parameter;
   * `node.bind(closeStream)` supplies the remaining main input series.
   */
  bind(input: BindingInput): Node;

  /**
   * Reports whether the main program and every request child have all inputs.
   *
   * @example A program using `close` is not ready until a DataStream supplying
   * `close` has been bound.
   */
  ready(): boolean;

  /**
   * Observes output and starts execution when the first observer is attached.
   *
   * Later observers share the same runtime and receive only future output.
   *
   * @example `node.to(new StdoutSink())` starts the pipeline and prints each
   * output Datum.
   */
  to(observer: Partial<Observer<Datum>>): Subscription;

  /**
   * Stops the input subscription and releases every main and request runtime.
   *
   * @example Call `node.dispose()` to stop a live Subject or WebSocket source.
   */
  dispose(): void;
}

/**
 * Mutable owner behind the public Node identity.
 *
 * `_module` is this level's compiled program, `data` is its combined input
 * Observable, and `requests` mirrors the compiled request-child array. Binding
 * may replace modules and data while the TeaNode object itself stays stable.
 */
class TeaNode implements Node {
  private _module: JSModule;
  private data: Observable<Datum> | null;
  private requests: TeaNode[];
  private clock: Clock = i;
  private timed = false;
  private readonly results = new Subject<Datum>();
  private runtime: JSRuntime | null = null;
  private connection: Subscription | null = null;
  private started = false;
  private disposed = false;

  /**
   * Creates one Node for this module and one child Node for every Tea request.
   *
   * @example A program declaring `daily = request.security(...)` creates a
   * main TeaNode whose `requests[0]` executes the `daily` expression.
   */
  constructor(module: JSModule) {
    this.data = null;
    this.requests = module.requests.map(request => new TeaNode(request));
    this._module = module;
  }

  /**
   * Rebuilds and returns the current immutable module tree.
   *
   * Each child Node owns its latest module separately, so this getter gathers
   * those child modules before exposing one complete tree.
   *
   * @example After binding the `daily` request stream, `node.module` includes
   * the newly bound child module under `module.requests[0]`.
   */
  get module(): JSModule {
    return this.snapshot();
  }

  /**
   * Classifies the input as parameters or streams and applies it synchronously.
   *
   * Binding changes the Node's configuration and input graph but never
   * subscribes to a DataStream. Binding is rejected after execution starts.
   *
   * @example `node.bind(stream).bind({length: 20})` supplies a stream and then
   * a parameter while returning the same Node from both calls.
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
   * Checks that this module and every request child have all required inputs.
   *
   * @example If the main `close` stream is bound but the `daily` request stream
   * is missing, `ready()` still returns `false`.
   */
  ready(): boolean {
    return (
      this._module.ready() && this.requests.every(request => request.ready())
    );
  }

  /**
   * Attaches an output observer and starts the one shared execution if needed.
   *
   * The first call creates the runtime and subscribes to the prepared input
   * graph. Later calls only observe future Datums from the existing execution.
   *
   * @example With a live Subject, `node.to(stdout)` starts execution;
   * `node.to(csv)` then records the same future outputs without a second run.
   */
  to(observer: Partial<Observer<Datum>>): Subscription {
    if (this.disposed) throw new Error('Node is disposed');
    if (this.started) return this.results.subscribe(observer);
    if (!this.ready()) {
      throw new Error(
        `Node is missing bindings: ${this._module
          .remaining()
          .map(binding => binding.name)
          .join(', ')}`,
      );
    }
    if (this._module.manifest.builtin.length !== 0) {
      throw new Error('Node builtin input wiring is not implemented yet');
    }
    const subscription = this.results.subscribe(observer);
    let execution: Observable<readonly [Datum, StepResult]>;
    try {
      execution = this.steps();
    } catch (error) {
      subscription.unsubscribe();
      this.disposeRuntime();
      throw error;
    }
    this.started = true;

    this.connection = execution.subscribe({
      next: ([, result]) => this.results.next(result.toDatum()),
      error: error => this.results.error(error),
      complete: () => this.results.complete(),
    });
    return subscription;
  }

  /**
   * Stops execution, releases all runtimes, and completes output observers.
   *
   * @example Calling `node.dispose()` twice is safe and performs one teardown.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.connection?.unsubscribe();
    this.disposeRuntime();
    this.results.complete();
  }

  /**
   * Releases this runtime and recursively releases every request-child runtime.
   *
   * @example Disposing a main program with one `daily` request releases both
   * the main JSRuntime and the child JSRuntime.
   */
  private disposeRuntime(): void {
    this.runtime?.dispose();
    this.runtime = null;
    this.requests.forEach(request => request.disposeRuntime());
  }

  /**
   * Applies named parameter values to a new immutable compiled module tree.
   *
   * `bindModule()` recalculates any configuration that depends on the supplied
   * values. `updateModule()` then installs the new main and request modules on
   * their existing Node owners. If a parameter changes which source series is
   * required, the old input Observable is discarded because it no longer
   * describes the program's inputs.
   *
   * @example For `length = input.int(10)`, `{length: 20}` produces a new module
   * tree containing `20`; it does not emit data or start the runtime.
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
        self.clock = i;
        self.timed = false;
      }
    });
  }

  /**
   * Connects DataStreams to the main program and its request children.
   *
   * A single DataStream supplies every still-missing main series. A named
   * object routes each key either to a main series or to the child Node created
   * for a request with that variable name. Binding only builds Observables; it
   * does not subscribe to them.
   *
   * @example `node.bind(closeStream)` supplies `close` to a simple program.
   * `node.bind({close: main, daily: requested})` supplies the main `close`
   * stream and the request declared as `daily`.
   */
  private bindStreams(
    input: DataStream<unknown> | Readonly<Record<string, DataStream<unknown>>>,
  ): Effect.Effect<void, Error> {
    const self = this;
    /**
     * Installs streams that feed fields of this Node's main program.
     *
     * Each pair says which field names to read from one DataStream. The helper
     * checks that known clocks agree, marks those series as supplied in a new
     * module, converts each stream emission into a Datum, and combines it with
     * any main input already bound.
     *
     * @example `[[["close", "open"], bars]]` reads both fields from each
     * object emitted by `bars` and produces Datums such as
     * `{close: 10, open: 9}`.
     */
    const bindRoot = (
      bindings: readonly (readonly [
        names: readonly string[],
        stream: DataStream<unknown>,
      ])[],
    ): Effect.Effect<void, Error> =>
      Effect.gen(function* () {
        if (bindings.length === 0) return;
        const streams = bindings.map(([, stream]) => stream);
        const clocks = [
          self.clock,
          ...streams.map(stream => stream.clock),
        ].filter(clock => clock !== i);
        if (clocks.some(clock => clock !== clocks[0])) {
          return yield* Effect.fail(
            new Error('bound DataStream clocks disagree'),
          );
        }
        const assignments = bindings.flatMap(([names]) =>
          names.map(name => ({kind: 'series' as const, name})),
        );
        const data = bindings.reduce<Observable<Datum> | null>(
          (combined, [names, stream]) =>
            self.combineData(combined, self.sourceData(stream, names)),
          null,
        );
        const module = yield* bindModule(self.snapshot(), assignments);
        self.updateModule(module);
        self.clock = clocks[0] ?? i;
        self.timed ||= streams.some(stream => self.hasTime(stream));
        self.data = self.combineData(self.data, data);
      });

    /**
     * Validates named stream keys and returns the streams owned by this Node.
     *
     * Every key must match exactly one destination: either a main series name
     * or a direct request variable name. Request streams are deliberately left
     * out of the return value because `bindRequestStreams()` passes them to
     * their child Nodes afterward.
     *
     * @example Given `{close: main, daily: child}`, this returns the `close`
     * binding; `daily` is valid but is handled by the request child.
     */
    const rootBindings = (
      input: Readonly<Record<string, DataStream<unknown>>>,
    ) =>
      Effect.gen(function* () {
        const rootNames = self.seriesNames();
        const requestNames = self._module.manifest.requests.map(
          request => request.name,
        );
        for (const name of Object.keys(input)) {
          const root = rootNames.includes(name);
          const requests = requestNames.filter(
            candidate => candidate === name,
          ).length;
          if ((root ? 1 : 0) + requests === 0) {
            return yield* Effect.fail(
              new Error(
                `no bind-known root series or static request child matches '${name}'`,
              ),
            );
          }
          if ((root ? 1 : 0) + requests > 1) {
            return yield* Effect.fail(
              new Error(`stream binding '${name}' is ambiguous`),
            );
          }
        }
        return Object.entries(input)
          .filter(([name]) => rootNames.includes(name))
          .map(([name, stream]) => [[name], stream] as const);
      });

    return Effect.gen(function* () {
      if (input instanceof DataStream) {
        const names = self._module
          .remaining()
          .filter(binding => binding.kind === 'series')
          .map(binding => binding.name);
        yield* bindRoot([[names, input]]);
        return;
      }

      const root = yield* rootBindings(input);
      yield* bindRoot(root);
      yield* self.bindRequestStreams(input);
    });
  }

  /**
   * Passes each named request stream to the child Node that computes it.
   *
   * The compiled request array and the child Node array have the same order.
   * Looking up the request's variable name in `input` therefore identifies the
   * child that should receive that stream. Calling the child's `bindStreams()`
   * recursively applies the same rule to nested requests.
   *
   * @example For `daily = request.security(...)`, `{daily: stream}` is passed
   * to the child Node responsible for calculating `daily`.
   */
  private bindRequestStreams(
    input: Readonly<Record<string, DataStream<unknown>>>,
  ): Effect.Effect<void, Error> {
    const self = this;
    return Effect.gen(function* () {
      for (let requestId = 0; requestId < self.requests.length; requestId++) {
        const child = self.requests[requestId]!;
        const name = self._module.manifest.requests[requestId]?.name;
        const stream = name === undefined ? undefined : input[name];
        if (stream !== undefined) yield* child.bindStreams(stream);
      }
    });
  }

  /**
   * Installs a newly bound immutable module tree without replacing Node objects.
   *
   * Each new child module is matched to the existing child Node at the same
   * request-array position. Existing child owners are updated recursively;
   * a child Node is created only when the new module tree has a new child.
   * This preserves the identity and Observable ownership of the public Node.
   *
   * @example Binding `{length: 20}` replaces the main and `daily` child modules
   * that contain `length`, while `node` remains the same JavaScript object.
   */
  private updateModule(module: JSModule): void {
    const requests = module.requests.map((request, requestId) => {
      const child = this.requests[requestId];
      if (child === undefined) return new TeaNode(request);
      child.updateModule(request);
      return child;
    });
    this._module = module;
    this.requests = requests;
  }

  /**
   * Collects the modules owned by this Node tree into one immutable JSModule.
   *
   * A TeaNode stores its own module and its child TeaNodes separately. This
   * function walks the children, recursively obtains their current modules,
   * and replaces only child references that changed. The result is suitable
   * for `bindModule()` or the public `node.module` getter.
   *
   * @example If only the `daily` child was rebound, `snapshot()` returns the
   * original main module with that one updated child module attached.
   */
  private snapshot(): JSModule {
    if (this.requests.length !== this._module.requests.length) {
      return fatal('TeaNode request state disagrees with JSModule requests');
    }
    return this.requests.reduce((parent, child, requestId) => {
      const childModule = child.snapshot();
      return parent.requests[requestId] === childModule
        ? parent
        : withRequestModule(parent, requestId, childModule);
    }, this._module);
  }

  /**
   * Lists the input-series names read directly by this Node's module.
   *
   * Request-child series are not included because their child Nodes report
   * their own names.
   *
   * @example A main program evaluating `close + open` returns
   * `["close", "open"]`.
   */
  private seriesNames(): readonly string[] {
    return moduleBindings(this._module)
      .filter(binding => binding.kind === 'series')
      .map(binding => binding.name);
  }

  /**
   * Converts one schema-validated DataStream into the Datum shape Node uses.
   *
   * Object emissions contribute only the requested fields. A scalar emission
   * is allowed when exactly one field name is requested. If the schema declares
   * `time: bigint`, the time field is retained and must not move backward.
   *
   * @example With names `["close"]`, `10` and `{close: 10, volume: 5}` both
   * become `{close: 10}`. With names `["close", "open"]`, the source must emit
   * an object containing both fields.
   */
  private sourceData(
    source: DataStream<unknown>,
    names: readonly string[],
  ): Observable<Datum> {
    const timed = this.hasTime(source);
    let previousTime: bigint | null = null;
    return source.asObservable().pipe(
      map(value => {
        const parsed = value;
        if (this.isRecord(parsed)) {
          const entries = names.map(name => {
            if (!Object.hasOwn(parsed, name)) {
              throw new Error(`source value does not provide series '${name}'`);
            }
            return [name, parsed[name]] as const;
          });
          if (timed) {
            const time = parsed.time;
            if (
              typeof time !== 'bigint' ||
              (previousTime !== null && time < previousTime)
            ) {
              throw new Error('DataStream time must be a nondecreasing bigint');
            }
            previousTime = time;
            entries.push(['time', time]);
          }
          return Object.freeze(Object.fromEntries(entries));
        }
        if (names.length === 1) return Object.freeze({[names[0]!]: parsed});
        throw new Error(`source value does not provide series '${names[0]}'`);
      }),
    );
  }

  /**
   * Combines two partial Datum streams into one complete input stream.
   *
   * `null` means that no input has been bound yet. Otherwise values pair in
   * order: the first Datum from each side becomes one merged Datum, followed by
   * the second pair. If both sides carry `time`, their values must match.
   *
   * @example
   * ```text
   * close stream: {close: 10}  {close: 11}
   * open stream:  {open: 9}    {open: 10}
   * combined:     {close: 10, open: 9}
   *               {close: 11, open: 10}
   * ```
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
        if (left === undefined) return undefined;
        if (
          Object.hasOwn(left, 'time') &&
          Object.hasOwn(right, 'time') &&
          left.time !== right.time
        ) {
          throw new Error('synchronized DataStream times disagree');
        }
        return [Object.freeze({...left, ...right}), 1];
      }),
    );
  }

  /**
   * Reports whether the DataStream schema declares an event-time field.
   *
   * @example `z.object({time: z.bigint(), close: z.number()})` returns `true`;
   * a schema containing only `close` returns `false`.
   */
  private hasTime(stream: DataStream<unknown>): boolean {
    return (
      stream.schema instanceof z.ZodObject &&
      stream.schema.shape.time instanceof z.ZodBigInt
    );
  }

  /**
   * Distinguishes a named-field object from scalar, null, and array values.
   *
   * @example `{close: 1}` can supply a field by name; `1`, `null`, and `[1]`
   * cannot.
   */
  private isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  /**
   * Converts a Datum field into the numeric value accepted by JSRuntime.
   *
   * A missing field becomes Tea's numeric missing value (`NaN`). Numbers pass
   * through unchanged, while strings and other host values are rejected.
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
   * Builds the Observable that executes one Tea step for each complete Datum.
   *
   * The starting Observable is the main input assembled by `combineData()`.
   * Every request child is then executed and its result is added under the
   * request variable name. Once a Datum contains all main-series and request
   * values, it is converted into one synchronous `JSRuntime.step()` call. The
   * returned pair keeps the input Datum beside the physical StepResult so a
   * request parent can read child results before public output conversion.
   * Unsubscribing disposes the runtime through `finalize()`.
   *
   * @example `{close: 10, daily: 9}` becomes one runtime step with series
   * `[10]` and request values `[9]`, then emits `[datum, stepResult]`.
   */
  private steps(): Observable<readonly [Datum, StepResult]> {
    if (this._module.manifest.builtin.length !== 0) {
      throw new Error('Node builtin input wiring is not implemented yet');
    }
    const runtime = new JSRuntime(this._module);
    this.runtime = runtime;
    const names = this.seriesNames();
    const specs = this._module.manifest.requests;
    let pending = this.data ?? of(Object.freeze({}) as Datum);
    specs.forEach((spec, requestId) => {
      const child = this.requests[requestId];
      if (child === undefined) {
        return fatal(`request ${requestId} has no child Node`);
      }
      pending = this.synchronize(spec, child, pending);
    });
    return pending.pipe(
      map(datum => {
        const requests = specs.map(spec => {
          if (!Object.hasOwn(datum, spec.name)) {
            return fatal(`request '${spec.name}' was not synchronized`);
          }
          return datum[spec.name] as Value;
        });
        const result = Exit.match(
          Effect.runSyncExit(
            runtime.step({
              series: names.map(name => this.numericSeries(datum[name])),
              builtins: [],
              requests,
              provisional: false,
            }),
          ),
          {
            onFailure: cause => {
              throw Cause.squash(cause);
            },
            onSuccess: value => value,
          },
        );
        return [datum, result] as const;
      }),
      finalize(() => runtime.dispose()),
    );
  }

  /**
   * Executes a request child and exposes the single value its parent requested.
   *
   * A child step may calculate many internal values, but the request declaration
   * identifies one result slot. This function pairs each child input Datum with
   * that copied Tea value so the parent can synchronize the two timelines.
   *
   * @example If the child receives `{close: 9}` and its requested expression is
   * `close * 2`, this Observable emits `[{close: 9}, 18]`.
   */
  private requestOutput(spec: RequestSpec): Observable<RequestOutput> {
    return this.steps().pipe(
      map(([datum]) => {
        const runtime = this.runtime;
        if (runtime === null) return fatal('request child has no runtime');
        return [
          datum,
          runtime.readResult(spec.resultSlot, spec.resultLayout),
        ] as const;
      }),
    );
  }

  /**
   * Adds one request child's results to the main Datum stream through the first
   * applicable synchronization policy:
   *
   * - A scalar request pairs one child result with one main Datum.
   * - A collect request with divisible clocks groups a fixed number of child
   *   results for each main Datum.
   * - Otherwise, timed main and child streams use main event times as window
   *   boundaries.
   * - A collect request with neither clock nor time information falls back to
   *   one child result per main Datum, preserved as a one-element array.
   *
   * Every policy writes its value under the request variable name before the
   * main runtime executes. In the diagrams below, `A+1` means main Datum `A`
   * extended with `{daily: 1}`.
   *
   * @example Scalar one-to-one request:
   * ```text
   * position | 1   | 2   | 3
   * main     | A   | B   | C
   * child    | 1   | 2   | 3
   * output   | A+1 | B+2 | C+3
   * ```
   *
   * @example Collect request with a two-to-one clock ratio:
   * ```text
   * position | 1 | 2       | 3 | 4       | 5 | 6
   * main     | A |         | B |         | C |
   * child    | 1 | 2       | 3 | 4       | 5 | 6
   * output   |   | A+[1,2] |   | B+[3,4] |   | C+[5,6]
   * ```
   *
   * @example Collect request using main event-time windows:
   * ```text
   * event time | 5 | 8 | 10      | 20   | 25 | 30
   * main       |   |   | A       | B    |    | C
   * child      | 1 | 2 |         |      | 3  |
   * output     |   |   | A+[1,2] | B+[] |    | C+[3]
   * ```
   *
   * @example Collect fallback when clocks and event times are unavailable:
   * ```text
   * position | 1     | 2     | 3
   * main     | A     | B     | C
   * child    | 1     | 2     | 3
   * output   | A+[1] | B+[2] | C+[3]
   * ```
   */
  private synchronize(
    spec: RequestSpec,
    child: TeaNode,
    target: Observable<Datum>,
  ): Observable<Datum> {
    const count = this.requestCount(spec, child);
    const project =
      spec.merge.mode === 'sample'
        ? this.oneToOne(spec.name, false)
        : count !== null
          ? this.countWindow(spec.name, count)
          : this.timed && child.timed
            ? this.eventWindow(spec.name)
            : this.oneToOne(spec.name, true);
    return child.requestOutput(spec).pipe(sync(target, project));
  }

  /**
   * Checks request clocks and derives a fixed child count when possible.
   *
   * Clock division answers a simple question: how many equally sized child
   * periods fit exactly inside one main period? It does not inspect observed
   * values or timestamps.
   *
   * @param spec - The request declaration, including its requested timeframe.
   * @param child - The Node executing the requested expression.
   * @returns The exact positive child count for a divisible collect window, or
   * `null` when clock-count synchronization does not apply.
   *
   * @example A five-minute main clock divided by a one-minute child clock
   * yields `5`; a five-minute clock and a two-minute clock have no exact count.
   */
  private requestCount(spec: RequestSpec, child: TeaNode): number | null {
    const expected = timeframeClock(spec.context?.timeframe ?? '');
    if (expected !== i && child.clock !== i && expected !== child.clock) {
      throw new Error(
        `request '${spec.name}' expects clock ${expected}, received ${child.clock}`,
      );
    }
    const childClock = child.clock === i ? expected : child.clock;
    if (
      spec.merge.mode !== 'collect' ||
      this.clock === i ||
      childClock === i ||
      this.clock % childClock !== 0n
    ) {
      return null;
    }
    const ratio = this.clock / childClock;
    if (ratio > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`request '${spec.name}' clock ratio is too large`);
    }
    return Number(ratio);
  }

  /**
   * Pairs main and child values by their arrival order.
   *
   * The first main Datum pairs with the first child result, the second with the
   * second, and so on. A main Datum waits if its child counterpart has not
   * arrived. Timestamps and clocks are ignored.
   *
   * @param name - The request declaration name written into the main datum.
   * @param array - Whether to preserve the collect result as `[value]` instead
   * of exposing the scalar value directly.
   * @returns A function that waits when no child result exists and otherwise
   * consumes the oldest child result.
   *
   * @example
   * ```text
   * main:  A   B   C
   * child: 1   2   3
   * pair:  A+1 B+2 C+3
   * ```
   */
  private oneToOne(name: string, array: boolean): RequestProjector {
    return (datum, buffered) => {
      const first = buffered[0];
      if (first === undefined) return undefined;
      const value = array ? Object.freeze([first[1]]) : first[1];
      return [Object.freeze({...datum, [name]: value}), 1];
    };
  }

  /**
   * Groups a fixed number of child results for each main Datum.
   *
   * One main datum represents one complete group of `count` consecutive child
   * results. The main stream waits until the whole group exists; partial groups
   * never advance the parent program.
   *
   * @param name - The request declaration name written into the main datum.
   * @param count - The number of child values required for each main datum.
   * @returns A function that waits for `count` child results, writes them as
   * one frozen array, and consumes exactly that group.
   *
   * @example With a two-minute main clock and one-minute child clock:
   * ```text
   * main:  A       B       C
   * child: 1   2   3   4   5   6
   * pair:  A+[1,2] B+[3,4] C+[5,6]
   * ```
   */
  private countWindow(name: string, count: number): RequestProjector {
    return (datum, buffered) => {
      if (buffered.length < count) return undefined;
      const values = Object.freeze(
        buffered.slice(0, count).map(([, value]) => value),
      );
      return [Object.freeze({...datum, [name]: values}), count];
    };
  }

  /**
   * Groups child results between consecutive main event times.
   *
   * The first window selects `child.time <= main.time`. Later windows select
   * `previousMain < child.time <= main.time`. Values at or before the previous
   * boundary arrived too late: the projector consumes and drops them. Values
   * after the current boundary remain buffered for a later main datum.
   *
   * @param name - The request declaration name written into the main datum.
   * @returns A function that always writes a frozen array, including an empty
   * array when the current time window contains no child results.
   *
   * @example
   * ```text
   * time:  | 5 | 8 | 10      | 20   | 25 | 30    |
   * main:  |   |   | A       | B    |    | C     |
   * child: | 1 | 2 |         |      | 3  |       |
   * pair:  |   |   | A+[1,2] | B+[] |    | C+[3] |
   * ```
   */
  private eventWindow(name: string): RequestProjector {
    let previousMain: bigint | null = null;
    return (datum, buffered) => {
      const mainTime = datum.time;
      if (
        typeof mainTime !== 'bigint' ||
        (previousMain !== null && mainTime <= previousMain)
      ) {
        throw new Error('main DataStream time must be an increasing bigint');
      }
      const values: Value[] = [];
      let consume = 0;
      for (const [childDatum, value] of buffered) {
        const childTime = childDatum.time;
        if (typeof childTime !== 'bigint') {
          return fatal('timed child datum has no bigint time');
        }
        if (childTime > mainTime) break;
        consume += 1;
        if (previousMain !== null && childTime <= previousMain) {
          // Its window already emitted: consume this late value without
          // publishing it into the current window.
          continue;
        }
        values.push(value);
      }
      previousMain = mainTime;
      return [
        Object.freeze({...datum, [name]: Object.freeze(values)}),
        consume,
      ];
    };
  }
}

/**
 * Creates the public Node owner for one compiled module tree.
 *
 * Construction mirrors request children but does not bind streams, create a
 * runtime, or subscribe to anything.
 *
 * @example A compiled program with no requests creates one Node. A program with
 * `daily = request.security(...)` creates the main Node plus one private child.
 */
export function createNode(module: JSModule): Node {
  return new TeaNode(module);
}
