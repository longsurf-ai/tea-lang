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
  constructor(
    readonly program: Program,
    private readonly bound: BoundModule | null = null,
    private readonly rows: Observable<Readonly<Record<string, unknown>>> | null =
      null,
  ) {}

  bind(input: TeaBindingInput): TeaNode {
    const requirements = this.bound?.remaining() ?? extract(this.program)[0];
    const prepared = prepareBinding(input, requirements);
    const next = Effect.runSync(
      bindModule(this.bound ?? this.program, prepared.assignments),
    );
    return new TeaNode(
      this.program,
      next,
      combineRows(this.rows, prepared.rows),
    );
  }

  ready(): boolean {
    return this.bound?.ready() ?? false;
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
      throw new Error('TeaNode static request wiring is not implemented yet');
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
