// Purpose: Project Program parameter declarations into the target-neutral host schema.

import {fatal} from '../base/print';
import {IrKind} from '../ir/node';
import {
  ParamConstraintKind,
  ParamDefaultKind,
  type ParamInput,
} from '../ir/program';
import {isNaValue, TypeKind, type ConstValue, type Type} from '../ir/type';
import type {Parameter} from '../runtime/params';
import type {Scalar} from '../runtime/value';

/**
 * Preserve parameter constraints and enum identity in either backend.
 * @example `parametersOf(program.params, program.nominalIds)[0].defaultValue`
 * reads the checked default without binding a run.
 */
export function parametersOf(
  params: readonly ParamInput[],
  nominalIds: ReadonlyMap<Type, string>,
): readonly Parameter[] {
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
    active:
      param.active.kind === IrKind.Const &&
      typeof param.active.value === 'boolean'
        ? param.active.value
        : null,
    constraints: paramConstraints(param),
    enumType:
      param.type.kind === TypeKind.Enum
        ? {
            name: param.type.name,
            ...(nominalIds.has(param.type)
              ? {typeId: nominalIds.get(param.type)}
              : {}),
            members: param.type.members.map(member => ({...member})),
          }
        : null,
    seriesSid: null,
  }));
}

function paramType(param: ParamInput): Parameter['type'] {
  if (param.defaultValue?.kind === ParamDefaultKind.Series) return 'source';
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
      return fatal(`param '${param.name}' has no parameter type`);
  }
}

function paramDefault(param: ParamInput): Parameter['defaultValue'] {
  if (param.defaultValue === null) return null;
  if (param.defaultValue.kind === ParamDefaultKind.Series) {
    return param.defaultValue.series.id;
  }
  return constValue(param.defaultValue.value);
}

function constValue(value: ConstValue): Scalar {
  if (isNaValue(value)) return null;
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return fatal(
      'non-finite constant reached parameter declaration construction',
    );
  }
  return value;
}

function numericOrNull(value: ConstValue | null): number | null {
  if (typeof value !== 'number') return null;
  return Number.isFinite(value)
    ? value
    : fatal(
        'non-finite numeric constraint reached parameter declaration construction',
      );
}

function paramConstraints(param: ParamInput): Parameter['constraints'] {
  const constraints = param.constraints;
  if (constraints === null) return null;
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
