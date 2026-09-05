// Purpose: Minimal structured output capture for tests.

import type {
  DeclaredOutput,
  EffectSpec,
  OutputSink,
  Datum,
} from '../runtime/abi';

export class OutputCapture implements OutputSink {
  outputs: readonly DeclaredOutput[] = [];
  effectSchemas: readonly EffectSpec[] = [];
  readonly publications: Datum[] = [];
  readonly emissions: {
    readonly row: number;
    readonly outputId: number;
    readonly channels: readonly unknown[];
    readonly provisional: boolean;
  }[] = [];
  readonly effectEmissions: {
    readonly row: number;
    readonly effectId: number;
    readonly payload: unknown;
    readonly provisional: boolean;
  }[] = [];

  declare(declaration: Parameters<OutputSink['declare']>[0]): void {
    this.outputs = declaration.outputs;
    this.effectSchemas = declaration.effects;
  }

  publish(datum: Datum): void {
    this.publications.push(datum);
    this.outputs.forEach((output, outputId) => {
      const value = datum[`output${outputId}`] as Record<
        string,
        unknown
      > | null;
      if (value === null || value === undefined) return;
      this.emissions.push({
        row: datum.index,
        outputId,
        channels: output.spec.channels.map(field => value[field.name]),
        provisional: datum.provisional,
      });
    });
    const events = this.effectSchemas
      .flatMap((_, effectId) =>
        (
          datum[`effect${effectId}`] as readonly {
            ordinal: number;
            payload: unknown;
          }[]
        ).map(event => ({effectId, ...event})),
      )
      .sort((a, b) => a.ordinal - b.ordinal);
    for (const event of events) {
      this.effectEmissions.push({
        row: datum.index,
        effectId: event.effectId,
        payload: event.payload,
        provisional: datum.provisional,
      });
    }
  }
}
