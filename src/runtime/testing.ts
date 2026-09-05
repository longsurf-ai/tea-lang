// Concise Arrow-backed fixtures for execution tests; binding tests compile real Tea.

import {
  Bool,
  DataType,
  Field,
  Float64,
  List,
  Schema,
  Struct,
  Utf8,
} from 'apache-arrow';
import type {BuiltinSpec, JSModule} from './module-abi';
import {cloneModule, initializeModule} from './module-binding';
import {outputFields, publicationSchema} from './output';

type Fixture = Omit<
  JSModule,
  'bind' | 'ready' | 'remaining' | 'inputs' | 'outputs' | 'parameters'
> & {
  readonly inputs: Omit<JSModule['inputs'], 'schema' | 'builtins'> & {
    readonly schema?: Schema;
    readonly builtins: readonly (Omit<BuiltinSpec, 'constant'> & {
      readonly constant?: boolean;
    })[];
  };
  readonly parameters: readonly (Omit<
    JSModule['parameters'][number],
    'active'
  > & {readonly active?: boolean | null})[];
  readonly outputs: {
    readonly schema: Schema;
    readonly declarations?: JSModule['outputs']['declarations'];
  };
};

/**
 * Construct a static execution fixture without another binding implementation.
 * Tests of generated binding must use compile/load instead of this helper.
 * @example `testModule({...code, outputs: {schema: publicationSchema([])}})`
 * creates a module with no program output fields.
 */
export function testModule(code: Fixture): JSModule {
  const fields = outputFields(code.outputs.schema);
  const declarations =
    code.outputs.declarations ??
    fields.map(field => {
      const channels: readonly Field[] =
        field.metadata.get('tea:write') === 'append'
          ? [field.type.children[0].type.children[1]]
          : field.type.children;
      return {
        args: [],
        layouts: channels.map(field =>
          code.state.layout.findIndex(layout => {
            if (DataType.isFloat(field.type)) return layout.kind === 'number';
            if (DataType.isBool(field.type)) return layout.kind === 'boolean';
            if (DataType.isUtf8(field.type))
              return (
                layout.kind === 'nullable-scalar' || layout.kind === 'enum'
              );
            return (
              layout.kind === field.metadata.get('tea:type') &&
              (!('name' in layout) ||
                layout.name === field.metadata.get('tea:name'))
            );
          }),
        ),
      };
    });
  const module = initializeModule({
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
    outputs: {schema: code.outputs.schema, declarations},
    requests: [],
    bind() {},
  });
  return cloneModule({...module, requests: code.requests});
}

/** A scalar Arrow field; `scalar('price')` describes a non-null Float64. */
export function scalar(name: string, kind = 'float'): Field {
  return new Field(
    name,
    kind === 'bool'
      ? new Bool()
      : kind === 'string' || kind === 'color'
        ? new Utf8()
        : new Float64(),
    kind === 'string' || kind === 'color',
    new Map([['tea:type', kind]]),
  );
}

/**
 * Describe a fixture output with ordinary Arrow types and explicit write mode.
 * @example `output('output0', [scalar('series')])` is an assignment field;
 * `output('effect0', [scalar('payload')], true)` is an event list.
 */
export function output(
  name: string,
  fields: readonly Field[],
  append = false,
): Field {
  return new Field(
    name,
    append
      ? new List(
          new Field('item', new Struct([scalar('ordinal'), ...fields]), false),
        )
      : new Struct([...fields]),
    !append,
    new Map([
      ['tea:write', append ? 'append' : 'set'],
      ['tea:kind', append ? 'event' : 'probe'],
    ]),
  );
}
