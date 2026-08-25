// Purpose: Host-visible output declarations and atomic row publication seams.

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

export interface RowPublication {
  readonly row: number;
  // Epoch-ms bar-open time when the provider owns an explicit axis. Hosts may
  // still publish row-only data, represented to consumers as null.
  readonly time?: number | null;
  readonly outputs: readonly DenseEmission[];
  readonly effects: readonly EffectEmission[];
  readonly provisional: boolean;
}

export interface OutputSinkCapabilities {
  readonly denseRows?: 'all' | 'final';
  readonly effects?: 'all' | 'none';
}

export interface OutputSink {
  readonly capabilities?: OutputSinkCapabilities;
  declare(declaration: ExecutionDeclaration): void;
  publish(publication: RowPublication): void;
}
