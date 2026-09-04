// Purpose: Minimal structured output capture for tests.

import type {
  DeclaredOutput,
  EffectSpec,
  EffectValue,
  OutputSink,
  Datum,
  Value,
} from '../runtime/abi';

export class OutputCapture implements OutputSink {
  outputs: readonly DeclaredOutput[] = [];
  effectSchemas: readonly EffectSpec[] = [];
  readonly publications: Datum[] = [];
  readonly emissions: {
    readonly row: number;
    readonly outputId: number;
    readonly channels: readonly Value[];
    readonly provisional: boolean;
  }[] = [];
  readonly effectEmissions: {
    readonly row: number;
    readonly effectId: number;
    readonly payload: EffectValue;
    readonly provisional: boolean;
  }[] = [];

  declare(declaration: Parameters<OutputSink['declare']>[0]): void {
    this.outputs = declaration.outputs;
    this.effectSchemas = declaration.effects;
  }

  publish(datum: Datum): void {
    this.publications.push(datum);
    for (const output of datum.outputs) {
      this.emissions.push({
        row: datum.index,
        outputId: output.outputId,
        channels: output.channels,
        provisional: datum.provisional,
      });
    }
    for (const effect of datum.effects) {
      this.effectEmissions.push({
        row: datum.index,
        effectId: effect.effectId,
        payload: effect.payload,
        provisional: datum.provisional,
      });
    }
  }
}
