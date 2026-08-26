// Purpose: Renderer-neutral sweep results and their terminal report projection.

import type {ExecutionSummary} from '../execution/execute';
import type {SweepRange} from '../execution/parameters';
import type {DeclaredOutput, ExecutionDeclaration, Value} from '../runtime/abi';
import {reportValue, type ReportSection} from './report';

export type SweepParameterId = `parameter:${string}`;
export type SweepOutputId = `output:${number}:${number}`;
export type SweepMetricId = `metric:${number}:${number}`;
export type SweepCell = number | string | boolean | null;

export interface SweepDenseValue {
  readonly row: number;
  readonly outputId: number;
  readonly channels: readonly Value[];
}

export interface SweepReportSnapshot {
  readonly bindingIndex: number;
  readonly declaration: ExecutionDeclaration;
  readonly rows: number;
  readonly finalOutputs: readonly SweepDenseValue[];
}

export interface SweepParameter {
  readonly id: SweepParameterId;
  readonly name: string;
  readonly label: string;
  readonly type: string;
  readonly swept: boolean;
  readonly values: readonly SweepCell[];
}

export interface SweepOutput {
  readonly id: SweepOutputId;
  readonly outputId: number;
  readonly channel: number;
  readonly label: string;
  readonly type: string;
}

export interface SweepMetric {
  readonly id: SweepMetricId;
  readonly output: SweepOutputId;
  readonly label: string;
}

export interface SweepScenario {
  readonly bindingIndex: number;
  readonly rows: number;
  readonly parameters: Readonly<Record<SweepParameterId, SweepCell>>;
  readonly outputs: Readonly<Partial<Record<SweepOutputId, SweepCell>>>;
  readonly metrics: Readonly<Partial<Record<SweepMetricId, number | null>>>;
}

export interface SweepResult {
  readonly axes: readonly SweepRange[];
  readonly parameters: readonly SweepParameter[];
  readonly outputs: readonly SweepOutput[];
  readonly metrics: readonly SweepMetric[];
  readonly scenarios: readonly SweepScenario[];
}

export interface DenseOutputColumn extends SweepOutput {}

export function buildSweepResult(
  summary: ExecutionSummary,
  snapshots: readonly SweepReportSnapshot[],
  ranges: readonly SweepRange[] = [],
): SweepResult {
  if (snapshots.length !== summary.bindings.length) {
    throw new Error(
      `sweep report has ${snapshots.length} snapshots for ${summary.bindings.length} bindings`,
    );
  }

  const snapshotsByBinding = new Map<number, SweepReportSnapshot>();
  for (const snapshot of snapshots) {
    if (snapshotsByBinding.has(snapshot.bindingIndex)) {
      throw new Error(
        `sweep report has duplicate snapshot for binding ${snapshot.bindingIndex}`,
      );
    }
    snapshotsByBinding.set(snapshot.bindingIndex, snapshot);
  }
  const bindingIndices = new Set<number>();
  for (const binding of summary.bindings) {
    if (bindingIndices.has(binding.bindingIndex)) {
      throw new Error(
        `sweep report has duplicate execution binding ${binding.bindingIndex}`,
      );
    }
    bindingIndices.add(binding.bindingIndex);
    const snapshot = snapshotsByBinding.get(binding.bindingIndex);
    if (snapshot === undefined) {
      throw new Error(
        `sweep report is missing snapshot for binding ${binding.bindingIndex}`,
      );
    }
    if (snapshot.rows !== binding.rows) {
      throw new Error(
        `sweep report binding ${binding.bindingIndex} has ${snapshot.rows} snapshot rows for ${binding.rows} execution rows`,
      );
    }
  }

  const firstSnapshot =
    summary.bindings.length === 0
      ? undefined
      : snapshotsByBinding.get(summary.bindings[0]!.bindingIndex);
  const outputs = denseOutputColumns(firstSnapshot?.declaration.outputs ?? []);
  const outputSchema = JSON.stringify(
    firstSnapshot?.declaration.outputs.map(output => output.spec) ?? [],
  );
  for (const snapshot of snapshots) {
    if (
      JSON.stringify(
        snapshot.declaration.outputs.map(output => output.spec),
      ) !== outputSchema
    ) {
      throw new Error(
        `sweep report binding ${snapshot.bindingIndex} has a mismatched output schema`,
      );
    }
  }
  const numericOutputs = new Map(
    outputs
      .filter(output => output.type === 'int' || output.type === 'float')
      .map(output => [output.id, metricFor(output)]),
  );
  const scenarios = summary.bindings.map((binding): SweepScenario => {
    const snapshot = snapshotsByBinding.get(binding.bindingIndex)!;
    const parameters: Record<SweepParameterId, SweepCell> = {};
    for (const input of binding.inputs) {
      parameters[parameterId(input.spec.name)] = normalizeSweepValue(
        input.value,
      );
    }

    const outputValues: Partial<Record<SweepOutputId, SweepCell>> = {};
    const metricValues: Partial<Record<SweepMetricId, number | null>> = {};
    const byOutput = new Map(
      snapshot.finalOutputs.map(output => [output.outputId, output.channels]),
    );
    for (const output of outputs) {
      const value = byOutput.get(output.outputId)?.[output.channel];
      if (value === undefined) continue;
      const normalized = normalizeSweepValue(value);
      outputValues[output.id] = normalized;
      const metric = numericOutputs.get(output.id);
      if (metric !== undefined) {
        metricValues[metric.id] =
          typeof normalized === 'number' ? normalized : null;
      }
    }

    return {
      bindingIndex: binding.bindingIndex,
      rows: binding.rows,
      parameters,
      outputs: outputValues,
      metrics: metricValues,
    };
  });

  const rangeNames = new Set(ranges.map(range => range.name));
  const parameterSpecs = uniqueByName(
    summary.bindings.flatMap(binding =>
      binding.inputs.map(input => input.spec),
    ),
  );
  const parameters = parameterSpecs.map((spec): SweepParameter => {
    const id = parameterId(spec.name);
    return {
      id,
      name: spec.name,
      label:
        typeof spec.title === 'string' && spec.title.length > 0
          ? spec.title
          : spec.name,
      type: spec.type,
      swept: rangeNames.has(spec.name),
      values: uniqueCells(
        scenarios.map(scenario => scenario.parameters[id] ?? null),
      ),
    };
  });

  return {
    axes: ranges.map(range => ({...range, values: [...range.values]})),
    parameters,
    outputs,
    metrics: [...numericOutputs.values()],
    scenarios,
  };
}

export function sweepResultSection(result: SweepResult): ReportSection {
  return {
    title: 'Sweep Results',
    columns: [
      'binding',
      'rows',
      ...result.parameters.map(parameter => parameter.name),
      ...result.outputs.map(output => output.label),
    ],
    rows: result.scenarios.map(scenario => [
      scenario.bindingIndex,
      scenario.rows,
      ...result.parameters.map(parameter =>
        reportValue(scenario.parameters[parameter.id]),
      ),
      ...result.outputs.map(output =>
        output.id in scenario.outputs
          ? reportValue(scenario.outputs[output.id] ?? null)
          : '',
      ),
    ]),
  };
}

export function denseOutputColumns(
  outputs: readonly DeclaredOutput[],
): DenseOutputColumn[] {
  return outputs.flatMap((output, outputId) =>
    output.spec.channels.map((channelSpec, channel) => ({
      id: outputIdFor(outputId, channel),
      outputId,
      channel,
      label: outputChannelLabel(output, outputId, channel),
      type: channelSpec.type,
    })),
  );
}

export function parameterId(name: string): SweepParameterId {
  return `parameter:${name}`;
}

export function outputIdFor(outputId: number, channel: number): SweepOutputId {
  return `output:${outputId}:${channel}`;
}

export function metricIdFor(outputId: number, channel: number): SweepMetricId {
  return `metric:${outputId}:${channel}`;
}

function metricFor(output: SweepOutput): SweepMetric {
  return {
    id: metricIdFor(output.outputId, output.channel),
    output: output.id,
    label: output.label,
  };
}

function normalizeSweepValue(value: Value): SweepCell {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  return JSON.stringify(value);
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

function uniqueByName<T extends {readonly name: string}>(
  values: readonly T[],
): readonly T[] {
  const seen = new Set<string>();
  return values.filter(value => {
    if (seen.has(value.name)) return false;
    seen.add(value.name);
    return true;
  });
}

function uniqueCells(values: readonly SweepCell[]): readonly SweepCell[] {
  const seen = new Set<string>();
  return values.filter(value => {
    const key = `${typeof value}:${String(value)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
