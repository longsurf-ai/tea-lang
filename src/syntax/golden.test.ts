// Purpose: Golden token-dump tests — every testdata/*.tea has a committed .tokens.golden; regenerate with UPDATE_GOLDENS=1 bun test.

import {existsSync, readdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, test} from 'bun:test';
import {newFileBase} from '../base/pos';
import {dumpTokens} from './dumper';
import {tokenize} from './syntax';

const TESTDATA = join(import.meta.dir, '../../testdata');
const UPDATE = process.env['UPDATE_GOLDENS'] === '1';

describe('token dump goldens', () => {
  const files = readdirSync(TESTDATA).filter(name => name.endsWith('.tea'));
  expect(files.length).toBeGreaterThan(0);

  for (const name of files) {
    test(name, () => {
      const src = readFileSync(join(TESTDATA, name), 'utf8');
      const tokens = tokenize(newFileBase(`testdata/${name}`), src, () => {
        // Errors are the error-comments harness's concern; goldens lock the
        // recovered token stream either way.
      });
      const dump = `${dumpTokens(tokens)}\n`;
      const goldenPath = join(TESTDATA, `${name}.tokens.golden`);

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
    });
  }
});
