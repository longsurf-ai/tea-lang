// Purpose: Atomic host publication seam for declared dense outputs and sparse effects.

import type {OutputSpec} from './module-abi';
import type {EffectSpec} from './schema';
import type {EffectValue, Value} from './value';

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
