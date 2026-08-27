// Purpose: Host-visible output declarations and atomic indexed publication seams.

import type {EffectSpec} from './schema';
import type {EffectValue, ManifestValue, Value} from './value';

export type OutputChannelTransport =
  | {readonly kind: 'int'}
  | {readonly kind: 'float'}
  | {readonly kind: 'bool'}
  | {readonly kind: 'string'}
  | {readonly kind: 'color'}
  | {
      readonly kind: 'enum';
      readonly name: string;
      readonly members: readonly string[];
    }
  | {
      readonly kind: 'resource';
      readonly handle:
        | 'line'
        | 'label'
        | 'box'
        | 'table'
        | 'polyline'
        | 'linefill';
    }
  | {readonly kind: 'output-ref'; readonly output: 'plot' | 'hline'}
  | {readonly kind: 'struct'; readonly name: string}
  | {readonly kind: 'array'}
  | {readonly kind: 'matrix'}
  | {readonly kind: 'map'}
  | {readonly kind: 'tuple'};

export interface OutputChannelSpec {
  readonly name: string;
  readonly type: string;
  readonly transport: OutputChannelTransport;
}

export interface OutputSpec {
  readonly effect: string;
  readonly staticArgs: readonly {
    readonly name: string;
    readonly value: ManifestValue;
  }[];
  readonly channels: readonly OutputChannelSpec[];
}

export interface DeclaredOutput {
  readonly spec: OutputSpec;
  readonly boundArgs: readonly {
    readonly name: string;
    readonly value: Value;
  }[];
}

export interface ExecutionDeclaration {
  readonly outputs: readonly DeclaredOutput[];
  readonly effects: readonly EffectSpec[];
}

export interface DenseEmission {
  readonly outputId: number;
  readonly channels: readonly Value[];
}

export interface EffectEmission {
  readonly effectId: number;
  readonly payload: EffectValue;
}

/** One lossless result produced by a successful Node or GPU step. */
export interface Datum extends Readonly<Record<string, unknown>> {
  // Absolute execution index within the producing Node or GPU binding.
  readonly index: number;
  // Exact epoch-millisecond source time. A missing time means that the input
  // stream has no event-time field.
  readonly time?: number | null;
  // Every emitted output keeps its declaration id and ordered channel array.
  // No entry for an output means it was not emitted; an entry containing NaN
  // means Tea explicitly emitted its numeric missing value. Neither case is
  // converted to null or flattened into named object fields.
  readonly outputs: readonly DenseEmission[];
  // Sparse effects retain their declaration ids and exact typed payloads.
  readonly effects: readonly EffectEmission[];
  readonly provisional: boolean;
}

export interface OutputSink {
  declare(declaration: ExecutionDeclaration): void;
  publish(publication: Datum): void;
}
