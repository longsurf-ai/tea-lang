#!/usr/bin/env -S node --import tsx
// Purpose: CLI entry point — Commander argument parsing and process I/O only; all compilation lives in compile.ts.

import {readFileSync, writeFileSync} from 'node:fs';
import {Command, InvalidArgumentError} from 'commander';
import {configureLog, parseLogLevel} from './base/log';
import {formatPos, newFileBase} from './base/pos';
import {Errors, type ErrorMsg} from './base/print';
import {UnimplementedError} from './base/unimplemented';
import {
  executeConfigCommand,
  runCommand,
  sweepCommand,
  type CliExecutionResult,
} from './cli/execution';
import {CliParameterError} from './cli/parameters';
import {compile, compileToProgram, parseFile} from './compile';
import {startDocsServer} from './docs/server';
import {UnsupportedExecutionBackendError} from './execute';
import {ExecutionConfigError, loadConfig} from './execution/config';
import {ExecutionParameterError} from './execution/parameters';
import {dumpProgram} from './ir/dumper';
import {GpuDeviceError} from './providers/gpu/dawn';
import {
  TrajectoryArchiveBudgetError,
  TrajectoryArchiveProjectionBudgetError,
  TrajectoryArchiveUnsupportedTransportError,
} from './providers/sinks/trajectory-archive';
import {BindError, ExecutionError, RequestError} from './runtime/abi';
import {GpuBindingError, GpuExecutionError} from './runtime/gpu';
import {dumpFile, dumpTokens} from './syntax/dumper';
import {tokenize} from './syntax/syntax';

function exitWithErrors(errors: readonly ErrorMsg[]): never {
  for (const error of errors) {
    console.error(`${formatPos(error.pos)}: ${error.msg}`);
  }
  process.exit(1);
}

function finishExecution(result: CliExecutionResult): void {
  if (!result.ok) exitWithErrors(result.errors);
}

function exitWithCliError(error: unknown): never {
  if (error instanceof UnimplementedError) {
    console.error(`tea: ${error.message}`);
    process.exit(2);
  }
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
    error instanceof UnsupportedExecutionBackendError ||
    error instanceof GpuBindingError ||
    error instanceof GpuExecutionError ||
    error instanceof GpuDeviceError ||
    error instanceof TrajectoryArchiveBudgetError ||
    error instanceof TrajectoryArchiveProjectionBudgetError ||
    error instanceof TrajectoryArchiveUnsupportedTransportError
  );
}

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

const executionHost = {
  environment: process.env,
  fetchImpl: fetch,
  now: Date.now,
  print: (line: string) => console.log(line),
};

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
  .option('--json', 'print a structured machine-readable result')
  .action(async (configArgument: string, options: {json?: boolean}) => {
    const config = loadConfig(configArgument);
    finishExecution(
      await executeConfigCommand(config, options.json === true, executionHost),
    );
  });

tea
  .command('run')
  .description('Compile and execute a Tea script over a CSV dataset')
  .argument('<file>', 'Tea source file')
  .requiredOption('-i, --input <file>', 'CSV dataset to bind as input series')
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
      options: {input: string; trace?: boolean; gpu?: boolean},
      command: Command,
    ) => {
      finishExecution(
        await runCommand(
          file,
          options.input,
          {trace: options.trace === true, gpu: options.gpu === true},
          command.args.slice(1),
          executionHost,
        ),
      );
    },
  );

tea
  .command('sweep')
  .description('Run a Cartesian parameter sweep over a CSV dataset')
  .argument('<file>', 'Tea source file')
  .requiredOption('-i, --input <file>', 'CSV dataset to bind as input series')
  .option('--cpu', 'use the JavaScript CPU runtime instead of WebGPU')
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
      options: {input: string; cpu?: boolean; maxScenarios: number},
      command: Command,
    ) => {
      finishExecution(
        await sweepCommand(
          file,
          options.input,
          {cpu: options.cpu === true, maxScenarios: options.maxScenarios},
          command.args.slice(1),
          executionHost,
        ),
      );
    },
  );

tea
  .command('build')
  .description('Compile a Tea script and emit JavaScript')
  .argument('<file>', 'Tea source file')
  .option('-o, --out <file>', 'write emitted JavaScript here instead of stdout')
  .action((file: string, options: {out?: string}) => {
    const result = compile([file]);
    if (!result.ok) exitWithErrors(result.errors);
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

      if (wantTokens) {
        const source = readFileSync(file, 'utf8');
        const tokens = tokenize(newFileBase(file), source, (pos, message) =>
          errors.errorAt(pos, message),
        );
        console.log(dumpTokens(tokens));
      }
      if (wantAst) console.log(dumpFile(parseFile(file, errors)));
      if (wantIr) {
        const program = compileToProgram([file], errors);
        if (program !== null) console.log(dumpProgram(program));
      }
      if (errors.count > 0) exitWithErrors(errors.flushErrors());
    },
  );

try {
  await tea.parseAsync();
} catch (error) {
  exitWithCliError(error);
}
