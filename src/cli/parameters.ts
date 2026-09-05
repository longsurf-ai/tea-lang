// Purpose: Parse source-declared parameter flags for one CLI Batch Recipe.

import {OperationalError} from '../base/operational-error';
import type {Parameter} from '../runtime/params';

export type CliParameterValue = number | string | boolean;

export class CliParameterError extends OperationalError {
  constructor(message: string) {
    super(message);
    this.name = 'CliParameterError';
  }
}

/**
 * Decode only the supplied CLI flags into a parameter patch. Usable defaults,
 * ranges, enum membership, and color normalization belong to Module.bind().
 * Unknown/reserved names, duplicate flags, and unsafe scalar syntax fail here.
 *
 * @example With an integer length declaration, `parseRunParameters(specs,
 * ['--length', '20'])` returns `{length: 20}`; no flags returns `{}`.
 */
export function parseRunParameters(
  specs: readonly Parameter[],
  tokens: readonly string[],
  reservedNames: ReadonlySet<string> = new Set(),
): Readonly<Record<string, CliParameterValue>> {
  const byName = new Map(specs.map(spec => [spec.name, spec]));
  for (const spec of specs) {
    if (reservedNames.has(spec.name)) {
      throw new CliParameterError(
        `source parameter '${spec.name}' conflicts with a reserved command option`,
      );
    }
  }

  const parsed = Object.create(null) as Record<string, CliParameterValue>;
  const seen = new Set<string>();
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    const flag = splitFlag(token);
    const spec = byName.get(flag.name);
    if (spec === undefined) {
      throw new CliParameterError(`unknown parameter option '${token}'`);
    }
    if (seen.has(flag.name)) {
      throw new CliParameterError(
        `parameter '${flag.name}' was specified more than once`,
      );
    }

    let raw = flag.value;
    if (raw === null) {
      index += 1;
      raw = tokens[index] ?? null;
      if (raw === null) {
        throw new CliParameterError(
          `parameter option '${token}' requires a value`,
        );
      }
    }
    parsed[spec.name] = coerceScalar(spec, raw);
    seen.add(spec.name);
  }

  return Object.freeze(parsed);
}

function splitFlag(token: string): {
  readonly name: string;
  readonly value: string | null;
} {
  const prefix = token.startsWith('--') ? 2 : token.startsWith('-') ? 1 : 0;
  if (prefix === 0 || token.length === prefix) {
    throw new CliParameterError(
      `unexpected parameter argument '${token}'; expected --name <value>`,
    );
  }
  const body = token.slice(prefix);
  const equals = body.indexOf('=');
  const name = equals < 0 ? body : body.slice(0, equals);
  const value = equals < 0 ? null : body.slice(equals + 1);
  if (name.length === 0 || value === '') {
    throw new CliParameterError(`invalid parameter option '${token}'`);
  }
  return {name, value};
}

function coerceScalar(spec: Parameter, raw: string): CliParameterValue {
  switch (spec.type) {
    case 'int': {
      if (!/^[+-]?\d+$/.test(raw)) {
        throw new CliParameterError(
          `parameter '${spec.name}' expects an integer, received '${raw}'`,
        );
      }
      const value = Number(raw);
      if (!Number.isSafeInteger(value)) {
        throw new CliParameterError(
          `parameter '${spec.name}' expects a safe integer`,
        );
      }
      return value;
    }
    case 'float': {
      const value = Number(raw);
      if (raw.trim() === '' || !Number.isFinite(value)) {
        throw new CliParameterError(
          `parameter '${spec.name}' expects a finite number`,
        );
      }
      return value;
    }
    case 'bool':
      if (raw !== 'true' && raw !== 'false') {
        throw new CliParameterError(
          `parameter '${spec.name}' expects true or false`,
        );
      }
      return raw === 'true';
    default:
      return raw;
  }
}
