// Purpose: End-to-end JS proof that imported package globals use ordinary
// transactional var storage isolated per binding.

import {describe, expect, test} from 'vitest';
import {Errors, fatal} from '../../base/print';
import {newFileBase} from '../../base/pos';
import {checkPackage} from '../../checker/check';
import {generate} from '../../codegen/codegen';
import {
  resolveImports,
  type PackageSource,
  type Registry,
} from '../../loader/loader';
import {buildProgram} from '../../noder/noder';
import {csvProvider} from '../../providers/data/csv';
import {MemorySink} from '../../providers/sinks/memory-sink';
import {parse} from '../../syntax/syntax';
import {bindFixedHistory as bind} from './fixed-history';
import {loadModule} from '../load';

const COUNTER = [
  'library("counter")',
  'var int value = 0',
  'export next() =>',
  '    value := value + 1',
  '    value',
].join('\n');

function moduleFor(source: string) {
  const errors = new Errors();
  const file = parse(newFileBase('main.tea'), source, (pos, message) =>
    errors.errorAt(pos, message),
  );
  const registry: Registry = (path: string): PackageSource | null =>
    path === 'counter'
      ? {filename: 'memory/counter.tea', source: COUNTER}
      : null;
  const checked = checkPackage(
    [file],
    errors,
    resolveImports([file], registry, []),
  );
  if (errors.count !== 0) {
    return fatal(
      errors
        .flushErrors()
        .map(error => error.msg)
        .join('; '),
    );
  }
  const program = buildProgram(checked, errors);
  if (errors.count !== 0) {
    return fatal(
      errors
        .flushErrors()
        .map(error => error.msg)
        .join('; '),
    );
  }
  return loadModule(generate(program));
}

async function values(
  source: string,
  rows: number,
): Promise<readonly unknown[]> {
  const sink = new MemorySink();
  const bound = await bind(moduleFor(source), {
    params: {},
    provider: csvProvider(
      `close\n${Array.from({length: rows}, () => '1').join('\n')}\n`,
    ),
    sink,
    timeNow: 0,
  });
  try {
    await bound.runAll();
  } finally {
    bound.dispose();
  }
  return sink.emissions.map(emission => emission.channels[0]);
}

describe('package runtime globals in JS', () => {
  test('persists within one binding and starts fresh in the next binding', async () => {
    const source = 'import counter\nplot(counter.next())';
    expect(await values(source, 3)).toEqual([1, 2, 3]);
    expect(await values(source, 2)).toEqual([1, 2]);
  });

  test('aliases share one state instance', async () => {
    const source = [
      'import counter as first',
      'import counter as second',
      'plot(first.next())',
      'plot(second.next())',
    ].join('\n');
    expect(await values(source, 1)).toEqual([1, 2]);
  });

  test('rolls initialization back across a provisional first-row transaction', async () => {
    const sink = new MemorySink();
    const bound = await bind(
      moduleFor('import counter\nplot(counter.next())'),
      {
        params: {},
        provider: csvProvider('close\n1\n'),
        sink,
        timeNow: 0,
      },
    );
    try {
      bound.executeRow(0, true);
      bound.executeRow(0, false);
      bound.commitRow(0);
    } finally {
      bound.dispose();
    }
    expect(
      sink.emissions.map(emission => [
        emission.channels[0],
        emission.provisional,
      ]),
    ).toEqual([
      [1, true],
      [1, false],
    ]);
  });
});
