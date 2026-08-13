// Purpose: Parse source-declared parameter flags after Commander has parsed the fixed CLI surface.

import type {ParamSpec, Value} from '../runtime/abi';
import {resolveParamValues} from '../runtime/params';

export type CliParameterValue = number | string | boolean;

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

export interface SweepAxis {
  readonly name: string;
  readonly type: 'int' | 'float';
  readonly values: readonly number[];
}

export interface ExpandedParameterSweep {
  readonly axes: readonly SweepAxis[];
  readonly parameterSets: readonly Readonly<
    Record<string, CliParameterValue>
  >[];
}

type ParsedParameterAssignment =
  | {
      readonly kind: 'scalar';
      readonly values: readonly [CliParameterValue];
    }
  | {
      readonly kind: 'numericRange';
      readonly type: 'int' | 'float';
      readonly values: readonly number[];
    };

// Dynamic flags deliberately accept both conventional `--length` and the
// Pine-friendly `-length` spelling. Commander owns fixed host flags first;
// this parser sees only the tokens it did not recognize.
export function parseRunParameters(
  specs: readonly ParamSpec[],
  tokens: readonly string[],
  reservedNames: ReadonlySet<string> = new Set(),
): Readonly<Record<string, CliParameterValue>> {
  const parsed = parseAssignments(specs, tokens, reservedNames, false, 1);
  return Object.fromEntries(
    [...parsed].map(([name, assignment]) => [name, assignment.values[0]!]),
  );
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
  const parsed = parseAssignments(
    specs,
    tokens,
    options.reservedNames ?? new Set(),
    true,
    options.maxScenarios,
  );

  let scenarioCount = 1;
  for (const {values} of parsed.values()) {
    if (scenarioCount > Math.floor(options.maxScenarios / values.length)) {
      throw new CliParameterError(
        `parameter sweep exceeds the ${options.maxScenarios} scenario limit`,
      );
    }
    scenarioCount *= values.length;
  }

  const axes: SweepAxis[] = [];
  let parameterSets: Readonly<Record<string, CliParameterValue>>[] = [{}];
  for (const spec of specs) {
    const assignment = parsed.get(spec.name);
    if (assignment === undefined) continue;
    if (assignment.kind === 'numericRange') {
      axes.push({
        name: spec.name,
        type: assignment.type,
        values: assignment.values,
      });
    }
    parameterSets = parameterSets.flatMap(parameterSet =>
      assignment.values.map(value => ({
        ...parameterSet,
        [spec.name]: value,
      })),
    );
  }
  return {axes, parameterSets};
}

// Compatibility surface for callers that only need execution parameter sets.
export function expandSweepParameters(
  specs: readonly ParamSpec[],
  tokens: readonly string[],
  options: SweepParameterOptions,
): readonly Readonly<Record<string, CliParameterValue>>[] {
  return expandParameterSweep(specs, tokens, options).parameterSets;
}

function parseAssignments(
  specs: readonly ParamSpec[],
  tokens: readonly string[],
  reservedNames: ReadonlySet<string>,
  allowRanges: boolean,
  maxAxisValues: number,
): ReadonlyMap<string, ParsedParameterAssignment> {
  const byName = new Map(specs.map(spec => [spec.name, spec]));
  for (const spec of specs) {
    if (reservedNames.has(spec.name)) {
      throw new CliParameterError(
        `source parameter '${spec.name}' conflicts with a reserved command option`,
      );
    }
  }

  const parsed = new Map<string, ParsedParameterAssignment>();
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    const flag = splitFlag(token);
    const spec = byName.get(flag.name);
    if (spec === undefined) {
      throw new CliParameterError(`unknown parameter option '${token}'`);
    }
    if (parsed.has(flag.name)) {
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
    parsed.set(
      spec.name,
      numericRangeSyntax
        ? {
            kind: 'numericRange',
            type: spec.type,
            values: numericRange(spec, raw, maxAxisValues),
          }
        : {kind: 'scalar', values: [coerceAndValidate(spec, raw)]},
    );
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

function coerceAndValidate(spec: ParamSpec, raw: string): CliParameterValue {
  let candidate: CliParameterValue;
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
      candidate = value;
      break;
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
      candidate = value;
      break;
    }
    case 'bool':
      if (raw !== 'true' && raw !== 'false') {
        throw new CliParameterError(
          `parameter '${spec.name}' expects true or false`,
        );
      }
      candidate = raw === 'true';
      break;
    default:
      candidate = raw;
      break;
  }

  try {
    const value = resolveParamValues([spec], {[spec.name]: candidate})[0];
    if (
      typeof value !== 'number' &&
      typeof value !== 'string' &&
      typeof value !== 'boolean'
    ) {
      throw new CliParameterError(
        `parameter '${spec.name}' cannot be supplied through the CLI`,
      );
    }
    return value;
  } catch (error) {
    if (error instanceof CliParameterError) throw error;
    if (error instanceof Error) throw new CliParameterError(error.message);
    throw error;
  }
}

function numericRange(
  spec: ParamSpec,
  raw: string,
  maxValues: number,
): readonly number[] {
  const parts = raw.split(':');
  if (parts.length !== 3 || parts.some(part => part.length === 0)) {
    throw new CliParameterError(
      `parameter '${spec.name}' range must be start:stop:step`,
    );
  }
  const [startText, stopText, stepText] = parts as [string, string, string];
  const start = parseRangeNumber(spec, startText);
  const stop = parseRangeNumber(spec, stopText);
  const step = parseRangeNumber(spec, stepText, false);
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
  const scale = 10 ** precision;
  const scaledStart = Math.round(start * scale);
  const scaledStop = Math.round(stop * scale);
  const scaledStep = Math.round(step * scale);
  if (
    !Number.isSafeInteger(scaledStart) ||
    !Number.isSafeInteger(scaledStop) ||
    !Number.isSafeInteger(scaledStep)
  ) {
    throw new CliParameterError(
      `parameter '${spec.name}' range exceeds safe numeric precision`,
    );
  }

  const distance =
    BigInt(scaledStop) >= BigInt(scaledStart)
      ? BigInt(scaledStop) - BigInt(scaledStart)
      : BigInt(scaledStart) - BigInt(scaledStop);
  const count = distance / BigInt(Math.abs(scaledStep)) + 1n;
  if (count > BigInt(maxValues)) {
    throw new CliParameterError(
      `parameter '${spec.name}' range has ${count.toString()} values, exceeding the ${maxValues} scenario limit`,
    );
  }

  const values: number[] = [];
  for (
    let current = scaledStart;
    scaledStep > 0 ? current <= scaledStop : current >= scaledStop;
    current += scaledStep
  ) {
    values.push(parseRangeNumber(spec, String(current / scale)));
  }
  return values;
}

function parseRangeNumber(
  spec: ParamSpec,
  raw: string,
  applyConstraints = true,
): number {
  const value = coerceAndValidate(
    applyConstraints ? spec : {...spec, constraints: null},
    raw,
  );
  if (typeof value !== 'number') {
    throw new CliParameterError(
      `parameter '${spec.name}' does not support numeric ranges`,
    );
  }
  return value;
}

function decimalPlaces(raw: string): number {
  const match = /^[+-]?(?:\d+(?:\.(\d*))?|\.(\d+))(?:e([+-]?\d+))?$/i.exec(raw);
  if (match === null) return 0;
  const fraction = match[1] ?? match[2] ?? '';
  const exponent = Number(match[3] ?? 0);
  return Math.max(0, fraction.length - exponent);
}
