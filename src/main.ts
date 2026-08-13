#!/usr/bin/env bun
// Purpose: CLI entry point — Commander argument parsing and process I/O only; all compilation lives in compile.ts. Sole owner of error printing and exit codes; run presentation is delegated to providers sinks.

import {readFileSync, writeFileSync} from 'node:fs';
import {Command, InvalidArgumentError} from 'commander';
import {configureLog, parseLogLevel} from './base/log';
import {formatPos, newFileBase} from './base/pos';
import {Errors, type ErrorMsg} from './base/print';
import {UnimplementedError} from './base/unimplemented';
import {
  CliParameterError,
  expandParameterSweep,
  parseRunParameters,
} from './cli/parameters';
import {compile, compileToProgram, parseFile} from './compile';
import {paramSpecsOf} from './codegen/params';
import {startDocsServer} from './docs/server';
import {
  executeProgram,
  type ExecutionSummary,
  UnsupportedExecutionTargetError,
} from './execute';
import {dumpProgram} from './ir/dumper';
import {builtinSources} from './providers/data/builtin-sources';
import {csvProvider} from './providers/data/csv';
import {createDawnDevice, GpuDeviceError} from './providers/gpu/dawn';
import {relayGpuCliToNode} from './providers/gpu/node-host';
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
  type BindInputs,
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

try {
  const relayed = await relayGpuCliToNode(
    process.argv.slice(2),
    import.meta.url,
  );
  if (relayed !== null) process.exit(relayed);
} catch (error) {
  if (error instanceof GpuDeviceError) {
    console.error(`tea: ${error.message}`);
    process.exit(1);
  }
  throw error;
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

async function executeCliTarget(
  program: NonNullable<ReturnType<typeof compileToProgram>>,
  bindings: readonly BindInputs[],
  backend: 'cpu' | 'gpu',
): Promise<{
  readonly summary: ExecutionSummary;
  readonly device?: string;
  dispose(): Promise<void>;
}> {
  if (backend === 'cpu') {
    return {
      summary: await executeProgram(program, bindings, {kind: 'cpu'}),
      dispose: async () => {},
    };
  }
  const lease = await createDawnDevice();
  try {
    const summary = await executeProgram(program, bindings, {
      kind: 'gpu',
      device: lease.device,
    });
    return {
      summary,
      device: lease.device.label || 'Dawn WebGPU',
      dispose: () => lease.dispose(),
    };
  } catch (error) {
    await lease.dispose();
    throw error;
  }
}

function readCsvProvider(filename: string) {
  return builtinSources({
    primary: csvProvider(readFileSync(filename, 'utf8')),
    config: process.env,
  });
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
          const params = parseRunParameters(
            paramSpecsOf(program.params),
            dynamicTokens(command),
            RUN_RESERVED_PARAMETERS,
          );
          const reportSink =
            options.trace === true ? null : new RunReportSink();
          const sink: OutputSink =
            reportSink ?? new TraceSink(line => console.log(line));
          const timeNow = Date.now();
          const execution = await executeCliTarget(
            program,
            [
              {
                params,
                provider: readCsvProvider(options.input),
                sink,
                timeNow,
              },
            ],
            options.gpu === true ? 'gpu' : 'cpu',
          );
          try {
            if (reportSink !== null) {
              const rendered = renderReport(
                reportSectionsForRun(
                  execution.summary,
                  reportSink,
                  execution.device,
                ),
              );
              if (rendered.length > 0) console.log(rendered);
            }
          } finally {
            await execution.dispose();
          }
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
          const sweep = expandParameterSweep(
            paramSpecsOf(program.params),
            dynamicTokens(command),
            {
              maxScenarios: options.maxScenarios,
              reservedNames: SWEEP_RESERVED_PARAMETERS,
            },
          );
          if (options.view === true && sweep.axes.length < 2) {
            throw new SweepProjectionError(
              'sweep visualization requires at least two numeric parameter ranges',
            );
          }
          const parameterSets = sweep.parameterSets;
          const provider = readCsvProvider(options.input);
          const timeNow = Date.now();
          const sinks = parameterSets.map(() => new SweepReportSink());
          const bindings: BindInputs[] = parameterSets.map((params, index) => ({
            params,
            provider,
            sink: sinks[index]!,
            timeNow,
          }));
          const execution = await executeCliTarget(
            program,
            bindings,
            options.cpu === true ? 'cpu' : 'gpu',
          );
          let result;
          try {
            result = buildSweepResult(
              execution.summary,
              sinks.map((sink, index) =>
                sink.snapshot(execution.summary.bindings[index]!.bindingIndex),
              ),
              sweep.axes,
            );
            const sections = [
              systemReportSection(execution.summary, {
                device: execution.device,
              }),
              ...(options.view === true ? [] : [sweepResultSection(result)]),
            ];
            const rendered = renderReport(sections);
            if (rendered.length > 0) console.log(rendered);
          } finally {
            await execution.dispose();
          }
          if (options.view === true) {
            await startSweepViewer(result, new PlotlySweepRenderer(), {
              print: line => console.log(line),
              warn: line => console.error(line),
            });
          }
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
