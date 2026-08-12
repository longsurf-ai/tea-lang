// Purpose: Project and resolve Tea parameters once for every host/backend.

import {fatal} from '../base/print';
import {
  ParamConstraintKind,
  ParamDefaultKind,
  type ParamInput,
} from '../ir/program';
import {isNaValue, TypeKind, type ConstValue} from '../ir/type';
import {BindError, type ManifestValue, type ParamSpec, type Value} from './abi';

// ParamSpec is the sole bind-independent parameter schema. Both codegen
// targets and hosts consume this projection instead of reconstructing input
// semantics from Program expressions.
export function paramSpecsOf(
  params: readonly ParamInput[],
): readonly ParamSpec[] {
  return params.map(param => ({
    name: param.name,
    title: param.title,
    type: paramType(param),
    control: param.control,
    group: param.group,
    inline: param.inline,
    tooltip: param.tooltip,
    confirm: param.confirm,
    display: param.display,
    defaultValue: paramDefault(param),
    constraints: paramConstraints(param),
    enumType:
      param.type.kind === TypeKind.Enum
        ? {
            name: param.type.name,
            members: param.type.members.map(member => ({...member})),
          }
        : null,
    // Source parameters are assigned their target series slot by JS codegen.
    // Other consumers use this neutral projection directly.
    seriesSid: null,
  }));
}

// Pure resolution shared by CPU, GPU, and CLI validation. Callers provide
// already-parsed host values; this function applies defaults and enforces the
// complete ParamSpec value/constraint contract in declaration order.
export function resolveParamValues(
  specs: readonly ParamSpec[],
  raw: Readonly<Record<string, unknown>>,
): readonly Value[] {
  const known = new Set(specs.map(spec => spec.name));
  for (const name of Object.keys(raw)) {
    if (!known.has(name)) {
      throw new BindError(`unknown parameter '${name}'`);
    }
  }
  const values: Value[] = [];
  for (const spec of specs) {
    const provided = raw[spec.name];
    const candidate = provided !== undefined ? provided : spec.defaultValue;
    let value: Value;
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
      const color = canonicalInputColor(candidate);
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

function paramType(param: ParamInput): ParamSpec['type'] {
  if (param.defaultValue?.kind === ParamDefaultKind.Series) {
    return 'source';
  }
  switch (param.type.kind) {
    case TypeKind.Int:
      return 'int';
    case TypeKind.Float:
      return 'float';
    case TypeKind.Bool:
      return 'bool';
    case TypeKind.String:
      return 'string';
    case TypeKind.Color:
      return 'color';
    case TypeKind.Enum:
      return 'enum';
    default:
      return fatal(`param '${param.name}' has no manifest type`);
  }
}

function paramDefault(param: ParamInput): ParamSpec['defaultValue'] {
  if (param.defaultValue === null) {
    return null;
  }
  if (param.defaultValue.kind === ParamDefaultKind.Series) {
    return param.defaultValue.series.id;
  }
  return constValue(param.defaultValue.value);
}

function constValue(value: ConstValue): ManifestValue {
  if (isNaValue(value)) {
    return null;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return fatal('non-finite constant reached parameter manifest construction');
  }
  return value;
}

function numericOrNull(value: ConstValue | null): number | null {
  if (typeof value !== 'number') {
    return null;
  }
  return Number.isFinite(value)
    ? value
    : fatal(
        'non-finite numeric constraint reached parameter manifest construction',
      );
}

function paramConstraints(param: ParamInput): ParamSpec['constraints'] {
  const constraints = param.constraints;
  if (constraints === null) {
    return null;
  }
  switch (constraints.kind) {
    case ParamConstraintKind.Range:
      return {
        kind: ParamConstraintKind.Range,
        minval: numericOrNull(constraints.minval),
        maxval: numericOrNull(constraints.maxval),
        step: numericOrNull(constraints.step),
      };
    case ParamConstraintKind.Options:
      return {
        kind: ParamConstraintKind.Options,
        options: constraints.options.map(value => constValue(value)),
      };
  }
}

function canonicalInputColor(value: string): string | null {
  const match = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(value);
  if (match === null) {
    return null;
  }
  const base = `#${match[1].toUpperCase()}`;
  const alpha = match[2]?.toUpperCase();
  return alpha === undefined || alpha === 'FF' ? base : `${base}${alpha}`;
}
