#!/usr/bin/env bun
// Purpose: CLI entry point — Commander argument parsing and process I/O only; all compilation lives in compile.ts. Sole owner of error printing and exit codes; run presentation is delegated to providers sinks.

import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createInterface} from 'node:readline';
import {Command, InvalidArgumentError, Option} from 'commander';
import {configureLog, parseLogLevel} from './base/log';
import {formatPos, newFileBase} from './base/pos';
import {Errors, type ErrorMsg} from './base/print';
import {UnimplementedError} from './base/unimplemented';
import {
  CliParameterError,
  parseRunParameterSelections,
  parseSweepParameterSelections,
} from './cli/parameters';
import {compile, compileToProgram, parseFile} from './compile';
import {paramSpecsOf} from './codegen/params';
import {startDocsServer} from './docs/server';
import {
  type ExecutionSummary,
  UnsupportedExecutionTargetError,
} from './execute';
import {
  ExecutionConfigError,
  loadExecutionConfig,
  type ExecutionConfig,
  type LoadedExecutionConfig,
} from './execution/config';
import {ExecutionParameterError} from './execution/parameters';
import {
  executeConfiguredProgram,
  executeLoadedConfig,
  executeLoadedSweepScenario,
  type ConfiguredExecutionResult,
} from './execution/run';
import {dumpProgram} from './ir/dumper';
import {GpuDeviceError} from './providers/gpu/dawn';
import {
  expectedRelayedConfigHash,
  relayGpuCliToNode,
} from './providers/gpu/node-host';
import {RunReportSink, SweepReportSink} from './providers/sinks/report-sink';
import {
  TrajectoryArchive,
  TrajectoryArchiveBudgetError,
  TrajectoryArchiveProjectionBudgetError,
  TrajectoryArchiveUnsupportedTransportError,
  type TrajectoryArchiveSink,
} from './providers/sinks/trajectory-archive';
import {TraceSink} from './providers/sinks/trace-sink';
import {
  buildSweepResult,
  buildExecutionSystemResult,
  buildTrajectoryResult,
  DASHBOARD_TRAJECTORY_RESULT_SCHEMA,
  EXECUTION_RESULT_SCHEMA,
  parameterReportSection,
  renderReport,
  sweepResultSection,
  systemReportSection,
  type ReportSection,
  type ExecutionSnapshotResult,
  type SweepResult,
} from './reporting';
import type {SweepReportSnapshot} from './reporting/sweep';
import {
  BindError,
  ExecutionError,
  RequestError,
  type OutputSink,
} from './runtime/abi';
import {GpuBindingError, GpuExecutionError} from './runtime/gpu';
import {dumpFile, dumpTokens} from './syntax/dumper';
import {tokenize} from './syntax/syntax';
import {
  PlotlySweepRenderer,
  startSweepViewer,
  SweepProjectionError,
} from './visualization';

// Exit 1: the Tea source had errors. The batch arrives sorted and deduped
// from flushErrors(); this is the only place errors are printed.
function exitWithErrors(errors: readonly ErrorMsg[]): never {
  for (const e of errors) {
    console.error(`${formatPos(e.pos)}: ${e.msg}`);
  }
  process.exit(1);
}

// Exit 2: an unimplemented stage was reached (distinct from exit 1 for Tea
// source errors); everything else is an internal failure and propagates
// loudly with a stack.
function runStage<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof UnimplementedError) {
      console.error(`tea: ${error.message}`);
      process.exit(2);
    }
    throw error;
  }
}

// The async variant for verbs that bind: context resolution awaits.
async function runStageAsync<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof UnimplementedError) {
      console.error(`tea: ${error.message}`);
      process.exit(2);
    }
    throw error;
  }
}

// Logging is configured once at the process boundary: TEA_LOG names the
// level (debug|info|warn|error; default warn), events go to stderr —
// stdout stays program output.
const teaLogLevel = process.env['TEA_LOG'];
if (teaLogLevel !== undefined && teaLogLevel !== '') {
  const level = parseLogLevel(teaLogLevel);
  if (level === null) {
    console.error(
      `tea: unknown TEA_LOG level '${teaLogLevel}' (debug|info|warn|error)`,
    );
  } else {
    configureLog({level});
  }
}

const cliArguments = process.argv.slice(2);
let preloadedExecutionConfig: LoadedExecutionConfig | null = null;
try {
  const configArgument = executeConfigArgument(cliArguments);
  if (configArgument !== null) {
    preloadedExecutionConfig = loadExecutionConfig(configArgument);
    const expectedHash = expectedRelayedConfigHash();
    if (
      expectedHash !== null &&
      preloadedExecutionConfig.bytesHash !== expectedHash
    ) {
      throw new ExecutionConfigError(
        'execution config changed after GPU host selection',
      );
    }
  }
  const relayed = await relayGpuCliToNode(
    cliArguments,
    import.meta.url,
    preloadedExecutionConfig === null
      ? {}
      : {
          executionRuntime: preloadedExecutionConfig.config.runtime.kind,
          configBytesHash: preloadedExecutionConfig.bytesHash,
        },
  );
  if (relayed !== null) process.exit(relayed);
} catch (error) {
  if (
    error instanceof GpuDeviceError ||
    error instanceof ExecutionConfigError
  ) {
    console.error(`tea: ${error.message}`);
    process.exit(1);
  }
  throw error;
}

function executeConfigArgument(args: readonly string[]): string | null {
  if (args[0] !== 'execute') return null;
  const separator = args.indexOf('--');
  const options = args.slice(1, separator < 0 ? undefined : separator);
  if (
    options.includes('--help') ||
    options.includes('-h') ||
    options.includes('--version') ||
    options.includes('-V')
  )
    return null;
  let optionsEnded = false;
  const valueOptions = new Set([
    '--scenario',
    '--expected-config-sha256',
    '--expected-program-sha256',
    '--expected-provider-sha256',
    '--replay-time-now',
  ]);
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--') {
      optionsEnded = true;
      continue;
    }
    if (optionsEnded) return argument;
    if (
      argument === '--view' ||
      argument === '--trace' ||
      argument === '--json' ||
      argument === '--dashboard-session'
    )
      continue;
    if (valueOptions.has(argument)) {
      index += 1;
      continue;
    }
    if ([...valueOptions].some(option => argument.startsWith(`${option}=`)))
      continue;
    if (argument.startsWith('-')) {
      throw new ExecutionConfigError(`unknown execute option '${argument}'`);
    }
    return argument;
  }
  return null;
}

const tea = new Command('tea')
  .description('Tea language compiler and runner')
  .version('0.1.0');

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new InvalidArgumentError('port must be an integer from 0 to 65535');
  }
  return port;
}

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new InvalidArgumentError('value must be a positive integer');
  }
  return parsed;
}

function parsePositiveOrZeroInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new InvalidArgumentError('value must be a non-negative safe integer');
  }
  return parsed;
}

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
  'view',
  'max-scenarios',
  'help',
  'h',
  'version',
  'V',
]);

function dynamicTokens(command: Command): readonly string[] {
  return command.args.slice(1);
}

function exitWithExecutionError(error: unknown): never {
  if (isExecutionHostError(error)) {
    console.error(`tea: ${error.message}`);
    process.exit(1);
  }
  throw error;
}

function isExecutionHostError(error: unknown): error is Error {
  return (
    error instanceof CliParameterError ||
    error instanceof ExecutionConfigError ||
    error instanceof ExecutionParameterError ||
    error instanceof BindError ||
    error instanceof RequestError ||
    error instanceof ExecutionError ||
    error instanceof UnsupportedExecutionTargetError ||
    error instanceof GpuBindingError ||
    error instanceof GpuExecutionError ||
    error instanceof GpuDeviceError ||
    error instanceof SweepProjectionError ||
    error instanceof TrajectoryArchiveBudgetError ||
    error instanceof TrajectoryArchiveProjectionBudgetError ||
    error instanceof TrajectoryArchiveUnsupportedTransportError
  );
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

function legacyConfig(
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
  sinkForExecution: (executionIndex: number) => OutputSink,
  expectedProviderBytesHash?: string,
) {
  return {
    environment: process.env,
    fetchImpl: fetch,
    now: Date.now,
    sinkForExecution,
    ...(expectedProviderBytesHash === undefined
      ? {}
      : {expectedProviderBytesHash}),
  };
}

function rangeSelectionCount(config: ExecutionConfig): number {
  return Object.values(config.execution.parameters).filter(
    selection =>
      typeof selection === 'object' &&
      selection !== null &&
      Object.prototype.hasOwnProperty.call(selection, 'range'),
  ).length;
}

function loadedConfigForArgument(argument: string): LoadedExecutionConfig {
  const configPath = resolve(argument);
  if (preloadedExecutionConfig === null) {
    return loadExecutionConfig(configPath);
  }
  if (preloadedExecutionConfig.configPath !== configPath) {
    throw new ExecutionConfigError(
      'execution config argument changed after preflight',
    );
  }
  return preloadedExecutionConfig;
}

function renderRunExecution(
  execution: ConfiguredExecutionResult,
  sink: RunReportSink | null,
): void {
  if (sink === null) return;
  const rendered = renderReport(
    reportSectionsForRun(execution.summary, sink, execution.device),
  );
  if (rendered.length > 0) console.log(rendered);
}

async function renderSweepExecution(
  execution: ConfiguredExecutionResult,
  sinks: readonly SweepReportSink[],
  view: boolean,
): Promise<void> {
  const result = buildSweepResult(
    execution.summary,
    sinks.map((sink, index) =>
      sink.snapshot(execution.summary.bindings[index]!.bindingIndex),
    ),
    execution.axes,
  );
  const sections = [
    systemReportSection(execution.summary, {device: execution.device}),
    ...(view ? [] : [sweepResultSection(result)]),
  ];
  const rendered = renderReport(sections);
  if (rendered.length > 0) console.log(rendered);
  if (view) {
    await startSweepViewer(result, new PlotlySweepRenderer(), {
      print: line => console.log(line),
      warn: line => console.error(line),
    });
  }
}

function sweepResultForExecution(
  execution: ConfiguredExecutionResult,
  sinks: readonly {snapshot(bindingIndex: number): SweepReportSnapshot}[],
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

function printMachineResult(value: unknown): void {
  console.log(JSON.stringify(value));
}

const DASHBOARD_SCENARIO_SCHEMA = 'tea.dashboard-scenario/v1' as const;
// Enough for the checked-in 100-execution daily BTC sweep while remaining a
// fail-closed retained-data bound. Minute-scale histories need a different,
// display-tier archive rather than silently exhausting the host.
const DASHBOARD_TRAJECTORY_ARCHIVE_MAX_BYTES = 128 * 1024 * 1024;

interface DashboardScenarioRequest {
  readonly schema: typeof DASHBOARD_SCENARIO_SCHEMA;
  readonly bindingIndex: number;
  readonly configBytesHash: string;
  readonly programBytesHash: string;
  readonly providerBytesHash: string;
  readonly effectiveTimeNow: number;
}

async function serveDashboardScenarios(
  snapshot: ExecutionSnapshotResult,
  execution: ConfiguredExecutionResult,
  sinks: readonly TrajectoryArchiveSink[],
  archive: TrajectoryArchive,
): Promise<void> {
  const archived = new Map(
    execution.summary.bindings.map((binding, index) => [
      binding.bindingIndex,
      {binding, sink: sinks[index]!},
    ]),
  );
  const lines = createInterface({input: process.stdin, crlfDelay: Infinity});
  try {
    for await (const line of lines) {
      if (line.trim().length === 0) continue;
      try {
        const request = dashboardScenarioRequest(line);
        assertDashboardSnapshot(request, snapshot);
        const selected = archived.get(request.bindingIndex);
        if (selected === undefined) {
          throw new ExecutionConfigError(
            `scenario ${request.bindingIndex} is outside the archived sweep`,
          );
        }
        printMachineResult({
          schema: DASHBOARD_TRAJECTORY_RESULT_SCHEMA,
          config: snapshot,
          trajectory: selected.sink.trajectory(
            selected.binding,
            request.bindingIndex,
          ),
        });
      } catch (error) {
        if (!isExecutionHostError(error)) {
          throw error;
        }
        printDashboardScenarioError(error);
      }
    }
  } finally {
    lines.close();
    archive.reset();
  }
}

function printDashboardScenarioError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.log(
    JSON.stringify({
      schema: 'tea.dashboard-error/v1',
      error: message,
    }),
  );
}

function dashboardScenarioRequest(line: string): DashboardScenarioRequest {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new ExecutionConfigError(
      'dashboard scenario request must be one JSON object per line',
    );
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ExecutionConfigError('invalid dashboard scenario request');
  }
  const request = value as Partial<DashboardScenarioRequest> &
    Record<string, unknown>;
  if (
    Object.keys(request).sort().join(',') !==
      'bindingIndex,configBytesHash,effectiveTimeNow,programBytesHash,providerBytesHash,schema' ||
    request.schema !== DASHBOARD_SCENARIO_SCHEMA ||
    !Number.isSafeInteger(request.bindingIndex) ||
    (request.bindingIndex as number) < 0 ||
    !sha256(request.configBytesHash) ||
    !sha256(request.programBytesHash) ||
    !sha256(request.providerBytesHash) ||
    !Number.isSafeInteger(request.effectiveTimeNow)
  ) {
    throw new ExecutionConfigError('invalid dashboard scenario request');
  }
  return request as DashboardScenarioRequest;
}

function assertDashboardSnapshot(
  request: DashboardScenarioRequest,
  snapshot: ExecutionSnapshotResult,
): void {
  if (
    request.configBytesHash.toLowerCase() !== snapshot.bytesHash ||
    request.programBytesHash.toLowerCase() !== snapshot.programBytesHash ||
    request.providerBytesHash.toLowerCase() !== snapshot.providerBytesHash ||
    request.effectiveTimeNow !== snapshot.effectiveTimeNow
  ) {
    throw new ExecutionConfigError(
      'dashboard scenario request does not match the sweep snapshot',
    );
  }
}

function sha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
}

tea
  .command('docs')
  .description('Serve the documentation website locally')
  .option(
    '--port <number>',
    'port to bind (default: any available port)',
    parsePort,
    0,
  )
  .option('--no-open', 'do not open the documentation in a browser')
  .action(async (options: {port: number; open: boolean}) => {
    await startDocsServer({
      port: options.port,
      open: options.open,
      print: line => console.log(line),
      warn: line => console.error(line),
    });
  });

tea
  .command('execute')
  .description('Execute a Tea program from a YAML or JSON configuration')
  .argument('<config>', 'execution configuration file')
  .option('--view', 'open an interactive 3D parameter view for a sweep')
  .option('--json', 'print a structured machine-readable result')
  .addOption(new Option('--dashboard-session').hideHelp())
  .option(
    '--scenario <binding>',
    'rerun one sweep binding and return its full trajectory',
    parsePositiveOrZeroInteger,
  )
  .addOption(new Option('--expected-config-sha256 <hash>').hideHelp())
  .addOption(new Option('--expected-program-sha256 <hash>').hideHelp())
  .addOption(new Option('--expected-provider-sha256 <hash>').hideHelp())
  .addOption(new Option('--replay-time-now <epoch-ms>').hideHelp())
  .option(
    '--trace',
    'print the machine trace format for a run instead of a table',
  )
  .action(
    async (
      configArgument: string,
      options: {
        view?: boolean;
        trace?: boolean;
        json?: boolean;
        scenario?: number;
        expectedConfigSha256?: string;
        expectedProgramSha256?: string;
        expectedProviderSha256?: string;
        replayTimeNow?: string;
        dashboardSession?: boolean;
      },
    ) => {
      await runStageAsync(async () => {
        try {
          const loaded = loadedConfigForArgument(configArgument);
          if (options.view === true && options.trace === true) {
            throw new ExecutionConfigError(
              '--view and --trace cannot be used together',
            );
          }
          if (
            options.json === true &&
            (options.view === true || options.trace === true)
          ) {
            throw new ExecutionConfigError(
              '--json cannot be used with --view or --trace',
            );
          }
          if (options.scenario !== undefined && options.json !== true) {
            throw new ExecutionConfigError('--scenario requires --json');
          }
          if (options.dashboardSession === true && options.json !== true) {
            throw new ExecutionConfigError(
              '--dashboard-session requires --json',
            );
          }
          if (
            options.dashboardSession === true &&
            options.scenario !== undefined
          ) {
            throw new ExecutionConfigError(
              '--dashboard-session cannot be used with --scenario',
            );
          }
          if (
            (options.expectedConfigSha256 !== undefined ||
              options.expectedProgramSha256 !== undefined ||
              options.expectedProviderSha256 !== undefined ||
              options.replayTimeNow !== undefined) &&
            (options.json !== true || options.scenario === undefined)
          ) {
            throw new ExecutionConfigError(
              'replay snapshot options require --json --scenario',
            );
          }
          if (
            options.view === true &&
            loaded.config.execution.kind !== 'sweep'
          ) {
            throw new ExecutionConfigError(
              '--view requires a sweep execution config',
            );
          }
          if (
            options.trace === true &&
            loaded.config.execution.kind !== 'run'
          ) {
            throw new ExecutionConfigError(
              '--trace requires a run execution config',
            );
          }
          if (options.view === true && rangeSelectionCount(loaded.config) < 2) {
            throw new SweepProjectionError(
              'sweep visualization requires at least two numeric parameter ranges',
            );
          }
          if (
            options.dashboardSession === true &&
            loaded.config.execution.kind !== 'sweep'
          ) {
            throw new ExecutionConfigError(
              '--dashboard-session requires a sweep execution config',
            );
          }

          if (options.scenario !== undefined) {
            if (loaded.config.execution.kind !== 'sweep') {
              throw new ExecutionConfigError(
                '--scenario requires a sweep execution config',
              );
            }
            if (
              options.expectedConfigSha256 === undefined ||
              options.expectedProgramSha256 === undefined ||
              options.expectedProviderSha256 === undefined ||
              options.replayTimeNow === undefined
            ) {
              throw new ExecutionConfigError(
                '--scenario requires --expected-config-sha256, --expected-program-sha256, --expected-provider-sha256, and --replay-time-now from the sweep result',
              );
            }
            if (!/^[0-9a-f]{64}$/i.test(options.expectedProviderSha256)) {
              throw new ExecutionConfigError(
                '--expected-provider-sha256 must be a 64-digit hexadecimal SHA-256',
              );
            }
            if (!/^[0-9a-f]{64}$/i.test(options.expectedProgramSha256)) {
              throw new ExecutionConfigError(
                '--expected-program-sha256 must be a 64-digit hexadecimal SHA-256',
              );
            }
            if (
              !/^[0-9a-f]{64}$/i.test(options.expectedConfigSha256) ||
              options.expectedConfigSha256.toLowerCase() !== loaded.bytesHash
            ) {
              throw new ExecutionConfigError(
                'execution config does not match the selected sweep snapshot',
              );
            }
            const replayTimeNow = Number(options.replayTimeNow);
            if (!Number.isSafeInteger(replayTimeNow)) {
              throw new ExecutionConfigError(
                '--replay-time-now must be a finite safe epoch-ms integer',
              );
            }
            if (
              loaded.config.execution.timeNow !== undefined &&
              loaded.config.execution.timeNow !== replayTimeNow
            ) {
              throw new ExecutionConfigError(
                '--replay-time-now does not match execution.timeNow',
              );
            }
            const sink = new RunReportSink();
            const result = await executeLoadedSweepScenario(
              loaded,
              options.scenario,
              replayTimeNow,
              options.expectedProgramSha256.toLowerCase(),
              new Errors(),
              contextDependencies(
                () => sink,
                options.expectedProviderSha256.toLowerCase(),
              ),
            );
            if (!result.ok) exitWithErrors(result.errors);
            const binding = result.execution.summary.bindings[0];
            if (binding === undefined) {
              throw new ExecutionConfigError(
                `scenario ${options.scenario} produced no execution`,
              );
            }
            printMachineResult({
              ...machineResultBase(
                loaded,
                result.execution,
                result.programBytesHash,
              ),
              trajectory: buildTrajectoryResult(
                binding,
                sink.snapshot(),
                options.scenario,
              ),
            });
            return;
          }

          const errors = new Errors();
          if (loaded.config.execution.kind === 'run') {
            const reportSink =
              options.trace === true ? null : new RunReportSink();
            const sink: OutputSink =
              reportSink ?? new TraceSink(line => console.log(line));
            const result = await executeLoadedConfig(
              loaded,
              errors,
              contextDependencies(() => sink),
            );
            if (!result.ok) exitWithErrors(result.errors);
            if (options.json === true) {
              const binding = result.execution.summary.bindings[0];
              if (reportSink === null || binding === undefined) {
                throw new ExecutionConfigError(
                  'run execution produced no trajectory',
                );
              }
              printMachineResult({
                ...machineResultBase(
                  loaded,
                  result.execution,
                  result.programBytesHash,
                ),
                trajectory: buildTrajectoryResult(
                  binding,
                  reportSink.snapshot(),
                ),
              });
              return;
            }
            renderRunExecution(result.execution, reportSink);
            return;
          }

          const reportSinks: SweepReportSink[] = [];
          const archiveSinks: TrajectoryArchiveSink[] = [];
          const archive =
            options.dashboardSession === true
              ? new TrajectoryArchive({
                  maxBytes: DASHBOARD_TRAJECTORY_ARCHIVE_MAX_BYTES,
                })
              : null;
          const result = await executeLoadedConfig(
            loaded,
            errors,
            contextDependencies(executionIndex => {
              if (archive !== null) {
                const sink = archive.createSink();
                archiveSinks[executionIndex] = sink;
                return sink;
              }
              const sink = new SweepReportSink();
              reportSinks[executionIndex] = sink;
              return sink;
            }),
          );
          if (!result.ok) exitWithErrors(result.errors);
          const sinks = archive === null ? reportSinks : archiveSinks;
          if (options.json === true) {
            const base = machineResultBase(
              loaded,
              result.execution,
              result.programBytesHash,
            );
            printMachineResult({
              ...base,
              sweep: sweepResultForExecution(result.execution, sinks),
            });
            if (archive !== null) {
              await serveDashboardScenarios(
                base.config,
                result.execution,
                archiveSinks,
                archive,
              );
            }
            return;
          }
          await renderSweepExecution(
            result.execution,
            reportSinks,
            options.view === true,
          );
        } catch (error) {
          exitWithExecutionError(error);
        }
      });
    },
  );

tea
  .command('run')
  .description('Compile and execute a Tea script over a CSV dataset')
  .argument('<file>', 'Tea source file')
  .option('-i, --input <file>', 'CSV dataset to bind as the input series')
  .option(
    '--trace',
    'print the machine trace format (golden-compatible) instead of a table',
  )
  .option('--gpu', 'execute with WebGPU instead of the JavaScript CPU runtime')
  .allowUnknownOption()
  .allowExcessArguments()
  .action(
    async (
      file: string,
      options: {input?: string; trace?: boolean; gpu?: boolean},
      command: Command,
    ) => {
      await runStageAsync(async () => {
        if (options.input === undefined) {
          console.error('tea: run requires --input <csv>');
          process.exit(1);
        }
        const errors = new Errors();
        const program = compileToProgram([file], errors);
        if (program === null) {
          exitWithErrors(errors.flushErrors());
        }
        try {
          const parameters = parseRunParameterSelections(
            paramSpecsOf(program.params),
            dynamicTokens(command),
            RUN_RESERVED_PARAMETERS,
          );
          const reportSink =
            options.trace === true ? null : new RunReportSink();
          const sink: OutputSink =
            reportSink ?? new TraceSink(line => console.log(line));
          const execution = await executeConfiguredProgram(
            program,
            legacyConfig(
              'run',
              file,
              options.input,
              {kind: options.gpu === true ? 'webgpu' : 'javascript'},
              parameters,
            ),
            contextDependencies(() => sink),
          );
          renderRunExecution(execution, reportSink);
        } catch (error) {
          exitWithExecutionError(error);
        }
      });
    },
  );

tea
  .command('sweep')
  .description('Run a Cartesian parameter sweep over a CSV dataset')
  .argument('<file>', 'Tea source file')
  .option('-i, --input <file>', 'CSV dataset to bind as the input series')
  .option('--cpu', 'use the JavaScript CPU runtime instead of WebGPU')
  .option('--view', 'open an interactive 3D parameter view')
  .option(
    '--max-scenarios <count>',
    'reject sweeps larger than this many bindings',
    parsePositiveInteger,
    10_000,
  )
  .allowUnknownOption()
  .allowExcessArguments()
  .action(
    async (
      file: string,
      options: {
        input?: string;
        cpu?: boolean;
        view?: boolean;
        maxScenarios: number;
      },
      command: Command,
    ) => {
      await runStageAsync(async () => {
        if (options.input === undefined) {
          console.error('tea: sweep requires --input <csv>');
          process.exit(1);
        }
        const errors = new Errors();
        const program = compileToProgram([file], errors);
        if (program === null) {
          exitWithErrors(errors.flushErrors());
        }
        try {
          const parameters = parseSweepParameterSelections(
            paramSpecsOf(program.params),
            dynamicTokens(command),
            SWEEP_RESERVED_PARAMETERS,
          );
          const config = legacyConfig(
            'sweep',
            file,
            options.input,
            {kind: options.cpu === true ? 'javascript' : 'webgpu'},
            parameters,
            options.maxScenarios,
          );
          if (options.view === true && rangeSelectionCount(config) < 2) {
            throw new SweepProjectionError(
              'sweep visualization requires at least two numeric parameter ranges',
            );
          }
          const sinks: SweepReportSink[] = [];
          const execution = await executeConfiguredProgram(
            program,
            config,
            contextDependencies(executionIndex => {
              const sink = new SweepReportSink();
              sinks[executionIndex] = sink;
              return sink;
            }),
          );
          await renderSweepExecution(execution, sinks, options.view === true);
        } catch (error) {
          exitWithExecutionError(error);
        }
      });
    },
  );

tea
  .command('build')
  .description('Compile a Tea script and emit JavaScript')
  .argument('<file>', 'Tea source file')
  .option('-o, --out <file>', 'write emitted JavaScript here instead of stdout')
  .action((file: string, options: {out?: string}) => {
    const result = runStage(() => compile([file]));
    if (!result.ok) {
      exitWithErrors(result.errors);
    }
    if (options.out === undefined) {
      console.log(result.js);
    } else {
      writeFileSync(options.out, result.js);
    }
  });

tea
  .command('parse')
  .description('Run the frontend and dump intermediate artifacts')
  .argument('<file>', 'Tea source file')
  .option('--tokens', 'dump the token stream')
  .option('--ast', 'dump the syntax tree (default)')
  .option('--ir', 'dump the lowered IR')
  .action(
    (
      file: string,
      options: {tokens?: boolean; ast?: boolean; ir?: boolean},
    ) => {
      const errors = new Errors();
      const wantTokens = options.tokens === true;
      const wantIr = options.ir === true;
      const wantAst = options.ast === true || (!wantTokens && !wantIr);

      runStage(() => {
        if (wantTokens) {
          const src = readFileSync(file, 'utf8');
          const tokens = tokenize(newFileBase(file), src, (pos, msg) =>
            errors.errorAt(pos, msg),
          );
          console.log(dumpTokens(tokens));
        }
        if (wantAst) {
          console.log(dumpFile(parseFile(file, errors)));
        }
        if (wantIr) {
          const program = compileToProgram([file], errors);
          if (program !== null) {
            console.log(dumpProgram(program));
          }
        }
      });
      if (errors.count > 0) {
        exitWithErrors(errors.flushErrors());
      }
    },
  );

await tea.parseAsync();
