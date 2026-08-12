// Purpose: Token-level scanner tests — sample-token table, streaming, refinements, version pragma, and literal error cases.

import {describe, expect, test} from 'bun:test';
import {scanText, kinds} from './testing';
import {
  CONTEXTUAL_KEYWORDS,
  KEYWORDS,
  PRECEDENCE,
  RESERVED_KEYWORDS,
  type LitKind,
  type Op,
  type TokenKind,
} from './tokens';

interface Sample {
  readonly src: string;
  readonly tok: TokenKind;
  readonly lit?: string;
  readonly kind?: LitKind;
  readonly op?: Op;
}

const SAMPLES: readonly Sample[] = [
  // names
  {src: 'x', tok: 'name', lit: 'x'},
  {src: 'foo_bar', tok: 'name', lit: 'foo_bar'},
  {src: '_A1', tok: 'name', lit: '_A1'},
  {src: 'true', tok: 'name', lit: 'true'},
  {src: 'na', tok: 'name', lit: 'na'},
  // literals
  {src: '123', tok: 'literal', kind: 'int', lit: '123'},
  {src: '3.14', tok: 'literal', kind: 'float', lit: '3.14'},
  {src: '.5', tok: 'literal', kind: 'float', lit: '.5'},
  {src: '6.02e23', tok: 'literal', kind: 'float', lit: '6.02e23'},
  {src: '1e-9', tok: 'literal', kind: 'float', lit: '1e-9'},
  {src: '"hi"', tok: 'literal', kind: 'string', lit: '"hi"'},
  {src: "'hi'", tok: 'literal', kind: 'string', lit: "'hi'"},
  {src: '"a\\"b"', tok: 'literal', kind: 'string', lit: '"a\\"b"'},
  {src: '#ff0000', tok: 'literal', kind: 'color', lit: '#ff0000'},
  {src: '#FF00AA80', tok: 'literal', kind: 'color', lit: '#FF00AA80'},
  // operators
  {src: '+', tok: 'operator', op: '+'},
  {src: '-', tok: 'operator', op: '-'},
  {src: '*', tok: 'operator', op: '*'},
  {src: '/', tok: 'operator', op: '/'},
  {src: '%', tok: 'operator', op: '%'},
  {src: '==', tok: 'operator', op: '=='},
  {src: '!=', tok: 'operator', op: '!='},
  {src: '<', tok: 'operator', op: '<'},
  {src: '<=', tok: 'operator', op: '<='},
  {src: '>', tok: 'operator', op: '>'},
  {src: '>=', tok: 'operator', op: '>='},
  {src: 'and', tok: 'operator', op: 'and'},
  {src: 'or', tok: 'operator', op: 'or'},
  {src: 'not', tok: 'operator', op: 'not'},
  // compound assignment
  {src: '+=', tok: 'assignop', op: '+'},
  {src: '-=', tok: 'assignop', op: '-'},
  {src: '*=', tok: 'assignop', op: '*'},
  {src: '/=', tok: 'assignop', op: '/'},
  {src: '%=', tok: 'assignop', op: '%'},
  // punctuation
  {src: '=', tok: 'assign'},
  {src: ':=', tok: 'define'},
  {src: '=>', tok: 'arrow'},
  {src: '?', tok: 'question'},
  {src: ':', tok: 'colon'},
  {src: '(', tok: 'lparen'},
  {src: ')', tok: 'rparen'},
  {src: '[', tok: 'lbrack'},
  {src: ']', tok: 'rbrack'},
  {src: ',', tok: 'comma'},
  {src: '.', tok: 'dot'},
];

describe('sample tokens', () => {
  for (const sample of SAMPLES) {
    test(JSON.stringify(sample.src), () => {
      const result = scanText(sample.src);
      expect(result.errors).toEqual([]);
      expect(kinds(result)).toEqual([sample.tok, 'newline', 'eof']);
      const token = result.tokens[0];
      if (sample.lit !== undefined) {
        expect(token.lit).toBe(sample.lit);
      }
      if (sample.kind !== undefined) {
        expect(token.kind).toBe(sample.kind);
      }
      if (sample.op !== undefined) {
        expect(token.op).toBe(sample.op);
        if (sample.tok === 'operator') {
          expect(result.tokens[0].tok).toBe('operator');
        }
      }
    });
  }

  test('operator precedence matches the table', () => {
    for (const sample of SAMPLES) {
      if (sample.tok !== 'operator' || sample.op === undefined) {
        continue;
      }
      const result = scanText(sample.src);
      expect(result.tokens[0].op).toBe(sample.op);
      expect(PRECEDENCE[sample.op]).toBeDefined();
    }
  });
});

describe('keywords', () => {
  for (const keyword of KEYWORDS) {
    test(keyword, () => {
      const result = scanText(keyword);
      expect(result.errors).toEqual([]);
      expect(kinds(result)).toEqual([keyword, 'newline', 'eof']);
    });
  }

  test('this is reserved while struct and interface are contextual', () => {
    expect(RESERVED_KEYWORDS).toContain('this');
    expect(CONTEXTUAL_KEYWORDS).toContain('struct');
    expect(CONTEXTUAL_KEYWORDS).toContain('interface');
    expect(CONTEXTUAL_KEYWORDS).not.toContain('method');
    expect(kinds(scanText('method inout'))).toEqual([
      'name',
      'name',
      'newline',
      'eof',
    ]);
  });
});

test('streaming all samples on one line', () => {
  const src = SAMPLES.map(s => s.src).join(' ');
  const result = scanText(src);
  expect(result.errors).toEqual([]);
  expect(kinds(result)).toEqual([...SAMPLES.map(s => s.tok), 'newline', 'eof']);
});

test('positions are monotonic', () => {
  const src = 'x = close + open\nif x > 2\n    y = "s" + #ff0000\n';
  const result = scanText(src);
  expect(result.errors).toEqual([]);
  for (let i = 1; i < result.tokens.length; i += 1) {
    const a = result.tokens[i - 1].pos;
    const b = result.tokens[i].pos;
    expect(b.line > a.line || (b.line === a.line && b.col >= a.col)).toBeTrue();
  }
});

test('//@version is captured', () => {
  const result = scanText('//@version=1\nx = 1\n');
  expect(result.version).toBe('1');
  expect(result.errors).toEqual([]);
});

test('first //@version wins', () => {
  const result = scanText('//@version=1\n//@version=2\n');
  expect(result.version).toBe('1');
});

describe('literal errors', () => {
  test('unterminated string', () => {
    const result = scanText('s = "abc\n');
    expect(result.errors.map(e => e.msg)).toEqual([
      'string literal not terminated',
    ]);
  });

  test('escape at end of line', () => {
    const result = scanText('s = "abc\\\n');
    expect(result.errors.map(e => e.msg)).toEqual([
      'string literal not terminated',
    ]);
  });

  test('bad color width', () => {
    const result = scanText('c = #ff00\n');
    expect(result.errors.map(e => e.msg)).toEqual([
      'color literal must have 6 or 8 hexadecimal digits',
    ]);
  });

  test('exponent without digits', () => {
    const result = scanText('n = 1e\n');
    expect(result.errors.map(e => e.msg)).toEqual(['exponent has no digits']);
  });

  test('invalid character is consumed and reported', () => {
    const result = scanText('x = @ 1\n');
    expect(result.errors.map(e => e.msg)).toEqual(['unexpected character "@"']);
    expect(kinds(result)).toEqual([
      'name',
      'assign',
      'literal',
      'newline',
      'eof',
    ]);
  });
});

describe('comments', () => {
  test('line comment is trivia', () => {
    const result = scanText('x = 1 // trailing\n// only\ny = 2\n');
    expect(result.errors).toEqual([]);
    expect(kinds(result)).toEqual([
      'name',
      'assign',
      'literal',
      'newline',
      'name',
      'assign',
      'literal',
      'newline',
      'eof',
    ]);
  });

  test('single-line block comment is inline trivia', () => {
    const result = scanText('x = /* mid */ 1\n');
    expect(result.errors).toEqual([]);
    expect(kinds(result)).toEqual([
      'name',
      'assign',
      'literal',
      'newline',
      'eof',
    ]);
  });

  test('multi-line block comment terminates the open statement', () => {
    const result = scanText('x = 1 /* a\nb */ y = 2\n');
    expect(result.errors).toEqual([]);
    expect(kinds(result)).toEqual([
      'name',
      'assign',
      'literal',
      'newline',
      'name',
      'assign',
      'literal',
      'newline',
      'eof',
    ]);
  });

  test('unterminated block comment', () => {
    const result = scanText('x = 1 /* never\n');
    expect(result.errors.map(e => e.msg)).toEqual([
      'block comment not terminated',
    ]);
  });
});
