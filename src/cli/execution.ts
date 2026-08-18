// Purpose: CLI host adapters for the three first-class execution entry points: run, sweep, and configured execute.

import {resolve} from 'node:path';
import type {ErrorMsg} from '../base/print';
import {Errors} from '../base/print';
import {compileToProgram} from '../compile';
import {paramSpecsOf} from '../codegen/params';
import type {ExecutionSummary} from '../execute';
import {
  type ExecutionConfig,
  ExecutionConfigError,
  type LoadedExecutionConfig,
} from '../execution/config';
import {
  executeConfiguredProgram,
  executeLoadedConfig,
  type ConfiguredExecutionResult,
} from '../execution/run';
import {RunReportSink, SweepReportSink} from '../providers/sinks/report-sink';
import {
  TrajectoryArchive,
  type TrajectoryArchiveSink,
} from '../providers/sinks/trajectory-archive';
import {TraceSink} from '../providers/sinks/trace-sink';
import {
  buildExecutionSystemResult,
  buildSweepResult,
  buildTrajectoryResult,
  EXECUTION_RESULT_SCHEMA,
  parameterReportSection,
  renderReport,
  sweepResultSection,
  systemReportSection,
  type ReportSection,
  type SweepResult,
} from '../reporting';
import type {OutputSink} from '../runtime/abi';
import {
  parseRunParameterSelections,
  parseSweepParameterSelections,
} from './parameters';

const JSON_RESULT_MAX_BYTES = 256 * 1024 * 1024;

const RUN_RESERVED_PARAMETERS = new Set([
  'input',
  'i',
  'trace',
  'gpu',
  'help',
  'h',
  'version',
  'V',
]);

const SWEEP_RESERVED_PARAMETERS = new Set([
  'input',
  'i',
  'cpu',
  'max-scenarios',
  'help',
  'h',
  'version',
  'V',
]);

export interface CliExecutionHost {
  readonly environment: NodeJS.ProcessEnv;
  readonly fetchImpl: typeof fetch;
  readonly now: () => number;
  print(line: string): void;
}

export type CliExecutionResult =
  | {readonly ok: true}
  | {readonly ok: false; readonly errors: readonly ErrorMsg[]};

export async function executeConfigCommand(
  loaded: LoadedExecutionConfig,
  json: boolean,
  host: CliExecutionHost,
): Promise<CliExecutionResult> {
  const errors = new Errors();
  if (loaded.config.execution.kind === 'run') {
    const sink = new RunReportSink();
    const result = await executeLoadedConfig(
      loaded,
      errors,
      contextDependencies(host, () => sink),
    );
    if (!result.ok) return result;
    if (json) {
      const binding = result.execution.summary.bindings[0];
      if (binding === undefined) {
        throw new ExecutionConfigError('run execution produced no trajectory');
      }
      printJson(host, {
        ...machineResultBase(loaded, result.execution, result.programBytesHash),
        trajectory: buildTrajectoryResult(binding, sink.snapshot()),
      });
    } else {
      renderRunExecution(host, result.execution, sink);
    }
    return {ok: true};
  }

  if (!json) {
    const sinks: SweepReportSink[] = [];
    const result = await executeLoadedConfig(
      loaded,
      errors,
      contextDependencies(host, executionIndex => {
        const sink = new SweepReportSink();
        sinks[executionIndex] = sink;
        return sink;
      }),
    );
    if (!result.ok) return result;
    renderSweepExecution(host, result.execution, sinks);
    return {ok: true};
  }

  const archive = new TrajectoryArchive({
    maxBytes: JSON_RESULT_MAX_BYTES,
    maxProjectionBytes: JSON_RESULT_MAX_BYTES,
  });
  const sinks: TrajectoryArchiveSink[] = [];
  try {
    const result = await executeLoadedConfig(
      loaded,
      errors,
      contextDependencies(host, executionIndex => {
        const sink = archive.createSink();
        sinks[executionIndex] = sink;
        return sink;
      }),
    );
    if (!result.ok) return result;
    printJson(host, {
      ...machineResultBase(loaded, result.execution, result.programBytesHash),
      sweep: sweepResultForExecution(result.execution, sinks),
      trajectories: archive.trajectories(result.execution.summary.bindings),
    });
    return {ok: true};
  } finally {
    archive.reset();
  }
}

export async function runCommand(
  file: string,
  input: string,
  options: {readonly trace: boolean; readonly gpu: boolean},
  dynamicTokens: readonly string[],
  host: CliExecutionHost,
): Promise<CliExecutionResult> {
  const errors = new Errors();
  const program = compileToProgram([file], errors);
  if (program === null) return {ok: false, errors: errors.flushErrors()};
  const parameters = parseRunParameterSelections(
    paramSpecsOf(program.params),
    dynamicTokens,
    RUN_RESERVED_PARAMETERS,
  );
  const reportSink = options.trace ? null : new RunReportSink();
  const sink: OutputSink =
    reportSink ?? new TraceSink(line => host.print(line));
  const execution = await executeConfiguredProgram(
    program,
    directConfig(
      'run',
      file,
      input,
      {kind: options.gpu ? 'webgpu' : 'javascript'},
      parameters,
    ),
    contextDependencies(host, () => sink),
  );
  renderRunExecution(host, execution, reportSink);
  return {ok: true};
}

export async function sweepCommand(
  file: string,
  input: string,
  options: {readonly cpu: boolean; readonly maxScenarios: number},
  dynamicTokens: readonly string[],
  host: CliExecutionHost,
): Promise<CliExecutionResult> {
  const errors = new Errors();
  const program = compileToProgram([file], errors);
  if (program === null) return {ok: false, errors: errors.flushErrors()};
  const parameters = parseSweepParameterSelections(
    paramSpecsOf(program.params),
    dynamicTokens,
    SWEEP_RESERVED_PARAMETERS,
  );
  const config = directConfig(
    'sweep',
    file,
    input,
    {kind: options.cpu ? 'javascript' : 'webgpu'},
    parameters,
    options.maxScenarios,
  );
  const sinks: SweepReportSink[] = [];
  const execution = await executeConfiguredProgram(
    program,
    config,
    contextDependencies(host, executionIndex => {
      const sink = new SweepReportSink();
      sinks[executionIndex] = sink;
      return sink;
    }),
  );
  renderSweepExecution(host, execution, sinks);
  return {ok: true};
}

function directConfig(
  kind: 'run' | 'sweep',
  source: string,
  input: string,
  runtime: ExecutionConfig['runtime'],
  parameters: ExecutionConfig['execution']['parameters'],
  maxExecutions?: number,
): ExecutionConfig {
  const provider = {kind: 'csv' as const, path: resolve(input)};
  const execution =
    kind === 'run'
      ? ({kind, provider, parameters} as const)
      : ({
          kind,
          provider,
          parameters,
          ...(maxExecutions === undefined ? {} : {maxExecutions}),
        } as const);
  return {
    schema: 'tea.execution/v1',
    program: {source: resolve(source)},
    runtime,
    execution,
  };
}

function contextDependencies(
  host: CliExecutionHost,
  sinkForExecution: (executionIndex: number) => OutputSink,
) {
  return {
    environment: host.environment,
    fetchImpl: host.fetchImpl,
    now: host.now,
    sinkForExecution,
  };
}

function reportSectionsForRun(
  summary: ExecutionSummary,
  sink: RunReportSink,
  device?: string,
): readonly ReportSection[] {
  return [
    systemReportSection(summary, {device}),
    parameterReportSection(summary),
    sink.denseSection(),
    sink.effectsSection(),
  ].filter(section => section.rows.length > 0);
}

function renderRunExecution(
  host: CliExecutionHost,
  execution: ConfiguredExecutionResult,
  sink: RunReportSink | null,
): void {
  if (sink === null) return;
  const rendered = renderReport(
    reportSectionsForRun(execution.summary, sink, execution.device),
  );
  if (rendered.length > 0) host.print(rendered);
}

function renderSweepExecution(
  host: CliExecutionHost,
  execution: ConfiguredExecutionResult,
  sinks: readonly SweepReportSink[],
): void {
  const result = sweepResultForExecution(execution, sinks);
  const rendered = renderReport([
    systemReportSection(execution.summary, {device: execution.device}),
    sweepResultSection(result),
  ]);
  if (rendered.length > 0) host.print(rendered);
}

function sweepResultForExecution(
  execution: ConfiguredExecutionResult,
  sinks: readonly {
    snapshot(bindingIndex: number): ReturnType<SweepReportSink['snapshot']>;
  }[],
): SweepResult {
  return buildSweepResult(
    execution.summary,
    sinks.map((sink, index) =>
      sink.snapshot(execution.summary.bindings[index]!.bindingIndex),
    ),
    execution.axes,
  );
}

function machineResultBase(
  loaded: LoadedExecutionConfig,
  execution: ConfiguredExecutionResult,
  programBytesHash: string,
) {
  if (execution.providerBytesHash === undefined) {
    throw new ExecutionConfigError(
      'machine execution did not capture provider bytes',
    );
  }
  return {
    schema: EXECUTION_RESULT_SCHEMA,
    config: {
      bytesHash: loaded.bytesHash,
      programSource: loaded.config.program.source,
      programBytesHash,
      providerBytesHash: execution.providerBytesHash,
      effectiveTimeNow: execution.timeNow,
    },
    system: buildExecutionSystemResult(execution),
  } as const;
}

function printJson(host: CliExecutionHost, value: unknown): void {
  host.print(JSON.stringify(value));
}
