// Purpose: Parse source-declared parameter flags after Commander has parsed the fixed CLI surface.

import {
  ExecutionParameterError,
  resolveExecutionParameters,
  type ParameterExecutionConfig,
  type ResolvedParameterAxis,
} from '../execution/parameters';
import type {ParameterScalar, ParameterSelection} from '../execution/config';
import type {ParamSpec} from '../runtime/abi';

export type CliParameterValue = ParameterScalar;

export class CliParameterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliParameterError';
  }
}

export interface SweepParameterOptions {
  readonly maxScenarios: number;
  readonly reservedNames?: ReadonlySet<string>;
}

export type SweepAxis = ResolvedParameterAxis;

export interface ExpandedParameterSweep {
  readonly axes: readonly SweepAxis[];
  readonly parameterSets: readonly Readonly<
    Record<string, CliParameterValue>
  >[];
}

// Dynamic flags deliberately accept both conventional `--length` and the
// Pine-friendly `-length` spelling. Commander owns fixed host flags first;
// this parser sees only the tokens it did not recognize.
export function parseRunParameters(
  specs: readonly ParamSpec[],
  tokens: readonly string[],
  reservedNames: ReadonlySet<string> = new Set(),
): Readonly<Record<string, CliParameterValue>> {
  const parameters = parseRunParameterSelections(specs, tokens, reservedNames);
  const execution = {
    kind: 'run',
    parameters,
  } as const;
  const resolved = invokeResolver(specs, execution).parameterSets[0]!;
  return Object.fromEntries(
    Object.keys(parameters).map(name => [name, resolved[name]!]),
  );
}

export function parseRunParameterSelections(
  specs: readonly ParamSpec[],
  tokens: readonly string[],
  reservedNames: ReadonlySet<string> = new Set(),
): Readonly<Record<string, ParameterSelection>> {
  return parseAssignments(specs, tokens, reservedNames, false);
}

export function parseSweepParameterSelections(
  specs: readonly ParamSpec[],
  tokens: readonly string[],
  reservedNames: ReadonlySet<string> = new Set(),
): Readonly<Record<string, ParameterSelection>> {
  return parseAssignments(specs, tokens, reservedNames, true);
}

// Parameter sets are ordinary binding maps. Axis provenance is kept separately
// because a scalar flag is not a swept dimension, even though it participates
// in every parameter set. Both follow source declaration order regardless of
// CLI flag order; unspecified parameters remain absent so the runtime applies
// their defaults.
export function expandParameterSweep(
  specs: readonly ParamSpec[],
  tokens: readonly string[],
  options: SweepParameterOptions,
): ExpandedParameterSweep {
  if (!Number.isSafeInteger(options.maxScenarios) || options.maxScenarios < 1) {
    throw new CliParameterError(
      'max scenarios must be a positive safe integer',
    );
  }
  const parameters = parseSweepParameterSelections(
    specs,
    tokens,
    options.reservedNames ?? new Set(),
  );
  const execution = {
    kind: 'sweep',
    parameters,
    maxExecutions: options.maxScenarios,
  } as const;
  return invokeResolver(specs, execution);
}

// Compatibility surface for callers that only need execution parameter sets.
export function expandSweepParameters(
  specs: readonly ParamSpec[],
  tokens: readonly string[],
  options: SweepParameterOptions,
): readonly Readonly<Record<string, CliParameterValue>>[] {
  return expandParameterSweep(specs, tokens, options).parameterSets;
}

function invokeResolver(
  specs: readonly ParamSpec[],
  execution: ParameterExecutionConfig,
): ExpandedParameterSweep {
  try {
    return resolveExecutionParameters(specs, execution);
  } catch (error) {
    if (error instanceof ExecutionParameterError) {
      throw new CliParameterError(error.message);
    }
    throw error;
  }
}

function parseAssignments(
  specs: readonly ParamSpec[],
  tokens: readonly string[],
  reservedNames: ReadonlySet<string>,
  allowRanges: boolean,
): Readonly<Record<string, ParameterSelection>> {
  const byName = new Map(specs.map(spec => [spec.name, spec]));
  for (const spec of specs) {
    if (reservedNames.has(spec.name)) {
      throw new CliParameterError(
        `source parameter '${spec.name}' conflicts with a reserved command option`,
      );
    }
  }

  const parsed = Object.create(null) as Record<string, ParameterSelection>;
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
      index++;
      raw = tokens[index] ?? null;
      if (raw === null) {
        throw new CliParameterError(
          `parameter option '${token}' requires a value`,
        );
      }
    }

    const numericRangeSyntax =
      allowRanges && isNumericSpec(spec) && raw.split(':').length === 3;
    parsed[spec.name] = numericRangeSyntax
      ? parseNumericRange(spec, raw)
      : coerceCliScalar(spec, raw);
    seen.add(spec.name);
  }
  return parsed;
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

function isNumericSpec(
  spec: ParamSpec,
): spec is ParamSpec & {readonly type: 'int' | 'float'} {
  return spec.type === 'int' || spec.type === 'float';
}

function coerceCliScalar(spec: ParamSpec, raw: string): ParameterScalar {
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
      if (raw.trim() === '') {
        throw new CliParameterError(
          `parameter '${spec.name}' expects a number`,
        );
      }
      const value = Number(raw);
      if (!Number.isFinite(value)) {
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

function parseNumericRange(
  spec: ParamSpec & {readonly type: 'int' | 'float'},
  raw: string,
): ParameterSelection {
  const parts = raw.split(':');
  if (parts.length !== 3 || parts.some(part => part.length === 0)) {
    throw new CliParameterError(
      `parameter '${spec.name}' range must be start:stop:step`,
    );
  }
  const [startText, stopText, stepText] = parts as [string, string, string];
  const start = coerceCliScalar(spec, startText) as number;
  const stop = coerceCliScalar(spec, stopText) as number;
  const step = coerceCliScalar(spec, stepText) as number;
  if (step === 0) {
    throw new CliParameterError(
      `parameter '${spec.name}' range step must not be zero`,
    );
  }
  if ((stop > start && step < 0) || (stop < start && step > 0)) {
    throw new CliParameterError(
      `parameter '${spec.name}' range step points away from its stop`,
    );
  }
  const precision = Math.max(
    decimalPlaces(startText),
    decimalPlaces(stopText),
    decimalPlaces(stepText),
  );
  if (precision > 12) {
    throw new CliParameterError(
      `parameter '${spec.name}' range has more than 12 decimal places`,
    );
  }
  return {
    range: {
      start,
      stop,
      step,
    },
  };
}

function decimalPlaces(raw: string): number {
  const match = /^[+-]?(?:\d+(?:\.(\d*))?|\.(\d+))(?:e([+-]?\d+))?$/i.exec(raw);
  if (match === null) return 0;
  const fraction = match[1] ?? match[2] ?? '';
  const exponent = Number(match[3] ?? 0);
  return Math.max(0, fraction.length - exponent);
}
