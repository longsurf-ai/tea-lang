// Parameter declarations and validation of host-supplied scalar values.

import {fatal} from '../base/print';
import {canonicalColor} from '../base/color';
import {BindError} from './errors';
import type {ParamDisplay} from '../ir/program';
import type {Scalar} from './value';

/**
 * One named parameter's declaration and current binding status. Constraints and
 * display metadata come from Tea; Module.bind validates and supplies the value.
 * A successful bind replaces parameter records atomically, so read the module's
 * current record when displaying newly bound values.
 *
 * @example
 * For `length = input.int(14, minval=1)`:
 * ```ts
 * module.parameters[0].defaultValue; // 14
 * module.parameters[0].value;        // undefined before binding
 * const configured = module.bind({length: 20});
 * module.parameters[0].value;        // 20
 * ```
 */
export interface Parameter {
  readonly name: string;
  readonly title: string | null;
  readonly type:
    | 'int'
    | 'float'
    | 'bool'
    | 'string'
    | 'color'
    | 'source'
    | 'enum';
  readonly control: string;
  readonly defaultValue: Scalar;
  /** Validated supplied value or applied default; absent before binding. */
  readonly value?: Scalar;
  /** Whether the control is active; null until its binding expression resolves. */
  readonly active: boolean | null;
  readonly constraints:
    | {
        readonly kind: 'range';
        readonly minval: number | null;
        readonly maxval: number | null;
        readonly step: number | null;
      }
    | {readonly kind: 'options'; readonly options: readonly Scalar[]}
    | null;
  readonly enumType: {
    /** Nominal declaration identity, independent of member spellings or title. */
    readonly typeId?: string;
    readonly name: string;
    readonly members: readonly {
      readonly name: string;
      readonly title: string;
    }[];
  } | null;
  readonly group: string | null;
  readonly inline: string | null;
  readonly tooltip: string | null;
  readonly confirm: boolean;
  readonly display: ParamDisplay;
  readonly seriesSid: number | null;
}

/**
 * Validate named values and apply declaration defaults. No module or stream is
 * mutated here; the module binder commits the returned scalars atomically.
 * @example `resolveParamValues([length], {length: 20})` returns `[20]`.
 */
export function resolveParamValues(
  specs: readonly Parameter[],
  raw: Readonly<Record<string, unknown>>,
): readonly Scalar[] {
  const known = new Set(specs.map(spec => spec.name));
  for (const name of Object.keys(raw)) {
    if (!known.has(name)) throw new BindError(`unknown parameter '${name}'`);
  }
  const values: Scalar[] = [];
  for (const spec of specs) {
    const provided = raw[spec.name];
    const candidate = provided !== undefined ? provided : spec.defaultValue;
    let value: Scalar;
    if (spec.type === 'int' || spec.type === 'float') {
      if (typeof candidate !== 'number') {
        throw new BindError(`parameter '${spec.name}' expects a number`);
      }
      if (!Number.isFinite(candidate)) {
        throw new BindError(`parameter '${spec.name}' expects a finite number`);
      }
      if (spec.type === 'int' && !Number.isSafeInteger(candidate)) {
        throw new BindError(`parameter '${spec.name}' expects a safe integer`);
      }
      value = candidate;
    } else if (spec.type === 'bool') {
      if (typeof candidate !== 'boolean') {
        throw new BindError(`parameter '${spec.name}' expects a boolean`);
      }
      value = candidate;
    } else if (spec.type === 'color') {
      if (typeof candidate !== 'string') {
        throw new BindError(`parameter '${spec.name}' expects a color`);
      }
      const color = canonicalColor(candidate);
      if (color === null) {
        throw new BindError(
          `parameter '${spec.name}' expects #RRGGBB or #RRGGBBAA`,
        );
      }
      value = color;
    } else if (spec.type === 'enum') {
      if (typeof candidate !== 'string') {
        throw new BindError(`parameter '${spec.name}' expects an enum member`);
      }
      const enumType = spec.enumType;
      if (enumType === null) {
        return fatal(`enum parameter '${spec.name}' has no enum metadata`);
      }
      if (!enumType.members.some(member => member.name === candidate)) {
        throw new BindError(
          `parameter '${spec.name}' is not a member of enum '${enumType.name}'`,
        );
      }
      value = candidate;
    } else {
      if (typeof candidate !== 'string') {
        throw new BindError(`parameter '${spec.name}' expects a string`);
      }
      value = candidate;
    }
    const constraints = spec.constraints;
    if (constraints?.kind === 'range') {
      if (typeof value !== 'number') {
        return fatal(
          `non-numeric parameter '${spec.name}' has range constraints`,
        );
      }
      if (constraints.minval !== null && value < constraints.minval) {
        throw new BindError(
          `parameter '${spec.name}' below minval ${constraints.minval}`,
        );
      }
      if (constraints.maxval !== null && value > constraints.maxval) {
        throw new BindError(
          `parameter '${spec.name}' above maxval ${constraints.maxval}`,
        );
      }
    } else if (
      constraints?.kind === 'options' &&
      !constraints.options.some(option => option === value)
    ) {
      throw new BindError(
        `parameter '${spec.name}' must be one of ${constraints.options.map(String).join(', ')}`,
      );
    }
    values.push(value);
  }
  return values;
}
