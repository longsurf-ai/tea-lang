#!/usr/bin/env bun
// Purpose: CLI entry point — Commander argument parsing and process I/O only; all compilation lives in compile.ts. Sole owner of error printing and exit codes; run presentation is delegated to providers sinks.

import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {Command, InvalidArgumentError} from 'commander';
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
  type ConfiguredExecutionResult,
} from './execution/run';
import {dumpProgram} from './ir/dumper';
import {GpuDeviceError} from './providers/gpu/dawn';
import {
  expectedRelayedConfigHash,
  relayGpuCliToNode,
} from './providers/gpu/node-host';
import {RunReportSink, SweepReportSink} from './providers/sinks/report-sink';
import {TraceSink} from './providers/sinks/trace-sink';
import {
  buildSweepResult,
  parameterReportSection,
  renderReport,
  sweepResultSection,
  systemReportSection,
  type ReportSection,
} from './reporting';
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
  for (const argument of args.slice(1)) {
    if (argument === '--') {
      optionsEnded = true;
      continue;
    }
    if (optionsEnded) return argument;
    if (argument === '--view' || argument === '--trace') continue;
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
  if (
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
    error instanceof SweepProjectionError
  ) {
    console.error(`tea: ${error.message}`);
    process.exit(1);
  }
  throw error;
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
) {
  return {
    environment: process.env,
    fetchImpl: fetch,
    now: Date.now,
    sinkForExecution,
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
  .option(
    '--trace',
    'print the machine trace format for a run instead of a table',
  )
  .action(
    async (
      configArgument: string,
      options: {view?: boolean; trace?: boolean},
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
            renderRunExecution(result.execution, reportSink);
            return;
          }

          const sinks: SweepReportSink[] = [];
          const result = await executeLoadedConfig(
            loaded,
            errors,
            contextDependencies(executionIndex => {
              const sink = new SweepReportSink();
              sinks[executionIndex] = sink;
              return sink;
            }),
          );
          if (!result.ok) exitWithErrors(result.errors);
          await renderSweepExecution(
            result.execution,
            sinks,
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
