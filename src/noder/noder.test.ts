// Purpose: Noder unit tests — desugarings (compound assign, tuple patterns, history-on-expression), param/output extraction with reference binding, and depth resolution observed on the built Program.

import {describe, expect, test} from 'bun:test';
import {newFileBase} from '../base/pos';
import {Errors, fatal} from '../base/print';
import {checkPackage} from '../checker/check';
import {
  DepthKind,
  IrKind,
  IrOp,
  PlaceKind,
  Storage,
  type HistReadExpr,
  type WriteNameStmt,
} from '../ir/node';
import {MergeMode, ParamConstraintKind, ParamDefaultKind} from '../ir/program';
import {TypeKind, isNaValue} from '../ir/type';
import {
  executionInputsOf,
  funcsOf,
  namesOf,
  seriesInputsOf,
  slotCountOf,
} from '../ir/visit';
import {
  resolveImports,
  type PackageSource,
  type Registry,
} from '../loader/loader';
import {parse} from '../syntax/syntax';
import {buildProgram} from './noder';
import {buildText, mustBuild} from './testing';
import {DEFAULT_MAX_BARS_BACK} from './depth';

function mustBuildWithLibraries(
  source: string,
  libraries: Readonly<Record<string, string>>,
) {
  const errors = new Errors();
  const file = parse(newFileBase('main.tea'), source, (pos, msg) =>
    errors.errorAt(pos, msg),
  );
  const registry: Registry = (path: string): PackageSource | null => {
    const library = libraries[path];
    return library === undefined
      ? null
      : {filename: `memory/${path}.tea`, source: library};
  };
  const checked = checkPackage(
    [file],
    errors,
    resolveImports([file], registry, []),
  );
  if (errors.count > 0) {
    return fatal(
      `fixture failed to check: ${errors
        .flushErrors()
        .map(
          error => `${error.pos.base.filename}:${error.pos.line}: ${error.msg}`,
        )
        .join('; ')}`,
    );
  }
  const program = buildProgram(checked, errors);
  if (errors.count > 0) {
    return fatal(
      `fixture failed to node: ${errors
        .flushErrors()
        .map(
          error => `${error.pos.base.filename}:${error.pos.line}: ${error.msg}`,
        )
        .join('; ')}`,
    );
  }
  return program;
}

describe('declarations', () => {
  test('plain decls write per bar; var decls initialize once', () => {
    const program = mustBuild('x = close + 1\nvar acc = 0.0\nacc := acc + x');
    // Persistent initialization stays at the declaration's lexical site.
    expect(program.body.map(stmt => stmt.kind)).toEqual([
      IrKind.WriteName,
      IrKind.InitName,
      IrKind.WriteName,
    ]);
    const write = program.body[0] as WriteNameStmt;
    expect(write.kind).toBe(IrKind.WriteName);
    expect(write.name.name).toBe('x');
    const acc = namesOf(program).find(n => n.name === 'acc');
    expect(acc).toBeDefined();
    expect(acc!.storage).toBe(Storage.Var);
    expect(program.body[1]).toMatchObject({
      kind: IrKind.InitName,
      name: acc,
    });
  });

  test('const declarations vanish; reads fold', () => {
    const program = mustBuild('const k = 4\nx = close * k');
    expect(namesOf(program).map(n => n.name)).toEqual(['x']);
    const write = program.body[0] as WriteNameStmt;
    const mul = write.value;
    expect(mul.kind).toBe(IrKind.Binary);
    if (mul.kind === IrKind.Binary) {
      expect(mul.y.kind).toBe(IrKind.Const);
    }
  });

  test('compound assignment desugars to the binary op', () => {
    const program = mustBuild('a = 0.0\na += close');
    const write = program.body[1] as WriteNameStmt;
    expect(write.kind).toBe(IrKind.WriteName);
    const value = write.value;
    expect(value.kind).toBe(IrKind.Binary);
    if (value.kind === IrKind.Binary) {
      expect(value.op).toBe(IrOp.Add);
      expect(value.x.kind).toBe(IrKind.HistRead);
    }
  });

  test('tuple declarations desugar through a temp and TupleGet', () => {
    const program = mustBuild('[a, b] = [close, open]\ns = a + b');
    const kinds = program.body.map(s => s.kind);
    expect(kinds).toEqual([
      IrKind.WriteName, // $tuple temp
      IrKind.WriteName, // a
      IrKind.WriteName, // b
      IrKind.WriteName, // s
    ]);
    const second = program.body[1] as WriteNameStmt;
    expect(second.value.kind).toBe(IrKind.TupleGet);
  });

  test('every na constant entering Program IR has a concrete nullable type', () => {
    const program = mustBuild(
      [
        'float x = na',
        'x := na',
        'y = close > 0 ? na : 1.0',
        'z = nz(na, 1.0)',
        'isMissing = na(na)',
        'asText = str.tostring(na)',
      ].join('\n'),
    );
    const writes = program.body.filter(
      (stmt): stmt is WriteNameStmt => stmt.kind === IrKind.WriteName,
    );
    const xValues = writes
      .filter(write => write.name.name === 'x')
      .map(write => write.value);
    expect(xValues).toHaveLength(2);
    for (const value of xValues) {
      expect(value.type.kind).toBe(TypeKind.Float);
      expect(value.kind).toBe(IrKind.Const);
      if (value.kind === IrKind.Const) {
        expect(isNaValue(value.value)).toBe(true);
      }
    }

    const y = writes.find(write => write.name.name === 'y')!.value;
    expect(y.kind).toBe(IrKind.Cond);
    if (y.kind === IrKind.Cond) {
      expect(y.then.type.kind).toBe(TypeKind.Float);
    }
    for (const name of ['z', 'isMissing', 'asText']) {
      const call = writes.find(write => write.name.name === name)!.value;
      expect(call.kind).toBe(IrKind.CallNative);
      if (call.kind === IrKind.CallNative) {
        expect(call.args[0].type.kind).toBe(TypeKind.Float);
      }
    }
  });
});

describe('user-defined types', () => {
  test('imported semantic types, methods, and functions project into Program IR', () => {
    const program = mustBuildWithLibraries(
      [
        'import model as pkg',
        'counter = pkg.Counter.new(3)',
        'read = counter.read()',
        'next = pkg.bump(counter)',
      ].join('\n'),
      {
        model: [
          'library("model")',
          'export type Counter',
          '    int value = 1',
          '    int read() const => this.value',
          'export bump(Counter counter) => counter.value + 1',
        ].join('\n'),
      },
    );

    const writes = program.body.filter(
      (stmt): stmt is WriteNameStmt => stmt.kind === IrKind.WriteName,
    );
    expect(writes[0].value.kind).toBe(IrKind.NewUserValue);
    expect(
      funcsOf(program)
        .map(func => func.callMode)
        .sort(),
    ).toEqual(['const-method', 'free']);
  });

  test('a field default nodes in a function instance', () => {
    const program = mustBuild(
      [
        'type Point',
        '    int x = 1',
        'make() => Point.new()',
        'point = make()',
      ].join('\n'),
    );
    expect(funcsOf(program)[0].body).toMatchObject({
      kind: IrKind.NewUserValue,
      args: [{kind: IrKind.Const, value: 1}],
    });
  });

  test('a field default nodes in a request child', () => {
    const program = mustBuild(
      [
        'type Point',
        '    int x = 1',
        'point = request.security("A", "D", Point.new())',
      ].join('\n'),
    );
    expect(program.requests[0].child.body[0]).toMatchObject({
      kind: IrKind.WriteName,
      value: {
        kind: IrKind.NewUserValue,
        args: [{kind: IrKind.Const, value: 1}],
      },
    });
  });

  test('field reads and rooted writes project canonical field indices', () => {
    const program = mustBuild(
      [
        'type Point',
        '    int x',
        'type Holder',
        '    Point point',
        'holder = Holder.new(Point.new(1))',
        'holder.point.x := 3',
        'read = holder.point.x',
      ].join('\n'),
    );
    expect(program.body[1]).toMatchObject({
      kind: IrKind.UpdateValuePath,
      path: {
        root: {name: 'holder'},
        fieldIndices: [0, 0],
      },
      value: {kind: IrKind.Const, value: 3},
    });
    expect(program.body[2]).toMatchObject({
      kind: IrKind.WriteName,
      value: {
        kind: IrKind.FieldGet,
        fieldIndex: 0,
        x: {kind: IrKind.FieldGet, fieldIndex: 0},
      },
    });
  });

  test('collection mutators capture a rooted path and keep their result', () => {
    const program = mustBuild(
      ['xs = array.from(1, 2)', 'xs.push(3)', 'last = xs.pop()'].join('\n'),
    );
    expect(program.body[1]).toMatchObject({
      kind: IrKind.ExprStmt,
      x: {
        kind: IrKind.MutateCollection,
        operation: 'array.push',
        path: {root: {name: 'xs'}, fieldIndices: []},
        receiver: {kind: IrKind.HistRead},
        args: [{kind: IrKind.Const, value: 3}],
      },
    });
    expect(program.body[2]).toMatchObject({
      kind: IrKind.WriteName,
      name: {name: 'last'},
      value: {
        kind: IrKind.MutateCollection,
        operation: 'array.pop',
        path: {root: {name: 'xs'}, fieldIndices: []},
        args: [],
      },
    });
  });

  test('mutable methods project a hidden receiver and copy-in/copy-out call', () => {
    const program = mustBuild(
      [
        'type Foo',
        '    array<int> values',
        '    void append(int value) => this.values.push(value)',
        'foo = Foo.new(array.from(1))',
        'foo.append(2)',
      ].join('\n'),
    );
    const append = funcsOf(program).find(func => func.name === 'Foo.append');
    expect(append).toMatchObject({
      callMode: 'mutable-method',
      receiver: {name: 'this'},
      params: [{name: 'value'}],
      body: {
        kind: IrKind.MutateCollection,
        operation: 'array.push',
        path: {root: {name: 'this'}, fieldIndices: [0]},
      },
    });
    if (append?.callMode === 'mutable-method') {
      expect(append.params).not.toContain(append.receiver);
    }
    expect(program.body[1]).toMatchObject({
      kind: IrKind.ExprStmt,
      x: {
        kind: IrKind.CallMutableMethod,
        func: append,
        path: {root: {name: 'foo'}, fieldIndices: []},
        receiver: {kind: IrKind.HistRead},
        args: [{kind: IrKind.Const, value: 2}],
      },
    });
  });

  test('const methods keep the hidden receiver outside explicit argument order', () => {
    const program = mustBuild(
      [
        'struct Foo',
        '    int value',
        '    int inspect(int first, int second) const => this.value + first + second',
        'foo = Foo.new(10)',
        'result = foo.inspect(second = 2, first = 1)',
      ].join('\n'),
    );
    const inspect = funcsOf(program).find(func => func.name === 'Foo.inspect');
    expect(inspect).toMatchObject({
      callMode: 'const-method',
      receiver: {name: 'this'},
      params: [{name: 'first'}, {name: 'second'}],
    });
    if (inspect?.callMode === 'const-method') {
      expect(inspect.params).not.toContain(inspect.receiver);
    }
    expect(program.body[1]).toMatchObject({
      kind: IrKind.WriteName,
      value: {
        kind: IrKind.CallConstMethod,
        func: inspect,
        receiver: {kind: IrKind.HistRead},
        args: [
          {kind: IrKind.Const, value: 1},
          {kind: IrKind.Const, value: 2},
        ],
        argumentEvaluationOrder: [1, 0],
      },
    });
  });
});

describe('params and outputs', () => {
  test('input binds by declaration name and reads become param reads', () => {
    const program = mustBuild('len = input.int(14, "Length")\nx = close * len');
    expect(program.params.length).toBe(1);
    expect(program.params[0].name).toBe('len');
    expect(program.params[0].title).toBe('Length');
    expect(program.params[0].defaultValue).toEqual({
      kind: ParamDefaultKind.Const,
      value: 14,
    });
    // No per-bar write exists for len; only x.
    expect(namesOf(program).map(n => n.name)).toEqual(['x']);
  });

  test('a shadowed write does not disable an outer input binding', () => {
    const program = mustBuild(
      [
        'len = input.int(14)',
        'shadow = if true',
        '    len = 1',
        '    len := 2',
        '    len',
        'x = close * len',
      ].join('\n'),
    );
    expect(program.params[0].name).toBe('len');
    expect(namesOf(program).filter(name => name.name === 'len')).toHaveLength(
      1,
    );
  });

  test('a real outer write still disables input reference binding', () => {
    const program = mustBuild(
      [
        'len = input.int(14)',
        'if close > 0',
        '    len := 20',
        'x = close * len',
      ].join('\n'),
    );
    expect(program.params[0].name).not.toBe('len');
    expect(namesOf(program).filter(name => name.name === 'len')).toHaveLength(
      1,
    );
  });

  test('expression-position inputs take the input@line:col identity', () => {
    const program = mustBuild('x = close * input.int(2)');
    expect(program.params.length).toBe(1);
    expect(program.params[0].name).toBe('input@1:13');
  });

  test('input metadata keeps exclusive constraints, defaults, active, and enum identity', () => {
    const program = mustBuild(
      [
        'enum Mode',
        '    fast = "Fast"',
        '    slow = "Slow"',
        'enabled = input.bool(true)',
        'count = input.int(2, options=[1, 2], active=enabled)',
        'ratio = input.float(1.0, minval=0.0, maxval=2.0, step=0.5)',
        'mode = input.enum(Mode.fast, options=[Mode.fast, Mode.slow])',
      ].join('\n'),
    );
    const [enabled, count, ratio, mode] = program.params;
    expect(enabled.display).toBe('none');
    expect(enabled.active).toMatchObject({
      kind: IrKind.Const,
      type: {kind: TypeKind.Bool},
      value: true,
    });
    expect(count.display).toBe('all');
    expect(count.constraints).toEqual({
      kind: ParamConstraintKind.Options,
      options: [1, 2],
    });
    expect(count.active).toMatchObject({
      kind: IrKind.HistRead,
      place: {kind: PlaceKind.Param, param: enabled},
    });
    expect(ratio.constraints).toEqual({
      kind: ParamConstraintKind.Range,
      minval: 0,
      maxval: 2,
      step: 0.5,
    });
    expect(mode.type).toMatchObject({
      kind: TypeKind.Enum,
      name: 'Mode',
      members: [
        {name: 'fast', title: 'Fast'},
        {name: 'slow', title: 'Slow'},
      ],
    });
    expect(mode.defaultValue).toEqual({
      kind: ParamDefaultKind.Const,
      value: 'fast',
    });
    expect(mode.constraints).toEqual({
      kind: ParamConstraintKind.Options,
      options: ['fast', 'slow'],
    });
  });

  test('outputs partition into static, bind, and channel args', () => {
    const program = mustBuild(
      'p1 = plot(high, "High")\np2 = plot(low, "Low")\nfill(p1, p2)',
    );
    expect(program.outputs.length).toBe(3);
    const [high, , fill] = program.outputs;
    expect(high.staticArgs).toEqual([{name: 'title', value: 'High'}]);
    expect(high.channels).toEqual([{name: 'series', type: {kind: 'Float'}}]);
    // fill's plot refs resolve through the bound names into bindArgs.
    expect(fill.bindArgs.map(b => b.name)).toEqual(['plot1', 'plot2']);
    expect(fill.bindArgs[0].expr.kind).toBe(IrKind.OutputRef);
    // Each plotted series emits per bar.
    const emits = program.body.filter(s => s.kind === IrKind.Emit);
    expect(emits.length).toBe(2);
  });

  test('output channels retain named-argument source evaluation order', () => {
    const program = mustBuild(
      [
        'type Counter',
        '    array<int> values',
        '    int next() =>',
        '        value = this.values.size()',
        '        this.values.push(value)',
        '        value',
        '    color nextColor() =>',
        '        this.values.push(9)',
        '        color.red',
        'counter = Counter.new(array.new<int>())',
        'plot(color = counter.nextColor(), series = counter.next())',
      ].join('\n'),
    );
    const emit = program.body.find(stmt => stmt.kind === IrKind.Emit);
    expect(emit?.kind).toBe(IrKind.Emit);
    if (emit?.kind === IrKind.Emit) {
      expect(emit.output.channels.map(channel => channel.name)).toEqual([
        'series',
        'color',
      ]);
      expect(emit.argumentEvaluationOrder).toEqual([1, 0]);
    }
  });

  test('simple context-builtin output values remain per-bar channels', () => {
    const program = mustBuild('plot(timeframe.multiplier)');
    const [plot] = program.outputs;
    expect(plot.bindArgs).toEqual([]);
    expect(plot.channels).toEqual([
      {name: 'series', type: {kind: TypeKind.Int}},
    ]);
    expect(program.body.filter(stmt => stmt.kind === IrKind.Emit)).toHaveLength(
      1,
    );
  });

  test('a shadowed write does not disable an outer output reference', () => {
    const program = mustBuild(
      [
        'p = plot(high)',
        'q = plot(low)',
        'shadow = if true',
        '    p = 0',
        '    p := 1',
        '    p',
        'fill(p, q)',
      ].join('\n'),
    );
    const fill = program.outputs[2];
    expect(fill.bindArgs.map(arg => arg.expr.kind)).toEqual([
      IrKind.OutputRef,
      IrKind.OutputRef,
    ]);
    expect(namesOf(program).filter(name => name.name === 'p')).toHaveLength(1);
  });
});

describe('history', () => {
  test('history on a computed expression synthesizes an unconditional slot', () => {
    const program = mustBuild('x = (high + low)[2]\nplot(x)');
    const write = program.body[0] as WriteNameStmt;
    expect(write.name.name).toBe('$hist@1:5');
    const readback = program.body[1] as WriteNameStmt;
    const read = readback.value as HistReadExpr;
    expect(read.kind).toBe(IrKind.HistRead);
    expect(read.place.kind).toBe(PlaceKind.Name);
    expect(write.name.depth).toEqual({kind: DepthKind.Const, bars: 2});
  });

  test('history on an expression inside a block is rejected for now', () => {
    const {program, errors} = buildText(
      'y = if close > 0\n\t(high + low)[1]\nelse\n\t0.0',
    );
    expect(program).toBeNull();
    expect(errors.some(e => e.msg.includes('history on an expression'))).toBe(
      true,
    );
  });

  test('a shadowed write preserves a stable-place alias', () => {
    const program = mustBuild(
      [
        'src = close',
        'shadow = if true',
        '    src = 0.0',
        '    src := 1.0',
        '    src',
        'prev = src[1]',
        'plot(prev)',
      ].join('\n'),
    );
    const close = seriesInputsOf(program).find(series => series.id === 'close');
    expect(close?.depth).toEqual({kind: DepthKind.Const, bars: 1});
    expect(namesOf(program).filter(name => name.name === 'src')).toHaveLength(
      1,
    );
  });
});

describe('depth resolution', () => {
  test('const, bound, dynamic, and mixed demands resolve per place', () => {
    const program = mustBuild(
      [
        'indicator("d", max_bars_back=300)',
        'lookback = input.int(20)',
        'a = high[3]',
        'b = low[lookback]',
        'c = open[bar_index % 5]',
        'plot(a + b + c)',
      ].join('\n'),
    );
    const byId = new Map(seriesInputsOf(program).map(s => [s.id, s]));
    expect(byId.get('high')!.depth).toEqual({kind: DepthKind.Const, bars: 3});
    const low = byId.get('low')!.depth;
    expect(low.kind).toBe(DepthKind.Bound);
    const open = byId.get('open')!.depth;
    expect(open.kind).toBe(DepthKind.Capped);
    if (open.kind === DepthKind.Capped) {
      expect(open.bars).toMatchObject({kind: IrKind.Const, value: 300});
    }
  });

  test('an immutable root input alias remains an exact bound depth', () => {
    const program = mustBuild(
      [
        'identity(int value) => value',
        'len = input.int(1000)',
        'alias = identity(len) + 0',
        'base = close * 1',
        'plot(base[alias])',
      ].join('\n'),
    );
    const base = namesOf(program).find(name => name.name === 'base');
    expect(base?.depth.kind).toBe(DepthKind.Bound);
  });

  test('a simple execution input remains an exact bound depth', () => {
    const program = mustBuild(
      ['length = timeframe.multiplier', 'plot(close[length])'].join('\n'),
    );
    const close = seriesInputsOf(program).find(series => series.id === 'close');
    expect(close?.depth).toMatchObject({
      kind: DepthKind.Bound,
      expr: {
        kind: IrKind.HistRead,
        place: {kind: PlaceKind.Execution},
      },
    });
  });

  test('a block-local root input alias substitutes instead of reading unbound scratch', () => {
    const program = mustBuild(
      [
        'enabled = input.bool(true)',
        'value = if enabled',
        '    alias = input.int(1000) + 0',
        '    base = close * 1',
        '    base[alias]',
        'else',
        '    na',
        'plot(value)',
      ].join('\n'),
    );
    const base = namesOf(program).find(name => name.name === 'base')!;
    expect(base.depth.kind).toBe(DepthKind.Bound);
    if (base.depth.kind === DepthKind.Bound) {
      expect(base.depth.expr).toMatchObject({
        kind: IrKind.Binary,
        x: {kind: IrKind.HistRead, place: {kind: PlaceKind.Param}},
      });
    }
  });

  test('a direct root input UDF offset remains an exact bound depth', () => {
    const program = mustBuild(
      [
        'offset(int value) => value',
        'len = input.int(1000)',
        'plot(close[offset(len)])',
      ].join('\n'),
    );
    const close = seriesInputsOf(program).find(
      series => series.id === 'close',
    )!;
    expect(close.depth.kind).toBe(DepthKind.Bound);
    if (close.depth.kind === DepthKind.Bound) {
      expect(close.depth.expr).toMatchObject({
        kind: IrKind.CallFunc,
        func: {name: 'offset'},
      });
    }
  });

  test('function call sites substitute input params and locals into one max demand', () => {
    const program = mustBuild(
      [
        'sample(int length) =>',
        '    alias = length + 0',
        '    close[alias]',
        'plot(sample(input.int(2)) + sample(input.int(1000)))',
      ].join('\n'),
    );
    const close = seriesInputsOf(program).find(
      series => series.id === 'close',
    )!;
    expect(close.depth.kind).toBe(DepthKind.Bound);
    if (close.depth.kind === DepthKind.Bound) {
      expect(close.depth.expr).toMatchObject({
        kind: IrKind.CallNative,
        native: 'math.max',
        args: expect.arrayContaining([
          expect.objectContaining({
            kind: IrKind.CallNative,
            native: '$historyDepth',
          }),
        ]),
      });
    }
  });

  test('an input helper called inside the consuming UDF normalizes to the root argument', () => {
    const program = mustBuild(
      [
        'offset(int value) => value',
        'sample(int length) =>',
        '    base = close * 1',
        '    base[offset(length)]',
        'plot(sample(input.int(1000)))',
      ].join('\n'),
    );
    const base = namesOf(program).find(name => name.name === 'base')!;
    expect(base.depth.kind).toBe(DepthKind.Bound);
    if (base.depth.kind === DepthKind.Bound) {
      expect(base.depth.expr).toMatchObject({
        kind: IrKind.HistRead,
        place: {kind: PlaceKind.Param},
      });
    }
  });

  test('mutable method calls substitute the hidden receiver and explicit parameters', () => {
    const program = mustBuild(
      [
        'type Box',
        '    array<float> values',
        '    void sample(int length) => this.values.push(close[length])',
        'length = input.int(1000)',
        'box = Box.new(array.from(0.0))',
        'box.sample(length)',
      ].join('\n'),
    );
    const close = seriesInputsOf(program).find(series => series.id === 'close');
    expect(close?.depth.kind).toBe(DepthKind.Bound);
    if (close?.depth.kind === DepthKind.Bound) {
      expect(close.depth.expr).toMatchObject({
        kind: IrKind.HistRead,
        place: {kind: PlaceKind.Param, param: {name: 'length'}},
      });
    }
  });

  test('multiple root bound and const demands retain their exact maximum', () => {
    const program = mustBuild(
      [
        'short = input.int(2)',
        'long = input.int(1000)',
        'base = close * 1',
        'plot(base[short] + base[long] + base[1200])',
      ].join('\n'),
    );
    const base = namesOf(program).find(name => name.name === 'base')!;
    expect(base.depth.kind).toBe(DepthKind.Bound);
    if (base.depth.kind === DepthKind.Bound) {
      expect(base.depth.expr).toMatchObject({
        kind: IrKind.CallNative,
        native: 'math.max',
      });
      expect(JSON.stringify(base.depth.expr)).toContain('1200');
    }

    const invalid = mustBuild(
      'base = close * 1\nplot(base[2] + base[9007199254740992])',
    );
    const invalidBase = namesOf(invalid).find(name => name.name === 'base')!;
    expect(invalidBase.depth).toEqual({kind: DepthKind.Const, bars: 2});
  });

  test('a dynamic demand contributes its cap without erasing larger exact demands', () => {
    const program = mustBuild(
      [
        'length = input.int(1000)',
        'base = close * 1',
        'other = close * 1',
        'plot(base[length] + base[bar_index % 2])',
        'plot(other[1200] + other[bar_index % 2])',
      ].join('\n'),
    );
    const base = namesOf(program).find(name => name.name === 'base')!;
    expect(base.depth.kind).toBe(DepthKind.Bound);
    if (base.depth.kind === DepthKind.Bound) {
      expect(base.depth.expr).toMatchObject({
        kind: IrKind.CallNative,
        native: 'math.max',
      });
      expect(JSON.stringify(base.depth.expr)).toContain(
        String(DEFAULT_MAX_BARS_BACK),
      );
    }
    const other = namesOf(program).find(name => name.name === 'other')!;
    expect(other.depth).toMatchObject({
      kind: DepthKind.Capped,
      bars: {kind: IrKind.Const, value: 1200},
    });
  });

  test('the engine default cap applies without a declaration cap', () => {
    const program = mustBuild('c = close[bar_index % 5]\nplot(c)');
    const close = seriesInputsOf(program).find(s => s.id === 'close')!;
    expect(close.depth).toMatchObject({
      kind: DepthKind.Capped,
      bars: {value: DEFAULT_MAX_BARS_BACK},
    });
  });

  test('shared params retain the largest root and child demand', () => {
    const program = mustBuild(
      [
        'length = input.int(1)',
        'deep = request.security("A", "D", length[100])',
        'shallow = request.security("B", "D", length[20])',
        'root = length[2]',
        'plot(deep + shallow + root)',
      ].join('\n'),
    );
    expect(program.params[0].depth).toEqual({
      kind: DepthKind.Const,
      bars: 100,
    });
  });
});

describe('function stencils', () => {
  test('one func per signature; each call site mints its own slot', () => {
    const program = mustBuild(
      'fast = ta.ema(close, 9)\nslow = ta.ema(close, 21)\nplot(fast - slow)',
    );
    const funcs = funcsOf(program);
    expect(funcs.map(f => f.name)).toEqual(['ta.ema']);
    // Two ema call sites in the program frame → slots 0 and 1.
    expect(slotCountOf(program)).toBe(2);
  });

  test('different signatures stencil separately', () => {
    const program = mustBuild(
      'a = ta.sma(close, 10)\nb = ta.sma(close, input.int(10))\nplot(a + b)',
    );
    // (series float, const int) and (series float, input int).
    expect(funcsOf(program).map(f => f.name)).toEqual(['ta.sma', 'ta.sma']);
  });

  test('var locals and param history are frame state', () => {
    const program = mustBuild(
      'x = ta.ema(close, 9)\ny = ta.sma(close, 10)\nplot(x + y)',
    );
    const varLocals = namesOf(program).filter(n => n.storage === Storage.Var);
    expect(varLocals.map(n => n.name)).toEqual(['e']);
    const sma = funcsOf(program).find(f => f.name === 'ta.sma')!;
    // The loop induction range is bind-normalized, so source[i] retains the
    // exact upper bound instead of falling back to max_bars_back.
    expect(sma.params[0].depth.kind).toBe(DepthKind.Bound);
  });

  test('does not substitute a loop endpoint through decreasing offset arithmetic', () => {
    const program = mustBuild(
      [
        'reverse_sum(float source, int length) =>',
        '    float total = 0.0',
        '    for i = 0 to length - 1',
        '        total += source[length - 1 - i]',
        '    total',
        'plot(reverse_sum(close, input.int(5)))',
      ].join('\n'),
    );
    const func = funcsOf(program).find(f => f.name === 'reverse_sum')!;
    expect(func.params[0].depth.kind).toBe(DepthKind.Capped);
  });

  test('does not use an induction bound after the loop index is reassigned', () => {
    const program = mustBuild(
      [
        'mutated_index(float source, int length) =>',
        '    float total = 0.0',
        '    for i = 0 to length - 1',
        '        i := length + 10',
        '        total += source[i]',
        '    total',
        'plot(mutated_index(close, input.int(5)))',
      ].join('\n'),
    );
    const func = funcsOf(program).find(f => f.name === 'mutated_index')!;
    expect(func.params[0].depth.kind).toBe(DepthKind.Capped);
  });

  test('prelude functions call each other through the prelude scope', () => {
    const program = mustBuild('r = ta.rsi(close, 14)\nplot(r)');
    const names = funcsOf(program)
      .map(f => f.name)
      .sort();
    expect(names).toEqual(['change', 'rma', 'ta.rsi']);
  });

  test('user function defaults fill omitted arguments at the call site', () => {
    const program = mustBuild(
      [
        'clamp(float value, float lo = 0.0, float hi = 100.0) =>',
        '\tmath.min(math.max(value, lo), hi)',
        'c = clamp(close)',
        'plot(c)',
      ].join('\n'),
    );
    const clamp = funcsOf(program)[0];
    expect(clamp.params.map(p => p.name)).toEqual(['value', 'lo', 'hi']);
    const write = program.body[0] as WriteNameStmt;
    expect(write.value.kind).toBe(IrKind.CallFunc);
    if (write.value.kind === IrKind.CallFunc) {
      expect(write.value.args.length).toBe(3);
      expect(write.value.args[1].kind).toBe(IrKind.Const);
    }
  });
});

describe('requests', () => {
  test('typed builtins use execution places and reproject in request children', () => {
    const program = mustBuild(
      [
        'root = time + time_close + bar_index',
        'ticker = syminfo.tickerid',
        'child = request.security(ticker, "D", time)',
        'plot(root + child)',
      ].join('\n'),
    );
    expect(seriesInputsOf(program)).toEqual([]);
    const rootInputs = executionInputsOf(program);
    const childInputs = executionInputsOf(program.requests[0].child);
    expect(rootInputs.map(input => input.source)).toEqual([
      {domain: 'time', field: 'time'},
      {domain: 'time', field: 'time_close'},
      {domain: 'bar', field: 'bar_index'},
      {domain: 'syminfo', field: 'tickerid'},
    ]);
    expect(childInputs.map(input => input.source)).toEqual([
      {domain: 'time', field: 'time'},
    ]);
    expect(childInputs[0]).not.toBe(rootInputs[0]);
  });

  test('a request compiles its expression into a child Program', () => {
    const program = mustBuild(
      'd = request.security("AAPL", "D", close)\nplot(d)',
    );
    expect(program.requests.length).toBe(1);
    const edge = program.requests[0];
    expect(edge.merge.mode).toBe(MergeMode.Sample);
    expect(edge.resultName.name).toBe('$result');
    expect(edge.child.body.length).toBe(1);
    expect(edge.child.body[0].kind).toBe(IrKind.WriteName);
    // Context isolation: the child owns its close; the parent never reads
    // close directly here.
    expect(seriesInputsOf(edge.child).map(s => s.id)).toEqual(['close']);
    expect(seriesInputsOf(program)).toEqual([]);
  });

  test('a request keeps source order for parent context arguments only', () => {
    const program = mustBuild(
      [
        'd = request.security(',
        '    timeframe = "D",',
        '    expression = close,',
        '    symbol = "AAPL")',
      ].join('\n'),
    );
    const edge = program.requests[0];
    // Canonical context slots are symbol=0 and timeframe=1. The captured
    // expression belongs to the child Program and never enters this schedule.
    expect(edge.contextArgumentEvaluationOrder).toEqual([1, 0]);
  });

  test('request options remain bind expressions with one explicit schedule', () => {
    const program = mustBuild(
      [
        'g = input.bool(true)',
        'bars = input.int(25)',
        'd = request.security(',
        '    "AAPL", "D", close,',
        '    calc_bars_count=bars, gaps=g)',
      ].join('\n'),
    );
    const edge = program.requests[0];
    expect(edge.optionArgumentEvaluationOrder).toEqual([3, 0, 1, 2]);
    expect(edge.merge.gaps).toMatchObject({
      kind: IrKind.HistRead,
      place: {kind: PlaceKind.Param},
    });
    expect(edge.merge.lookahead).toMatchObject({
      kind: IrKind.Const,
      value: false,
    });
    expect(edge.merge.ignoreInvalidSymbol).toMatchObject({
      kind: IrKind.Const,
      value: false,
    });
    expect(edge.merge.calcBarsCount).toMatchObject({
      kind: IrKind.HistRead,
      place: {kind: PlaceKind.Param},
    });
  });

  test('parent history on the request result annotates the edge depth', () => {
    const program = mustBuild(
      'd = request.security("AAPL", "D", close)\np = d[2]\nplot(p)',
    );
    expect(program.requests[0].depth).toEqual({kind: DepthKind.Const, bars: 2});
  });

  test('bind-time inputs cross into captures; prelude state nests', () => {
    const program = mustBuild(
      [
        'len = input.int(9)',
        'd = request.security("AAPL", "D", ta.ema(close, len))',
        'plot(d)',
      ].join('\n'),
    );
    expect(program.params.map(p => p.name)).toEqual(['len']);
    const child = program.requests[0].child;
    // The ema stencil lives in the child's call graph, not the parent's.
    expect(funcsOf(child).map(f => f.name)).toEqual(['ta.ema']);
    expect(funcsOf(program)).toEqual([]);
  });

  test('a shared semantic function reprojects context and input dependencies', () => {
    const program = mustBuild(
      [
        'length = input.int(1)',
        'read() => close[length]',
        'root = read()',
        'child = request.security("X", "D", read())',
        'plot(root + child)',
      ].join('\n'),
    );
    const root = funcsOf(program).find(func => func.name === 'read');
    const child = funcsOf(program.requests[0].child).find(
      func => func.name === 'read',
    );
    expect(root).toBeDefined();
    expect(child).toBeDefined();
    expect(root).not.toBe(child);
    expect(seriesInputsOf(program).map(series => series.id)).toContain('close');
    expect(
      seriesInputsOf(program.requests[0].child).map(series => series.id),
    ).toContain('close');
  });

  test('parent and request child own distinct function Names and depths', () => {
    const program = mustBuild(
      [
        'sample(float source, int length) =>',
        '\tbase = source * 1',
        '\tbase[length]',
        'child = request.security("AAPL", "D", sample(close, input.int(1000)))',
        'root = sample(close, input.int(2))',
        'plot(child + root)',
      ].join('\n'),
    );
    const parent = funcsOf(program).find(func => func.name === 'sample')!;
    const child = funcsOf(program.requests[0].child).find(
      func => func.name === 'sample',
    )!;
    expect(parent).not.toBe(child);
    expect(parent.locals[0]).not.toBe(child.locals[0]);
    expect(parent.locals[0].depth.kind).toBe(DepthKind.Bound);
    expect(child.locals[0].depth.kind).toBe(DepthKind.Bound);
    expect(parent.locals[0].depth).toMatchObject({
      kind: DepthKind.Bound,
      expr: {
        kind: IrKind.HistRead,
        place: {
          kind: PlaceKind.Param,
          param: {defaultValue: {kind: ParamDefaultKind.Const, value: 2}},
        },
      },
    });
    expect(child.locals[0].depth).toMatchObject({
      kind: DepthKind.Bound,
      expr: {
        kind: IrKind.HistRead,
        place: {
          kind: PlaceKind.Param,
          param: {defaultValue: {kind: ParamDefaultKind.Const, value: 1000}},
        },
      },
    });
  });

  test('request captures stay isolated across function specializations', () => {
    const program = mustBuild(
      [
        'fetch(value) => request.security("X", "D", value)',
        'price = fetch(close)',
        'index = fetch(bar_index)',
      ].join('\n'),
    );
    expect(program.requests.map(edge => edge.resultType.kind)).toEqual([
      TypeKind.Float,
      TypeKind.Int,
    ]);
    expect(
      program.requests.map(edge => {
        const result = edge.child.body[0];
        return result.kind === IrKind.WriteName ? result.value.type.kind : null;
      }),
    ).toEqual([TypeKind.Float, TypeKind.Int]);
  });

  test('request binding distinguishes root aliases from function locals', () => {
    const staticProgram = mustBuild(
      [
        'indicator("t", dynamic_requests=false)',
        'sym = input.string("X")',
        'alias = sym + ""',
        'fetch() => request.security(alias, "D", close)',
        'plot(fetch())',
      ].join('\n'),
    );
    expect(staticProgram.requests[0].dynamic).toBe(false);

    const local = buildText(
      [
        'indicator("t", dynamic_requests=false)',
        'fetch(string symbol) => request.security(symbol, "D", close)',
        'sym = input.string("X")',
        'plot(fetch(sym))',
      ].join('\n'),
    );
    expect(local.program).toBeNull();
    expect(local.errors.map(error => error.msg)).toContainEqual(
      expect.stringContaining(
        'series context arguments need dynamic_requests=true',
      ),
    );
  });

  test('request binding respects execution-input qualifiers inline and through aliases', () => {
    const program = mustBuild(
      [
        'rowSymbol = barstate.isfirst ? "X" : "Y"',
        'simpleSymbol = syminfo.type == "stock" ? "X" : "Y"',
        'inline = request.security(barstate.isfirst ? "X" : "Y", "D", close)',
        'aliased = request.security(rowSymbol, "D", close)',
        'static = request.security(simpleSymbol, timeframe.period, close)',
      ].join('\n'),
    );
    expect(program.requests.map(request => request.dynamic)).toEqual([
      true,
      true,
      false,
    ]);
  });

  test('script series variables cannot cross into captures', () => {
    const {program, errors} = buildText(
      'x = close * 2\nd = request.security("A", "D", x)\nplot(d)',
    );
    expect(program).toBeNull();
    expect(
      errors.some(e => e.msg.includes('cannot reference script variable')),
    ).toBe(true);
  });

  test('request children inherit the source language version', () => {
    const program = mustBuild(
      '//@version=6\nvalue = request.security("A", "D", close)',
    );
    expect(program.version).toBe(6);
    expect(program.requests[0].child.version).toBe(6);
  });
});

describe('program surface', () => {
  test('indicator() becomes a declaration output, not a body statement', () => {
    const program = mustBuild('indicator("T", overlay=true)\nplot(close)');
    expect(program.outputs[0].effect).toBe('indicator');
    expect(program.outputs[0].staticArgs).toEqual([
      {name: 'title', value: 'T'},
      {name: 'overlay', value: true},
    ]);
    expect(program.body.every(s => s.kind === IrKind.Emit)).toBe(true);
  });

  test('strategy() reuses declaration noding with only minimal metadata', () => {
    const program = mustBuild(
      'strategy("Strategy", shorttitle="Short", overlay=true)',
    );
    expect(program.outputs).toHaveLength(1);
    expect(program.outputs[0]).toMatchObject({
      effect: 'strategy',
      staticArgs: [
        {name: 'title', value: 'Strategy'},
        {name: 'shorttitle', value: 'Short'},
        {name: 'overlay', value: true},
      ],
    });
    expect(program.body).toEqual([]);
  });

  test('version comes from the declared //@version', () => {
    expect(mustBuild('//@version=1\nplot(close)').version).toBe(1);
    expect(mustBuild('plot(close)').version).toBe(1);
  });
});

describe('sparse effects', () => {
  test('one semantic call site owns one stable effect across call sites', () => {
    const program = mustBuild(
      [
        'emitValue(int value) =>',
        '    effect.emit(value)',
        '    value',
        'first = emitValue(1)',
        'second = emitValue(2)',
      ].join('\n'),
    );

    expect(program.effects).toHaveLength(1);
    expect(program.effects[0].payloadType.kind).toBe(TypeKind.Int);
    const emitters = funcsOf(program).filter(func => func.name === 'emitValue');
    expect(emitters).toHaveLength(1);
    expect(emitters[0].body.kind).toBe(IrKind.BlockExpr);
    if (emitters[0].body.kind === IrKind.BlockExpr) {
      const emission = emitters[0].body.stmts[0];
      expect(emission.kind).toBe(IrKind.EmitEffect);
      if (emission.kind === IrKind.EmitEffect) {
        expect(emission.effect).toBe(program.effects[0]);
      }
    }
  });

  test('an imported UDT method emits its nominal payload through ordinary noding', () => {
    const program = mustBuildWithLibraries(
      [
        'import events',
        'event = events.Event.new("entry", 3)',
        'value = event.publish()',
      ].join('\n'),
      {
        events: [
          'library("events")',
          'export type Event',
          '    string commandId',
          '    int barIndex',
          '    int publish() const =>',
          '        effect.emit(Event.new(this.commandId, this.barIndex))',
          '        this.barIndex',
        ].join('\n'),
      },
    );

    expect(program.effects).toHaveLength(1);
    expect(program.effects[0].payloadType.kind).toBe(TypeKind.UserType);
    if (program.effects[0].payloadType.kind === TypeKind.UserType) {
      expect(program.effects[0].payloadType.name).toBe('Event');
    }
    expect(program.effects[0].payloadSchema).toEqual({
      kind: 'user-type',
      typeId: 'events.Event',
      displayName: 'Event',
      fields: [
        {name: 'commandId', value: {kind: 'string'}},
        {name: 'barIndex', value: {kind: 'int'}},
      ],
    });
    const publish = funcsOf(program).find(
      func => func.name === 'Event.publish',
    );
    expect(publish?.callMode).toBe('const-method');
    expect(publish?.body.kind).toBe(IrKind.BlockExpr);
    if (publish?.body.kind === IrKind.BlockExpr) {
      expect(publish.body.stmts[0].kind).toBe(IrKind.EmitEffect);
    }
  });

  test('generic effect schemas recursively use canonical type argument identities', () => {
    const program = mustBuild(
      [
        'interface Identified',
        '    int id() const',
        'type Order',
        '    int value',
        '    int id() const => this.value',
        'type Envelope<T: Identified>',
        '    T value',
        'event = Envelope.new(Order.new(7))',
        'effect.emit(event)',
      ].join('\n'),
    );

    expect(program.effects[0].payloadSchema).toEqual({
      kind: 'user-type',
      typeId: '@entry.Envelope<@entry.Order>',
      displayName: 'Envelope<Order>',
      fields: [
        {
          name: 'value',
          value: {
            kind: 'user-type',
            typeId: '@entry.Order',
            displayName: 'Order',
            fields: [{name: 'value', value: {kind: 'int'}}],
          },
        },
      ],
    });
  });

  test('entry nominal ids do not depend on caller file-path spelling', () => {
    const source = [
      'type Event',
      '    int id',
      'effect.emit(Event.new(1))',
    ].join('\n');
    const ids = ['strategy.tea', './strategy.tea', '/tmp/strategy.tea'].map(
      filename => {
        const result = buildText(source, filename);
        expect(result.errors).toEqual([]);
        return result.program?.effects[0]?.payloadSchema;
      },
    );

    expect(ids).toEqual([
      {
        kind: 'user-type',
        typeId: '@entry.Event',
        displayName: 'Event',
        fields: [{name: 'id', value: {kind: 'int'}}],
      },
      {
        kind: 'user-type',
        typeId: '@entry.Event',
        displayName: 'Event',
        fields: [{name: 'id', value: {kind: 'int'}}],
      },
      {
        kind: 'user-type',
        typeId: '@entry.Event',
        displayName: 'Event',
        fields: [{name: 'id', value: {kind: 'int'}}],
      },
    ]);
  });
});
