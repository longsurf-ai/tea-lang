// Concise Arrow-backed fixtures for execution tests; binding tests compile real Tea.

import {
  Bool,
  Field,
  Float64,
  List,
  Schema,
  Struct,
  Uint8,
  Utf8,
} from 'apache-arrow';
import type {Builtin} from './module-abi';
import {Module} from './module-binding';
import type {Step, FrameState} from './js/state-update';

type Fixture = Omit<
  Module,
  | 'bind'
  | 'ready'
  | 'remaining'
  | 'clone'
  | 'main'
  | 'inputs'
  | 'outputs'
  | 'parameters'
> & {
  main(step: Step, frame: FrameState): void;
  readonly inputs: Omit<Module['inputs'], 'schema' | 'builtins'> & {
    readonly schema?: Schema;
    readonly builtins: readonly (Omit<Builtin, 'constant'> & {
      readonly constant?: boolean;
    })[];
  };
  readonly parameters: readonly (Omit<
    Module['parameters'][number],
    'active'
  > & {readonly active?: boolean | null})[];
  readonly outputs: {
    readonly schema: Schema;
  };
};

/**
 * Construct a static execution fixture without another binding implementation.
 * Tests of generated binding must use compile/load instead of this helper.
 * @example `testModule({...code, outputs: {schema: outputSchema([])}})`
 * creates a module with no program output fields.
 */
export function testModule(code: Fixture): Module {
  return new Module(
    {
      ...code,
      inputs: {
        ...code.inputs,
        schema:
          code.inputs.schema ??
          new Schema(
            code.inputs.series.flatMap(series =>
              series.id === null ? [] : [scalar(series.id)],
            ),
          ),
        builtins: code.inputs.builtins.map(builtin => ({
          ...builtin,
          constant: builtin.constant ?? false,
        })),
      },
      parameters: code.parameters.map(parameter => ({
        ...parameter,
        active: parameter.active ?? true,
      })),
      outputs: {schema: code.outputs.schema},
      requests: code.requests,
    },
    ctx => code.main(ctx.storage, ctx.storage.rootFrame),
  );
}

/** A scalar Arrow field; `scalar('price')` describes a non-null Float64. */
export function scalar(name: string, kind = 'float'): Field {
  return new Field(
    name,
    kind === 'bool'
      ? new Bool()
      : kind === 'color'
        ? new Struct(
            ['r', 'g', 'b', 'a'].map(
              name => new Field(name, new Uint8(), false),
            ),
          )
        : kind === 'string'
          ? new Utf8()
          : new Float64(),
    kind === 'string' || kind === 'color',
    new Map([['tea:type', kind]]),
  );
}

/**
 * Describe a fixture output with ordinary Arrow types and explicit write mode.
 * @example `output('price', scalar('price'))` is an assignment field;
 * `output('fills', scalar('fill'), true)` is an append list.
 */
export function output(name: string, value: Field, append = false): Field {
  return new Field(
    name,
    append ? new List(value.clone({name: 'item'})) : value.type,
    !append,
    new Map([...value.metadata, ['tea:write', append ? 'append' : 'set']]),
  );
}
