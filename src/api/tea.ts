// Purpose: JavaScript embedding API — compile Tea source into a TeaNode whose
// immutable binding steps attach parameter values and concrete Observables.

import {Effect} from 'effect';
import {
  concatMap,
  finalize,
  from,
  map,
  of,
  share,
  type Observable,
} from 'rxjs';
import {OperationalError} from '../base/operational-error';
import {formatPos} from '../base/pos';
import {Errors, type ErrorMsg} from '../base/print';
import {compileToProgram} from '../compile';
import type {Program} from '../ir/program';
import {
  bindModule,
  extract,
  type Binding,
  type BindingAssignment,
  type BoundModule,
} from './binding';
import {boundModuleFacts} from './bound-module-internal';
import type {Sink} from './sink';
import {DataStream} from './stream';
import {sync} from './sync';
import {
  StateMachineRuntime,
  type StepResult,
} from '../runtime/state-machine-runtime';
import {ValueLayoutRegistry} from '../runtime/value-layout';

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
 * Public Tea program node. It owns the canonical Program and the concrete
 * Observables attached by successive immutable binding steps.
 */
export class TeaNode {
  private readonly requestChildren: readonly TeaNode[];

  constructor(
    readonly program: Program,
    private readonly bound: BoundModule | null = null,
    private readonly rows: Observable<Readonly<Record<string, unknown>>> | null =
      null,
    requestChildren?: readonly TeaNode[],
  ) {
    const children =
      requestChildren ??
      program.requests.map(request => new TeaNode(request.child));
    if (children.length !== program.requests.length) {
      throw new Error('TeaNode request children disagree with Program requests');
    }
    this.requestChildren = Object.freeze([...children]);
  }

  bind(input: TeaBindingInput): TeaNode {
    if (isKeyedStreams(input)) {
      return this.bindKeyedStreams(input);
    }
    const requirements = this.bound?.remaining() ?? extract(this.program)[0];
    const prepared = prepareBinding(input, requirements);
    const next = Effect.runSync(
      bindModule(this.bound ?? this.program, prepared.assignments),
    );
    return new TeaNode(
      this.program,
      next,
      combineRows(this.rows, prepared.rows),
      this.requestChildren,
    );
  }

  ready(): boolean {
    return (
      (this.bound?.ready() ?? false) &&
      this.requestChildren.every(child => child.ready())
    );
  }

  /** Internal handoff used when execution wiring is installed by `to()`. */
  boundModule(): BoundModule | null {
    return this.bound;
  }

  to(sink: Sink<StepResult>): void {
    if (!this.ready()) {
      throw new Error(
        `TeaNode is missing bindings: ${this.bound?.remaining().map(binding => binding.name).join(', ') ?? 'all inputs'}`,
      );
    }
    const facts = boundModuleFacts(this.bound!);
    if (facts === null) {
      throw new Error('ready BoundModule has no runtime facts');
    }
    if (facts.code.manifest.builtin.length !== 0) {
      throw new Error('TeaNode builtin input wiring is not implemented yet');
    }
    if (facts.requests.length !== 0) {
      // A request child needs temporal merge semantics. DataStream currently
      // exposes only values, so choosing row order as time would invent a
      // contract for alignment, missing values, and provisional finality.
      throw new Error(
        'TeaNode request execution requires time and finality semantics that DataStream does not provide',
      );
    }

    const runtime = new StateMachineRuntime(
      facts.code,
      facts.params.map(param => param.value),
      new ValueLayoutRegistry(facts.code.aggregateLayouts),
    );
    const seriesNames = this.bound!.bindings
      .filter(
        (binding): binding is Extract<Binding, {kind: 'series'}> =>
          binding.kind === 'series',
      )
      .map(binding => binding.name);
    const inputRows: Observable<Readonly<Record<string, unknown>>> =
      this.rows ??
      of(Object.freeze({}) as Readonly<Record<string, unknown>>);

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
        next: result => sink.next(result),
        error: error => sink.error(error),
        complete: () => sink.complete(),
      });
  }

  private bindKeyedStreams(
    input: Readonly<Record<string, DataStream<unknown>>>,
  ): TeaNode {
    let node = this.ensureBoundModule();
    const entries = Object.entries(input);
    const rootSeries = new Set(
      node.bound!.bindings
        .filter(
          (binding): binding is Extract<Binding, {kind: 'series'}> =>
            binding.kind === 'series',
        )
        .map(binding => binding.name),
    );
    const rootEntries = entries.filter(([name]) => rootSeries.has(name));

    if (rootEntries.length !== 0) {
      const prepared = prepareBinding(
        Object.fromEntries(rootEntries),
        node.bound!.bindings,
      );
      const next = Effect.runSync(
        bindModule(node.bound!, prepared.assignments),
      );
      node = new TeaNode(
        node.program,
        next,
        combineRows(node.rows, prepared.rows),
        node.requestChildren,
      );
      for (const [name] of rootEntries) {
        if (node.requestPaths(name).length !== 0) {
          throw new Error(
            `binding key '${name}' is both a root series and a static request context`,
          );
        }
      }
    }

    const pending = new Map(
      entries.filter(([name]) => !rootSeries.has(name)),
    );
    let progressed = true;
    while (pending.size !== 0 && progressed) {
      progressed = false;
      for (const [name, stream] of pending) {
        const paths = node.requestPaths(name);
        if (paths.length === 0) continue;
        if (paths.length > 1) {
          throw new Error(
            `static request binding key '${name}' is ambiguous`,
          );
        }
        node = node.bindRequestPath(paths[0]!, stream);
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
    return node;
  }

  private ensureBoundModule(): TeaNode {
    if (this.bound !== null) return this;
    return new TeaNode(
      this.program,
      Effect.runSync(bindModule(this.program, [])),
      this.rows,
      this.requestChildren,
    );
  }

  private requestPaths(name: string): readonly (readonly number[])[] {
    const direct =
      this.bound === null
        ? []
        : (boundModuleFacts(this.bound)?.requests ?? [])
            .filter(request => request.symbol === name)
            .map(request => [request.requestId] as const);
    const nested = this.requestChildren.flatMap((child, requestId) =>
      child
        .requestPaths(name)
        .map(path => [requestId, ...path] as readonly number[]),
    );
    return [...direct, ...nested];
  }

  private bindRequestPath(
    path: readonly number[],
    stream: DataStream<unknown>,
  ): TeaNode {
    const [requestId, ...rest] = path;
    const child =
      requestId === undefined ? undefined : this.requestChildren[requestId];
    if (child === undefined) {
      throw new Error('invalid TeaNode request path');
    }
    const nextChild =
      rest.length === 0
        ? child.bind(stream)
        : child.bindRequestPath(rest, stream);
    const children = [...this.requestChildren];
    children[requestId] = nextChild;
    return new TeaNode(this.program, this.bound, this.rows, children);
  }
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
  return new TeaNode(program);
}

interface PreparedBinding {
  readonly assignments: readonly BindingAssignment[];
  readonly rows: Observable<Readonly<Record<string, unknown>>> | null;
}

function prepareBinding(
  input: TeaBindingInput,
  requirements: readonly Binding[],
): PreparedBinding {
  if (input instanceof DataStream) {
    const series = requirements.filter(
      (binding): binding is Extract<Binding, {kind: 'series'}> =>
        binding.kind === 'series',
    );
    const rows = sourceRows(input.asObservable(), series.map(item => item.name));
    return {
      assignments: series.map(binding => ({
        kind: 'series' as const,
        name: binding.name,
        target: rows.pipe(map(row => row[binding.name])),
      })),
      rows,
    };
  }

  const entries = Object.entries(input);
  if (entries.every((entry): entry is [string, DataStream<unknown>] =>
    entry[1] instanceof DataStream,
  )) {
    const sources = entries.map(([name, stream]) => {
      const rows = sourceRows(stream.asObservable(), [name]);
      return {
        assignment: {
          kind: 'series' as const,
          name,
          target: rows.pipe(map(row => row[name])),
        },
        rows,
      };
    });
    return {
      assignments: sources.map(source => source.assignment),
      rows: sources.reduce<Observable<Readonly<Record<string, unknown>>> | null>(
        (combined, source) => combineRows(combined, source.rows),
        null,
      ),
    };
  }

  return {
    assignments: entries.map(([name, target]) => ({
      kind: 'parameter' as const,
      name,
      target,
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
                throw new Error(`source value does not provide series '${name}'`);
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
