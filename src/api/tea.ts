// Purpose: JavaScript embedding API — compile Tea source into a TeaNode whose
// immutable binding steps attach parameter values and concrete Observables.

import {Effect} from 'effect';
import {map, type Observable} from 'rxjs';
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
import type {Sink} from './sink';
import {DataStream} from './stream';

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
  ) {}

  bind(input: TeaBindingInput): TeaNode {
    const requirements = this.bound?.remaining() ?? extract(this.program)[0];
    const assignments = assignmentsFor(input, requirements);
    const next = Effect.runSync(
      bindModule(this.bound ?? this.program, assignments),
    );
    return new TeaNode(this.program, next);
  }

  ready(): boolean {
    return this.bound?.ready() ?? false;
  }

  /** Internal handoff used when execution wiring is installed by `to()`. */
  boundModule(): BoundModule | null {
    return this.bound;
  }

  to(_sink: Sink<unknown>): void {
    if (!this.ready()) {
      throw new Error(
        `TeaNode is missing bindings: ${this.bound?.remaining().map(binding => binding.name).join(', ') ?? 'all inputs'}`,
      );
    }
    throw new Error('TeaNode execution wiring is not implemented yet');
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

function assignmentsFor(
  input: TeaBindingInput,
  requirements: readonly Binding[],
): readonly BindingAssignment[] {
  if (input instanceof DataStream) {
    const series = requirements.filter(
      (binding): binding is Extract<Binding, {kind: 'series'}> =>
        binding.kind === 'series',
    );
    return series.map(binding => ({
      kind: 'series' as const,
      name: binding.name,
      target: projectSeries(input.asObservable(), binding.name, series.length),
    }));
  }

  const entries = Object.entries(input);
  if (entries.every((entry): entry is [string, DataStream<unknown>] =>
    entry[1] instanceof DataStream,
  )) {
    return entries.map(([name, stream]) => ({
      kind: 'series' as const,
      name,
      target: projectSeries(stream.asObservable(), name, 1),
    }));
  }

  return entries.map(([name, target]) => ({
    kind: 'parameter' as const,
    name,
    target,
  }));
}

function projectSeries(
  source: Observable<unknown>,
  name: string,
  boundSeries: number,
): Observable<unknown> {
  return source.pipe(
    map(value => {
      if (isRecord(value) && Object.hasOwn(value, name)) {
        return value[name];
      }
      if (boundSeries === 1) return value;
      throw new Error(`source value does not provide series '${name}'`);
    }),
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
