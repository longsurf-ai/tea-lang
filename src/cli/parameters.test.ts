import {describe, expect, test} from 'vitest';
import {generate} from '../codegen/codegen';
import {mustBuild} from '../noder/testing';
import {loadModule} from '../runtime/load';
import {BindError} from '../runtime/errors';
import type {Parameter} from '../runtime/params';
import {CliParameterError, parseRunParameters} from './parameters';

function spec(
  name: string,
  type: Parameter['type'],
  defaultValue: Parameter['defaultValue'],
  constraints: Parameter['constraints'] = null,
): Parameter {
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
    expect(() =>
      parseRunParameters(specs, ['--length', '9007199254740992']),
    ).toThrow('expects a safe integer');
  });

  test('returns only supplied values and leaves defaults and domain checks to module.bind', () => {
    const module = loadModule(
      generate(
        mustBuild(
          'enum Mode\n    fast\n    slow\nlength = input.int(10, minval=1)\nshade = input.color(#ff0000)\nmode = input.enum(Mode.fast)\nemit "output0" close[length]',
        ),
      ),
    );
    const empty = parseRunParameters(module.parameters, []);
    expect(empty).toEqual({});
    expect(module.bind(empty).parameters.map(param => param.value)).toEqual([
      10,
      '#FF0000',
      'fast',
    ]);
    const invalid = parseRunParameters(module.parameters, ['--length', '0']);
    expect(invalid).toEqual({length: 0});
    expect(() => module.bind(invalid)).toThrow(BindError);
    expect(() => module.bind(invalid)).toThrow(
      "parameter 'length' below minval 1",
    );
    const color = parseRunParameters(module.parameters, [
      '--shade',
      '#abcdefff',
    ]);
    expect(color.shade).toBe('#abcdefff');
    expect(module.bind(color).parameters[1]!.value).toBe('#ABCDEF');
    const mode = parseRunParameters(module.parameters, ['--mode', 'invalid']);
    expect(mode).toEqual({mode: 'invalid'});
    expect(() => module.bind(mode)).toThrow(
      "parameter 'mode' is not a member of enum 'Mode'",
    );
  });

  test('exposes a typed error for host handling', () => {
    expect(() => parseRunParameters(specs, ['value'])).toThrow(
      CliParameterError,
    );
  });
});
