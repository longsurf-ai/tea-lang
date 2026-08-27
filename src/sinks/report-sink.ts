// Purpose: Capture complete Datums for one human-readable run report.

import type {ReportCell, ReportSection} from '../reporting/report';
import {reportValue} from '../reporting/report';
import type {
  DeclaredOutput,
  EffectSpec,
  EffectValue,
  EffectValueSchema,
  ExecutionDeclaration,
  OutputSink,
  Datum,
  Value,
} from '../runtime/abi';

/** Captures every final output and typed effect from one Node execution. */
export class RunReportSink implements OutputSink {
  private declaration: ExecutionDeclaration = {outputs: [], effects: []};
  private readonly dense: {
    readonly index: number;
    readonly outputId: number;
    readonly channels: readonly Value[];
  }[] = [];
  private readonly effects: {
    readonly index: number;
    readonly effectId: number;
    readonly payload: EffectValue;
  }[] = [];

  declare(declaration: ExecutionDeclaration): void {
    this.declaration = cloneDeclaration(declaration);
    this.dense.length = 0;
    this.effects.length = 0;
  }

  publish(datum: Datum): void {
    if (datum.provisional) return;
    for (const output of datum.outputs) {
      this.dense.push({
        index: datum.index,
        outputId: output.outputId,
        channels: [...output.channels],
      });
    }
    for (const effect of datum.effects) {
      this.effects.push({
        index: datum.index,
        effectId: effect.effectId,
        payload: cloneEffectPayload(effect.payload),
      });
    }
  }

  denseSection(): ReportSection {
    const columns = this.declaration.outputs.flatMap((output, outputId) =>
      output.spec.channels.map((_channel, channel) => ({
        outputId,
        channel,
        label: outputChannelLabel(output, outputId, channel),
      })),
    );
    const byIndex = new Map<number, Map<number, readonly Value[]>>();
    for (const value of this.dense) {
      let outputs = byIndex.get(value.index);
      if (outputs === undefined) {
        outputs = new Map();
        byIndex.set(value.index, outputs);
      }
      outputs.set(value.outputId, value.channels);
    }
    return {
      title: 'Outputs',
      columns: ['index', ...columns.map(column => column.label)],
      rows: [...byIndex.entries()]
        .sort(([left], [right]) => left - right)
        .map(([index, outputs]) => [
          index,
          ...columns.map(column => {
            const value = outputs.get(column.outputId)?.[column.channel];
            return value === undefined ? '' : reportValue(value);
          }),
        ]),
    };
  }

  effectsSection(): ReportSection {
    return {
      title: 'Effects',
      columns: ['index', 'effect', 'payload'],
      rows: this.effects.map(effect => {
        const spec = this.declaration.effects[effect.effectId];
        return [
          effect.index,
          spec === undefined
            ? `effect[${effect.effectId}]`
            : effectLabel(spec, effect.effectId),
          spec === undefined
            ? displayEffectValue(effect.payload)
            : formatEffectPayload(spec.payload, effect.payload),
        ];
      }),
    };
  }
}

function outputChannelLabel(
  output: DeclaredOutput,
  outputId: number,
  channelIndex: number,
): string {
  const title = output.spec.staticArgs.find(arg => arg.name === 'title')?.value;
  const base =
    typeof title === 'string' && title.length > 0
      ? title
      : `${output.spec.effect}[${outputId}]`;
  const channel = output.spec.channels[channelIndex]!;
  return output.spec.channels.length === 1 || channel.name === 'series'
    ? base
    : `${base}.${channel.name}`;
}

function effectLabel(effect: EffectSpec, effectId: number): string {
  const payload = effect.payload;
  const type =
    payload.kind === 'enum' || payload.kind === 'struct'
      ? payload.typeId
      : payload.kind;
  return `effect[${effectId}] ${type}`;
}

function formatEffectPayload(
  schema: EffectValueSchema,
  value: EffectValue,
): ReportCell {
  return JSON.stringify(logicalEffectValue(schema, value));
}

function displayEffectValue(value: EffectValue): ReportCell {
  if (typeof value === 'number') return Number.isNaN(value) ? 'na' : value;
  if (value === null) return 'na';
  return typeof value === 'object' ? JSON.stringify(value) : value;
}

function logicalEffectValue(
  schema: EffectValueSchema,
  value: EffectValue,
): unknown {
  if (value === null || (typeof value === 'number' && Number.isNaN(value))) {
    return 'na';
  }
  if (schema.kind !== 'struct') return value;
  if (typeof value !== 'object') return '<invalid effect payload>';
  return Object.fromEntries(
    schema.fields.map((field, index) => [
      field.name,
      logicalEffectValue(field.value, value.fields[index]!),
    ]),
  );
}

function cloneDeclaration(
  declaration: ExecutionDeclaration,
): ExecutionDeclaration {
  return {
    outputs: declaration.outputs.map(output => ({
      spec: {
        ...output.spec,
        staticArgs: output.spec.staticArgs.map(arg => ({...arg})),
        channels: output.spec.channels.map(channel => ({
          ...channel,
          transport:
            channel.transport.kind === 'enum'
              ? {...channel.transport, members: [...channel.transport.members]}
              : {...channel.transport},
        })),
      },
      boundArgs: output.boundArgs.map(arg => ({...arg})),
    })),
    effects: declaration.effects.map(effect => ({
      payload: cloneEffectValueSchema(effect.payload),
    })),
  };
}

function cloneEffectValueSchema(schema: EffectValueSchema): EffectValueSchema {
  switch (schema.kind) {
    case 'enum':
      return {...schema, members: schema.members.map(member => ({...member}))};
    case 'struct':
      return {
        ...schema,
        fields: schema.fields.map(field => ({
          name: field.name,
          value: cloneEffectValueSchema(field.value),
        })),
      };
    default:
      return {...schema};
  }
}

function cloneEffectPayload(value: EffectValue): EffectValue {
  if (typeof value !== 'object' || value === null) return value;
  return Object.freeze({
    kind: 'struct' as const,
    fields: Object.freeze(value.fields.map(cloneEffectPayload)),
  });
}
