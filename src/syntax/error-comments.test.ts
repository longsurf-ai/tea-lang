// Purpose: ERROR-comment regression suite for the syntax layer — testdata files declare expected scan/parse diagnostics in place via the shared DSL.

import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, test} from 'bun:test';
import {collectExpectations, diffExpectations} from '../testing/error-comments';
import {parseText} from './testing';

const TESTDATA = join(import.meta.dir, '../../testdata');

describe('testdata error comments', () => {
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
