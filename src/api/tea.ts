// Purpose: Synchronous tagged-template construction of the public Node API.

import {OperationalError} from '../base/operational-error';
import {formatPos} from '../base/pos';
import {Errors, type ErrorMsg} from '../base/print';
import {compileToProgram} from '../compile';
import {generate} from '../codegen/codegen';
import {loadModule} from '../runtime/load';
import {moduleBindings, withModuleBindings} from '../runtime/module-binding';
import {createNode, type Node} from './node';

export type {BindingInput, Datum, Node} from './node';

const TEMPLATE_FILENAME = '<tea-template>';

export class TeaCompileError extends OperationalError {
  constructor(readonly errors: readonly ErrorMsg[]) {
    super(
      errors.map(error => `${formatPos(error.pos)}: ${error.msg}`).join('\n'),
    );
    this.name = 'TeaCompileError';
  }
}

/** Compile Tea source synchronously; Node keeps lifecycle Effects internal. */
export function tea(
  strings: TemplateStringsArray,
  ...args: readonly unknown[]
): Node {
  const source = dedent(
    strings.raw.reduce(
      (result, part, index) =>
        result + part + (index < args.length ? String(args[index]) : ''),
      '',
    ),
  );
  const errors = new Errors();
  const program = compileToProgram(
    [{filename: TEMPLATE_FILENAME, source}],
    errors,
  );
  if (program === null) {
    throw new TeaCompileError(errors.flushErrors());
  }

  const loaded = loadModule(generate(program));
  const module = withModuleBindings(loaded, moduleBindings(loaded));
  return createNode(module);
}

function dedent(source: string): string {
  const lines = source.split(/\r?\n/);
  while (lines[0]?.trim() === '') lines.shift();
  while (lines.at(-1)?.trim() === '') lines.pop();

  const contentLines = lines.filter(line => line.trim() !== '');
  let prefix = contentLines[0]?.match(/^[ \t]*/)?.[0] ?? '';
  for (const line of contentLines.slice(1)) {
    while (prefix !== '' && !line.startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
    }
  }
  return lines.map(line => line.slice(prefix.length)).join('\n');
}
