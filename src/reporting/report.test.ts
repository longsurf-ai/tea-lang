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
      timing: {
        loweringMs: 1.25,
        executionMs: 4,
        totalMs: 5.25,
        preparationMs: 0.5,
        encodeSubmitMs: 0.25,
        completionReadbackMs: 2.5,
        decodePublicationMs: 0.25,
      },
      chunks: 2,
      dispatches: 2,
      cache: {
        mode: 'workgroup-prefix',
        entryPoint: 'tea_main_cached',
        workgroupSize: 64,
        cachedWordsPerExecution: 12,
        cachedBytesPerExecution: 48,
        bytesPerWorkgroup: 3_072,
        segmentIds: ['root:header', 'root:locals'],
      },
    };

    const rendered = renderReport([
      systemReportSection(summary, {device: 'Dawn'}),
      parameterReportSection(summary),
    ]);

    expect(rendered).toContain('# System');
    expect(rendered).toContain('backend                gpu');
    expect(rendered).toContain('device                 Dawn');
    expect(rendered).toContain('throughput             50000 rows/s');
    expect(rendered).toContain('gpu preparation        0.50 ms');
    expect(rendered).toContain('encode + submit        0.25 ms');
    expect(rendered).toContain('completion + readback  2.50 ms');
    expect(rendered).toContain('decode + publication   0.25 ms');
    expect(rendered).toContain('cache mode             workgroup-prefix');
    expect(rendered).toContain('workgroup size         64');
    expect(rendered).toContain('cache / execution      48 B');
    expect(rendered).toContain('cache / workgroup      3072 B');
    expect(rendered).toContain('cached segments        2');
    expect(rendered).not.toContain('root:header');
    expect(rendered).toContain('# Parameters');
    expect(rendered).toContain('0        length     20     true');
  });
});
