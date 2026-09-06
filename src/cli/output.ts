import type {Module} from '../runtime/module-binding';
// Purpose: Concrete terminal rendering for `tea run` reports and traces.

import {DataType, type Field, type Schema} from 'apache-arrow';
import {outputFields} from '../runtime/output';
import {TabWriter} from '../base/tabwriter';
import type {Datum} from '../runtime/output';

type Cell = string | number | boolean | null;

/** Describe named output columns in their declared schema order. */
export function traceDeclaration(declaration: Module['outputs']): string[] {
  return outputFields(declaration.schema).map(
    field =>
      `# ${field.metadata.get('tea:write')} ${JSON.stringify(field.name)} type=${fieldLabel(field)}`,
  );
}

/** Render every output cell using schema order, including integer-like names. */
export function traceDatum(datum: Datum, schema: Schema): string[] {
  const provisional = datum.provisional ? ' ?' : '';
  return outputFields(schema).map(
    field =>
      `${datum.index} ${JSON.stringify(field.name)}${provisional} ${traceValue(datum[field.name])}`,
  );
}

/** Renders final publications and timing; provisional updates are excluded.
 * @example
 * ```ts
 * const declaration = {declarations: [], schema: outputSchema([])};
 * renderRunReport(declaration, [], [], {
 *   indices: 0, compilationMs: 1, executionMs: 0,
 * }); // A System table reporting zero indices and 1.00 ms compilation.
 * ```
 */
export function renderRunReport(
  declaration: Module['outputs'],
  publications: readonly Datum[],
  inputs: Module['parameters'],
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
      inputs.map(input => [input.name, reportValue(input.value), input.active]),
    ),
    renderOutputs(declaration, publications),
  ]
    .filter(Boolean)
    .join('\n\n');
}

function renderOutputs(
  declaration: Module['outputs'],
  publications: readonly Datum[],
): string {
  const columns = outputFields(declaration.schema);
  if (columns.length === 0) return '';
  const byIndex = new Map<number, Datum>();
  for (const datum of publications) {
    if (!datum.provisional) byIndex.set(datum.index, datum);
  }
  return renderSection(
    'Outputs',
    ['index', ...columns.map(column => column.name)],
    [...byIndex.entries()]
      .sort(([left], [right]) => left - right)
      .map(([index, outputs]) => [
        index,
        ...columns.map(column => reportValue(outputs[column.name])),
      ]),
  );
}

function fieldLabel(field: Field): string {
  if (DataType.isList(field.type))
    return `List<${fieldLabel(field.type.children[0])}>`;
  return (
    field.metadata.get('tea:typeId') ??
    field.metadata.get('tea:type') ??
    field.type.toString()
  );
}

function reportValue(value: unknown): Cell {
  if (typeof value === 'number') return Number.isNaN(value) ? 'na' : value;
  if (value === null) return 'na';
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  return (
    JSON.stringify(value, (_key, item: unknown) =>
      typeof item === 'number' && Number.isNaN(item)
        ? 'na'
        : item instanceof Map
          ? [...item]
          : item instanceof Uint8Array
            ? [...item]
            : item,
    ) ?? ''
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
