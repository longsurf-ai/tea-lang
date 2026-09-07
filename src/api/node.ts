import type {Module} from '../runtime/module-binding';
// Purpose: Public Node contract and private RxJS/Effect lifecycle implementation.

import {
  defer,
  finalize,
  map,
  Observable,
  of,
  type Observer,
  Subject,
  Subscription,
  takeUntil,
} from 'rxjs';
import {DataType, TimeUnit} from 'apache-arrow';
import {fatal} from '../base/print';
import {Context, type StepResult} from '../runtime/js/context';
import {
  moduleSeriesNames,
  requireConcreteModule,
} from '../runtime/module-binding';
import {BindError} from '../runtime/errors';
import {cloneSchema} from '../runtime/io';
import type {Request} from '../runtime/module-abi';
import {createDatum, type Datum} from '../runtime/output';
import {isTupleValue, type Stored} from '../runtime/value';
import {Value, unwrap} from '../runtime/js/value';
import {Color} from '../runtime/color';
import {i, timeframeClock, type Clock} from './clock';
import {DataStream} from './stream';
import {sync, type Wait} from './sync';

export type {Datum} from '../runtime/output';

/** One synchronized set of named input values moving through a Node. */
type InputDatum = Readonly<Record<string, unknown>>;

/** One child input paired with the Tea value computed from it. */
type RequestOutput = readonly [InputDatum, Stored];

/**
 * Decides whether one main input has enough child results to move forward,
 * returning `wait()` when it does not.
 */
type RequestProjector = (
  datum: InputDatum,
  buffered: readonly RequestOutput[],
  wait: () => Wait,
) => readonly [InputDatum, number] | Wait;

/** Supplies the contextual builtin vector for one Node in the request tree. */
type BuiltinSupplier = (
  path: readonly number[],
  module: Module,
  index: number,
  datum: InputDatum,
) => readonly Stored[];

const noBuiltins: BuiltinSupplier = (path, module) => {
  if (module.inputs.builtins.length !== 0) {
    throw new Error(
      `Node builtin input wiring is unavailable at request path ${path.join('.') || 'root'}`,
    );
  }
  return [];
};

/** Values accepted by `Node.bind()`: parameters, one stream, or named streams. */
export type BindingInput =
  | DataStream<unknown>
  | Readonly<Record<string, unknown>>;

/**
 * A compiled Tea program that can be bound to streams and observed as output.
 *
 * The Node and its module keep stable identities. Parameter patches update the
 * module in place; stream connections live only in the Node. It owns the input
 * Observable graph, one child Node per request, and the runtime created when
 * execution starts. Module readiness describes configuration; Node readiness
 * also requires the source streams to be connected.
 */
export interface Node {
  /**
   * The same compiled module owned by this Node, including Arrow schemas and
   * request children. It contains no stream connection state. Binding updates
   * this object in place until execution starts.
   *
   * @example After `node.bind({length: 20})`, `node.module.parameters[0].value`
   * is 20. `node.module.ready()` may be true before `node.ready()`, which also
   * requires connected streams.
   */
  readonly module: Module;

  /**
   * Supplies a parameter patch or connects input streams without subscribing.
   * Parameter binding preserves previous values and fills only unset defaults;
   * stream binding validates every requested field before changing connections.
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
   * If any observer throws while receiving a Datum, the shared execution stops
   * and every observer receives that same error.
   *
   * @example `node.to(new StdoutSink())` starts the pipeline and prints each
   * lossless output Datum.
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
 * A concrete implementation of the public Node interface.
 *
 * `module` is this level's compiled program, `data` is its combined input
 * Observable, and `requests` mirrors the compiled request-child array. Binding
 * updates configuration and data without replacing Node or module objects.
 */
class TeaNode implements Node {
  private data: Observable<InputDatum> | null;
  private readonly connected = new Set<string>();
  private readonly requests: TeaNode[];
  private publication: Module['outputs'] | null = null;
  private clock: Clock = i;
  private timed = false;
  private readonly results = new Subject<Datum>();
  private readonly deliveryFailure = new Subject<never>();
  private runtime: Context | null = null;
  private connection: Subscription | null = null;
  private committedIndices = 0;
  private started = false;
  private disposed = false;

  /**
   * Creates one Node for this module and one child Node for every Tea request.
   *
   * @example A program declaring `daily = request.security(...)` creates a
   * main TeaNode whose `requests[0]` executes the `daily` expression.
   */
  constructor(
    readonly module: Module,
    private readonly builtinSupplier: BuiltinSupplier,
    private readonly path: readonly number[] = [],
  ) {
    this.data = null;
    this.requests = module.requests.map(
      (request, requestId) =>
        new TeaNode(
          request.module,
          builtinSupplier,
          Object.freeze([...path, requestId]),
        ),
    );
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
    if (input instanceof DataStream) {
      this.bindStreams(input);
    } else if (
      Object.keys(input).length !== 0 &&
      Object.values(input).every(value => value instanceof DataStream)
    ) {
      this.bindStreams(input as Readonly<Record<string, DataStream<unknown>>>);
    } else {
      this.module.bind(input);
      this.refresh();
    }
    return this;
  }

  /**
   * Checks that this module and every request child have all required inputs.
   *
   * @example If the main `close` stream is bound but the `daily` request stream
   * is missing, `ready()` still returns `false`.
   */
  ready(): boolean {
    this.refresh();
    return (
      this.module.ready() &&
      this.bindingSeriesNames().every(name => this.connected.has(name)) &&
      this.requests.every(request => request.ready())
    );
  }

  /**
   * Attaches an output observer and starts the one shared execution if needed.
   *
   * The first call creates the runtime and subscribes to the prepared input
   * graph. Later calls only observe future Datums from the existing execution.
   * A thrown `next()` callback fails the shared graph instead of becoming an
   * unhandled RxJS consumer error.
   *
   * @example With a live Subject, `node.to(stdout)` starts execution;
   * `node.to(csv)` then records the same future outputs without a second run.
   */
  to(observer: Partial<Observer<Datum>>): Subscription {
    if (this.disposed) throw new Error('Node is disposed');
    if (this.started) return this.observe(observer);
    if (!this.ready()) {
      const missing = [
        ...this.module.remaining(),
        ...this.bindingSeriesNames().filter(name => !this.connected.has(name)),
        ...this.module.requests
          .filter((_, id) => !this.requests[id]!.ready())
          .map(request => request.name),
      ];
      throw new Error(
        missing.length === 0
          ? 'Node configuration is incomplete'
          : `Node is missing bindings: ${missing.join(', ')}`,
      );
    }
    const subscription = this.observe(observer);
    let execution: Observable<readonly [InputDatum, StepResult, index: number]>;
    try {
      execution = this.steps();
    } catch (error) {
      subscription.unsubscribe();
      this.disposeRuntime();
      throw error;
    }
    // The whole graph passed validation. Close every context before a source
    // can run user callbacks, including request children not yet subscribed.
    const start = (node: TeaNode): void => {
      node.started = true;
      Object.freeze(node.module);
      node.requests.forEach(start);
    };
    start(this);

    this.connection = execution
      .pipe(
        map(([input, result, index]) => this.datum(input, result, index)),
        takeUntil(this.deliveryFailure),
      )
      .subscribe({
        next: datum => this.results.next(datum),
        error: error => this.results.error(error),
        complete: () => this.results.complete(),
      });
    return subscription;
  }

  /**
   * Subscribes one observer and turns a thrown `next()` callback into a shared
   * Node failure.
   *
   * RxJS normally reports exceptions thrown by an Observer as unhandled
   * consumer errors. Routing the exception through `deliveryFailure` instead
   * stops the source graph and sends the same error to every observer.
   */
  private observe(observer: Partial<Observer<Datum>>): Subscription {
    return this.results.subscribe({
      next: datum => {
        try {
          observer.next?.(datum);
        } catch (error) {
          this.deliveryFailure.error(error);
        }
      },
      error: error => observer.error?.(error),
      complete: () => observer.complete?.(),
    });
  }

  /** Adds Node-owned position and source time to one exact step result. */
  private datum(input: InputDatum, result: StepResult, index: number): Datum {
    return createDatum(
      this.publication!.schema,
      index,
      result,
      this.outputTime(input.time),
    );
  }

  /** Converts the public bigint clock to exact epoch milliseconds. */
  private outputTime(value: unknown): number | null | undefined {
    if (value === undefined || value === null) return value;
    if (typeof value === 'number') {
      if (Number.isSafeInteger(value)) return value;
      return fatal('Node input time is not a safe epoch-ms integer');
    }
    if (typeof value !== 'bigint') {
      return fatal('Node input time is not numeric');
    }
    const time = Number(value);
    if (!Number.isSafeInteger(time) || BigInt(time) !== value) {
      return fatal('Node input time is not an exact epoch-ms integer');
    }
    return time;
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
   * the main Context and the child Context.
   */
  private disposeRuntime(): void {
    this.runtime?.dispose();
    this.runtime = null;
    this.requests.forEach(request => request.disposeRuntime());
  }

  /**
   * Connect streams only after every name, schema, clock, and extent passes.
   * Configuration stays in Module; this Node alone records connected series.
   *
   * @example `node.bind({close: prices, daily: dailyPrices})` connects the
   * root close field and the child declared as daily without subscribing either.
   */
  private bindStreams(
    input: DataStream<unknown> | Readonly<Record<string, DataStream<unknown>>>,
  ): void {
    this.refresh();
    const names = this.bindingSeriesNames();
    const root: (readonly [readonly string[], DataStream<unknown>])[] = [];
    const children: (readonly [TeaNode, DataStream<unknown>])[] = [];
    /* Handling name-stream bindings */
    if (input instanceof DataStream) {
      root.push([names.filter(name => !this.connected.has(name)), input]);
    } else {
      for (const [name, stream] of Object.entries(input)) {
        const ids = this.module.requests.flatMap((request, id) =>
          request.name === name ? [id] : [],
        );
        const count = (names.includes(name) ? 1 : 0) + ids.length;
        if (count === 0)
          throw new BindError(
            `no bind-known root series or static request child matches '${name}'`,
          );
        if (count !== 1)
          throw new BindError(`stream binding '${name}' is ambiguous`);
        if (ids.length === 1) children.push([this.requests[ids[0]!]!, stream]);
        else root.push([[name], stream]);
      }
    }
    for (const [names, stream] of root) {
      const error = this.streamError(names, stream);
      if (error !== undefined) throw error;
    }
    for (const [child, stream] of children) {
      const error = child.streamError(
        child.bindingSeriesNames().filter(name => !child.connected.has(name)),
        stream,
      );
      if (error !== undefined) throw error;
    }
    /* find all clocks that are not irregular (i) and check if they are all the same */
    const clocks = [
      this.clock,
      ...root.map(([, stream]) => stream.clock),
    ].filter(clock => clock !== i);
    if (clocks.some(clock => clock !== clocks[0]))
      throw new BindError('bound DataStream clocks disagree');

    for (const [names, stream] of root) {
      this.data = this.combineData(this.data, this.sourceData(stream, names));
      names.forEach(name => this.connected.add(name));
      this.timed ||= this.hasTime(stream);
    }
    this.clock = clocks[0] ?? i;
    for (const [child, stream] of children) child.bindStreams(stream);
  }

  /**
   * Check a stream before changing any binding in the graph.
   * @example A nullable or Utf8 close field fails before another request connects.
   */
  private streamError(
    names: readonly string[],
    stream: DataStream<unknown>,
  ): Error | undefined {
    if (this.clock !== i && stream.clock !== i && this.clock !== stream.clock)
      return new BindError('bound DataStream clocks disagree');
    const fields = stream.schema.fields;
    for (const name of names) {
      if (this.connected.has(name))
        return new BindError(`series '${name}' is already bound`);
      const field = fields.find(field => field.name === name);
      if (field === undefined)
        return new BindError(`source schema does not provide series '${name}'`);
      if (
        field.nullable ||
        (!DataType.isFloat(field.type) &&
          !(DataType.isInt(field.type) && field.type.bitWidth < 64))
      ) {
        return new BindError(`series '${name}' requires a numeric Arrow field`);
      }
    }
  }

  /**
   * Drop obsolete stream connections after a source parameter changes, including
   * patches made directly through node.module.bind(). Other parameters keep the
   * existing graph. A request child owns and refreshes its own connections.
   * @example Changing source from close to open requires binding an open stream.
   */
  private refresh(): void {
    if (this.started) return;
    const names = new Set(
      this.module.inputs.schema.fields.map(field => field.name),
    );
    if ([...this.connected].some(name => !names.has(name))) {
      this.connected.clear();
      this.data = null;
      this.clock = i;
      this.timed = false;
    }
    this.requests.forEach(request => request.refresh());
  }

  /**
   * Lists one input-series name for every sid read by this Node's module.
   *
   * Request-child series are not included because their child Nodes report
   * their own names.
   *
   * Duplicate names remain duplicated because `Context.step()` receives one
   * value per sid even when two slots read the same source field.
   */
  private seriesNames(): readonly string[] {
    return moduleSeriesNames(this.module);
  }

  /** Lists the distinct series names currently visible to public binding. */
  private bindingSeriesNames(): readonly string[] {
    return [...new Set(moduleSeriesNames(this.module))];
  }

  /**
   * Converts one schema-validated DataStream into the input record Node uses.
   *
   * Object emissions contribute only the requested fields. A scalar emission
   * is allowed when exactly one field name is requested. Arrow millisecond
   * timestamps or Int64 time fields retain exact event time and cannot move
   * backward; nullable absent and explicit-null time remain distinct.
   *
   * @example With names `["close"]`, `10` and `{close: 10, volume: 5}` both
   * become `{close: 10}`. With names `["close", "open"]`, the source must emit
   * an object containing both fields.
   */
  private sourceData(
    source: DataStream<unknown>,
    names: readonly string[],
  ): Observable<InputDatum> {
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
          if (timed && parsed.time != null) {
            const time = this.inputTime(parsed.time, 'time');
            if (previousTime !== null && time < previousTime) {
              throw new Error('DataStream time must be a nondecreasing bigint');
            }
            previousTime = time;
            entries.push(['time', time]);
          } else if (timed && Object.hasOwn(parsed, 'time')) {
            entries.push(['time', null]);
          }
          return Object.freeze(Object.fromEntries(entries));
        }
        if (names.length === 1) return Object.freeze({[names[0]!]: parsed});
        throw new Error(`source value does not provide series '${names[0]}'`);
      }),
    );
  }

  /** Validates one exact epoch-millisecond input time before execution. */
  private inputTime(value: unknown, field: 'time'): bigint {
    if (typeof value !== 'bigint' && typeof value !== 'number') {
      throw new Error(`DataStream ${field} must be an exact epoch-ms integer`);
    }
    const number = Number(value);
    if (
      !Number.isSafeInteger(number) ||
      (typeof value === 'bigint' && BigInt(number) !== value)
    ) {
      throw new Error(`DataStream ${field} must be an exact epoch-ms integer`);
    }
    return BigInt(number);
  }

  /**
   * Combines two partial input streams into one complete input stream.
   *
   * `null` means that no input has been bound yet. Otherwise values pair in
   * order: the first value from each side becomes one merged input, followed by
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
    current: Observable<InputDatum> | null,
    next: Observable<InputDatum> | null,
  ): Observable<InputDatum> | null {
    if (current === null) return next;
    if (next === null) return current;
    return current.pipe(
      sync(next, (right, buffered, wait) => {
        const left = buffered[0];
        if (left === undefined) return wait();
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
   * @example A Schema with a TimestampMillisecond `time` field returns `true`;
   * a schema containing only Float64 `close` returns `false`.
   */
  private hasTime(stream: DataStream<unknown>): boolean {
    const type = stream.schema.fields.find(
      field => field.name === 'time',
    )?.type;
    return (
      (DataType.isTimestamp(type) && type.unit === TimeUnit.MILLISECOND) ||
      (DataType.isInt(type) && type.bitWidth === 64)
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
   * Converts one input field into the numeric value accepted by Context.
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
   * Builds the Observable that executes one Tea step for each complete input.
   *
   * The starting Observable is the main input assembled by `combineData()`.
   * Every request child is then executed and its result is added under the
   * request variable name. Once an input contains all main-series and request
   * values, it is converted into one synchronous `Context.step()` call. The
   * returned pair keeps the input record beside the physical StepResult so a
   * request parent can read child results before public output conversion.
   * Unsubscribing disposes the runtime through `finalize()`.
   *
   * @example `{close: 10, daily: 9}` becomes one runtime step with series
   * `[10]` and request values `[9]`, then emits `[datum, stepResult]`.
   */
  private steps(): Observable<
    readonly [InputDatum, StepResult, index: number]
  > {
    requireConcreteModule(this.module);
    const names = this.seriesNames();
    const specs = this.module.requests;
    let pending = this.data ?? of(Object.freeze({}) as InputDatum);
    specs.forEach((spec, requestId) => {
      const child = this.requests[requestId];
      if (child === undefined) {
        return fatal(`request ${requestId} has no child Node`);
      }
      pending = this.synchronize(spec, child, pending);
    });
    return defer(() => {
      const runtime = new Context(this.module);
      this.runtime = runtime;
      this.publication = {
        ...this.module.outputs,
        schema: cloneSchema(this.module.outputs.schema),
      };
      return pending.pipe(
        map(datum => {
          const index = this.committedIndices;
          const requests = specs.map(spec => {
            if (!Object.hasOwn(datum, spec.name)) {
              return fatal(`request '${spec.name}' was not synchronized`);
            }
            return datum[spec.name] as Stored;
          });
          const result = runtime.step({
            series: names.map(name => this.numericSeries(datum[name])),
            builtins: this.builtinSupplier(
              this.path,
              this.module,
              index,
              datum,
            ),
            requests,
            provisional: false,
          });
          if (!result.provisional) this.committedIndices += 1;
          return [datum, result, index] as const;
        }),
        finalize(() => runtime.dispose()),
      );
    });
  }

  /**
   * Executes a request child and exposes the single value its parent requested.
   *
   * A child step may calculate many internal values, but the request declaration
   * identifies one result slot. This function pairs each child input record with
   * that copied Tea value so the parent can synchronize the two timelines.
   *
   * @example If the child receives `{close: 9}` and its requested expression is
   * `close * 2`, this Observable emits `[{close: 9}, 18]`.
   */
  private requestOutput(spec: Request): Observable<RequestOutput> {
    return this.steps().pipe(
      map(([datum]) => {
        const runtime = this.runtime;
        if (runtime === null) return fatal('request child has no runtime');
        return [
          this.requestTiming(datum),
          this.copyRequestResult(
            spec.resultEmpty,
            runtime.readResult(spec.resultSlot, spec.resultEmpty),
          ),
        ] as const;
      }),
    );
  }

  /** Retains only the event time while a child result is buffered. */
  private requestTiming(datum: InputDatum): InputDatum {
    return Object.freeze(datum.time === undefined ? {} : {time: datum.time});
  }

  /** Copies one scalar or tuple across a child runtime boundary. */
  private copyRequestResult(expected: Value<unknown>, value: Stored): Stored {
    expected.assertStored(value);
    if (
      value === null ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      typeof value === 'string' ||
      value instanceof Color
    )
      return value;
    if (expected.kind === 'tuple' && isTupleValue(value)) {
      return Object.freeze(
        expected.elements!.map((element, index) =>
          element.withStored(
            this.copyRequestResult(
              element,
              unwrap(value[index] as Value<unknown>),
            ),
          ),
        ),
      );
    }
    throw new Error(
      `request result '${expected.kind}' cannot cross a Node boundary`,
    );
  }

  /**
   * Adds one request child's results to the main input stream through the first
   * applicable synchronization policy:
   *
   * - A timed scalar request selects the newest child opened at or before the
   *   main event time and applies its `fill` policy; an untimed scalar
   *   request pairs one child result with one main input.
   * - A timed collect request uses main event times as window boundaries.
   * - Without usable event times, a collect request with divisible clocks
   *   groups a fixed number of child results for each main input.
   * - A collect request with neither clock nor time information falls back to
   *   one child result per main input, preserved as a one-element array.
   *
   * Every policy writes its value under the request variable name before the
   * main runtime executes. In the diagrams below, `A+1` means main input `A`
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
   * @example Timed scalar request with carried fill:
   * ```text
   * event time | 0    | 1   | 2
   * main       | A    | B   | C
   * child      |      | 1   |
   * output     | A+na | B+1 | C+1
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
    spec: Request,
    child: TeaNode,
    target: Observable<InputDatum>,
  ): Observable<InputDatum> {
    const childClock = this.requestClock(spec, child);
    let continueAfterSourceComplete = false;
    let project: RequestProjector;
    if (spec.mode === 'sample') {
      const timed = this.timed && child.timed;
      project = timed ? this.sample(spec) : this.oneToOne(spec.name, false);
      continueAfterSourceComplete = timed;
    } else if (this.timed && child.timed) {
      project = this.eventWindow(spec.name);
      continueAfterSourceComplete = true;
    } else {
      const count = this.requestCount(spec, childClock);
      project =
        count === null
          ? this.oneToOne(spec.name, true)
          : this.countWindow(spec.name, count);
    }
    return child
      .requestOutput(spec)
      .pipe(sync(target, project, continueAfterSourceComplete));
  }

  /**
   * Selects the newest child result opened at or before the main event time
   * and applies the request's fill policy.
   *
   * The selected child remains buffered so a completed finite child stream can
   * continue serving later parent inputs. Older child values are consumed once
   * a newer eligible child becomes current.
   */
  private sample(spec: Request): RequestProjector {
    const context = spec.context;
    if (context === null || context === undefined) {
      return fatal(`request '${spec.name}' has no concrete context`);
    }
    const empty = spec.empty.value as Stored;
    let selected: RequestOutput | null = null;
    let previousBoundary: bigint | null = null;
    return (datum, buffered) => {
      const boundary = this.eventTime(datum, 'parent');
      if (previousBoundary !== null && boundary < previousBoundary) {
        return fatal('parent request interval boundary moved backward');
      }
      let selectedIndex = -1;
      let latePrefix = 0;
      for (let index = 0; index < buffered.length; index += 1) {
        const candidate = buffered[index]!;
        const available = this.eventTime(candidate[0], 'child');
        if (
          candidate !== selected &&
          previousBoundary !== null &&
          available <= previousBoundary
        ) {
          latePrefix = index + 1;
          continue;
        }
        if (available > boundary) break;
        selectedIndex = index;
      }
      const next = selectedIndex < 0 ? selected : buffered[selectedIndex]!;
      const advanced = next !== null && next !== selected;
      if (next !== null) selected = next;
      const value =
        selected === null || (context.fill === 'sparse' && !advanced)
          ? empty
          : selected[1];
      previousBoundary = boundary;
      const consume = advanced
        ? selectedIndex
        : latePrefix > 0
          ? latePrefix
          : Math.max(0, selectedIndex);
      return [Object.freeze({...datum, [spec.name]: value}), consume];
    };
  }

  /** Reads the event time of one timed input. */
  private eventTime(datum: InputDatum, owner: 'parent' | 'child'): bigint {
    const value = datum.time;
    if (typeof value !== 'bigint') {
      return fatal(`${owner} request input requires a bigint time`);
    }
    return value;
  }

  /** Validates the requested clock and returns the child's effective clock. */
  private requestClock(spec: Request, child: TeaNode): Clock {
    const expected = timeframeClock(spec.context?.timeframe ?? '');
    if (expected !== i && child.clock !== i && expected !== child.clock) {
      throw new Error(
        `request '${spec.name}' expects clock ${expected}, received ${child.clock}`,
      );
    }
    return child.clock === i ? expected : child.clock;
  }

  /**
   * Derives a fixed child count when neither interval policy applies.
   *
   * Clock division answers a simple question: how many equally sized child
   * periods fit exactly inside one main period? It does not inspect observed
   * values or timestamps.
   *
   * @param spec - The request declaration, including its requested timeframe.
   * @param childClock - The validated effective clock of the request child.
   * @returns The exact positive child count for a divisible collect window, or
   * `null` when clock-count synchronization does not apply.
   *
   * @example A five-minute main clock divided by a one-minute child clock
   * yields `5`; a five-minute clock and a two-minute clock have no exact count.
   */
  private requestCount(spec: Request, childClock: Clock): number | null {
    if (
      spec.mode !== 'collect' ||
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
   * The first main input pairs with the first child result, the second with the
   * second, and so on. A main input waits if its child counterpart has not
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
    return (datum, buffered, wait) => {
      const first = buffered[0];
      if (first === undefined) return wait();
      const value = array ? Object.freeze([first[1]]) : first[1];
      return [Object.freeze({...datum, [name]: value}), 1];
    };
  }

  /**
   * Groups a fixed number of child results for each main input.
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
    return (datum, buffered, wait) => {
      if (buffered.length < count) return wait();
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
      const values: Stored[] = [];
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
export function createNode(
  module: Module,
  builtinSupplier: BuiltinSupplier = noBuiltins,
): Node {
  return new TeaNode(module, builtinSupplier);
}
