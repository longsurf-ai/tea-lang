// Purpose: Host-visible output declarations and atomic indexed publication seams.

import {
  Bool,
  Field,
  Float64,
  List,
  Schema,
  Struct,
  TimestampMillisecond,
} from 'apache-arrow';
import type {EffectSpec} from './schema';
import type {ManifestValue, Value} from './value';

/**
 * One output declaration; channel structure uses Arrow fields directly.
 * @example A plot declares a Float64 field named `series`.
 */
export interface OutputSpec {
  readonly effect: string;
  readonly staticArgs: readonly {
    readonly name: string;
    readonly value: ManifestValue;
  }[];
  readonly channels: readonly Field[];
}

/**
 * An output's static declaration plus its prepared display arguments.
 * @example A bound horizontal line records its chosen `price` in `boundArgs`.
 */
export interface DeclaredOutput {
  readonly spec: OutputSpec;
  readonly boundArgs: readonly {
    readonly name: string;
    readonly value: Value;
  }[];
}

/**
 * Public declaration metadata and the Arrow schema for complete step records.
 * @example `declaration.schema.fields` includes `output0` and any event lists.
 */
export interface ExecutionDeclaration {
  readonly outputs: readonly DeclaredOutput[];
  readonly effects: readonly EffectSpec[];
  readonly schema: Schema;
}

/**
 * Internal final channel values for one declaration in one step.
 * @example `{outputId: 0, channels: [10]}` becomes `output0: {series: 10}`.
 */
export interface DenseEmission {
  readonly outputId: number;
  readonly channels: readonly unknown[];
}

/**
 * One internal event, already detached from the runtime at its emission.
 * @example Two events with the same effectId remain two ordered list entries.
 */
export interface EffectEmission {
  readonly effectId: number;
  readonly payload: unknown;
}

/**
 * A detached row matching the module's Arrow output schema. `outputN` fields are
 * nullable records; `effectN` fields are ordered lists of {ordinal, payload}.
 * @example `{index: 0, timed: false, provisional: false, output0: {series: 10}}`.
 */
export interface Datum extends Readonly<Record<string, unknown>> {
  // Absolute execution index within the producing Node or GPU binding.
  readonly index: number;
  // Exact epoch-millisecond source time. A missing time means that the input
  // stream has no event-time field.
  readonly time?: number | null;
  readonly provisional: boolean;
  /** Whether time was present, including explicit null, before serialization. */
  readonly timed: boolean;
}

export interface OutputSink {
  declare(declaration: ExecutionDeclaration): void;
  publish(publication: Datum): void;
}

/**
 * Describe one step using Arrow fields. Assignment outputs are nullable records;
 * event declarations are lists carrying a global emission ordinal.
 *
 * @example A float plot has `output1: Struct<series: Float64>`; an absent plot
 * is null while `{series: NaN}` is an explicit numeric missing value.
 */
export function outputSchema(
  outputs: readonly OutputSpec[],
  effects: readonly EffectSpec[],
): Schema {
  return new Schema([
    new Field('index', new Float64(), false),
    new Field('time', new TimestampMillisecond(), true),
    new Field('timed', new Bool(), false),
    new Field('provisional', new Bool(), false),
    ...outputs.map(
      (output, id) =>
        new Field(
          `output${id}`,
          new Struct([...output.channels]),
          true,
          new Map([['tea:effect', output.effect]]),
        ),
    ),
    ...effects.map(
      (effect, id) =>
        new Field(
          `effect${id}`,
          new List(
            new Field(
              'item',
              new Struct([
                new Field('ordinal', new Float64(), false),
                effect.payload,
              ]),
              false,
            ),
          ),
          false,
        ),
    ),
  ]);
}

/**
 * Add Node-owned coordinates to already detached runtime emissions. The schema
 * determines field names; no runtime references or positional payload language
 * cross this boundary. Event ordinals retain ordering across declarations.
 *
 * @example Two emissions at effect 0 produce
 * `effect0: [{ordinal: 0, payload: 'a'}, {ordinal: 1, payload: 'b'}]`.
 */
export function createDatum(
  declaration: ExecutionDeclaration,
  index: number,
  result: {
    readonly outputs: readonly DenseEmission[];
    readonly effects: readonly EffectEmission[];
    readonly provisional: boolean;
  },
  time?: number | null,
): Datum {
  const row: Record<string, unknown> = {
    index,
    ...(time === undefined ? {} : {time}),
    timed: time !== undefined,
    provisional: result.provisional,
  };
  declaration.outputs.forEach((_, id) => {
    row[`output${id}`] = null;
  });
  declaration.effects.forEach((_, id) => {
    row[`effect${id}`] = [];
  });
  for (const output of result.outputs) {
    const fields = declaration.outputs[output.outputId].spec.channels;
    row[`output${output.outputId}`] = Object.freeze(
      Object.fromEntries(
        fields.map((field, i) => [field.name, output.channels[i]]),
      ),
    );
  }
  result.effects.forEach((effect, ordinal) => {
    (row[`effect${effect.effectId}`] as unknown[]).push(
      Object.freeze({ordinal, payload: effect.payload}),
    );
  });
  declaration.effects.forEach((_, id) => Object.freeze(row[`effect${id}`]));
  return Object.freeze(row) as Datum;
}
