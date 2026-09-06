// Generated artifacts are checked against the actual typed runtime exports.

import {expect, test} from 'vitest';
import {mustBuild} from '../noder/testing';
import {generate} from './codegen';
import {checkGenerated} from './check';
import {loadModule} from '../runtime/load';
import {Context} from '../runtime/js/context';
import type {Value} from '../runtime/js/value';

const source = () =>
  generate(
    mustBuild(
      [
        'length = input.int(2)',
        'previous(float value) => value[1]',
        'var float total = 0',
        'total += previous(close) * length',
        'emit "output0" total',
      ].join('\n'),
    ),
  );

test('TypeScript checks generated state, history, function and output types', () => {
  expect(() => checkGenerated(source())).not.toThrow();
});

test('TypeScript rejects unknown program fields and incompatible values', () => {
  expect(() =>
    checkGenerated(`${source()}
import {text as wrongText} from 'tea/runtime';
function invalid(ctx: ProgramContext) {
  ctx.params.missing;
  ctx.inputs.series.missing;
  ctx.params.length.add(wrongText('bad'));
  ctx.outputs.output0.set(wrongText('bad'));
}
`),
  ).toThrow(/Property 'missing' does not exist/);
  expect(() =>
    checkGenerated(`${source()}
import {text as wrongText} from 'tea/runtime';
function invalid(ctx: ProgramContext) {
  ctx.outputs.output0.set(wrongText('bad'));
}
`),
  ).toThrow(/not assignable/);
});

test('generated inputs and parameter bindings cannot be reassigned during a step', () => {
  expect(() =>
    checkGenerated(`${source()}
function invalid(ctx: ProgramContext) {
  ctx.inputs.series.close = ctx.inputs.series.close;
  ctx.params.length = ctx.params.length;
}`),
  ).toThrow(/read-only property/);
  expect(() =>
    checkGenerated(`${source()}
function invalid(ctx: ProgramContext) {
  ctx.inputs.series.close.set(ctx.inputs.series.close.hist(0));
}`),
  ).toThrow(/Property 'set' does not exist/);
});

test('generated parameter values preserve nominal enums and numeric promotion', () => {
  const generated = generate(
    mustBuild(
      [
        'enum Left',
        '    same',
        'enum Right',
        '    same',
        'left = input.enum(Left.same)',
        'right = input.enum(Right.same)',
        'emit "output0" close',
      ].join('\n'),
    ),
  );
  const module = loadModule(generated).bind();
  const context = new Context<Record<string, Value<unknown>>>(module);
  expect(context.params.left.kind).toBe(module.parameters[0].enumType!.typeId);
  expect(context.params.right.kind).toBe(module.parameters[1].enumType!.typeId);
  expect(context.params.left.kind).not.toBe(context.params.right.kind);
  context.dispose();
  const imports = `import {int as integer, float as decimal, type Value as Captured} from 'tea/runtime';`;
  expect(() =>
    checkGenerated(`${generated}\n${imports}
function numeric() {
  const integerResult: Captured<number, 'int'> = integer(7).div(integer(2));
  const decimalResult: Captured<number, 'float'> = integer(7).div(decimal(2));
  const promoted: Captured<number, 'float'> = decimal(7).add(integer(2));
  return [integerResult, decimalResult, promoted];
}`),
  ).not.toThrow();
  expect(() =>
    checkGenerated(`${generated}
function wrongEnum(ctx: ProgramContext) {
  const left: typeof ctx.params.left = ctx.params.right;
}`),
  ).toThrow(/not assignable/);
  expect(() =>
    checkGenerated(`${generated}\n${imports}
const wrong: Captured<number, 'int'> = integer(7).div(decimal(2));
`),
  ).toThrow(/not assignable/);
});

test('an input-dependent tuple return keeps its captured values through history reads', () => {
  const generated = generate(
    mustBuild(
      [
        'lag = input.int(2)',
        'pair(n) => [n, n + 1]',
        '[a, b] = pair(lag)',
        'emit "output0" close[b]',
      ].join('\n'),
    ),
  );
  expect(() => checkGenerated(generated)).not.toThrow();
  const context = new Context(loadModule(generated).bind());
  const values = [10, 20, 30, 40, 50].map(
    close =>
      context.step({
        series: [close],
        builtins: [],
        requests: [],
        provisional: false,
      }).outputs,
  );
  expect(values).toEqual([NaN, NaN, NaN, 10, 20].map(value => [value]));
  context.dispose();
});
