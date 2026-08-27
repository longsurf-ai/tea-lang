import {describe, expect, test} from 'vitest';
import type {ParamSpec} from '../runtime/schema';
import {CliParameterError, parseRunParameters} from './parameters';

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

  test('exposes a typed error for host handling', () => {
    expect(() => parseRunParameters(specs, ['value'])).toThrow(
      CliParameterError,
    );
  });
});
