// Purpose: Commander parsing, command dispatch, logging, and exit-code policy.

import {Command, CommanderError, InvalidArgumentError} from 'commander';
import {createConnection} from 'vscode-languageserver/node';
import {configureLog, parseLogLevel} from '../base/log';
import {formatPos} from '../base/pos';
import {UnimplementedError} from '../base/unimplemented';
import {runCommand} from './execution';
import {buildCommand, parseCommand} from './compiler-tools';
import {cliFailure, type CliResult} from './result';
import {startDocsServer} from '../docs/server';
import {startLanguageServer} from '../lsp/server';

type CliCommand =
  | {readonly kind: 'docs'; readonly port: number; readonly open: boolean}
  | {readonly kind: 'lsp'}
  | {
      readonly kind: 'run';
      readonly file: string;
      readonly input: string;
      readonly trace: boolean;
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

const executionHost = {
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
    .command('lsp')
    .description('Serve the Language Server Protocol over stdin and stdout')
    .option('--stdio', 'accepted and ignored: stdio is the only transport')
    .action(() => {
      selected = {kind: 'lsp'};
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
    .allowUnknownOption()
    .allowExcessArguments()
    .action(
      (
        file: string,
        options: {input: string; trace?: boolean},
        command: Command,
      ) => {
        selected = {
          kind: 'run',
          file,
          input: options.input,
          trace: options.trace === true,
          parameters: command.args.slice(1),
        };
      },
    );

  tea
    .command('build')
    .description('Compile a Tea script and emit TypeScript')
    .argument('<file>', 'Tea source file')
    .option(
      '-o, --out <file>',
      'write emitted TypeScript here instead of stdout',
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

    case 'lsp':
      // Stdout carries protocol bytes only, so nothing on this path prints.
      // The streams are passed explicitly: left to itself the library wants
      // a transport flag in argv. The open stdin keeps the process alive, and
      // the library exits it on the `exit` notification or when stdin ends.
      startLanguageServer(createConnection(process.stdin, process.stdout));
      return {ok: true};

    case 'run':
      return runCommand(
        command.file,
        command.input,
        {trace: command.trace},
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
