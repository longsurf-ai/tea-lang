// Purpose: IR dump goldens — every tests/fixtures/ir/*.tea must node cleanly and lock its Program dump; regenerate with UPDATE_GOLDENS=1 npm test.

import {existsSync, readdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, test} from 'vitest';
import {dumpProgram} from '../ir/dumper';
import {buildText} from './testing';

const TESTDATA = join(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../tests/fixtures/ir',
);
const UPDATE = process.env['UPDATE_GOLDENS'] === '1';

function checkGolden(goldenPath: string, dump: string): void {
  if (UPDATE) {
    writeFileSync(goldenPath, dump);
    return;
  }
  if (!existsSync(goldenPath)) {
    throw new Error(
      `missing golden ${goldenPath}; run UPDATE_GOLDENS=1 npm test`,
    );
  }
  expect(dump).toBe(readFileSync(goldenPath, 'utf8'));
}

// Root-level fixtures that must compile through check + noding —
// grows toward the full corpus as catalog and language coverage lands.
const CHECKABLE = ['macd.tea'];

function testIrGolden(dir: string, name: string): void {
  test(name, () => {
    const src = readFileSync(join(dir, name), 'utf8');
    const {program, errors} = buildText(src, name);
    expect(errors.map(e => `${e.pos.line}:${e.pos.col}: ${e.msg}`)).toEqual([]);
    expect(program).not.toBeNull();
    checkGolden(join(dir, `${name}.ir.golden`), `${dumpProgram(program!)}\n`);
  });
}

describe('ir dump goldens', () => {
  const files = readdirSync(TESTDATA).filter(name => name.endsWith('.tea'));
  expect(files.length).toBeGreaterThan(0);

  for (const name of files) {
    testIrGolden(TESTDATA, name);
  }
  for (const name of CHECKABLE) {
    testIrGolden(join(TESTDATA, '..'), name);
  }
});
