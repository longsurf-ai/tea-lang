// Purpose: Backend-neutral report sections and deterministic terminal rendering.

import {TabWriter} from '../base/tabwriter';
import type {ExecutionSummary} from '../execute';
import type {Value} from '../runtime/abi';

export type ReportCell = string | number | boolean | null;

export interface ReportSection {
  readonly title: string;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly ReportCell[])[];
}

export interface SystemReportOptions {
  readonly device?: string;
}

export function systemReportSection(
  summary: ExecutionSummary,
  options: SystemReportOptions = {},
): ReportSection {
  const rows = summary.bindings.reduce(
    (total, binding) => total + binding.rows,
    0,
  );
  const seconds = summary.timing.executionMs / 1_000;
  const reportRows: ReportCell[][] = [
    ['backend', summary.backend],
    ...(options.device === undefined
      ? []
      : [['device', options.device] as ReportCell[]]),
    ['bindings', summary.bindings.length],
    ['rows', rows],
    ['lowering', milliseconds(summary.timing.loweringMs)],
    ['execution', milliseconds(summary.timing.executionMs)],
    ['total', milliseconds(summary.timing.totalMs)],
    [
      'throughput',
      seconds > 0 ? `${Math.round(rows / seconds)} rows/s` : 'n/a',
    ],
  ];
  if (summary.backend === 'gpu') {
    reportRows.push(
      ['chunks', summary.chunks],
      ['dispatches', summary.dispatches],
    );
  }
  return {title: 'System', columns: ['stat', 'value'], rows: reportRows};
}

export function parameterReportSection(
  summary: ExecutionSummary,
): ReportSection {
  return {
    title: 'Parameters',
    columns: ['binding', 'parameter', 'value', 'active'],
    rows: summary.bindings.flatMap(binding =>
      binding.inputs.map(input => [
        binding.bindingIndex,
        input.spec.name,
        reportValue(input.value),
        input.active,
      ]),
    ),
  };
}

export function renderReport(sections: readonly ReportSection[]): string {
  return sections.map(renderSection).join('\n\n');
}

export function reportValue(value: Value): ReportCell {
  if (typeof value === 'number') {
    return Number.isNaN(value) ? 'na' : value;
  }
  if (value === null) {
    return 'na';
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  return JSON.stringify(value);
}

function milliseconds(value: number): string {
  return `${value.toFixed(2)} ms`;
}

function renderSection(section: ReportSection): string {
  const writer = new TabWriter();
  writer.writeRaw(`# ${section.title}`);
  if (section.columns.length > 0) {
    writer.writeCells(section.columns);
  }
  for (const row of section.rows) {
    writer.writeCells(row.map(formatCell));
  }
  return writer.flush();
}

function formatCell(cell: ReportCell): string {
  if (cell === null) {
    return 'na';
  }
  if (typeof cell === 'number' && Number.isNaN(cell)) {
    return 'na';
  }
  return String(cell);
}
