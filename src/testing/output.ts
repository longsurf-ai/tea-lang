import type {Module} from '../runtime/module-binding';
// Purpose: Minimal structured output capture for tests.

import {Schema, type Field} from 'apache-arrow';
import {outputFields, type Datum} from '../runtime/output';

export class OutputCapture {
  schema = new Schema([]);
  fields: readonly Field[] = [];
  declarations: Module['outputs']['declarations'] = [];
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

  declare(declaration: Module['outputs']): void {
    this.schema = declaration.schema;
    this.fields = outputFields(declaration.schema);
    this.declarations = declaration.declarations;
  }

  publish(datum: Datum): void {
    this.publications.push(datum);
    this.fields.forEach((field, outputId) => {
      const value = datum[field.name];
      if (field.metadata.get('tea:write') === 'append') {
        for (const payload of value as readonly unknown[]) {
          this.effectEmissions.push({
            row: datum.index,
            outputId,
            payload,
            provisional: datum.provisional,
          });
        }
      } else if (value !== null && value !== undefined) {
        this.emissions.push({
          row: datum.index,
          outputId,
          channels: [value],
          provisional: datum.provisional,
        });
      }
    });
  }
}
