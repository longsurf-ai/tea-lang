// Purpose: Minimal structured output capture for tests.

import {Schema, type Field} from 'apache-arrow';
import {
  outputFields,
  type OutputSpec,
  type OutputSink,
  type Datum,
} from '../runtime/output';

export class OutputCapture implements OutputSink {
  schema = new Schema([]);
  fields: readonly Field[] = [];
  declarations: readonly OutputSpec[] = [];
  readonly publications: Datum[] = [];
  readonly emissions: {
    readonly row: number;
    readonly outputId: number;
    readonly channels: readonly unknown[];
    readonly provisional: boolean;
  }[] = [];
  readonly effectEmissions: {
    readonly row: number;
    readonly outputId: number;
    readonly payload: unknown;
    readonly provisional: boolean;
  }[] = [];

  declare(declaration: Parameters<OutputSink['declare']>[0]): void {
    this.schema = declaration.schema;
    this.fields = outputFields(declaration.schema);
    this.declarations = declaration.declarations;
  }

  publish(datum: Datum): void {
    this.publications.push(datum);
    const events: {outputId: number; ordinal: number; payload: unknown}[] = [];
    this.fields.forEach((field, outputId) => {
      const value = datum[field.name];
      if (field.metadata.get('tea:write') === 'append') {
        for (const event of value as readonly {
          ordinal: number;
          payload: unknown;
        }[]) {
          events.push({outputId, ...event});
        }
      } else if (value !== null && value !== undefined) {
        this.emissions.push({
          row: datum.index,
          outputId,
          channels: field.type.children.map(
            (channel: Field) =>
              (value as Record<string, unknown>)[channel.name],
          ),
          provisional: datum.provisional,
        });
      }
    });
    for (const event of events.sort((a, b) => a.ordinal - b.ordinal)) {
      this.effectEmissions.push({
        row: datum.index,
        outputId: event.outputId,
        payload: event.payload,
        provisional: datum.provisional,
      });
    }
  }
}
