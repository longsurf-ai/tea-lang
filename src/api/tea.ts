// Purpose: JavaScript embedding API — compile Tea source into a stable TeaNode
// that owns binding-time Observable composition and one execution lifecycle.

import {Effect} from 'effect';
import {
  concatMap,
  finalize,
  from,
  map,
  of,
  share,
  Subject,
  Subscription,
  type Observable,
} from 'rxjs';
import {OperationalError} from '../base/operational-error';
import {formatPos} from '../base/pos';
import {Errors, type ErrorMsg} from '../base/print';
import {compileToProgram} from '../compile';
import {generate} from '../codegen/codegen';
import {bindModule, type BindingAssignment} from './binding';
import type {Sink} from './sink';
import {DataStream} from './stream';
import {sync} from './sync';
import {JSRuntime, type StepResult} from '../runtime/js-runtime';
import {loadModule} from '../runtime/load';
import {
  requireModuleBinding,
  withRequestModule,
} from '../runtime/module-binding';
import type {JSModule, ModuleInputBinding} from '../runtime/module-abi';

const TEMPLATE_FILENAME = '<tea-template>';

export class TeaCompileError extends OperationalError {
  constructor(readonly errors: readonly ErrorMsg[]) {
    super(
      errors.map(error => `${formatPos(error.pos)}: ${error.msg}`).join('\n'),
    );
    this.name = 'TeaCompileError';
  }
}

export type TeaBindingInput =
  | DataStream<unknown>
  | Readonly<Record<string, unknown>>
  | Readonly<Record<string, DataStream<unknown>>>;

/**
 * Public Tea program node. Its JSModule tracks host-neutral binding state
 * while the node owns concrete Observables and their composition.
 */
export class TeaNode {
  private state: TeaNodeState;
  private readonly results = new Subject<StepResult>();
  private runtime: JSRuntime | null = null;
  private connection: Subscription | null = null;
  private started = false;
  private disposed = false;

  constructor(module: JSModule) {
    this.state = initialNodeState(module);
  }

  get module(): JSModule {
    return this.state.module;
  }

  bind(input: TeaBindingInput): TeaNode {
    this.assertBindable();
    this.state = bindNodeState(this.state, input);
    return this;
  }

  ready(): boolean {
    return stateReady(this.state);
  }

  to(sink: Sink<StepResult>): Subscription {
    this.assertLive();
    if (this.started) return this.results.subscribe(sink);

    if (!this.ready()) {
      throw new Error(
        `TeaNode is missing bindings: ${this.module
          .remaining()
          .map(binding => binding.name)
          .join(', ')}`,
      );
    }
    const binding = requireModuleBinding(this.module);
    if (this.module.manifest.builtin.length !== 0) {
      throw new Error('TeaNode builtin input wiring is not implemented yet');
    }
    if (binding.requests.length !== 0) {
      // A request child needs temporal merge semantics. DataStream currently
      // exposes only values, so choosing row order as time would invent a
      // contract for alignment, missing values, and provisional finality.
      throw new Error(
        'TeaNode request execution requires time and finality semantics that DataStream does not provide',
      );
    }

    const sinkSubscription = this.results.subscribe(sink);
    let runtime: JSRuntime;
    try {
      runtime = new JSRuntime(this.module);
    } catch (error) {
      sinkSubscription.unsubscribe();
      throw error;
    }
    this.runtime = runtime;
    this.started = true;

    const seriesNames = this.module.bindings
      .filter(
        (binding): binding is Extract<ModuleInputBinding, {kind: 'series'}> =>
          binding.kind === 'series',
      )
      .map(binding => binding.name);
    const inputRows: Observable<Readonly<Record<string, unknown>>> =
      this.state.rows ??
      of(Object.freeze({}) as Readonly<Record<string, unknown>>);

    const connection = new Subscription();
    this.connection = connection;
    connection.add(
      inputRows
        .pipe(
          concatMap(row =>
            from(
              Effect.runPromise(
                runtime.step({
                  series: seriesNames.map(name => numericSeries(row[name])),
                  builtins: [],
                  requests: [],
                  provisional: false,
                }),
              ),
            ),
          ),
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

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.connection?.unsubscribe();
    this.runtime?.dispose();
    this.results.complete();
  }

  private assertBindable(): void {
    this.assertLive();
    if (this.started) {
      throw new Error('TeaNode cannot bind after execution has started');
    }
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('TeaNode is disposed');
  }
}

type Row = Readonly<Record<string, unknown>>;

interface TeaNodeState {
  readonly module: JSModule;
  readonly rows: Observable<Row> | null;
  readonly requests: readonly TeaNodeState[];
}

function stateReady(state: TeaNodeState): boolean {
  return (
    state.module.ready() && state.requests.every(request => stateReady(request))
  );
}

function initialNodeState(module: JSModule): TeaNodeState {
  const requests = module.requests.map(request =>
    initialNodeState(bindEmpty(request)),
  );
  return nodeState(module, null, requests);
}

function bindNodeState(
  state: TeaNodeState,
  input: TeaBindingInput,
): TeaNodeState {
  if (isKeyedStreams(input)) return bindStreams(state, input);
  const prepared = prepareBinding(input, state.module.remaining());
  const module = Effect.runSync(bindModule(state.module, prepared.assignments));
  return stateWithModule(state, module, combineRows(state.rows, prepared.rows));
}

function bindStreams(
  state: TeaNodeState,
  input: Readonly<Record<string, DataStream<unknown>>>,
): TeaNodeState {
  let draft = state;
  const entries = Object.entries(input);
  const rootSeries = new Set(
    draft.module.bindings
      .filter(
        (binding): binding is Extract<ModuleInputBinding, {kind: 'series'}> =>
          binding.kind === 'series',
      )
      .map(binding => binding.name),
  );
  const rootEntries = entries.filter(([name]) => rootSeries.has(name));

  if (rootEntries.length !== 0) {
    const prepared = prepareBinding(
      Object.fromEntries(rootEntries),
      draft.module.bindings,
    );
    const module = Effect.runSync(
      bindModule(draft.module, prepared.assignments),
    );
    draft = stateWithModule(
      draft,
      module,
      combineRows(draft.rows, prepared.rows),
    );
    for (const [name] of rootEntries) {
      if (requestPaths(draft, name).length !== 0) {
        throw new Error(
          `binding key '${name}' is both a root series and a static request context`,
        );
      }
    }
  }

  const pending = new Map(entries.filter(([name]) => !rootSeries.has(name)));
  let progressed = true;
  while (pending.size !== 0 && progressed) {
    progressed = false;
    for (const [name, stream] of pending) {
      const paths = requestPaths(draft, name);
      if (paths.length === 0) continue;
      if (paths.length > 1) {
        throw new Error(`static request binding key '${name}' is ambiguous`);
      }
      draft = bindRequestPath(draft, paths[0]!, stream);
      pending.delete(name);
      progressed = true;
    }
  }

  if (pending.size !== 0) {
    const name = pending.keys().next().value as string;
    throw new Error(
      `no bind-known root series or static request child matches '${name}'`,
    );
  }
  return draft;
}

function requestPaths(
  state: TeaNodeState,
  name: string,
): readonly (readonly number[])[] {
  const direct = (state.module.binding?.requests ?? []).flatMap(
    (request, requestId) =>
      request.symbol === name ? [[requestId] as const] : [],
  );
  const nested = state.requests.flatMap((child, requestId) =>
    requestPaths(child, name).map(
      path => [requestId, ...path] as readonly number[],
    ),
  );
  return [...direct, ...nested];
}

function bindRequestPath(
  state: TeaNodeState,
  path: readonly number[],
  stream: DataStream<unknown>,
): TeaNodeState {
  const [requestId, ...rest] = path;
  const child = requestId === undefined ? undefined : state.requests[requestId];
  if (child === undefined) throw new Error('invalid TeaNode request path');

  const nextChild =
    rest.length === 0
      ? bindNodeState(child, stream)
      : bindRequestPath(child, rest, stream);
  const requests = [...state.requests];
  requests[requestId] = nextChild;
  return nodeState(
    withRequestModule(state.module, requestId, nextChild.module),
    state.rows,
    requests,
  );
}

function stateWithModule(
  state: TeaNodeState,
  module: JSModule,
  rows: Observable<Row> | null,
): TeaNodeState {
  const next = bindEmpty(module);
  const requests = next.requests.map((request, requestId) => {
    const child = state.requests[requestId];
    return child === undefined
      ? initialNodeState(request)
      : stateWithModule(child, request, child.rows);
  });
  return nodeState(next, rows, requests);
}

function nodeState(
  module: JSModule,
  rows: Observable<Row> | null,
  requests: readonly TeaNodeState[],
): TeaNodeState {
  if (requests.length !== module.requests.length) {
    throw new Error('TeaNode request state disagrees with JSModule requests');
  }
  const attached = requests.reduce(
    (parent, child, requestId) =>
      parent.requests[requestId] === child.module
        ? parent
        : withRequestModule(parent, requestId, child.module),
    module,
  );
  return Object.freeze({
    module: attached,
    rows,
    requests: Object.freeze([...requests]),
  });
}

/** Compile Tea source from a tagged template into its API-level TeaNode. */
export function tea(
  strings: TemplateStringsArray,
  ...args: readonly unknown[]
): TeaNode {
  const source = dedent(
    strings.raw.reduce(
      (result, part, index) =>
        result + part + (index < args.length ? String(args[index]) : ''),
      '',
    ),
  );
  const errors = new Errors();
  const program = compileToProgram(
    [{filename: TEMPLATE_FILENAME, source}],
    errors,
  );
  if (program === null) {
    throw new TeaCompileError(errors.flushErrors());
  }

  return new TeaNode(bindEmpty(loadModule(generate(program))));
}

function bindEmpty(module: JSModule): JSModule {
  return Effect.runSync(bindModule(module, []));
}

interface PreparedBinding {
  readonly assignments: readonly BindingAssignment[];
  readonly rows: Observable<Readonly<Record<string, unknown>>> | null;
}

function prepareBinding(
  input: TeaBindingInput,
  requirements: readonly ModuleInputBinding[],
): PreparedBinding {
  if (input instanceof DataStream) {
    const series = requirements.filter(
      (binding): binding is Extract<ModuleInputBinding, {kind: 'series'}> =>
        binding.kind === 'series',
    );
    const rows = sourceRows(
      input.asObservable(),
      series.map(item => item.name),
    );
    return {
      assignments: series.map(binding => ({
        kind: 'series' as const,
        name: binding.name,
      })),
      rows,
    };
  }

  const entries = Object.entries(input);
  if (
    entries.every(
      (entry): entry is [string, DataStream<unknown>] =>
        entry[1] instanceof DataStream,
    )
  ) {
    const sources = entries.map(([name, stream]) => {
      const rows = sourceRows(stream.asObservable(), [name]);
      return {
        assignment: {
          kind: 'series' as const,
          name,
        },
        rows,
      };
    });
    return {
      assignments: sources.map(source => source.assignment),
      rows: sources.reduce<Observable<
        Readonly<Record<string, unknown>>
      > | null>((combined, source) => combineRows(combined, source.rows), null),
    };
  }

  return {
    assignments: entries.map(([name, target]) => ({
      kind: 'parameter' as const,
      name,
      value: target,
    })),
    rows: null,
  };
}

function isKeyedStreams(
  input: TeaBindingInput,
): input is Readonly<Record<string, DataStream<unknown>>> {
  return (
    !(input instanceof DataStream) &&
    Object.values(input).every(value => value instanceof DataStream)
  );
}

function sourceRows(
  source: Observable<unknown>,
  names: readonly string[],
): Observable<Readonly<Record<string, unknown>>> {
  return source.pipe(
    map(value => {
      if (isRecord(value)) {
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

function combineRows(
  current: Observable<Readonly<Record<string, unknown>>> | null,
  next: Observable<Readonly<Record<string, unknown>>> | null,
): Observable<Readonly<Record<string, unknown>>> | null {
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

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numericSeries(value: unknown): number {
  if (value === undefined) return Number.NaN;
  if (typeof value !== 'number') {
    throw new TypeError('Tea series input must be numeric');
  }
  return value;
}

function dedent(source: string): string {
  const lines = source.split(/\r?\n/);
  while (lines[0]?.trim() === '') lines.shift();
  while (lines.at(-1)?.trim() === '') lines.pop();

  const contentLines = lines.filter(line => line.trim() !== '');
  let prefix = contentLines[0]?.match(/^[ \t]*/)?.[0] ?? '';
  for (const line of contentLines.slice(1)) {
    while (prefix !== '' && !line.startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
    }
  }
  return lines.map(line => line.slice(prefix.length)).join('\n');
}
