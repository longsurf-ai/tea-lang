// Purpose: Recipe run reports render deterministic timing and parameters.

import {describe, expect, test} from 'vitest';
import type {ParamSpec} from '../runtime/schema';
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

describe('run reports', () => {
  test('renders Recipe timing and effective parameters', () => {
    const rendered = renderReport([
      systemReportSection({
        indices: 200,
        timing: {compilationMs: 1.25, executionMs: 4, totalMs: 5.25},
      }),
      parameterReportSection([{spec: LENGTH, value: 20, active: true}]),
    ]);

    expect(rendered).toContain('# System');
    expect(rendered).toContain('indices      200');
    expect(rendered).toContain('compilation  1.25 ms');
    expect(rendered).toContain('execution    4.00 ms');
    expect(rendered).toContain('throughput   50000 indices/s');
    expect(rendered).toContain('# Parameters');
    expect(rendered).toContain('length     20     true');
  });
});
