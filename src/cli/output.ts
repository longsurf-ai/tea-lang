// Purpose: Concrete terminal rendering for `tea run` reports and traces.

import {TabWriter} from '../base/tabwriter';
import type {
  BoundInput,
  DeclaredOutput,
  Datum,
  EffectValue,
  EffectValueSchema,
  ExecutionDeclaration,
  Value,
} from '../runtime/abi';

type Cell = string | number | boolean | null;

export function traceDeclaration(declaration: ExecutionDeclaration): string[] {
  return [
    ...declaration.outputs.map((output, outputId) => {
      const statics = output.spec.staticArgs
        .map(arg => `${arg.name}=${traceValue(arg.value)}`)
        .join(' ');
      const bounds = output.boundArgs
        .map(arg => `${arg.name}=${traceValue(arg.value)}`)
        .join(' ');
      return (
        `# output[${outputId}] ${output.spec.effect}` +
        (statics.length > 0 ? ` ${statics}` : '') +
        (bounds.length > 0 ? ` bound{${bounds}}` : '')
      );
    }),
    ...declaration.effects.map((effect, effectId) => {
      const payload = effect.payload;
      const name =
        payload.kind === 'enum' || payload.kind === 'struct'
          ? payload.typeId
          : payload.kind;
      return `# effect[${effectId}] type=${name}`;
    }),
  ];
}

export function traceDatum(datum: Datum): string[] {
  const provisional = datum.provisional ? ' ?' : '';
  return [
    ...datum.outputs.map(
      output =>
        `${datum.index} ${output.outputId}${provisional} ${output.channels
          .map(traceValue)
          .join(' ')}`,
    ),
    ...datum.effects.map(
      effect =>
        `${datum.index} effect[${effect.effectId}]${provisional} ${traceEffectValue(effect.payload)}`,
    ),
  ];
}

export function renderRunReport(
  declaration: ExecutionDeclaration,
  publications: readonly Datum[],
  inputs: readonly BoundInput[],
  summary: Readonly<{
    indices: number;
    compilationMs: number;
    executionMs: number;
  }>,
): string {
  const seconds = summary.executionMs / 1_000;
  return [
    renderSection(
      'System',
      ['stat', 'value'],
      [
        ['indices', summary.indices],
        ['compilation', milliseconds(summary.compilationMs)],
        ['execution', milliseconds(summary.executionMs)],
        ['total', milliseconds(summary.compilationMs + summary.executionMs)],
        [
          'throughput',
          seconds > 0
            ? `${Math.round(summary.indices / seconds)} indices/s`
            : 'n/a',
        ],
      ],
    ),
    renderSection(
      'Parameters',
      ['parameter', 'value', 'active'],
      inputs.map(input => [
        input.spec.name,
        reportValue(input.value),
        input.active,
      ]),
    ),
    renderOutputs(declaration, publications),
    renderEffects(declaration, publications),
  ]
    .filter(Boolean)
    .join('\n\n');
}

function renderOutputs(
  declaration: ExecutionDeclaration,
  publications: readonly Datum[],
): string {
  const columns = declaration.outputs.flatMap((output, outputId) =>
    output.spec.channels.map((_channel, channel) => ({
      outputId,
      channel,
      label: outputChannelLabel(output, outputId, channel),
    })),
  );
  const byIndex = new Map<number, Map<number, readonly Value[]>>();
  for (const datum of publications) {
    if (datum.provisional) continue;
    for (const output of datum.outputs) {
      let values = byIndex.get(datum.index);
      if (values === undefined) {
        values = new Map();
        byIndex.set(datum.index, values);
      }
      values.set(output.outputId, output.channels);
    }
  }
  return renderSection(
    'Outputs',
    ['index', ...columns.map(column => column.label)],
    [...byIndex.entries()]
      .sort(([left], [right]) => left - right)
      .map(([index, outputs]) => [
        index,
        ...columns.map(column => {
          const value = outputs.get(column.outputId)?.[column.channel];
          return value === undefined ? '' : reportValue(value);
        }),
      ]),
  );
}

function renderEffects(
  declaration: ExecutionDeclaration,
  publications: readonly Datum[],
): string {
  const rows = publications.flatMap(datum =>
    datum.provisional
      ? []
      : datum.effects.map(effect => {
          const spec = declaration.effects[effect.effectId];
          return [
            datum.index,
            spec === undefined
              ? `effect[${effect.effectId}]`
              : effectLabel(spec.payload, effect.effectId),
            spec === undefined
              ? displayEffectValue(effect.payload)
              : JSON.stringify(
                  logicalEffectValue(spec.payload, effect.payload),
                ),
          ] as const;
        }),
  );
  return renderSection('Effects', ['index', 'effect', 'payload'], rows);
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

function effectLabel(schema: EffectValueSchema, effectId: number): string {
  const type =
    schema.kind === 'enum' || schema.kind === 'struct'
      ? schema.typeId
      : schema.kind;
  return `effect[${effectId}] ${type}`;
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

function displayEffectValue(value: EffectValue): Cell {
  if (typeof value === 'number') return Number.isNaN(value) ? 'na' : value;
  if (value === null) return 'na';
  return typeof value === 'object' ? JSON.stringify(value) : value;
}

function reportValue(value: Value): Cell {
  if (typeof value === 'number') return Number.isNaN(value) ? 'na' : value;
  if (value === null) return 'na';
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  return JSON.stringify(value);
}

function traceValue(value: Value): string {
  if (typeof value === 'number') {
    return Number.isNaN(value) ? 'na' : String(value);
  }
  return value === null ? 'na' : String(value);
}

function traceEffectValue(value: EffectValue): string {
  if (typeof value === 'number') {
    return Number.isNaN(value) ? 'na' : String(value);
  }
  if (value === null) return 'na';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function milliseconds(value: number): string {
  return `${value.toFixed(2)} ms`;
}

function renderSection(
  title: string,
  columns: readonly string[],
  rows: readonly (readonly Cell[])[],
): string {
  if (rows.length === 0) return '';
  const writer = new TabWriter();
  writer.writeRaw(`# ${title}`);
  writer.writeCells(columns);
  for (const row of rows) writer.writeCells(row.map(formatCell));
  return writer.flush();
}

function formatCell(cell: Cell): string {
  if (cell === null || (typeof cell === 'number' && Number.isNaN(cell))) {
    return 'na';
  }
  return String(cell);
}
