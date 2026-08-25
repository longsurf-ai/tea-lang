// Purpose: Output manifest transport tags come directly from Program types; display spellings never become machine type information.

import {describe, expect, test} from 'vitest';
import type {Program} from '../ir/program';
import {
  BoolType,
  ColorType,
  FloatType,
  IntType,
  LineType,
  StringType,
  TypeKind,
  type EnumType,
  type StructType,
} from '../ir/type';
import {RUNTIME_ABI_VERSION, type JSModule} from '../runtime/abi';
import {loadModule} from '../runtime/load';
import {generate} from './codegen';

describe('output manifest transport', () => {
  test('projects exhaustive machine tags while retaining display types', () => {
    const mode: EnumType = {
      kind: TypeKind.Enum,
      name: 'Mode',
      members: [
        {name: 'fast', title: 'Fast'},
        {name: 'slow', title: 'Slow'},
      ],
    };
    // Intentionally collides with the enum's display name. The transport tag
    // must preserve the semantic distinction without reparsing `type`.
    const userMode: StructType = {
      kind: TypeKind.Struct,
      name: 'Mode',
      fields: [{name: 'value', type: IntType}],
    };
    const program: Program = {
      version: 1,
      params: [],
      requests: [],
      outputs: [
        {
          effect: 'probe',
          staticArgs: [],
          bindArgs: [],
          bindArgumentEvaluationOrder: [],
          channels: [
            {name: 'integer', type: IntType},
            {name: 'decimal', type: FloatType},
            {name: 'flag', type: BoolType},
            {name: 'text', type: StringType},
            {name: 'color', type: ColorType},
            {name: 'enum', type: mode},
            {name: 'user', type: userMode},
            {name: 'line', type: LineType},
            {name: 'array', type: {kind: TypeKind.Array, elem: IntType}},
            {
              name: 'tuple',
              type: {kind: TypeKind.Tuple, elems: [IntType, StringType]},
            },
          ],
        },
      ],
      effects: [],
      packageGlobals: [],
      init: [],
      body: [],
    };

    const module = loadModule(generate(program)) as JSModule;
    expect(module.abi).toBe(RUNTIME_ABI_VERSION);
    expect(module.manifest.outputs[0].channels).toEqual([
      {name: 'integer', type: 'int', transport: {kind: 'int'}},
      {name: 'decimal', type: 'float', transport: {kind: 'float'}},
      {name: 'flag', type: 'bool', transport: {kind: 'bool'}},
      {name: 'text', type: 'string', transport: {kind: 'string'}},
      {name: 'color', type: 'color', transport: {kind: 'color'}},
      {
        name: 'enum',
        type: 'Mode',
        transport: {kind: 'enum', name: 'Mode', members: ['fast', 'slow']},
      },
      {
        name: 'user',
        type: 'Mode',
        transport: {kind: 'struct', name: 'Mode'},
      },
      {
        name: 'line',
        type: 'line',
        transport: {kind: 'resource', handle: 'line'},
      },
      {name: 'array', type: 'array<int>', transport: {kind: 'array'}},
      {name: 'tuple', type: '[int, string]', transport: {kind: 'tuple'}},
    ]);
  });
});
