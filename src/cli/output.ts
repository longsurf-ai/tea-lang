// Purpose: Concrete terminal rendering for `tea run` reports and traces.

import type {Field} from 'apache-arrow';
import {TabWriter} from '../base/tabwriter';
import type {
  BoundInput,
  DeclaredOutput,
  Datum,
  ExecutionDeclaration,
} from '../runtime/abi';

type Cell = string | number | boolean | null;

/** Formats declarations using presentation metadata and Arrow payload fields.
 * @example traceDeclaration({outputs: [], effects: [], schema: new Schema([])})
 * // []
 */
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
    ...declaration.effects.map(
      (effect, effectId) =>
        `# effect[${effectId}] type=${fieldLabel(effect.payload)}`,
    ),
  ];
}

/** Formats a schema-named publication, restoring global event order.
 * @example traceDatum({index: 2, timed: false, provisional: false, output0: {series: 7}})
 * // ['2 0 7']
 */
export function traceDatum(datum: Datum): string[] {
  const provisional = datum.provisional ? ' ?' : '';
  return [
    ...Object.entries(datum).flatMap(([name, value]) =>
      /^output\d+$/.test(name) && value !== null && typeof value === 'object'
        ? [
            `${datum.index} ${name.slice(6)}${provisional} ${Object.values(value).map(traceValue).join(' ')}`,
          ]
        : [],
    ),
    ...events(datum).map(
      ({id, payload}) =>
        `${datum.index} effect[${id}]${provisional} ${traceValue(payload)}`,
    ),
  ];
}

/** Renders final publications and timing; provisional updates are excluded.
 * @example
 * ```ts
 * const declaration = {outputs: [], effects: [], schema: new Schema([])};
 * renderRunReport(declaration, [], [], {
 *   indices: 0, compilationMs: 1, executionMs: 0,
 * }); // A System table reporting zero indices and 1.00 ms compilation.
 * ```
 */
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
  if (columns.length === 0) return '';
  const byIndex = new Map<number, Datum>();
  for (const datum of publications) {
    if (!datum.provisional) byIndex.set(datum.index, datum);
  }
  return renderSection(
    'Outputs',
    ['index', ...columns.map(column => column.label)],
    [...byIndex.entries()]
      .sort(([left], [right]) => left - right)
      .map(([index, outputs]) => [
        index,
        ...columns.map(column => {
          const output = outputs[`output${column.outputId}`] as Record<
            string,
            unknown
          > | null;
          const channel =
            declaration.outputs[column.outputId]!.spec.channels[
              column.channel
            ]!;
          const value = output?.[channel.name];
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
      : events(datum).map(({id, payload}) => {
          const spec = declaration.effects[id];
          return [
            datum.index,
            `effect[${id}]${spec === undefined ? '' : ` ${fieldLabel(spec.payload)}`}`,
            reportValue(payload),
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

function fieldLabel(field: Field): string {
  return (
    field.metadata.get('tea:typeId') ??
    field.metadata.get('tea:type') ??
    field.type.toString()
  );
}

function events(datum: Datum) {
  return Object.entries(datum)
    .flatMap(([name, value]) =>
      /^effect\d+$/.test(name) && Array.isArray(value)
        ? value.map((event: {ordinal: number; payload: unknown}) => ({
            id: Number(name.slice(6)),
            ...event,
          }))
        : [],
    )
    .sort((a, b) => a.ordinal - b.ordinal);
}

function reportValue(value: unknown): Cell {
  if (typeof value === 'number') return Number.isNaN(value) ? 'na' : value;
  if (value === null) return 'na';
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'number' && Number.isNaN(item)
      ? 'na'
      : item instanceof Map
        ? [...item]
        : item instanceof Uint8Array
          ? [...item]
          : item,
  );
}

function traceValue(value: unknown): string {
  return String(reportValue(value));
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
