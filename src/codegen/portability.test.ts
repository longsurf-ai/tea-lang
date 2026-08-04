// Purpose: Portability gate — generated modules must stay strict-mode ES2015 FunctionBody with whitelisted globals only, so any ES2015 engine executes them; parse-enforced so the ceiling cannot drift.

import {describe, expect, test} from 'bun:test';
import {parse} from 'acorn';
import {DEFAULT_COMPILE_CONFIG} from '../base/config';
import {Errors} from '../base/print';
import {mustBuild} from '../noder/testing';
import {generate} from './codegen';

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
  // requests arrays, rt.bindRequest in init, rt.request reads, and an
  // input param crossing into the capture (compilation-global params).
  [
    'indicator("req")',
    'scale = input.float(10.0)',
    'r = request.security("X", "D", ta.change(close) * scale)',
    'plot(r)',
    'plot(r[1])',
  ].join(String.fromCharCode(10)),
];

// Syntax past ES2015 or impure globals that must never appear.
const DENY = [
  /\bpadStart\b/,
  /\bpadEnd\b/,
  /\*\*/,
  /\?\./,
  /\?\?/,
  /\basync\b/,
  /\bawait\b/,
  /\bDate\b/,
  /Math\.random/,
  /\brequire\b/,
  /\bimport\b/,
  /\bexport\b/,
];

describe('generated-module portability', () => {
  for (const [i, src] of SOURCES.entries()) {
    test(`module ${i} parses as strict ES2015 and avoids denied tokens`, () => {
      const js = generate(mustBuild(src), DEFAULT_COMPILE_CONFIG, new Errors());
      // The artifact is a FunctionBody; parse it in function context.
      expect(() =>
        parse(`(function () {${String.fromCharCode(10)}${js}})`, {
          ecmaVersion: 2015,
          sourceType: 'script',
        }),
      ).not.toThrow();
      for (const pattern of DENY) {
        expect(js).not.toMatch(pattern);
      }
    });
  }
});
