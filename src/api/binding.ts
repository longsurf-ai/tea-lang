import {Effect} from 'effect';
import {isObservable, type Observable} from 'rxjs';
import * as z from 'zod';
import {OperationalError} from '../base/operational-error';
import {generate} from '../codegen/codegen';
import type {Program} from '../ir/program';
import {TypeKind, type Type} from '../ir/type';
import {seriesInputsOf} from '../ir/visit';
import {BindError} from '../runtime/errors';
import {loadModule} from '../runtime/load';
import type {TeaModule} from '../runtime/module-abi';
import {resolveParamValues} from '../runtime/params';
import {
  boundModuleCode,
  installBoundModuleState,
} from './bound-module-internal';
import {
  ModuleBindingEvaluationError,
  evaluateModuleBinding,
  freezeGeneratedModule,
  type BoundModuleFacts,
} from './module-binding';

export type Binding =
  | {
      readonly kind: 'series';
      readonly name: string;
      readonly type: z.ZodType;
      readonly target?: Observable<unknown>;
    }
  | {
      readonly kind: 'parameter';
      readonly name: string;
      readonly type: z.ZodType;
      readonly target?: unknown;
    };

/** One semantic value supplied to a Program binding requirement. */
export type BindingAssignment =
  | {
      readonly kind: 'series';
      readonly name: string;
      readonly target: Observable<unknown>;
    }
  | {
      readonly kind: 'parameter';
      readonly name: string;
      readonly target: unknown;
    };

export type BindingErrorCode =
  | 'UNKNOWN_BINDING'
  | 'BINDING_KIND_MISMATCH'
  | 'DUPLICATE_BINDING'
  | 'INVALID_BINDING'
  | 'UNSUPPORTED_BINDING';

/** An expected failure while applying host values to Program requirements. */
export class BindingError extends OperationalError {
  constructor(
    readonly code: BindingErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'BindingError';
  }
}

/**
 * The immutable binding-time view of one Program.
 *
 * A BoundModule may still have missing bindings. `ready()` means only that
 * every semantic input requirement has a target; it does not mean that any
 * Observable has been subscribed.
 */
export interface BoundModule {
  readonly program: Program;
  readonly bindings: readonly Binding[];

  ready(): boolean;
  remaining(): readonly Binding[];
}

/**
 * Apply parameter values and series targets without mutating either input.
 *
 * Passing a Program creates its first BoundModule. Passing a BoundModule
 * applies another immutable binding step. Observable wiring and subscription
 * ownership stay with the API layer that constructs the assignments.
 */
export function bindModule(
  target: Program | BoundModule,
  supplied: readonly BindingAssignment[],
): Effect.Effect<BoundModule, BindingError> {
  return Effect.gen(function* () {
    const module = isBoundModule(target)
      ? target
      : makeBoundModule(
          target,
          freezeGeneratedModule(loadModule(generate(target))),
          extract(target)[0],
          null,
        );
    let bindings = module.bindings;

    for (const assignment of supplied) {
      const sameName = bindings.filter(
        binding => binding.name === assignment.name,
      );
      const matches = sameName.filter(
        binding => binding.kind === assignment.kind,
      );

      if (matches.length === 0) {
        if (sameName.length !== 0) {
          yield* Effect.fail(
            new BindingError(
              'BINDING_KIND_MISMATCH',
              `binding '${assignment.name}' is ${sameName[0].kind}, not ${assignment.kind}`,
            ),
          );
        }
        yield* Effect.fail(
          new BindingError(
            'UNKNOWN_BINDING',
            `unknown ${assignment.kind} binding '${assignment.name}'`,
          ),
        );
      }

      if (matches.some(hasTarget)) {
        yield* Effect.fail(
          new BindingError(
            'DUPLICATE_BINDING',
            `${assignment.kind} binding '${assignment.name}' is already bound`,
          ),
        );
      }

      let boundTarget: unknown = assignment.target;
      if (assignment.kind === 'series') {
        if (!isObservable(assignment.target)) {
          yield* Effect.fail(
            new BindingError(
              'INVALID_BINDING',
              `series binding '${assignment.name}' expects an Observable`,
            ),
          );
        }
      } else {
        const parsed = matches[0].type.safeParse(assignment.target);
        if (!parsed.success) {
          yield* Effect.fail(
            new BindingError(
              'INVALID_BINDING',
              `parameter binding '${assignment.name}' does not match its Tea type`,
            ),
          );
        }
        boundTarget = parsed.data;
      }

      bindings = Object.freeze(
        bindings.map(binding => {
          if (
            binding.name !== assignment.name ||
            binding.kind !== assignment.kind
          ) {
            return binding;
          }
          if (assignment.kind === 'series') {
            if (binding.kind !== 'series') return binding;
            return freezeBinding({...binding, target: assignment.target});
          }
          if (binding.kind !== 'parameter') return binding;
          return freezeBinding({...binding, target: boundTarget});
        }),
      );
    }

    const code = boundModuleCode(module);
    const facts = bindings.every(hasTarget)
      ? yield* bindFacts(code, bindings)
      : null;
    return makeBoundModule(module.program, code, bindings, facts);
  });
}

class ImmutableBoundModule implements BoundModule {
  readonly program: Program;
  readonly bindings: readonly Binding[];

  constructor(
    program: Program,
    bindings: readonly Binding[],
    private readonly complete: boolean,
  ) {
    this.program = program;
    this.bindings = Object.freeze(bindings.map(freezeBinding));
    Object.freeze(this);
  }

  ready(): boolean {
    return this.complete;
  }

  remaining(): readonly Binding[] {
    return Object.freeze(this.bindings.filter(binding => !hasTarget(binding)));
  }
}

function isBoundModule(value: Program | BoundModule): value is BoundModule {
  return value instanceof ImmutableBoundModule;
}

function makeBoundModule(
  program: Program,
  code: TeaModule,
  bindings: readonly Binding[],
  facts: BoundModuleFacts | null,
): BoundModule {
  const module = new ImmutableBoundModule(program, bindings, facts !== null);
  installBoundModuleState(module, code, facts);
  return module;
}

function bindFacts(
  code: TeaModule,
  bindings: readonly Binding[],
): Effect.Effect<BoundModuleFacts, BindingError> {
  return Effect.try({
    try: () => {
      const rawParams = Object.fromEntries(
        bindings
          .filter(
            (binding): binding is Extract<
              Binding,
              {readonly kind: 'parameter'}
            > => binding.kind === 'parameter' && hasTarget(binding),
          )
          .map(binding => [binding.name, binding.target]),
      );
      const values = resolveParamValues(code.manifest.params, rawParams);
      return evaluateModuleBinding(code, values);
    },
    catch: error => {
      if (error instanceof BindError) {
        return new BindingError('INVALID_BINDING', error.message);
      }
      if (error instanceof ModuleBindingEvaluationError) {
        return new BindingError('UNSUPPORTED_BINDING', error.message);
      }
      throw error;
    },
  });
}

function hasTarget(binding: Binding): boolean {
  return Object.hasOwn(binding, 'target');
}

function freezeBinding(binding: Binding): Binding {
  return Object.freeze({...binding});
}

type Pair<A, B> = [A, B];

/**
 * Extract input and output bindings from a Program.
 *
 * Inputs contain the Program's declared parameters, context series, and
 * recursive request contexts. Output channels are series bindings.
 */
export function extract(program: Program): Pair<Binding[], Binding[]> {
  const schemas = new Map<Type, z.ZodType>();
  return [
    inputBindingsOf(program, schemas),
    outputBindingsOf(program, schemas),
  ];
}

function inputBindingsOf(
  program: Program,
  schemas: Map<Type, z.ZodType>,
): Binding[] {
  const bindings: Binding[] = [
    ...program.params.map<Binding>(parameter => ({
      kind: 'parameter',
      name: parameter.name,
      type: schemaOf(parameter.type, schemas),
    })),
    ...seriesInputsOf(program).map<Binding>(series => ({
      kind: 'series',
      name: series.id,
      type: schemaOf(series.type, schemas),
    })),
  ];

  return bindings;
}

function outputBindingsOf(
  program: Program,
  schemas: Map<Type, z.ZodType>,
): Binding[] {
  return program.outputs.flatMap((output, outputId) => {
    const prefix = `${output.effect}[${outputId}]`;
    const qualifyChannel = output.channels.length > 1;
    return output.channels.map<Binding>(channel => ({
      kind: 'series',
      name: qualifyChannel ? `${prefix}.${channel.name}` : prefix,
      type: schemaOf(channel.type, schemas),
    }));
  });
}

function schemaOf(type: Type, schemas: Map<Type, z.ZodType>): z.ZodType {
  const existing = schemas.get(type);
  if (existing !== undefined) {
    return existing;
  }

  let schema: z.ZodType;
  switch (type.kind) {
    case TypeKind.Int:
      schema = z.union([z.number().int(), z.nan()]);
      break;
    case TypeKind.Float:
      schema = z.union([z.number(), z.nan()]);
      break;
    case TypeKind.Bool:
      schema = z.boolean();
      break;
    case TypeKind.String:
    case TypeKind.Color:
      schema = z.string().nullable();
      break;
    case TypeKind.Enum: {
      const members = type.members.map(member => member.name);
      schema = (
        members.length === 0
          ? z.never()
          : z.enum(members as [string, ...string[]])
      ).nullable();
      break;
    }
    case TypeKind.Array:
      schema = z.array(schemaOf(type.elem, schemas)).nullable();
      break;
    case TypeKind.Matrix:
      schema = z.array(z.array(schemaOf(type.elem, schemas))).nullable();
      break;
    case TypeKind.Map:
      schema = z
        .map(schemaOf(type.key, schemas), schemaOf(type.value, schemas))
        .nullable();
      break;
    case TypeKind.Struct:
      // Structs may be recursive through collections, so install the lazy
      // schema in the identity cache before visiting their fields.
      schema = z.lazy(() =>
        z
          .object(
            Object.fromEntries(
              type.fields.map(field => [
                field.name,
                schemaOf(field.type, schemas),
              ]),
            ),
          )
          .nullable(),
      );
      schemas.set(type, schema);
      return schema;
    case TypeKind.Tuple: {
      const elements = type.elems.map(elem => schemaOf(elem, schemas));
      schema = (
        elements.length === 0
          ? z.tuple([])
          : z.tuple(elements as [z.ZodType, ...z.ZodType[]])
      ).nullable();
      break;
    }
    case TypeKind.Line:
    case TypeKind.Label:
    case TypeKind.Box:
    case TypeKind.Table:
    case TypeKind.Polyline:
    case TypeKind.Linefill:
      schema = z
        .object({
          kind: z.literal('resource'),
          handle: z.literal(type.kind),
          id: z.number().int(),
        })
        .nullable();
      break;
    case TypeKind.Na:
      schema = z.union([z.nan(), z.null()]);
      break;
    case TypeKind.Invalid:
    case TypeKind.Void:
    case TypeKind.Plot:
    case TypeKind.Hline:
    case TypeKind.Func:
      schema = z.never();
      break;
  }

  schemas.set(type, schema);
  return schema;
}
