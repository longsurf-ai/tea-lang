// Purpose: Indentation-machinery tests — block open/close, dedent drains, continuation lines, blank/comment lines, tabs, CRLF, and indent errors.

import {expect, test} from 'vitest';
import {scanText, kinds} from './testing';

test('simple block', () => {
  const result = scanText('if c\n    x = 1\ny = 2\n');
  expect(result.errors).toEqual([]);
  expect(kinds(result)).toEqual([
    'if',
    'name',
    'newline',
    'indent',
    'name',
    'assign',
    'literal',
    'newline',
    'dedent',
    'name',
    'assign',
    'literal',
    'newline',
    'eof',
  ]);
});

test('nested blocks drain all dedents at EOF', () => {
  const result = scanText('if a\n    if b\n        x = 1\n');
  expect(result.errors).toEqual([]);
  expect(kinds(result)).toEqual([
    'if',
    'name',
    'newline',
    'indent',
    'if',
    'name',
    'newline',
    'indent',
    'name',
    'assign',
    'literal',
    'newline',
    'dedent',
    'dedent',
    'eof',
  ]);
});

test('newline precedes dedent when a block closes', () => {
  const result = scanText('if a\n    x = 1\nelse\n    y = 2\n');
  expect(result.errors).toEqual([]);
  expect(kinds(result)).toEqual([
    'if',
    'name',
    'newline',
    'indent',
    'name',
    'assign',
    'literal',
    'newline',
    'dedent',
    'else',
    'newline',
    'indent',
    'name',
    'assign',
    'literal',
    'newline',
    'dedent',
    'eof',
  ]);
});

test('continuation line (2 spaces) extends the statement', () => {
  const result = scanText('plot(close,\n  color)\n');
  expect(result.errors).toEqual([]);
  expect(kinds(result)).toEqual([
    'name',
    'lparen',
    'name',
    'comma',
    'name',
    'rparen',
    'newline',
    'eof',
  ]);
});

test('continuation inside a block (6 spaces)', () => {
  const result = scanText('if c\n    x = f(a,\n      b)\n');
  expect(result.errors).toEqual([]);
  expect(kinds(result)).toEqual([
    'if',
    'name',
    'newline',
    'indent',
    'name',
    'assign',
    'name',
    'lparen',
    'name',
    'comma',
    'name',
    'rparen',
    'newline',
    'dedent',
    'eof',
  ]);
});

test('blank and comment-only lines emit nothing', () => {
  const result = scanText('x = 1\n\n   \n// note\ny = 2\n');
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

test('comment-only line inside a block keeps the block open', () => {
  const result = scanText('if c\n    x = 1\n    // note\n    y = 2\n');
  expect(result.errors).toEqual([]);
  expect(kinds(result)).toEqual([
    'if',
    'name',
    'newline',
    'indent',
    'name',
    'assign',
    'literal',
    'newline',
    'name',
    'assign',
    'literal',
    'newline',
    'dedent',
    'eof',
  ]);
});

test('tab counts as one indent unit', () => {
  const result = scanText('if a\n\tx = 1\n');
  expect(result.errors).toEqual([]);
  expect(kinds(result)).toEqual([
    'if',
    'name',
    'newline',
    'indent',
    'name',
    'assign',
    'literal',
    'newline',
    'dedent',
    'eof',
  ]);
});

test('mixed tabs and spaces are an error', () => {
  const result = scanText('if a\n\t x = 1\n');
  expect(result.errors.map(e => e.msg)).toEqual([
    'mixed tabs and spaces in indentation',
  ]);
});

test('unindent to an unknown level', () => {
  const result = scanText('if b\n        y = 1\n    z = 2\n');
  expect(result.errors.map(e => e.msg)).toEqual([
    'unindent does not match any outer indentation level',
  ]);
});

test('continuation with nothing to continue', () => {
  const result = scanText('  x = 1\n');
  expect(result.errors.map(e => e.msg)).toEqual(['unexpected indentation']);
});

test('CRLF behaves like LF', () => {
  const lf = scanText('if c\n    x = 1\ny = 2\n');
  const crlf = scanText('if c\r\n    x = 1\r\ny = 2\r\n');
  expect(crlf.errors).toEqual([]);
  expect(kinds(crlf)).toEqual(kinds(lf));
});

test('deeper-than-one-unit block is a single level', () => {
  const result = scanText('if a\n        x = 1\ny = 2\n');
  expect(result.errors).toEqual([]);
  expect(kinds(result)).toEqual([
    'if',
    'name',
    'newline',
    'indent',
    'name',
    'assign',
    'literal',
    'newline',
    'dedent',
    'name',
    'assign',
    'literal',
    'newline',
    'eof',
  ]);
});
