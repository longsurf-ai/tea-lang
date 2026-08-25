// Purpose: JavaScript embedding API — compiles a Tea tagged template through
// the canonical frontend and returns its static Program.

import {OperationalError} from '../base/operational-error';
import {formatPos} from '../base/pos';
import {Errors, type ErrorMsg} from '../base/print';
import {compileToProgram} from '../compile';
import type {Program} from '../ir/program';
import { Observable, Subject } from "rxjs";
import type { DataStream } from "./stream";
import * as z from "zod";
import { extract, type Binding } from "./binding";
import type { Sink } from "./sink";


const TEMPLATE_FILENAME = '<tea-template>';
type Key = string;

export class TeaCompileError extends OperationalError {
  constructor(readonly errors: readonly ErrorMsg[]) {
    super(
      errors.map(error => `${formatPos(error.pos)}: ${error.msg}`).join('\n'),
    );
    this.name = 'TeaCompileError';
  }
}

export class TeaNode {
    private readonly input_bindings: Binding[];
    private readonly output_bindings: Binding[];
    private input: Observable<unknown>;
    private output: Observable<unknown>;

    constructor(private readonly ir: Program) {
        [this.input_bindings, this.output_bindings] = extract(ir);
    }

    /**
     * Bind inputs to the program
     */
    bind(inputs: DataStream<T> | Record<string, unknown> | Record<Key, DataStream<T>>): TeaNode {
        if (inputs instanceof DataStream) {
            // go through the inputs data stream, and try to match it to the input bindings

            // for each data stream input, we need to somehow join it and update the input observable, as well as update the output Observable. The idea is that the output subscribes to the input observable, but runs the program on the input observable for every input received.
        } else {
            // try to match the inputs to the input bindings
        }
    }

    /**
     * Return true if the program is ready to be executed.
     */
    ready(): boolean {

    }


    to(sink: Sink<z.output<T>>): void {

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
