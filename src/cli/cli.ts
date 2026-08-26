// Purpose: Commander parsing, command dispatch, logging, and exit-code policy.

import {Command, CommanderError, InvalidArgumentError} from 'commander';
import {configureLog, parseLogLevel} from '../base/log';
import {formatPos} from '../base/pos';
import {UnimplementedError} from '../base/unimplemented';
import {
  execute,
  runCommand,
  sweepCommand,
  type ExecuteOutput,
} from './execution';
import {buildCommand, parseCommand} from './compiler-tools';
import {cliFailure, type CliResult} from './result';
import {startDocsServer} from '../docs/server';
import {loadConfig} from '../execution/config';

type CliCommand =
  | {readonly kind: 'docs'; readonly port: number; readonly open: boolean}
  | {
      readonly kind: 'execute';
      readonly config: string;
      readonly output: ExecuteOutput;
    }
  | {
      readonly kind: 'run';
      readonly file: string;
      readonly input: string;
      readonly trace: boolean;
      readonly gpu: boolean;
      readonly parameters: readonly string[];
    }
  | {
      readonly kind: 'sweep';
      readonly file: string;
      readonly input: string;
      readonly cpu: boolean;
      readonly maxScenarios: number;
      readonly parameters: readonly string[];
    }
  | {readonly kind: 'build'; readonly file: string; readonly out?: string}
  | {
      readonly kind: 'parse';
      readonly file: string;
      readonly tokens: boolean;
      readonly ast: boolean;
      readonly ir: boolean;
    };

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

function parseArgs(argv: readonly string[]): CliCommand | null {
  let selected: CliCommand | null = null;
  const tea = new Command('tea')
    .description('Tea language compiler and runner')
    .version('0.1.0')
    .exitOverride();

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
    .action((options: {port: number; open: boolean}) => {
      selected = {kind: 'docs', port: options.port, open: options.open};
    });

  tea
    .command('execute')
    .description('Execute a Tea program from a YAML or JSON configuration')
    .argument('<config>', 'execution configuration file')
    .option('--json', 'print a structured machine-readable result')
    .action((config: string, options: {json?: boolean}) => {
      selected = {
        kind: 'execute',
        config,
        output: options.json === true ? 'json' : 'text',
      };
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
    .option(
      '--gpu',
      'execute with WebGPU instead of the JavaScript CPU runtime',
    )
    .allowUnknownOption()
    .allowExcessArguments()
    .action(
      (
        file: string,
        options: {input: string; trace?: boolean; gpu?: boolean},
        command: Command,
      ) => {
        selected = {
          kind: 'run',
          file,
          input: options.input,
          trace: options.trace === true,
          gpu: options.gpu === true,
          parameters: command.args.slice(1),
        };
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
      (
        file: string,
        options: {input: string; cpu?: boolean; maxScenarios: number},
        command: Command,
      ) => {
        selected = {
          kind: 'sweep',
          file,
          input: options.input,
          cpu: options.cpu === true,
          maxScenarios: options.maxScenarios,
          parameters: command.args.slice(1),
        };
      },
    );

  tea
    .command('build')
    .description('Compile a Tea script and emit JavaScript')
    .argument('<file>', 'Tea source file')
    .option(
      '-o, --out <file>',
      'write emitted JavaScript here instead of stdout',
    )
    .action((file: string, options: {out?: string}) => {
      selected = {
        kind: 'build',
        file,
        ...(options.out === undefined ? {} : {out: options.out}),
      };
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
        selected = {
          kind: 'parse',
          file,
          tokens: options.tokens === true,
          ast: options.ast === true,
          ir: options.ir === true,
        };
      },
    );

  tea.parse(argv);
  return selected;
}

async function dispatch(command: CliCommand): Promise<CliResult> {
  switch (command.kind) {
    case 'docs':
      await startDocsServer({
        port: command.port,
        open: command.open,
        print: line => console.log(line),
        warn: line => console.error(line),
      });
      return {ok: true};

    case 'execute':
      return execute(loadConfig(command.config), executionHost, command.output);

    case 'run':
      return runCommand(
        command.file,
        command.input,
        {trace: command.trace, gpu: command.gpu},
        command.parameters,
        executionHost,
      );

    case 'sweep':
      return sweepCommand(
        command.file,
        command.input,
        {cpu: command.cpu, maxScenarios: command.maxScenarios},
        command.parameters,
        executionHost,
      );

    case 'build': {
      return buildCommand(command.file, command.out);
    }

    case 'parse': {
      return parseCommand(command.file, command);
    }
  }
}

function printResult(result: CliResult): number {
  if (result.ok) return 0;
  if (result.kind === 'diagnostics') {
    for (const error of result.errors) {
      console.error(`${formatPos(error.pos)}: ${error.msg}`);
    }
  } else {
    console.error(`tea: ${result.message}`);
  }
  return 1;
}

export async function runCli(argv: readonly string[]): Promise<number> {
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
    const command = parseArgs(argv);
    return command === null ? 0 : printResult(await dispatch(command));
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode;
    if (error instanceof UnimplementedError) {
      console.error(`tea: ${error.message}`);
      return 2;
    }
    const failure = cliFailure(error);
    if (failure !== null) return printResult(failure);
    throw error;
  }
}
