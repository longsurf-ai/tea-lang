// Purpose: Checker unit tests — semantic objects, inferred types, qualifier propagation, constant folding, and call resolution observed through Info.

import {describe, expect, test} from 'vitest';
import {NodeKind, type CallExpr, type ExprStmt} from '../syntax/nodes';
import {Qualifier, TypeKind, isNaValue} from '../ir/type';
import {CallKind, SelectionKind} from './info';
import {CATALOG} from './catalog';
import {ObjectKind, type BuiltinObject, type VariableObject} from './object';
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

  test('eager ternaries fold only when every operand has a concrete value', () => {
    const r = checkText(
      [
        'folded = true ? 1 : 2',
        'fallible = true ? 1 : array.new<int>().first()',
      ].join('\n'),
    );
    expect(r.errors).toEqual([]);
    expect(initTvOf(r, 'folded').value).toBe(1);
    expect(initTvOf(r, 'fallible').value).toBeNull();
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
      (object): object is VariableObject =>
        object.kind === ObjectKind.Variable &&
        object.name === 'x' &&
        object !== outer,
    );
    expect(inner).toBeDefined();
    expect(r.info.reassigned.has(outer)).toBe(false);
    expect(r.info.reassigned.has(inner!)).toBe(true);
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
    expect(r.info.reassigned.has(x)).toBe(true);
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
    const call = [...r.info.calls.values()].find(
      resolution => resolution.kind === CallKind.Function,
    );
    const instance =
      call?.kind === CallKind.Function ? call.instance : undefined;
    const local = [...instance!.info.defs.values()].find(
      (object): object is VariableObject =>
        object.kind === ObjectKind.Variable && object.name === 'x',
    );
    expect(instance).toBeDefined();
    expect(local).toBeDefined();
    expect(r.info.reassigned.has(outer)).toBe(false);
    expect(instance!.info.reassigned.has(local!)).toBe(true);
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
      expect(r.info.reassigned.has(sum)).toBe(false);
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

  test('numeric NaN folds to the canonical na constant', () => {
    const r = checkText(
      [
        'sqrt = math.sqrt(-1)',
        'divide = 1.0 / 0.0',
        'modulo = 1 % 0',
        'difference = math.exp(1000) - math.exp(1000)',
        'composed = math.sqrt(-1) + 1',
        'negated = -math.sqrt(-1)',
        'literal = 1e999',
        'literalComparison = 1e999 == 1e999',
      ].join('\n'),
    );
    expect(r.errors).toEqual([]);
    for (const name of [
      'sqrt',
      'divide',
      'modulo',
      'difference',
      'composed',
      'negated',
      'literal',
    ]) {
      const value = initTvOf(r, name).value;
      expect(value !== null && isNaValue(value)).toBe(true);
    }
    expect(initTvOf(r, 'literalComparison').value).toBe(false);
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

describe('structs', () => {
  test('every constructor allocation is series-qualified', () => {
    const r = checkText(
      [
        'type Sample',
        '    float value = close',
        'fromDefault = Sample.new()',
        'fromExplicit = Sample.new(1.0)',
      ].join('\n'),
    );
    expect(r.errors).toEqual([]);
    expect(declaredName(r, 'fromDefault').qualifier).toBe(Qualifier.Series);
    expect(declaredName(r, 'fromExplicit').qualifier).toBe(Qualifier.Series);
    const sample = r.checked.pkg.scope.lookup('Sample');
    expect(sample?.kind).toBe(ObjectKind.Struct);
    if (sample?.kind === ObjectKind.Struct) {
      // The declared nominal type and semantic declaration graph refer to the
      // same canonical field objects.
      expect(sample.type.fields[0]).toEqual({
        name: 'value',
        type: sample.fields[0].type,
      });
      expect(sample.fields[0].defaultValue?.tv.qualifier).toBe(
        Qualifier.Series,
      );
    }
  });
});

describe('semantic ownership', () => {
  test('a checked package owns declarations, scopes, exports, and imports', () => {
    const r = checkText(
      [
        'import ta',
        'export identity(x) => x',
        'value = ta.sma(close, 2) + identity(close)',
      ].join('\n'),
    );
    expect(r.errors).toEqual([]);
    expect(r.info.scopes.get(r.file)).toBe(r.checked.pkg.scope);
    expect(r.checked.pkg.scope.lookup('value')).toBe(declaredName(r, 'value'));
    expect(r.checked.pkg.scope.lookup('identity')?.kind).toBe(
      ObjectKind.Function,
    );
    expect(r.checked.pkg.exports.has('identity')).toBe(true);

    const ta = r.checked.pkg.imports.find(pkg => pkg.name === 'ta');
    expect(ta?.name).toBe('ta');
    expect(ta?.path).toBe('ta');
    expect(ta?.files).toHaveLength(1);
    expect(ta?.scope.lookup('sma')?.kind).toBe(ObjectKind.Function);
    expect(ta?.exports.has('sma')).toBe(true);
    expect(
      [...r.info.uses.values()].some(
        object => object.kind === ObjectKind.PackageName && object.pkg === ta,
      ),
    ).toBe(true);
    expect(
      [...r.info.uses.values()].filter(
        object => object.kind === ObjectKind.Function,
      ),
    ).toHaveLength(2);
  });

  test('one semantic function instance projects into root and request Programs', () => {
    const r = checkText(
      [
        'read() => close',
        'root = read()',
        'child = request.security("X", "D", read())',
      ].join('\n'),
    );
    expect(r.errors).toEqual([]);
    const rootCall = [...r.info.calls.values()].find(
      resolution => resolution.kind === CallKind.Function,
    );
    const request = [...r.info.calls.values()].find(
      resolution => resolution.kind === CallKind.Request,
    );
    expect(rootCall?.kind).toBe(CallKind.Function);
    expect(request?.kind).toBe(CallKind.Request);
    if (
      rootCall?.kind !== CallKind.Function ||
      request?.kind !== CallKind.Request
    ) {
      return;
    }
    const childCall = [...request.capture.calls.values()].find(
      resolution => resolution.kind === CallKind.Function,
    );
    expect(childCall?.kind).toBe(CallKind.Function);
    if (childCall?.kind === CallKind.Function) {
      expect(childCall.instance).toBe(rootCall.instance);
    }
    expect(
      [...rootCall.instance.dependencies].some(
        dependency =>
          dependency.kind === ObjectKind.Builtin &&
          dependency.binding?.kind === 'series' &&
          dependency.binding.id === 'close',
      ),
    ).toBe(true);
  });

  test('request policy follows transitive declaration dependencies', () => {
    const allowed = checkText(
      [
        'length = input.int(1)',
        'read() => close[length]',
        'child = request.security("X", "D", read())',
      ].join('\n'),
    );
    expect(allowed.errors).toEqual([]);

    const rejected = checkText(
      [
        'source = close * 2',
        'read() => source',
        'child = request.security("X", "D", read())',
      ].join('\n'),
    );
    expect(rejected.errors.map(error => error.msg)).toContainEqual(
      expect.stringContaining("reads script variable 'source'"),
    );
  });

  test('request policy includes only defaults used by the call', () => {
    const functionDefault = checkText(
      [
        'source = close * 2',
        'read(value = source) => value',
        'explicit = request.security("X", "D", read(close))',
        'omitted = request.security("Y", "D", read())',
      ].join('\n'),
    );
    expect(functionDefault.errors.map(error => error.msg)).toContainEqual(
      expect.stringContaining("reads script variable 'source'"),
    );
    expect(
      functionDefault.errors.some(
        error => error.pos.line === 3 && error.msg.includes('source'),
      ),
    ).toBe(false);

    const constructorDefault = checkText(
      [
        'source = close * 2',
        'type Sample',
        '    float value = source',
        'explicit = request.security("X", "D", Sample.new(close).value)',
        'omitted = request.security("Y", "D", Sample.new().value)',
      ].join('\n'),
    );
    expect(constructorDefault.errors.map(error => error.msg)).toContainEqual(
      expect.stringContaining("'Sample.new' reads script variable 'source'"),
    );
    expect(
      constructorDefault.errors.some(
        error => error.pos.line === 4 && error.msg.includes('source'),
      ),
    ).toBe(false);
  });

  test('request results reject every non-scalar type', () => {
    const cases = [
      {
        source: [
          'type Sample',
          '    int value',
          'x = request.security("X", "D", Sample.new(1))',
        ].join('\n'),
        type: 'Sample',
      },
      {
        source: 'x = request.security("X", "D", array.new<int>())',
        type: 'array<int>',
      },
      {
        source: 'x = request.security("X", "D", matrix.new<int>(1, 1, 0))',
        type: 'matrix<int>',
      },
      {
        source: 'x = request.security("X", "D", map.new<string, int>())',
        type: 'map<string, int>',
      },
      {
        source:
          'x = request.security("X", "D", [close, [true, array.new<int>()]])',
        type: '[float, [bool, array<int>]]',
      },
      {
        source: 'x = request.security("X", "D", [close, true])',
        type: '[float, bool]',
      },
    ] as const;

    for (const {source, type} of cases) {
      const result = checkText(source);
      expect(result.errors.map(error => error.msg)).toEqual([
        `request expression cannot return ${type}; request results must be scalar`,
      ]);
      expect(
        [...result.info.calls.values()].some(
          resolution => resolution.kind === CallKind.Request,
        ),
      ).toBe(false);
    }
  });

  test('request results have fixed scalar and window-array shapes', () => {
    const result = checkText(
      [
        'scalar = request.security("X", "D", close)',
        'window = request.security_lower_tf("Y", "1", open)',
      ].join('\n'),
    );

    expect(result.errors).toEqual([]);
    expect(
      [...result.info.calls.values()].filter(
        resolution => resolution.kind === CallKind.Request,
      ),
    ).toHaveLength(2);
    expect(initTvOf(result, 'scalar').type.kind).toBe(TypeKind.Float);
    expect(initTvOf(result, 'window').type).toMatchObject({
      kind: TypeKind.Array,
      elem: {kind: TypeKind.Float},
    });
  });

  test('request calls require one plain top-level declaration target', () => {
    for (const source of [
      'plot(request.security("X", "D", close))',
      'request.security("X", "D", close)',
      '[left, right] = request.security("X", "D", [open, close])',
      'var value = request.security("X", "D", close)',
      'if true\n    value = request.security("X", "D", close)',
      'fetch() => request.security("X", "D", close)\nvalue = fetch()',
      'value = request.security("X", "D", request.security("Y", "W", close))',
    ]) {
      expect(checkText(source).errors.map(error => error.msg)).toContain(
        'request call must directly initialize one plain top-level variable',
      );
    }
  });
});

describe('context builtins', () => {
  test('every catalog variable has exactly the binding allowed by its qualifier', () => {
    for (const builtin of CATALOG.vars.values()) {
      if (builtin.qualifier === Qualifier.Const) {
        expect(builtin.binding).toBeNull();
      } else {
        expect(builtin.binding).not.toBeNull();
      }
    }
  });

  test('catalog runtime bindings are an exact closed vocabulary', () => {
    const series = [...CATALOG.vars.values()].flatMap(builtin =>
      builtin.binding?.kind === 'series' ? [builtin.binding.id] : [],
    );
    expect(series).toEqual([
      'open',
      'high',
      'low',
      'close',
      'volume',
      'hl2',
      'hlc3',
      'ohlc4',
      'hlcc4',
    ]);

    const builtins = [...CATALOG.vars.values()].flatMap(builtin =>
      builtin.binding?.kind === 'builtin'
        ? [[builtin.name, builtin.binding.source] as const]
        : [],
    );
    expect(builtins).toEqual([
      ['bar_index', {domain: 'bar', field: 'bar_index'}],
      ['last_bar_index', {domain: 'bar', field: 'last_bar_index'}],
      ['time', {domain: 'time', field: 'time'}],
      ['time_close', {domain: 'time', field: 'time_close'}],
      ['timenow', {domain: 'time', field: 'timenow'}],
      ['syminfo.tickerid', {domain: 'syminfo', field: 'tickerid'}],
      ['syminfo.ticker', {domain: 'syminfo', field: 'ticker'}],
      ['syminfo.prefix', {domain: 'syminfo', field: 'prefix'}],
      ['syminfo.currency', {domain: 'syminfo', field: 'currency'}],
      ['syminfo.basecurrency', {domain: 'syminfo', field: 'basecurrency'}],
      ['syminfo.type', {domain: 'syminfo', field: 'type'}],
      ['syminfo.timezone', {domain: 'syminfo', field: 'timezone'}],
      ['syminfo.mintick', {domain: 'syminfo', field: 'mintick'}],
      ['syminfo.pointvalue', {domain: 'syminfo', field: 'pointvalue'}],
      ['timeframe.period', {domain: 'timeframe', field: 'period'}],
      ['timeframe.multiplier', {domain: 'timeframe', field: 'multiplier'}],
      ['timeframe.isseconds', {domain: 'timeframe', field: 'isseconds'}],
      ['timeframe.isminutes', {domain: 'timeframe', field: 'isminutes'}],
      ['timeframe.isintraday', {domain: 'timeframe', field: 'isintraday'}],
      ['timeframe.isdaily', {domain: 'timeframe', field: 'isdaily'}],
      ['timeframe.isweekly', {domain: 'timeframe', field: 'isweekly'}],
      ['timeframe.ismonthly', {domain: 'timeframe', field: 'ismonthly'}],
      ['timeframe.isdwm', {domain: 'timeframe', field: 'isdwm'}],
      ['barstate.isfirst', {domain: 'barstate', field: 'isfirst'}],
      ['barstate.islast', {domain: 'barstate', field: 'islast'}],
      ['barstate.ishistory', {domain: 'barstate', field: 'ishistory'}],
      ['barstate.isrealtime', {domain: 'barstate', field: 'isrealtime'}],
      ['barstate.isconfirmed', {domain: 'barstate', field: 'isconfirmed'}],
      ['barstate.isnew', {domain: 'barstate', field: 'isnew'}],
    ]);
  });

  test('context builtin occurrences resolve to canonical BuiltinObjects', () => {
    const r = checkText('a = close + close\nb = syminfo.tickerid');
    expect(r.errors).toEqual([]);
    const close = [...r.info.uses.values()].filter(
      (object): object is BuiltinObject =>
        object.kind === ObjectKind.Builtin &&
        object.binding?.kind === 'series' &&
        object.binding.id === 'close',
    );
    expect(close).toHaveLength(2);
    expect(close[0].qualifier).toBe(Qualifier.Series);
    expect(close[0]).toBe(close[1]);

    const tickerid = [...r.info.selections.values()].find(
      selection =>
        selection.kind === SelectionKind.Builtin &&
        selection.builtin.binding?.kind === 'builtin' &&
        selection.builtin.binding.source.domain === 'syminfo' &&
        selection.builtin.binding.source.field === 'tickerid',
    );
    expect(tickerid?.kind).toBe(SelectionKind.Builtin);
    if (tickerid?.kind === SelectionKind.Builtin) {
      expect(tickerid.builtin.qualifier).toBe(Qualifier.Simple);
    }
  });

  test('catalog bindings distinguish numeric series from typed builtins', () => {
    const r = checkText(
      [
        'price = close',
        'opened = time',
        'closed = time_close',
        'index = bar_index',
        'first = barstate.isfirst',
        'symbol = syminfo.tickerid',
        'period = timeframe.period',
      ].join('\n'),
    );
    expect(r.errors).toEqual([]);
    const builtins = [
      ...r.info.uses.values(),
      ...[...r.info.selections.values()].flatMap(selection =>
        selection.kind === SelectionKind.Builtin ? [selection.builtin] : [],
      ),
    ].filter(
      (object): object is BuiltinObject => object.kind === ObjectKind.Builtin,
    );
    const bindings = new Map(
      builtins.map(builtin => [builtin.name, builtin.binding]),
    );
    expect(bindings.get('close')).toEqual({kind: 'series', id: 'close'});
    expect(bindings.get('time')).toEqual({
      kind: 'builtin',
      source: {domain: 'time', field: 'time'},
    });
    expect(bindings.get('time_close')).toEqual({
      kind: 'builtin',
      source: {domain: 'time', field: 'time_close'},
    });
    expect(bindings.get('bar_index')).toEqual({
      kind: 'builtin',
      source: {domain: 'bar', field: 'bar_index'},
    });
    expect(bindings.get('barstate.isfirst')).toEqual({
      kind: 'builtin',
      source: {domain: 'barstate', field: 'isfirst'},
    });
    expect(bindings.get('syminfo.tickerid')).toEqual({
      kind: 'builtin',
      source: {domain: 'syminfo', field: 'tickerid'},
    });
    expect(bindings.get('timeframe.period')).toEqual({
      kind: 'builtin',
      source: {domain: 'timeframe', field: 'period'},
    });
  });
});

describe('calls', () => {
  test('named arguments align to Tea prelude parameters', () => {
    const r = checkText('plot(close, color=color.blue, title="x")');
    expect(r.errors).toEqual([]);
    const call = (r.file.stmtList[0] as ExprStmt).x as CallExpr;
    expect(call.kind).toBe(NodeKind.CallExpr);
    const resolved = r.info.calls.get(call);
    expect(resolved?.kind).toBe(CallKind.Function);
    if (resolved?.kind !== CallKind.Function) {
      return;
    }
    expect(resolved.instance.name).toBe('plot');
    // plot(series, title, color, ...): slot 0 = series, 1 = title, 2 = color.
    expect(resolved.args[0]).not.toBeNull();
    expect(resolved.args[1]).not.toBeNull();
    expect(resolved.args[2]).not.toBeNull();
    expect(resolved.args[3]).toBeNull();
    expect(resolved.argumentEvaluationOrder).toEqual([
      0, 2, 1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
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

  test('input defaults and concrete metadata reject na before noding', () => {
    for (const source of [
      'x = input.color(color.new(color.blue, math.sqrt(-1)))',
      'x = input.float(1e999)',
      'x = input.int(1, title=na)',
      'x = input.int(1, tooltip=na)',
      'x = input.int(1, inline=na)',
      'x = input.int(1, group=na)',
      'x = input.int(1, display=na)',
    ]) {
      const r = checkText(source);
      expect(r.errors.map(error => error.msg)).toContainEqual(
        expect.stringContaining('cannot be na'),
      );
    }

    const nonFoldedDisplay = checkText(
      'f() => display.none\nx = input.int(1, display=f())',
    );
    expect(nonFoldedDisplay.errors.map(error => error.msg)).toContainEqual(
      expect.stringContaining('must be a constant literal'),
    );

    const nullableRange = checkText(
      'x = input.int(1, minval=na, maxval=na, step=na)',
    );
    expect(nullableRange.errors.map(error => error.msg)).toContainEqual(
      expect.stringContaining('cannot be na'),
    );
  });

  test('indicator max_bars_back is an integer from 0 through 5000', () => {
    for (const source of [
      'indicator("t", max_bars_back=na)',
      'indicator("t", max_bars_back=-1)',
      'indicator("t", max_bars_back=5001)',
      'indicator("t", max_bars_back=9007199254740992)',
    ]) {
      const r = checkText(source);
      expect(r.errors).not.toEqual([]);
    }

    expect(checkText('indicator("t", max_bars_back=5000)').errors).toEqual([]);
  });

  test('strategy has the exact minimal declaration surface', () => {
    const overloads = CATALOG.funcs.get('strategy');
    expect(overloads).toHaveLength(1);
    expect(overloads?.[0]?.params.map(param => param.name)).toEqual([
      'title',
      'shorttitle',
      'overlay',
    ]);
    expect(overloads?.[0]?.effect).toBe('declaration');

    expect(
      checkText('strategy("Strategy", "Short", overlay=true)').errors,
    ).toEqual([]);
    expect(
      checkText('strategy("Strategy", format="price")').errors.map(
        error => error.msg,
      ),
    ).toContainEqual(expect.stringContaining("unknown argument 'format'"));
  });

  test('strategy is one exclusive first-statement declaration', () => {
    const late = checkText('value = 1\nstrategy("Late")');
    expect(late.errors.map(error => error.msg)).toContain(
      'strategy() declaration must be the first statement in a strategy script',
    );

    const duplicate = checkText('strategy("First")\nstrategy("Second")');
    expect(duplicate.errors.map(error => error.msg)).toContain(
      'duplicate strategy() declaration',
    );

    for (const other of ['indicator("Indicator")', 'library("library")']) {
      const conflict = checkText(`strategy("Strategy")\n${other}`);
      expect(conflict.errors.map(error => error.msg)).toContain(
        `strategy() cannot be combined with ${other.slice(0, other.indexOf('('))}()`,
      );
    }

    const nested = checkText(['if true', '    strategy("Nested")'].join('\n'));
    expect(nested.errors.map(error => error.msg)).toContain(
      "'strategy' can only be called at the top level of the script",
    );
  });

  test('parentheses do not bypass strategy declaration placement rules', () => {
    const late = checkText('value = 1\n(strategy("Late"))');
    expect(late.errors.map(error => error.msg)).toContain(
      'strategy() declaration must be the first statement in a strategy script',
    );

    const duplicate = checkText('strategy("First")\n((strategy("Second")))');
    expect(duplicate.errors.map(error => error.msg)).toContain(
      'duplicate strategy() declaration',
    );

    const conflict = checkText(
      'strategy("Strategy")\n(indicator("Indicator"))',
    );
    expect(conflict.errors.map(error => error.msg)).toContain(
      'strategy() cannot be combined with indicator()',
    );
  });

  test('input overloads preserve their exact positional and nominal types', () => {
    const r = checkText(
      [
        'enum Mode',
        '    fast = "Fast"',
        '    slow = "Slow"',
        'enabled = input.bool(true)',
        'count = input.int(2, "Count", options=[1, 2], active=enabled)',
        'ratio = input.float(0, options=[-3.14, -1.57, 0, 1.57, 3.14])',
        'name = input.string("EMA", options=["EMA", "SMA"])',
        'symbol = input.symbol("NASDAQ:AAPL", "Symbol", "tip")',
        'note = input.text_area("memo", "Note", "tip", "Group")',
        'sourceA = input.source(close, confirm=true)',
        'sourceB = input(close, inline="row", group="Source", tooltip="tip")',
        'mode = input.enum(Mode.fast, options=[Mode.fast, Mode.slow])',
      ].join('\n'),
    );
    expect(r.errors).toEqual([]);
    expect(declaredName(r, 'mode').type.kind).toBe(TypeKind.Enum);
    expect(declaredName(r, 'mode').qualifier).toBe(Qualifier.Input);
    expect(declaredName(r, 'sourceB').qualifier).toBe(Qualifier.Series);
  });

  test('inputs are global declarations from local blocks, UDFs, and scalar request captures', () => {
    const r = checkText(
      [
        'if true',
        '    local = input.int(1)',
        'f() =>',
        '    enabled = input.bool(true)',
        '    input.int(2, active=enabled)',
        'x = f()',
        'captured = request.security("X", "D", close * input.float(2))',
      ].join('\n'),
    );
    expect(r.errors).toEqual([]);

    const exported = checkText(
      ['export f() => input.int(1)', 'x = f()'].join('\n'),
    );
    expect(exported.errors.map(error => error.msg)).toContainEqual(
      expect.stringContaining('cannot be called from an exported function'),
    );

    const localActive = checkText(
      [
        'enabled = input.bool(true)',
        'f(bool enabled) => input.int(1, active=enabled)',
        'x = f(enabled)',
      ].join('\n'),
    );
    expect(localActive.errors.map(error => error.msg)).toContainEqual(
      expect.stringContaining(
        'active cannot depend on local execution state because the input is program-global',
      ),
    );

    const capturedSource = checkText(
      'x = request.security("X", "D", input.source(close))',
    );
    expect(capturedSource.errors.map(error => error.msg)).toContainEqual(
      expect.stringContaining(
        'cannot declare a source input inside a request expression',
      ),
    );

    const capturedAlias = checkText(
      [
        'length = input.int(2)',
        'computed = length + 0',
        'x = request.security("X", "D", close[computed])',
      ].join('\n'),
    );
    expect(capturedAlias.errors.map(error => error.msg)).toContainEqual(
      expect.stringContaining(
        "cannot capture computed script variable 'computed'",
      ),
    );
  });

  test('input constraints reject ambiguous or invalid host metadata', () => {
    const cases = [
      ['input.bool(true, options=[true])', "unknown argument 'options'"],
      ['input.symbol("A", options=["A"])', "unknown argument 'options'"],
      ['input.text_area("x", inline="row")', "unknown argument 'inline'"],
      ['input(1, confirm=true)', "unknown argument 'confirm'"],
      [
        'opts = ["a", "b"]\nx = input.string("a", options=opts)',
        'tuple values are transport-only',
      ],
      ['x = input.string("a", options=[1, 2])', 'must have type string'],
      ['x = input.string("a", options=["b", "c"])', 'default must be one of'],
      ['x = input.int(1, options=[1, 1])', 'cannot repeat'],
      ['x = input.float(0.0, options=[0.0, -0.0])', 'cannot repeat'],
      ['x = input.int(0, minval=1)', 'at least minval'],
      ['x = input.int(3, maxval=2)', 'at most maxval'],
      ['x = input.int(1, minval=2, maxval=0)', 'cannot exceed'],
      ['x = input.int(1, step=0)', 'greater than zero'],
      ['x = input.int(1, display=display.pane)', 'display must be'],
      ['x = input.source(volume)', 'source default must be'],
      ['x = input.source(time)', 'source default must be'],
      ['x = input.source(time_close)', 'source default must be'],
      ['x = input.source(bar_index)', 'source default must be'],
      ['x = input.source(close + 1)', 'source default must be'],
      ['x = input.int(1, active=close > 0)', 'accepts at most input'],
    ] as const;
    for (const [source, diagnostic] of cases) {
      const r = checkText(source);
      expect(r.errors.map(error => error.msg)).toContainEqual(
        expect.stringContaining(diagnostic),
      );
    }
  });

  test('request bind options accept simple expressions and reject invalid contracts', () => {
    const valid = checkText(
      [
        'fill_policy = syminfo.type == "stock" ? "sparse" : "carry"',
        'ignore = input.bool(false)',
        'bars = input.int(25)',
        'x = request.security("X", "D", close, fill=fill_policy, ignore_invalid_symbol=ignore, calc_bars_count=bars)',
      ].join('\n'),
    );
    expect(valid.errors).toEqual([]);

    const cases = [
      [
        'x = request.security("X", "D", close, calc_bars_count=-1)',
        'must be between 0',
      ],
      [
        'x = request.security("X", "D", close, calc_bars_count=int(na))',
        'cannot be na',
      ],
      [
        'x = request.security("X", "D", close, availability="middle")',
        'request option \'availability\' has invalid value "middle"',
      ],
      [
        'x = request.security("X", "D", close, fill="forward")',
        'request option \'fill\' has invalid value "forward"',
      ],
      [
        [
          'fetch(string policy) => request.security("X", "D", close, fill=policy)',
          'x = fetch("carry")',
        ].join('\n'),
        'request call must directly initialize one plain top-level variable',
      ],
    ] as const;
    for (const [source, diagnostic] of cases) {
      const r = checkText(source);
      expect(r.errors.map(error => error.msg)).toContainEqual(
        expect.stringContaining(diagnostic),
      );
    }
  });

  test('staged native arguments are rejected before type matching and publish no call resolution', () => {
    for (const value of ['1', '"USD"']) {
      const r = checkText(
        `x = request.security("X", "D", close, currency=${value})`,
      );
      expect(r.errors.map(error => error.msg)).toEqual([
        "argument 'currency' to 'request.security' is not supported yet",
      ]);
      expect(r.info.calls.size).toBe(0);
    }
  });

  test('a bind-time UDF qualifier includes work before its return value', () => {
    const r = checkText(
      [
        'f(bool x) =>',
        '    y = close',
        '    z = y + 1',
        '    x',
        'enabled = input.bool(true)',
        'mode = input.int(1, active=f(enabled))',
      ].join('\n'),
    );
    expect(r.errors.map(error => error.msg)).toContainEqual(
      expect.stringContaining('accepts at most input'),
    );
  });

  test('enum options keep declaration identity', () => {
    const r = checkText(
      [
        'enum Left',
        '    one',
        'enum Right',
        '    one',
        'x = input.enum(Left.one, options=[Right.one])',
      ].join('\n'),
    );
    expect(r.errors.map(error => error.msg)).toContainEqual(
      expect.stringContaining('must have type Left'),
    );
  });

  test('na contracts reject bool and string nz while folding comparisons', () => {
    expect(checkText('x = na(true)').errors).not.toEqual([]);
    expect(checkText('x = nz("", "fallback")').errors).not.toEqual([]);

    const enumNa = checkText(
      ['enum Mode', '    fast', 'x = na(Mode.fast)'].join('\n'),
    );
    expect(enumNa.errors).toEqual([]);

    const r = checkText(
      [
        'float missing = na',
        'same = missing == 1.0',
        'different = missing != 1.0',
        'overflow = math.exp(1000)',
      ].join('\n'),
    );
    expect(r.errors).toEqual([]);
    expect(initTvOf(r, 'same').value).toBe(false);
    expect(initTvOf(r, 'different').value).toBe(false);
    expect(isNaValue(initTvOf(r, 'overflow').value!)).toBe(true);

    for (const source of [
      'x = na == close',
      'x = close != na',
      'x = na < 1',
      'x = 1 >= na',
    ]) {
      expect(checkText(source).errors.map(error => error.msg)).toContain(
        'cannot use bare na in a comparison; use na(...) to test missing values',
      );
    }
  });
});

describe('diagnostics', () => {
  test('switch has at most one default arm and it is final', () => {
    const nonFinal = checkText(
      ['x = switch 1', '    => 10', '    1 => 20'].join('\n'),
    );
    expect(nonFinal.errors.map(error => error.msg)).toContain(
      'switch default arm must be last',
    );

    const duplicate = checkText(
      ['x = switch 1', '    => 10', '    => 20'].join('\n'),
    );
    expect(duplicate.errors.map(error => error.msg)).toContain(
      'switch may contain only one default arm',
    );
  });

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
      'for-in tuple pattern takes two values',
    );
    expect(r.info.reassigned.has(declaredName(r, 'x'))).toBe(true);
  });

  test('rejects a compile-time zero numeric range step', () => {
    for (const zero of ['0', '0.0', '-0.0']) {
      const r = checkText(
        ['value = for i = 1 to 3 by ' + zero, '    i'].join('\n'),
      );
      expect(r.errors.map(error => error.msg)).toContain(
        "'for' step must not be zero",
      );
    }
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
