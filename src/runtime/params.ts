// Purpose: Resolve raw host parameter values against one generated ParamSpec schema.

import {fatal} from '../base/print';
import {BindError} from './errors';
import type {ParamSpec} from './schema';
import type {Value} from './value';

export function resolveParamValues(
  specs: readonly ParamSpec[],
  raw: Readonly<Record<string, unknown>>,
): readonly Value[] {
  const known = new Set(specs.map(spec => spec.name));
  for (const name of Object.keys(raw)) {
    if (!known.has(name)) throw new BindError(`unknown parameter '${name}'`);
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

function canonicalInputColor(value: string): string | null {
  const match = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(value);
  if (match === null) return null;
  const base = `#${match[1].toUpperCase()}`;
  const alpha = match[2]?.toUpperCase();
  return alpha === undefined || alpha === 'FF' ? base : `${base}${alpha}`;
}
