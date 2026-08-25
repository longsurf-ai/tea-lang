import {Effect} from 'effect';
import {OperationalError} from '../base/operational-error';
import {BindError} from '../runtime/errors';
import type {JSModule, ModuleBinding} from '../runtime/module-abi';
import {resolveParamValues} from '../runtime/params';
import type {ManifestValue, Value} from '../runtime/value';
import {
  ModuleBindingEvaluationError,
  moduleBindings,
  withModuleBindings,
} from '../runtime/module-binding';

/** One host-neutral value supplied to a generated module requirement. */
export type BindingAssignment =
  | {
      readonly kind: 'series';
      readonly name: string;
    }
  | {
      readonly kind: 'parameter';
      readonly name: string;
      readonly value: unknown;
    };

export type BindingErrorCode =
  | 'UNKNOWN_BINDING'
  | 'BINDING_KIND_MISMATCH'
  | 'DUPLICATE_BINDING'
  | 'INVALID_BINDING'
  | 'UNSUPPORTED_BINDING';

/** An expected failure while applying values to module requirements. */
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
 * Apply parameter values and series-supplied markers without mutating the
 * module. Concrete streams remain owned by the public Node implementation.
 */
export function bindModule(
  module: JSModule,
  supplied: readonly BindingAssignment[],
): Effect.Effect<JSModule, BindingError> {
  return Effect.gen(function* () {
    let bindings = moduleBindings(module);

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

      if (
        assignment.kind === 'series' &&
        matches.some(inputSupplied)
      ) {
        yield* Effect.fail(
          new BindingError(
            'DUPLICATE_BINDING',
            `${assignment.kind} binding '${assignment.name}' is already bound`,
          ),
        );
      }

      let parameterValue: Value | undefined;
      if (assignment.kind === 'parameter') {
        const pid = module.manifest.params.findIndex(
          spec => spec.name === assignment.name,
        );
        try {
          parameterValue = resolveParamValues(module.manifest.params, {
            [assignment.name]: assignment.value,
          })[pid];
        } catch (error) {
          if (error instanceof BindError) {
            yield* Effect.fail(
              new BindingError('INVALID_BINDING', error.message),
            );
          }
          throw error;
        }
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
            return freezeModuleInput({...binding, supplied: true});
          }
          if (binding.kind !== 'parameter') return binding;
          return freezeModuleInput({
            ...binding,
            value: parameterValue as ManifestValue,
          });
        }),
      );
    }

    return yield* Effect.try({
      try: () => withModuleBindings(module, bindings),
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
  });
}

function inputSupplied(input: ModuleBinding): boolean {
  return input.kind === 'series'
    ? input.supplied
    : Object.hasOwn(input, 'value');
}

function freezeModuleInput(input: ModuleBinding): ModuleBinding {
  return Object.freeze({...input});
}
