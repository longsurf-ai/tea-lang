// Purpose: Synchronous tagged-template construction of the public Node API.

import {OperationalError} from '../base/operational-error';
import {formatPos} from '../base/pos';
import {Errors, type ErrorMsg} from '../base/print';
import {compileToProgram} from '../compiler';
import {generate} from '../codegen/codegen';
import {loadModule} from '../runtime/load';
import {pineBuiltinSupplier} from '../extension/pine';
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

/**
 * Compile an in-memory Tea template and prepare its usable parameter defaults.
 * The returned Node owns future stream connections; constructing it does not
 * subscribe to data or execute a step. Diagnostics throw TeaCompileError.
 *
 * @example
 * ```ts
 * const node = tea`
 *   length = input.int(14)
 *   plot(close[length])
 * `;
 * node.module.parameters[0].value; // 14
 * node.ready(); // false until a close DataStream is connected
 * const configured = node.bind({length: 20}); // leaves node unchanged
 * ```
 */
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

  const module = loadModule(generate(program)).bind();
  return createNode(module, pineBuiltinSupplier());
}
