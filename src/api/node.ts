// Purpose: Public Node contract and private RxJS/Effect lifecycle implementation.

import {Cause, Effect, Either, Exit} from 'effect';
import {
  concatMap,
  finalize,
  map,
  Observable,
  of,
  Subject,
  Subscription,
} from 'rxjs';
import * as z from 'zod';
import {fatal} from '../base/print';
import {JSRuntime, type StepResult} from '../runtime/js-runtime';
import {moduleBindings, withRequestModule} from '../runtime/module-binding';
import type {JSModule, RequestSpec} from '../runtime/module-abi';
import type {Value} from '../runtime/value';
import {bindModule} from './binding';
import {i, timeframeClock, type Clock} from './clock';
import type {Sink} from './sink';
import {DataStream} from './stream';
import {sync} from './sync';

type Datum = Readonly<Record<string, unknown>>;
type RequestOutput = readonly [Datum, Value];
type RequestProjector = (
  datum: Datum,
  buffered: readonly RequestOutput[],
) => readonly [Datum, number] | undefined;

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
  private clock: Clock = i;
  private timed = false;
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
  constructor(module: JSModule) {
    this.data = null;
    this.requests = module.requests.map(request => new TeaNode(request));
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
      this._module.ready() && this.requests.every(request => request.ready())
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
    if (this._module.manifest.builtin.length !== 0) {
      throw new Error('Node builtin input wiring is not implemented yet');
    }
    const sinkSubscription = this.results.subscribe(sink);
    let execution: Observable<readonly [Datum, StepResult]>;
    try {
      execution = this.steps();
    } catch (error) {
      sinkSubscription.unsubscribe();
      this.disposeRuntime();
      throw error;
    }
    this.started = true;

    this.connection = execution.subscribe({
      next: ([, result]) => this.results.next(result),
      error: error => this.results.error(error),
      complete: () => this.results.complete(),
    });
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
    this.disposeRuntime();
    this.results.complete();
  }

  /** Dispose every runtime in this private request subtree. */
  private disposeRuntime(): void {
    this.runtime?.dispose();
    this.runtime = null;
    this.requests.forEach(request => request.disposeRuntime());
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
        self.clock = i;
        self.timed = false;
      }
    });
  }

  /**
   * Binds direct series and request-variable streams.
   *
   * @example `{close: root, daily: child}` targets a series and one request.
   */
  private bindStreams(
    input: DataStream<unknown> | Readonly<Record<string, DataStream<unknown>>>,
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
        if (
          self.clock !== i &&
          input.clock !== i &&
          self.clock !== input.clock
        ) {
          return yield* Effect.fail(
            new Error('bound DataStream clocks disagree'),
          );
        }
        const module = yield* bindModule(self.snapshot(), assignments);
        self.updateModule(module);
        if (self.clock === i) self.clock = input.clock;
        self.timed ||= self.hasTime(input);
        self.data = self.combineData(self.data, self.sourceData(input, names));
        return;
      }

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

      const root = Object.entries(input).filter(([name]) =>
        rootNames.includes(name),
      );
      if (root.length !== 0) {
        const clocks = [
          self.clock,
          ...root.map(([, stream]) => stream.clock),
        ].filter(clock => clock !== i);
        if (clocks.some(clock => clock !== clocks[0])) {
          return yield* Effect.fail(
            new Error('bound DataStream clocks disagree'),
          );
        }
        const assignments = root.map(([name]) => ({
          kind: 'series' as const,
          name,
        }));
        const data = root.reduce<Observable<Datum> | null>(
          (combined, [name, stream]) =>
            self.combineData(combined, self.sourceData(stream, [name])),
          null,
        );
        const module = yield* bindModule(self.snapshot(), assignments);
        self.updateModule(module);
        self.clock = clocks[0] ?? i;
        self.timed ||= root.some(([, stream]) => self.hasTime(stream));
        self.data = self.combineData(self.data, data);
      }

      yield* self.bindRequestStreams(input);
    });
  }

  /**
   * Binds each request variable's stream to its generated child Node.
   *
   * @example `input.daily` binds only the request declared as `daily`.
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
   * Updates each Node from the corresponding module in a newly bound tree.
   *
   * @example Parameter concretization replaces child manifests in rid order.
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
   * Builds one recursive module snapshot from the current Node tree.
   *
   * @example `node.module` attaches each `requests[rid].module` only when the
   * caller asks for the complete generated-module tree.
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
    source: DataStream<unknown>,
    names: readonly string[],
  ): Observable<Datum> {
    const timed = this.hasTime(source);
    let previousTime: bigint | null = null;
    return source.asObservable().pipe(
      map(value => {
        const parsed = source.schema.parse(value);
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

  /** Whether this stream's Zod object schema declares `time: bigint`. */
  private hasTime(stream: DataStream<unknown>): boolean {
    return (
      stream.schema instanceof z.ZodObject &&
      stream.schema.shape.time instanceof z.ZodBigInt
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

  /** Execute this Node after recursively synchronizing every request child. */
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
      concatMap(datum =>
        this.stepDatum(
          runtime,
          names,
          datum,
          specs.map(spec => {
            if (!Object.hasOwn(datum, spec.name)) {
              return fatal(`request '${spec.name}' was not synchronized`);
            }
            return datum[spec.name] as Value;
          }),
        ).pipe(map(result => [datum, result] as const)),
      ),
      finalize(() => runtime.dispose()),
    );
  }

  /** Execute a child and expose only its declared request result. */
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

  /** Apply the scalar or collect synchronization selected for one edge. */
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
   * Validate an edge's declared and supplied clocks and derive its batch size.
   *
   * Clock division proves a structural relationship between two regular
   * streams: one main period contains an exact number of child periods. It
   * does not inspect timestamps or observed arrival rates.
   *
   * @param spec - The parent request whose timeframe supplies an expected clock.
   * @param child - The child Node whose bound DataStream supplies its actual clock.
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
   * Synchronize the streams by ordinal position.
   *
   * The first main datum pairs with the first child result, the second with the
   * second, and so on. A main datum waits if its child counterpart has not
   * arrived. This policy assigns no meaning to timestamps or cadence.
   *
   * @param name - The request declaration name written into the main datum.
   * @param array - Whether to preserve the collect result as `[value]` instead
   * of exposing the scalar value directly.
   * @returns A stateless `sync` projector that waits when the child buffer is
   * empty and otherwise consumes exactly its first value.
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
   * Synchronize regular streams by grouping a fixed number of child periods.
   *
   * One main datum represents one complete group of `count` consecutive child
   * results. The main stream waits until the whole group exists; partial groups
   * never advance the parent program.
   *
   * @param name - The request declaration name written into the main datum.
   * @param count - The number of child values required for each main datum.
   * @returns A stateless `sync` projector that waits for `count` buffered
   * values, writes them as one frozen array, and consumes exactly that batch.
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
   * Synchronize irregular streams using main event times as window boundaries.
   *
   * The first window selects `child.time <= main.time`. Later windows select
   * `previousMain < child.time <= main.time`. Values at or before the previous
   * boundary arrived too late: the projector consumes and drops them. Values
   * after the current boundary remain buffered for a later main datum.
   *
   * @param name - The request declaration name written into the main datum.
   * @returns A stateful `sync` projector that always emits a frozen array,
   * including an empty array when the current window contains no child values.
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
    requests: readonly Value[],
  ): Observable<StepResult> {
    return new Observable(subscriber => {
      const cancel = Effect.runCallback(
        runtime.step({
          series: seriesNames.map(name => this.numericSeries(datum[name])),
          builtins: [],
          requests,
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
