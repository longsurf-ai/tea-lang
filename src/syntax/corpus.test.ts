// Purpose: Pine conformance gate — every corpus script must parse with zero errors; skipped on standalone checkouts where the corpus is absent.

import {existsSync, readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, test} from 'bun:test';
import {formatPos, newFileBase} from '../base/pos';
import {parse} from './syntax';

// Monorepo-only: third-party community scripts that are not vendored into
// this package.
const CORPUS = join(
  import.meta.dir,
  '../../../../docs/tsgraph/pinescripts/scripts',
);

describe.skipIf(!existsSync(CORPUS))('pine corpus parses cleanly', () => {
  const files = readdirSync(CORPUS).filter(name => name.endsWith('.pine'));

  for (const name of files) {
    test(name, () => {
      const src = readFileSync(join(CORPUS, name), 'utf8');
      const reports: string[] = [];
      const file = parse(newFileBase(name), src, (pos, msg) => {
        reports.push(`${formatPos(pos)}: ${msg}`);
      });
      expect(reports.slice(0, 8)).toEqual([]);
      expect(file.stmtList.length).toBeGreaterThan(0);
    });
  }
});
