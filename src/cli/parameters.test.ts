import {describe, expect, test} from 'bun:test';
import type {ParamSpec} from '../runtime/abi';
import {
  CliParameterError,
  expandParameterSweep,
  expandSweepParameters,
  parseRunParameters,
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

describe('dynamic CLI parameters', () => {
  test('accepts long, Pine-style single-dash, equals, and typed values', () => {
    expect(
      parseRunParameters(specs, [
        '-length',
        '20',
        '--factor=1.5',
        '--enabled',
        'false',
        '--mode',
        'slow',
      ]),
    ).toEqual({length: 20, factor: 1.5, enabled: false, mode: 'slow'});
  });

  test('rejects unknown, duplicate, reserved, and invalid values', () => {
    expect(() => parseRunParameters(specs, ['--other', '1'])).toThrow(
      "unknown parameter option '--other'",
    );
    expect(() =>
      parseRunParameters(specs, ['--length', '2', '--length', '3']),
    ).toThrow("parameter 'length' was specified more than once");
    expect(() => parseRunParameters(specs, [], new Set(['length']))).toThrow(
      "source parameter 'length' conflicts",
    );
    expect(() => parseRunParameters(specs, ['--enabled', 'yes'])).toThrow(
      "parameter 'enabled' expects true or false",
    );
    expect(() => parseRunParameters(specs, ['--length', '0'])).toThrow(
      "parameter 'length' below minval 1",
    );
  });
});

describe('parameter sweeps', () => {
  test('reports only syntactic numeric ranges as declaration-ordered axes', () => {
    expect(
      expandParameterSweep(
        specs,
        [
          '--factor',
          '1:1.5:0.2',
          '--enabled',
          'false',
          '--length',
          '1:2:1',
          '--mode',
          'slow',
        ],
        {maxScenarios: 10},
      ),
    ).toEqual({
      axes: [
        {name: 'length', type: 'int', values: [1, 2]},
        {name: 'factor', type: 'float', values: [1, 1.2, 1.4]},
      ],
      parameterSets: [
        {length: 1, factor: 1, enabled: false, mode: 'slow'},
        {length: 1, factor: 1.2, enabled: false, mode: 'slow'},
        {length: 1, factor: 1.4, enabled: false, mode: 'slow'},
        {length: 2, factor: 1, enabled: false, mode: 'slow'},
        {length: 2, factor: 1.2, enabled: false, mode: 'slow'},
        {length: 2, factor: 1.4, enabled: false, mode: 'slow'},
      ],
    });
  });

  test('does not report scalar numeric flags as axes', () => {
    expect(
      expandParameterSweep(specs, ['--length', '3', '--factor', '1.5'], {
        maxScenarios: 1,
      }),
    ).toEqual({
      axes: [],
      parameterSets: [{length: 3, factor: 1.5}],
    });
  });

  test('keeps a one-value numeric range as an axis', () => {
    expect(
      expandParameterSweep(specs, ['--length', '3:3:1'], {maxScenarios: 1}),
    ).toEqual({
      axes: [{name: 'length', type: 'int', values: [3]}],
      parameterSets: [{length: 3}],
    });
  });

  test('expands inclusive decimal ranges in declaration order', () => {
    expect(
      expandSweepParameters(
        specs,
        ['--factor', '1:1.5:0.2', '--length', '1:2:1'],
        {maxScenarios: 10},
      ),
    ).toEqual([
      {length: 1, factor: 1},
      {length: 1, factor: 1.2},
      {length: 1, factor: 1.4},
      {length: 2, factor: 1},
      {length: 2, factor: 1.2},
      {length: 2, factor: 1.4},
    ]);
  });

  test('supports descending ranges and scalar axes', () => {
    expect(
      expandSweepParameters(specs, ['--length', '3:1:-1', '--mode', 'slow'], {
        maxScenarios: 3,
      }),
    ).toEqual([
      {length: 3, mode: 'slow'},
      {length: 2, mode: 'slow'},
      {length: 1, mode: 'slow'},
    ]);
  });

  test('keeps defaults implicit and enforces the scenario ceiling', () => {
    expect(expandSweepParameters(specs, [], {maxScenarios: 1})).toEqual([{}]);
    expect(() =>
      expandSweepParameters(specs, [], {maxScenarios: 10_001}),
    ).toThrow('maxExecutions must not exceed 10000');
    expect(() =>
      expandSweepParameters(specs, ['--length', '1:3:1'], {
        maxScenarios: 2,
      }),
    ).toThrow('range has 3 values, exceeding the 2 scenario limit');
    expect(() =>
      expandSweepParameters(specs, ['--factor', '0:1000000:0.000001'], {
        maxScenarios: 10,
      }),
    ).toThrow('range has 1000000000001 values');
  });

  test('rejects zero or misdirected range steps', () => {
    expect(() =>
      expandSweepParameters(specs, ['--factor', '1:2:0'], {
        maxScenarios: 10,
      }),
    ).toThrow('range step must not be zero');
    expect(() =>
      expandSweepParameters(specs, ['--factor', '1:2:-0.1'], {
        maxScenarios: 10,
      }),
    ).toThrow('range step points away from its stop');
  });

  test('exposes a typed error for host handling', () => {
    expect(() => parseRunParameters(specs, ['value'])).toThrow(
      CliParameterError,
    );
  });
});
