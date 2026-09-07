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

test('Context infers its module fields and rejects invented generic shapes', () => {
  expect(() =>
    checkGenerated(`${source()}
import {Context as Execution, type Value as Captured} from 'tea/runtime';
const inferred = new Execution(program);
const length: Captured<number, 'int'> = inferred.params.length;
const close: Captured<number, 'float'> = inferred.inputs.series.close.hist();
// @ts-expect-error inference must not widen the known fields to any
inferred.params.missing;
// @ts-expect-error an unrelated parameter cannot be supplied by this module
new Execution<{missing: Captured<number, 'int'>}>(program);
// @ts-expect-error adding a parameter to a compatible shape is also invalid
new Execution<ProgramContext['params'] & {missing: Captured<number, 'int'>}>(program);
// @ts-expect-error an existing parameter cannot change its value type
new Execution<{length: Captured<string | null, 'string'>}>(program);
// @ts-expect-error an additional output cannot be inferred from this module
new Execution<ProgramContext['params'], ProgramContext['inputs'], ProgramContext['state'], ProgramContext['outputs'] & {missing: {set(value: Captured<number, 'float'>): void}}>(program);
`),
  ).not.toThrow();
});

test('runtime factories construct captured values without a public untyped constructor', () => {
  expect(() =>
    checkGenerated(`${source()}
import {Value as CapturedValue, int as integer, float as decimal, text as stringValue} from 'tea/runtime';
const whole: CapturedValue<number, 'int'> = integer(3);
const fraction: CapturedValue<number, 'float'> = decimal(0.5);
const label: CapturedValue<string | null, 'string'> = stringValue('hello');
const updated: CapturedValue<number, 'int'> = whole.withStored(4);
// @ts-expect-error Value is a public type; construction uses typed factories
new CapturedValue('hello', 'int');
// @ts-expect-error replacing a payload must preserve its captured type
integer(1).withStored('wrong');
`),
  ).not.toThrow();
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
  const context = new Context(module);
  const params = context.params as Record<'left' | 'right', Value<unknown>>;
  expect(params.left.kind).toBe(module.parameters[0].enumType!.typeId);
  expect(params.right.kind).toBe(module.parameters[1].enumType!.typeId);
  expect(params.left.kind).not.toBe(params.right.kind);
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
    checkGenerated(`${generated}
function wrongEnumPayload(ctx: ProgramContext) {
  const left: typeof ctx.params.left.value = ctx.params.right.value;
}`),
  ).toThrow(/not assignable/);
  expect(() =>
    checkGenerated(`${generated}\n${imports}
const wrong: Captured<number, 'int'> = integer(7).div(decimal(2));
`),
  ).toThrow(/not assignable/);
});

test('generated string enums retain members, display titles and captured equality', () => {
  const generated = generate(
    mustBuild(
      [
        'enum Status',
        '    pending = "Pending title"',
        '    ready = "Ready title"',
        'status = input.enum(Status.pending)',
        'var Status previous = Status.ready',
        'emit "same" status == previous',
        'emit "title" str.tostring(status)',
        'previous := status',
      ].join('\n'),
    ),
  );
  expect(generated).toMatch(/enum StatusEnum\d+ \{/);
  expect(generated).toContain('pending = "pending"');
  expect(generated).toMatch(/StatusEnum\d+\.ready/);
  expect(() => checkGenerated(generated)).not.toThrow();
  const module = loadModule(generated).bind();
  const context = new Context(module);
  const step = () =>
    context.step({series: [], builtins: [], requests: [], provisional: false});
  expect(step().outputs).toEqual([false, 'Pending title']);
  expect(step().outputs).toEqual([true, 'Pending title']);
  context.dispose();
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
