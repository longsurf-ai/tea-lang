// Purpose: In-package conformance corpus — every script under tests/fixtures/corpus must parse with zero errors; the package never reads outside its own tree.

import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, test} from 'vitest';
import {formatPos, newFileBase} from '../base/pos';
import {parse} from './syntax';

const CORPUS = join(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../tests/fixtures/corpus',
);

describe('conformance corpus parses cleanly', () => {
  const files = readdirSync(CORPUS).filter(name => name.endsWith('.tea'));
  expect(files.length).toBeGreaterThan(0);

  for (const name of files) {
    test(name, () => {
      const src = readFileSync(join(CORPUS, name), 'utf8');
      const reports: string[] = [];
      const file = parse(newFileBase(name), src, (pos, msg) => {
        reports.push(`${formatPos(pos)}: ${msg}`);
      });
      expect(reports).toEqual([]);
      expect(file.stmtList.length).toBeGreaterThan(0);
    });
  }
});
