// Purpose: Generic report collectors: complete run capture and memory-bounded sweep summaries.

import type {ExecutionSummary} from '../../execute';
import type {ReportCell, ReportSection} from '../../reporting/report';
import {reportValue} from '../../reporting/report';
import {
  type DeclaredOutput,
  type EffectSpec,
  type EffectValue,
  type EffectValueSchema,
  type ExecutionDeclaration,
  type OutputSink,
  type RowPublication,
  type Value,
} from '../../runtime/abi';

interface DenseValue {
  readonly row: number;
  readonly outputId: number;
  readonly channels: readonly Value[];
}

interface CapturedEffect {
  readonly row: number;
  readonly effectId: number;
  readonly payload: EffectValue;
}

export interface SweepReportSnapshot {
  readonly declaration: ExecutionDeclaration;
  readonly rows: number;
  readonly finalOutputs: readonly DenseValue[];
}

abstract class ReportSinkBase implements OutputSink {
  protected declaration: ExecutionDeclaration = {outputs: [], effects: []};
  protected rowCount = 0;

  declare(declaration: ExecutionDeclaration): void {
    this.declaration = cloneDeclaration(declaration);
    this.rowCount = 0;
    this.reset();
  }

  publish(publication: RowPublication): void {
    if (publication.provisional) {
      return;
    }
    this.rowCount = Math.max(this.rowCount, publication.row + 1);
    this.capture(publication);
  }

  protected abstract reset(): void;
  protected abstract capture(publication: RowPublication): void;

  protected denseSectionFrom(values: readonly DenseValue[]): ReportSection {
    const columns = denseColumns(this.declaration.outputs);
    const byRow = new Map<number, Map<number, readonly Value[]>>();
    for (const value of values) {
      let outputs = byRow.get(value.row);
      if (outputs === undefined) {
        outputs = new Map();
        byRow.set(value.row, outputs);
      }
      outputs.set(value.outputId, value.channels);
    }
    return {
      title: 'Dense Outputs',
      columns: ['row', ...columns.map(column => column.label)],
      rows: [...byRow.entries()]
        .sort(([left], [right]) => left - right)
        .map(([row, outputs]) => [
          row,
          ...columns.map(column => {
            const value = outputs.get(column.outputId)?.[column.channel];
            return value === undefined ? '' : reportValue(value);
          }),
        ]),
    };
  }
}

// Captures every final dense emission and typed effect for a single ordinary
// run. Provisional attempts are intentionally excluded from user reports.
export class RunReportSink extends ReportSinkBase {
  private readonly dense: DenseValue[] = [];
  private readonly effects: CapturedEffect[] = [];

  denseSection(): ReportSection {
    return this.denseSectionFrom(this.dense);
  }

  effectsSection(): ReportSection {
    return {
      title: 'Effects',
      columns: ['row', 'effect', 'payload'],
      rows: this.effects.map(effect => {
        const spec = this.declaration.effects[effect.effectId];
        return [
          effect.row,
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

  protected reset(): void {
    this.dense.length = 0;
    this.effects.length = 0;
  }

  protected capture(publication: RowPublication): void {
    for (const output of publication.outputs) {
      this.dense.push({
        row: publication.row,
        outputId: output.outputId,
        channels: [...output.channels],
      });
    }
    for (const effect of publication.effects) {
      this.effects.push({
        row: publication.row,
        effectId: effect.effectId,
        payload: cloneEffectPayload(effect.payload),
      });
    }
  }
}

// Retains O(outputs) state regardless of history length: only each channel's
// latest final value. Sweeps intentionally decline sparse effect payloads.
export class SweepReportSink extends ReportSinkBase {
  readonly capabilities = {denseRows: 'final', effects: 'none'} as const;
  private readonly finalOutputs = new Map<number, DenseValue>();

  snapshot(): SweepReportSnapshot {
    return {
      declaration: cloneDeclaration(this.declaration),
      rows: this.rowCount,
      finalOutputs: [...this.finalOutputs.values()].map(output => ({
        ...output,
        channels: [...output.channels],
      })),
    };
  }

  denseSection(): ReportSection {
    return this.denseSectionFrom([...this.finalOutputs.values()]);
  }

  protected reset(): void {
    this.finalOutputs.clear();
  }

  protected capture(publication: RowPublication): void {
    for (const output of publication.outputs) {
      this.finalOutputs.set(output.outputId, {
        row: publication.row,
        outputId: output.outputId,
        channels: [...output.channels],
      });
    }
  }
}

export function composeOutputSinks(
  ...sinks: readonly OutputSink[]
): OutputSink {
  return {
    capabilities: {
      denseRows:
        sinks.length > 0 &&
        sinks.every(sink => sink.capabilities?.denseRows === 'final')
          ? 'final'
          : 'all',
      effects:
        sinks.length > 0 &&
        sinks.every(sink => sink.capabilities?.effects === 'none')
          ? 'none'
          : 'all',
    },
    declare(declaration) {
      for (const sink of sinks) {
        sink.declare(declaration);
      }
    },
    publish(publication) {
      for (const sink of sinks) {
        sink.publish(publication);
      }
    },
  };
}

export function sweepReportSections(
  summary: ExecutionSummary,
  sinks: readonly SweepReportSink[],
): readonly ReportSection[] {
  if (sinks.length !== summary.bindings.length) {
    throw new Error(
      `sweep report has ${sinks.length} sinks for ${summary.bindings.length} bindings`,
    );
  }
  const snapshots = sinks.map(sink => sink.snapshot());
  const paramNames = unique(
    summary.bindings.flatMap(binding =>
      binding.inputs.map(input => input.spec.name),
    ),
  );
  const dense = snapshots[0]?.declaration.outputs ?? [];
  const denseCols = denseColumns(dense);
  const results: ReportSection = {
    title: 'Sweep Results',
    columns: [
      'binding',
      'rows',
      ...paramNames,
      ...denseCols.map(column => column.label),
    ],
    rows: summary.bindings.map((binding, index) => {
      const snapshot = snapshots[index]!;
      const inputs = new Map(
        binding.inputs.map(input => [
          input.spec.name,
          reportValue(input.value),
        ]),
      );
      const outputs = new Map(
        snapshot.finalOutputs.map(output => [output.outputId, output.channels]),
      );
      return [
        binding.bindingIndex,
        binding.rows,
        ...paramNames.map(name => inputs.get(name) ?? ''),
        ...denseCols.map(column => {
          const value = outputs.get(column.outputId)?.[column.channel];
          return value === undefined ? '' : reportValue(value);
        }),
      ];
    }),
  };
  return [results];
}

interface DenseColumn {
  readonly outputId: number;
  readonly channel: number;
  readonly label: string;
}

function denseColumns(outputs: readonly DeclaredOutput[]): DenseColumn[] {
  return outputs.flatMap((output, outputId) =>
    output.spec.channels.map((channel, channelIndex) => ({
      outputId,
      channel: channelIndex,
      label: outputChannelLabel(output, outputId, channelIndex),
    })),
  );
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
    payload.kind === 'enum' || payload.kind === 'user-type'
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
  if (typeof value === 'number') {
    return Number.isNaN(value) ? 'na' : value;
  }
  if (value === null) {
    return 'na';
  }
  return typeof value === 'object' ? JSON.stringify(value) : value;
}

function logicalEffectValue(
  schema: EffectValueSchema,
  value: EffectValue,
): unknown {
  if (value === null || (typeof value === 'number' && Number.isNaN(value))) {
    return 'na';
  }
  if (schema.kind !== 'user-type') {
    return value;
  }
  if (typeof value !== 'object') {
    return '<invalid effect payload>';
  }
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
    case 'user-type':
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
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  return Object.freeze({
    kind: 'user-type' as const,
    fields: Object.freeze(value.fields.map(cloneEffectPayload)),
  });
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
