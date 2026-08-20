import {describe, expect, test} from 'vitest';
import type {ParamSpec} from '../runtime/abi';
import type {
  ParameterSelection,
  RunExecutionConfig,
  SweepExecutionConfig,
} from './config';
import {
  DEFAULT_MAX_EXECUTIONS,
  ExecutionParameterError,
  resolveExecutionParameters,
} from './parameters';

function spec(
  name: string,
  type: ParamSpec['type'],
  defaultValue: ParamSpec['defaultValue'],
  constraints: ParamSpec['constraints'] = null,
): ParamSpec {
  return {
    name,
    title: null,
    type,
    control: type,
    defaultValue,
    constraints,
    enumType:
      type === 'enum'
        ? {
            name: 'Mode',
            members: [
              {name: 'fast', title: 'Fast'},
              {name: 'slow', title: 'Slow'},
            ],
          }
        : null,
    group: null,
    inline: null,
    tooltip: null,
    confirm: false,
    display: 'all',
    seriesSid: null,
  };
}

const specs = [
  spec('length', 'int', 10, {kind: 'range', minval: 1, maxval: 100, step: 1}),
  spec('factor', 'float', 1),
  spec('enabled', 'bool', true),
  spec('mode', 'enum', 'fast'),
] as const;

const provider = {kind: 'csv', path: '/tmp/input.csv'} as const;

function run(
  parameters: Readonly<Record<string, ParameterSelection>>,
): RunExecutionConfig {
  return {kind: 'run', provider, parameters};
}

function sweep(
  parameters: Readonly<Record<string, ParameterSelection>>,
  maxExecutions?: number,
): SweepExecutionConfig {
  return {
    kind: 'sweep',
    provider,
    parameters,
    ...(maxExecutions === undefined ? {} : {maxExecutions}),
  };
}

describe('structured execution parameters', () => {
  test('resolves one run while keeping omitted defaults implicit', () => {
    expect(
      resolveExecutionParameters(
        specs,
        run({length: 20, enabled: false, mode: 'slow'}),
      ),
    ).toEqual({
      ranges: [],
      sets: [{length: 20, enabled: false, mode: 'slow'}],
    });
  });

  test('rejects ranges and maxExecutions for run', () => {
    expect(() =>
      resolveExecutionParameters(
        specs,
        run({length: {range: {start: 1, stop: 3, step: 1}}}),
      ),
    ).toThrow("run parameter 'length' does not accept a range");
    expect(() =>
      resolveExecutionParameters(specs, {
        ...run({}),
        maxExecutions: 2,
      } as RunExecutionConfig),
    ).toThrow('run execution does not accept maxExecutions');
  });

  test('expands ranges and parameter sets in declaration order', () => {
    expect(
      resolveExecutionParameters(
        specs,
        sweep(
          {
            factor: {range: {start: 1, stop: 1.5, step: 0.2}},
            enabled: false,
            length: {range: {start: 1, stop: 2, step: 1}},
          },
          10,
        ),
      ),
    ).toEqual({
      ranges: [
        {name: 'length', values: [1, 2]},
        {name: 'factor', values: [1, 1.2, 1.4]},
      ],
      sets: [
        {length: 1, factor: 1, enabled: false},
        {length: 1, factor: 1.2, enabled: false},
        {length: 1, factor: 1.4, enabled: false},
        {length: 2, factor: 1, enabled: false},
        {length: 2, factor: 1.2, enabled: false},
        {length: 2, factor: 1.4, enabled: false},
      ],
    });
  });

  test('keeps one-value ranges as ranges and no-range sweeps as one execution', () => {
    expect(
      resolveExecutionParameters(
        specs,
        sweep({length: {range: {start: 3, stop: 3, step: 1}}}, 1),
      ),
    ).toEqual({
      ranges: [{name: 'length', values: [3]}],
      sets: [{length: 3}],
    });
    expect(resolveExecutionParameters(specs, sweep({}))).toEqual({
      ranges: [],
      sets: [{}],
    });
  });

  test('supports descending ranges with scaled decimal arithmetic', () => {
    expect(
      resolveExecutionParameters(
        specs,
        sweep({factor: {range: {start: 0.3, stop: 0.1, step: -0.1}}}, 3),
      ).sets,
    ).toEqual([{factor: 0.3}, {factor: 0.2}, {factor: 0.1}]);
  });

  test('preflights each cardinality and the product before materialization', () => {
    expect(() =>
      resolveExecutionParameters(
        specs,
        sweep(
          {factor: {range: {start: 0, stop: 1_000_000, step: 0.000001}}},
          10,
        ),
      ),
    ).toThrow('range has 1000000000001 values');
    expect(() =>
      resolveExecutionParameters(
        specs,
        sweep(
          {
            length: {range: {start: 1, stop: 4, step: 1}},
            factor: {range: {start: 1, stop: 4, step: 1}},
          },
          15,
        ),
      ),
    ).toThrow('parameter sweep exceeds the 15 scenario limit');
  });

  test('defaults maxExecutions and validates selection semantics', () => {
    expect(DEFAULT_MAX_EXECUTIONS).toBe(10_000);
    expect(() => resolveExecutionParameters(specs, sweep({other: 1}))).toThrow(
      "unknown parameter 'other'",
    );
    expect(() =>
      resolveExecutionParameters(specs, sweep({length: 1.5})),
    ).toThrow("parameter 'length' expects a safe integer");
    expect(() =>
      resolveExecutionParameters(specs, sweep({mode: 'other'})),
    ).toThrow("parameter 'mode' is not a member of enum 'Mode'");
    expect(() =>
      resolveExecutionParameters(
        specs,
        sweep({enabled: {range: {start: 0, stop: 1, step: 1}}}),
      ),
    ).toThrow("parameter 'enabled' does not support numeric ranges");
    expect(() => resolveExecutionParameters(specs, sweep({}, 0))).toThrow(
      'maxExecutions must be a positive safe integer',
    );
    expect(() => resolveExecutionParameters(specs, sweep({}, 10_001))).toThrow(
      'maxExecutions must not exceed 10000',
    );
  });

  test('rejects invalid range direction, precision, and malformed selections', () => {
    expect(() =>
      resolveExecutionParameters(
        specs,
        sweep({factor: {range: {start: 1, stop: 2, step: -0.1}}}),
      ),
    ).toThrow('range step points away from its stop');
    expect(() =>
      resolveExecutionParameters(
        specs,
        sweep({factor: {range: {start: 0, stop: 1, step: 1e-13}}}),
      ),
    ).toThrow('range has more than 12 decimal places');
    expect(() =>
      resolveExecutionParameters(
        specs,
        sweep({factor: {range: {start: 1, stop: 2, step: 0}}}),
      ),
    ).toThrow('range step must not be zero');
    expect(() =>
      resolveExecutionParameters(
        specs,
        sweep({factor: {range: {start: 1, stop: 2}}} as never),
      ),
    ).toThrow(ExecutionParameterError);
  });
});
