// Purpose: Golden dump tests — every tests/fixtures/*.tea has a committed .tokens.golden, and parseable fixtures also lock a .ast.golden; regenerate with UPDATE_GOLDENS=1 bun test.

import {existsSync, readdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, test} from 'bun:test';
import {formatPos, newFileBase} from '../base/pos';
import {dumpFile, dumpTokens} from './dumper';
import {parse, tokenize} from './syntax';

const TESTDATA = join(import.meta.dir, '../../tests/fixtures');
const UPDATE = process.env['UPDATE_GOLDENS'] === '1';

// Grows as parser slices land; every listed fixture must parse error-free.
const AST_PARSEABLE = [
  'example.tea',
  'exprs.tea',
  'macd.tea',
  'tokens.tea',
  'types.tea',
];

function checkGolden(goldenPath: string, dump: string): void {
  if (UPDATE) {
    writeFileSync(goldenPath, dump);
    return;
  }
  if (!existsSync(goldenPath)) {
    throw new Error(
      `missing golden ${goldenPath}; run UPDATE_GOLDENS=1 bun test`,
    );
  }
  expect(dump).toBe(readFileSync(goldenPath, 'utf8'));
}

describe('token dump goldens', () => {
  const files = readdirSync(TESTDATA).filter(name => name.endsWith('.tea'));
  expect(files.length).toBeGreaterThan(0);

  for (const name of files) {
    test(name, () => {
      const src = readFileSync(join(TESTDATA, name), 'utf8');
      const tokens = tokenize(
        newFileBase(`tests/fixtures/${name}`),
        src,
        () => {
          // Errors are the error-comments harness's concern; goldens lock the
          // recovered token stream either way.
        },
      );
      checkGolden(
        join(TESTDATA, `${name}.tokens.golden`),
        `${dumpTokens(tokens)}\n`,
      );
    });
  }
});

describe('ast dump goldens', () => {
  for (const name of AST_PARSEABLE) {
    test(name, () => {
      const src = readFileSync(join(TESTDATA, name), 'utf8');
      const errors: string[] = [];
      const file = parse(
        newFileBase(`tests/fixtures/${name}`),
        src,
        (pos, msg) => {
          errors.push(`${formatPos(pos)}: ${msg}`);
        },
      );
      expect(errors).toEqual([]);
      checkGolden(join(TESTDATA, `${name}.ast.golden`), `${dumpFile(file)}\n`);
    });
  }
});
