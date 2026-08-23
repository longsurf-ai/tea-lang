// Purpose: JavaScript embedding API — compiles a Tea tagged template through
// the canonical frontend and returns its static Program.

import {OperationalError} from '../base/operational-error';
import {formatPos} from '../base/pos';
import {Errors, type ErrorMsg} from '../base/print';
import {compileToProgram} from '../compile';
import type {Program} from '../ir/program';
import { Observable } from "rxjs";
import type { DataStream } from "./stream";
import type { OperatorFunction } from "rxjs";
import * as z from "zod";
import type { Pair } from "./util";

const TEMPLATE_FILENAME = '<tea-template>';

export class TeaCompileError extends OperationalError {
  constructor(readonly errors: readonly ErrorMsg[]) {
    super(
      errors.map(error => `${formatPos(error.pos)}: ${error.msg}`).join('\n'),
    );
    this.name = 'TeaCompileError';
  }
}

/**
 * Compile Tea source from a tagged template into a Program.
 * Interpolations are inserted as Tea source fragments.
 */
export function tea(
  strings: TemplateStringsArray,
  ...args: readonly unknown[]
): Program {
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
  return program;
}

function dedent(source: string): string {
  const lines = source.split(/\r?\n/);
  while (lines[0]?.trim() === '') {
    lines.shift();
  }
  while (lines.at(-1)?.trim() === '') {
    lines.pop();
  }

  const contentLines = lines.filter(line => line.trim() !== '');
  let prefix = contentLines[0]?.match(/^[ \t]*/)?.[0] ?? '';
  for (const line of contentLines.slice(1)) {
    while (prefix !== '' && !line.startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
    }
  }
  return lines.map(line => line.slice(prefix.length)).join('\n');
}

export type Output<O, E> = Pair<O, E[]>;

export interface TeaOperator<
    I extends z.ZodType,
    O extends z.ZodType,
    E extends z.ZodType,
> extends OperatorFunction<
    z.input<I>, Output<z.output<O>, z.output<E>>> {
    readonly input: I;
    readonly output: O;
    readonly effect: E;
}


export 

export function makeTea<T>(program: Program): {
    return (observable: Observable<T>) => 
        new Observable<T>(subscriber => {
}
