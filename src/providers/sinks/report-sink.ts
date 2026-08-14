// Purpose: Generic report collectors: complete run capture and memory-bounded sweep summaries.

import type {ExecutionSummary} from '../../execute';
import type {ReportCell, ReportSection} from '../../reporting/report';
import {reportValue} from '../../reporting/report';
import {
  buildSweepResult,
  denseOutputColumns,
  sweepResultSection,
  type SweepDenseValue,
  type SweepReportSnapshot,
} from '../../reporting/sweep';
export type {SweepReportSnapshot} from '../../reporting/sweep';
import type {
  TrajectoryDenseEmission,
  TrajectoryEffectEmission,
  TrajectoryReportSnapshot,
} from '../../reporting/trajectory';
import {
  type EffectSpec,
  type EffectValue,
  type EffectValueSchema,
  type ExecutionDeclaration,
  type OutputSink,
  type RowPublication,
  type Value,
} from '../../runtime/abi';

type DenseValue = SweepDenseValue;

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
    const columns = denseOutputColumns(this.declaration.outputs);
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
  private readonly dense: TrajectoryDenseEmission[] = [];
  private readonly effects: TrajectoryEffectEmission[] = [];
  private readonly times = new Map<number, number | null>();

  snapshot(): TrajectoryReportSnapshot {
    return {
      declaration: cloneDeclaration(this.declaration),
      times: Array.from(
        {length: this.rowCount},
        (_, row) => this.times.get(row) ?? null,
      ),
      denseOutputs: this.dense.map(output => ({
        ...output,
        channels: [...output.channels],
      })),
      effects: this.effects.map(effect => ({
        ...effect,
        payload: cloneEffectPayload(effect.payload),
      })),
    };
  }

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
    this.times.clear();
  }

  protected capture(publication: RowPublication): void {
    this.times.set(
      publication.row,
      publication.time !== undefined && publication.time !== null
        ? publication.time
        : null,
    );
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

  snapshot(bindingIndex: number): SweepReportSnapshot {
    return {
      bindingIndex,
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
  const snapshots = sinks.map((sink, index) =>
    sink.snapshot(summary.bindings[index]!.bindingIndex),
  );
  return [sweepResultSection(buildSweepResult(summary, snapshots))];
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
