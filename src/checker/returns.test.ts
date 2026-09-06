import {describe, expect, test} from 'vitest';
import {CallKind} from './info';
import {checkText} from './testing';

describe('explicit returns', () => {
  test('infers returns through nested branches and permits existing tail sugar', () => {
    const result = checkText(
      'f(bool x) =>\n    if x\n        return 1\n    return 2\ng() => 3\nemit "a" f(true)\nemit "b" g()',
    );
    expect(result.errors).toEqual([]);
    for (const call of result.info.calls.values())
      if (call.kind === CallKind.Function)
        expect(call.instance.resultType.kind).toBe('Int');
  });
  test('all-return branches need no synthetic fallthrough value', () => {
    expect(
      checkText(
        'f(bool x) =>\n    if x\n        return 1\n    else\n        return 2\nemit "a" f(true)',
      ).errors,
    ).toEqual([]);
  });
  test.each([
    'return 1',
    'f(bool x) =>\n    if x\n        return 1\nf(true)',
    'f(bool x) =>\n    if x\n        return 1\n    return "bad"\nf(true)',
    'struct S\n    int f() =>\n        return "bad"\ns = S.new()\ns.f()',
  ])('rejects invalid function exits: %s', source =>
    expect(checkText(source).errors.length).toBeGreaterThan(0),
  );
});
