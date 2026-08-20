// Purpose: ERROR-comment regression suite for the syntax layer — fixture files declare expected scan/parse diagnostics in place via the shared DSL.

import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, test} from 'vitest';
import {collectExpectations, diffExpectations} from '../testing/error-comments';
import {parseText} from './testing';

const TESTDATA = join(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../tests/fixtures',
);

describe('fixture error comments', () => {
  const files = readdirSync(TESTDATA).filter(name => name.endsWith('.tea'));
  expect(files.length).toBeGreaterThan(0);

  for (const name of files) {
    test(name, () => {
      const src = readFileSync(join(TESTDATA, name), 'utf8');
      const expectations = collectExpectations(src);
      const {errors} = parseText(src, name);

      const {missing, unexpected} = diffExpectations(
        name,
        expectations,
        errors,
      );
      expect(missing).toEqual([]);
      expect(unexpected).toEqual([]);
    });
  }
});
