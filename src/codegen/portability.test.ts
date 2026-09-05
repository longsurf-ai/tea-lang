// Purpose: Generated artifacts are ordinary TypeScript modules with only deterministic runtime imports.

import {describe, expect, test} from 'vitest';
import ts from 'typescript';
import {mustBuild} from '../noder/testing';
import {generate} from './codegen';
import {checkGenerated} from './check';

const SOURCES = [
  // Exercises funcs, loops, switch dispatch, tuples, and bind-time args.
  [
    'indicator("gate", overlay=true)',
    'len = input.int(5, "Len", minval=1)',
    'level = input.float(70.0)',
    'hline(level * 1.5)',
    'p1 = plot(ta.sma(close, len))',
    'p2 = plot(ta.ema(close, len))',
    'fill(p1, p2, color=color.new(color.blue, 90))',
    '[m, s, h] = ta.macd(close, 5, 8, 3)',
    'plot(m + s + h)',
    'plot(ta.sar(0.02, 0.02, 0.2))',
  ].join(String.fromCharCode(10)),
  // Exercises the request emission shapes: sibling child-module consts,
  // request entries, the private binding callback, ctx.request reads, and an
  // input param crossing into the capture (compilation-global params).
  [
    'indicator("req")',
    'scale = input.float(10.0)',
    'r = request.security("X", "D", ta.change(close) * scale)',
    'plot(r)',
    'plot(r[1])',
  ].join(String.fromCharCode(10)),
];

// Host I/O and obsolete artifact machinery never belong in generated programs.
const DENY = [
  /\bpadStart\b/,
  /\bpadEnd\b/,
  /\*\*/,
  /\basync\b/,
  /\bawait\b/,
  /\bDate\b/,
  /Math\.random/,
  /(?<!\.)\brequire\(/,
  /\bevaluateBinding\b/,
  /\$evaluate\b/,
  /\$module\b/,
];

describe('generated-module portability', () => {
  for (const [i, src] of SOURCES.entries()) {
    test(`module ${i} parses as TypeScript and imports only the runtime`, () => {
      const source = generate(mustBuild(src));
      expect(() => checkGenerated(source)).not.toThrow();
      const parsed = ts.createSourceFile(
        'program.ts',
        source,
        ts.ScriptTarget.ESNext,
        true,
        ts.ScriptKind.TS,
      );
      const transpiled = ts.transpileModule(source, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
        },
        reportDiagnostics: true,
      });
      expect(transpiled.diagnostics).toEqual([]);
      const imports = parsed.statements.filter(ts.isImportDeclaration);
      expect(
        imports.map(
          declaration => (declaration.moduleSpecifier as ts.StringLiteral).text,
        ),
      ).toEqual(['tea/runtime']);
      expect(parsed.statements.some(ts.isExportAssignment)).toBe(true);
      expect(source).not.toMatch(
        /ctx\.(read|write|frame|series|builtin|param|emit|append)\(/,
      );
      expect(source).not.toContain('funcs:');
      for (const pattern of DENY) expect(source).not.toMatch(pattern);
    });
  }
});
