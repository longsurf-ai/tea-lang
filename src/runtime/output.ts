// Arrow fields own output names, shapes and write modes; declarations own only execution facts.

import {Bool, Field, Float64, Schema, TimestampMillisecond} from 'apache-arrow';
import type {JSModule} from './module-abi';
import type {Scalar} from './value';

/**
 * Configuration for the output field at the same position in outputFields().
 * Arrow owns its name, shape, kind and write mode. Layout IDs only locate live
 * values during snapshotting; args are null until binding resolves them.
 * @example A plot's declaration contains its chosen linewidth in args and the
 * runtime descriptor for its series in layouts[0].
 */
export interface OutputSpec {
  readonly args:
    | readonly {readonly name: string; readonly value: Scalar}[]
    | null;
  readonly layouts: readonly number[];
}

/** The compiled module's output contract, shared unchanged with observers. */
export type ExecutionDeclaration = JSModule['outputs'];

/**
 * A detached row matching the module's Arrow output schema. Assignment fields
 * are nullable records; append fields are lists carrying global event ordinals.
 * @example `{index: 0, timed: false, provisional: false, output0: {series: 10}}`.
 */
export interface Datum extends Readonly<Record<string, unknown>> {
  readonly index: number;
  readonly time?: number | null;
  readonly provisional: boolean;
  readonly timed: boolean;
}

export interface OutputSink {
  declare(declaration: ExecutionDeclaration): void;
  publish(publication: Datum): void;
}

/**
 * Add Node-owned coordinates to the program's Arrow fields. Each call owns its
 * coordinate fields; callers cannot change another schema's metadata.
 * @example `publicationSchema([price]).fields[0].name` is `index`.
 */
export function publicationSchema(fields: readonly Field[]): Schema {
  return new Schema([
    new Field('index', new Float64(), false),
    new Field('time', new TimestampMillisecond(), true),
    new Field('timed', new Bool(), false),
    new Field('provisional', new Bool(), false),
    ...fields,
  ]);
}

/**
 * Return fields written by the program, excluding execution coordinates.
 * Write mode is explicit: a List may be assigned as a value or appended to.
 * @example `outputFields(module.outputs.schema)[0].metadata.get('tea:write')`
 * is `set` for a plot and `append` for an event list.
 */
export function outputFields(schema: Schema): readonly Field[] {
  return schema.fields.filter(field => field.metadata.has('tea:write'));
}

/**
 * Attach execution coordinates to detached output cells. No output schema or
 * payload conversion is reconstructed here; cells already match their fields.
 * @example An append cell `[{ordinal: 0, payload: 'buy'}]` becomes the value
 * of the corresponding effect0 field in the published row.
 */
export function createDatum(
  declaration: ExecutionDeclaration,
  index: number,
  result: {readonly outputs: readonly unknown[]; readonly provisional: boolean},
  time?: number | null,
): Datum {
  return Object.freeze({
    index,
    ...(time === undefined ? {} : {time}),
    timed: time !== undefined,
    provisional: result.provisional,
    ...Object.fromEntries(
      outputFields(declaration.schema).map((field, i) => [
        field.name,
        result.outputs[i],
      ]),
    ),
  });
}
