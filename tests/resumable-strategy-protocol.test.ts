// Purpose: Prove a static resumable broker protocol can coordinate fill
// application and shared struct mutation on CPU while reference-struct WGSL
// lowering remains fail-closed.

import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, test} from 'bun:test';
import {Errors} from '../src/base/print';
import {compileProgramToWgsl} from '../src/codegen/wgsl';
import {compile, compileToProgram} from '../src/compile';
import {executeProgram} from '../src/execute';
import {TypeKind} from '../src/ir/type';
import {funcsOf, namesOf} from '../src/ir/visit';
import {csvProvider} from '../src/providers/data/csv';
import {MemorySink} from '../src/providers/sinks/memory-sink';

const SOURCE = join(
  import.meta.dir,
  'fixtures/gpu/resumable-strategy-protocol/source.tea',
);

function program() {
  const errors = new Errors();
  const result = compileToProgram([SOURCE], errors);
  if (result === null) {
    throw new Error(
      errors
        .flushErrors()
        .map(error => error.msg)
        .join('; '),
    );
  }
  expect(errors.count).toBe(0);
  return result;
}

function outputId(sink: MemorySink, title: string): number {
  const id = sink.outputs.findIndex(output =>
    output.spec.staticArgs.some(
      argument => argument.name === 'title' && argument.value === title,
    ),
  );
  if (id < 0) throw new Error(`missing output '${title}'`);
  return id;
}

function finalValue(sink: MemorySink, id: number): number {
  const emission = sink.emissions.findLast(entry => entry.outputId === id);
  const value = emission?.channels[0];
  if (typeof value !== 'number') {
    throw new Error(`output ${id} has no final numeric value`);
  }
  return value;
}

describe('static resumable strategy protocol spike', () => {
  test('uses only concrete values and statically constrained generic calls', () => {
    const source = readFileSync(SOURCE, 'utf8');
    const compiled = program();

    expect(source).toContain('interface ResumableBroker');
    expect(source).toContain(
      'type Coordinator<B: ResumableBroker, P: Accounting>',
    );
    expect(source).toContain(
      'Coordinator.new(SimpleBroker.new(), Ledger.new(1000.0))',
    );
    expect(source).toContain(
      'Coordinator.new(PathLikeBroker.new(), Ledger.new(1000.0))',
    );
    expect(source).not.toMatch(/\b(?:array|matrix|map)</);
    expect(source).not.toMatch(/\bwhile\b/);

    const names = namesOf(compiled);
    const collectionKinds: ReadonlySet<string> = new Set([
      TypeKind.Array,
      TypeKind.Matrix,
      TypeKind.Map,
    ]);
    expect(names.some(name => collectionKinds.has(name.type.kind))).toBe(false);
    expect(
      names.some(
        name =>
          name.type.kind === TypeKind.Struct &&
          ['ResumableBroker', 'Accounting'].includes(name.type.name),
      ),
    ).toBe(false);

    const functions = funcsOf(compiled).map(func => func.name);
    expect(functions).toContain('Coordinator<SimpleBroker, Ledger>.drain');
    expect(functions).toContain('SimpleBroker.resume');
    expect(functions).toContain('Coordinator<PathLikeBroker, Ledger>.drain');
    expect(functions).toContain('PathLikeBroker.resume');
  });

  test('compiles and executes through the ordinary CPU path with shared mutation', async () => {
    const result = compile([SOURCE]);
    expect(result.ok).toBe(true);

    const sink = new MemorySink();
    await executeProgram(
      program(),
      [
        {
          params: {},
          provider: csvProvider(
            ['time,open,high,low,close', '1,10,12,9,11', '2,11,14,10,13'].join(
              '\n',
            ),
          ),
          sink,
          timeNow: 2,
        },
      ],
      {kind: 'cpu'},
    );

    expect(finalValue(sink, outputId(sink, 'simple equity'))).toBe(1003);
    expect(finalValue(sink, outputId(sink, 'path-like equity'))).toBe(996);
  });

  test('specializes both broker types and fails closed at the WGSL struct boundary', () => {
    const result = compileProgramToWgsl(program());
    expect(result.status).toBe('staged-unsupported');
    if (result.status === 'staged-unsupported') {
      expect(result.artifact).toBeNull();
      expect(result.eligibility.issues[0]).toMatchObject({
        code: 'struct-reference-lowering-unimplemented',
        message:
          'GPU struct-reference lowering is deferred for Coordinator<SimpleBroker, Ledger>',
      });
    }
  });
});
