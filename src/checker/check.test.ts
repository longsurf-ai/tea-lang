// Purpose: Checker unit tests — inferred types, qualifier propagation (later-known wins), const folding, ambient series pooling, and native call resolution observed through the Info side tables.

import {describe, expect, test} from 'bun:test';
import {NodeKind, type CallExpr, type ExprStmt} from '../syntax/nodes';
import {Qualifier, TypeKind, isNaValue} from '../ir/type';
import {checkText, declaredName, initTvOf} from './testing';

describe('inference and folding', () => {
  test('literal arithmetic folds with Pine integer semantics', () => {
    const r = checkText(
      [
        'x = 2 * 3 + 1',
        'q = 7 / 2',
        'f = 2.5 / 2',
        's = "a" + "b"',
        'b = true and not false',
      ].join('\n'),
    );
    expect(r.errors).toEqual([]);
    expect(initTvOf(r, 'x')).toEqual({
      type: {kind: TypeKind.Int},
      qualifier: Qualifier.Const,
      value: 7,
    });
    expect(initTvOf(r, 'q').value).toBe(3); // int division truncates
    expect(initTvOf(r, 'f').value).toBe(1.25);
    expect(initTvOf(r, 's').value).toBe('ab');
    expect(initTvOf(r, 'b').value).toBe(true);
  });

  test('fold values travel only through never-reassigned names', () => {
    const r = checkText(
      ['a = 2', 'b = a * 3', 'c = 1', 'c := 2', 'd = c * 3'].join('\n'),
    );
    expect(r.errors).toEqual([]);
    expect(initTvOf(r, 'b').value).toBe(6);
    expect(initTvOf(r, 'd').value).toBeNull();
    expect(declaredName(r, 'c').qualifier).toBe(Qualifier.Series);
  });

  test('reassignment follows binding identity across shadowing', () => {
    const r = checkText(
      [
        'x = 2',
        'shadow = if true',
        '    x = 3',
        '    x := 4',
        '    x',
        'folded = x * 3',
      ].join('\n'),
    );
    expect(r.errors).toEqual([]);

    const outer = declaredName(r, 'x');
    const inner = [...r.info.defs.values()].find(
      name => name.name === 'x' && name !== outer,
    );
    expect(inner).toBeDefined();
    expect(r.info.reassigned.has(outer)).toBeFalse();
    expect(r.info.reassigned.has(inner!)).toBeTrue();
    expect(outer.qualifier).toBe(Qualifier.Const);
    expect(inner!.qualifier).toBe(Qualifier.Series);
    expect(initTvOf(r, 'folded').value).toBe(6);
  });

  test('a nested write to the outer binding remains whole-file conservative', () => {
    const r = checkText(
      [
        'x = 2',
        'before = x * 3',
        'if close > 0',
        '    x := 4',
        'after = x * 3',
      ].join('\n'),
    );
    expect(r.errors).toEqual([]);

    const x = declaredName(r, 'x');
    expect(r.info.reassigned.has(x)).toBeTrue();
    expect(x.qualifier).toBe(Qualifier.Series);
    expect(initTvOf(r, 'before').value).toBeNull();
    expect(initTvOf(r, 'after').value).toBeNull();
  });

  test('function-local writes do not affect same-spelled script bindings', () => {
    const r = checkText(
      [
        'x = 2',
        'bumpLocal() =>',
        '    x = 0',
        '    x += 1',
        '    x',
        'folded = x * 3',
        'called = bumpLocal()',
      ].join('\n'),
    );
    expect(r.errors).toEqual([]);

    const outer = declaredName(r, 'x');
    const instance = [...r.info.userCalls.values()][0]?.instance;
    const local = [...instance!.tables.defs.values()].find(
      name => name.name === 'x',
    );
    expect(instance).toBeDefined();
    expect(local).toBeDefined();
    expect(r.info.reassigned.has(outer)).toBeFalse();
    expect(instance!.tables.reassigned.has(local!)).toBeTrue();
    expect(initTvOf(r, 'folded').value).toBe(6);
  });

  test('library-local writes cannot affect script bindings by source order', () => {
    const sources = [
      ['avg = ta.sma(close, 2)', 'sum = 2', 'picked = input.int(sum)'],
      ['sum = 2', 'picked = input.int(sum)', 'avg = ta.sma(close, 2)'],
    ];
    for (const lines of sources) {
      const r = checkText(lines.join('\n'));
      expect(r.errors).toEqual([]);
      const sum = declaredName(r, 'sum');
      expect(sum.qualifier).toBe(Qualifier.Const);
      expect(r.info.reassigned.has(sum)).toBeFalse();
    }
  });

  test('na literal needs an annotation, and takes one', () => {
    const r = checkText('float x = na');
    expect(r.errors).toEqual([]);
    const x = declaredName(r, 'x');
    expect(x.type.kind).toBe(TypeKind.Float);
    const tv = initTvOf(r, 'x');
    expect(tv.value !== null && isNaValue(tv.value)).toBe(true);
  });
});

describe('qualifier propagation', () => {
  test('later-known wins across expressions and natives', () => {
    const r = checkText(
      [
        'len = input.int(14, "Len")',
        'halfLen = len / 2',
        'srcMix = close + 1',
        'src = input.source(close, "Src")',
        'var acc = 0.0',
      ].join('\n'),
    );
    expect(r.errors).toEqual([]);
    expect(declaredName(r, 'len').qualifier).toBe(Qualifier.Input);
    expect(declaredName(r, 'halfLen').qualifier).toBe(Qualifier.Input);
    expect(declaredName(r, 'srcMix').qualifier).toBe(Qualifier.Series);
    expect(declaredName(r, 'src').qualifier).toBe(Qualifier.Series);
    // Persistent storage reads are series regardless of the initializer.
    expect(declaredName(r, 'acc').qualifier).toBe(Qualifier.Series);
  });

  test('history reads are series and control structures yield series', () => {
    const r = checkText(
      ['prev = close[1]', 'm = if close > 0', '\tclose', 'else', '\topen'].join(
        '\n',
      ),
    );
    expect(r.errors).toEqual([]);
    expect(declaredName(r, 'prev').qualifier).toBe(Qualifier.Series);
    expect(declaredName(r, 'm').qualifier).toBe(Qualifier.Series);
    expect(declaredName(r, 'm').type.kind).toBe(TypeKind.Float);
  });
});

describe('ambient series', () => {
  test('one pooled SeriesInput object per host id', () => {
    const r = checkText('a = close + close\nb = syminfo.tickerid');
    expect(r.errors).toEqual([]);
    const close = r.info.series.get('close');
    expect(close).toBeDefined();
    expect(close!.qualifier).toBe(Qualifier.Series);
    const tickerid = r.info.series.get('syminfo.tickerid');
    expect(tickerid).toBeDefined();
    expect(tickerid!.qualifier).toBe(Qualifier.Simple);
    // Every ambient use resolves to the same pooled object.
    const pooled = [...r.info.ambient.values()].filter(s => s.id === 'close');
    expect(pooled.length).toBe(2);
    expect(pooled[0]).toBe(pooled[1]);
  });
});

describe('native calls', () => {
  test('named arguments align to catalog params', () => {
    const r = checkText('plot(close, color=color.blue, title="x")');
    expect(r.errors).toEqual([]);
    const call = (r.file.stmtList[0] as ExprStmt).x as CallExpr;
    expect(call.kind).toBe(NodeKind.CallExpr);
    const resolved = r.info.calls.get(call);
    expect(resolved).toBeDefined();
    expect(resolved!.native.name).toBe('plot');
    // plot(series, title, color, ...): slot 0 = series, 1 = title, 2 = color.
    expect(resolved!.args[0]).not.toBeNull();
    expect(resolved!.args[1]).not.toBeNull();
    expect(resolved!.args[2]).not.toBeNull();
    expect(resolved!.args[3]).toBeNull();
  });

  test('overload selection: int stays int, mixing widens to float', () => {
    const r = checkText(
      'a = math.max(1, 2, 3)\nb = math.max(1, 2.5)\nc = math.round(1.234, 2)',
    );
    expect(r.errors).toEqual([]);
    expect(initTvOf(r, 'a')).toMatchObject({
      type: {kind: TypeKind.Int},
      value: 3,
    });
    expect(initTvOf(r, 'b')).toMatchObject({
      type: {kind: TypeKind.Float},
      value: 2.5,
    });
    expect(initTvOf(r, 'c')).toMatchObject({
      type: {kind: TypeKind.Float},
      value: 1.23,
    });
  });

  test('join result qualifiers follow the arguments', () => {
    const r = checkText('a = math.max(1, 2)\nb = math.max(1, bar_index)');
    expect(r.errors).toEqual([]);
    expect(declaredName(r, 'a').qualifier).toBe(Qualifier.Const);
    expect(declaredName(r, 'b').qualifier).toBe(Qualifier.Series);
  });
});

describe('diagnostics', () => {
  test('invalid for-in targets remain user-facing errors', () => {
    const r = checkText(
      [
        'int[] values = na',
        'x = 1',
        'loop = for [i, value, extra] in values',
        '    x := 2',
        '    x',
      ].join('\n'),
    );
    expect(r.errors.map(error => error.msg)).toContain(
      'for-in tuple pattern takes [index, value]',
    );
    expect(r.info.reassigned.has(declaredName(r, 'x'))).toBeTrue();
  });

  test('undeclared names and non-bool conditions report once', () => {
    const r = checkText('x = missing + 1');
    expect(r.errors.length).toBe(1);
    expect(r.errors[0].msg).toBe("undeclared name 'missing'");
    expect(r.errors[0].pos.line).toBe(1);
  });

  test('poison suppresses cascades', () => {
    const r = checkText('x = missing + 1\ny = x * 2');
    expect(r.errors.length).toBe(1);
  });
});
