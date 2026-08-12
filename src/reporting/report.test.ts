// Purpose: Generic report sections render deterministically from target-neutral execution summaries.

import {describe, expect, test} from 'bun:test';
import type {ExecutionSummary} from '../execute';
import type {ParamSpec} from '../runtime/abi';
import {
  parameterReportSection,
  renderReport,
  systemReportSection,
} from './report';

const LENGTH: ParamSpec = {
  name: 'length',
  title: 'Length',
  type: 'int',
  control: 'int',
  defaultValue: 14,
  constraints: null,
  enumType: null,
  group: null,
  inline: null,
  tooltip: null,
  confirm: false,
  display: 'all',
  seriesSid: null,
};

describe('generic terminal reports', () => {
  test('prefaces results with backend statistics and effective parameters', () => {
    const summary: ExecutionSummary = {
      backend: 'gpu',
      bindings: [
        {
          bindingIndex: 0,
          rows: 200,
          inputs: [{spec: LENGTH, value: 20, active: true}],
        },
      ],
      timing: {loweringMs: 1.25, executionMs: 4, totalMs: 5.25},
      chunks: 2,
      dispatches: 2,
    };

    const rendered = renderReport([
      systemReportSection(summary, {device: 'Dawn'}),
      parameterReportSection(summary),
    ]);

    expect(rendered).toContain('# System');
    expect(rendered).toContain('backend     gpu');
    expect(rendered).toContain('device      Dawn');
    expect(rendered).toContain('throughput  50000 rows/s');
    expect(rendered).toContain('# Parameters');
    expect(rendered).toContain('0        length     20     true');
  });
});
