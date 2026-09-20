// Purpose: Noder unit tests — desugarings (compound assign, tuple patterns, history-on-expression), param/output extraction with reference binding, and depth resolution observed on the built Program.

import {describe, expect, test} from 'vitest';
import {newFileBase} from '../base/pos';
import {Errors, fatal} from '../base/print';
import {checkPackage} from '../checker/check';
import {
  DepthKind,
  IrKind,
  IrOp,
  PlaceKind,
  Storage,
  type AssignStmt,
  type ReadExpr,
  type Place,
} from '../ir/node';
import {MergeMode, ParamConstraintKind, ParamDefaultKind} from '../ir/program';
import {TypeKind, isNaValue} from '../ir/type';
import {
  builtinInputsOf,
  funcsOf,
  namesOf,
  seriesInputsOf,
  slotCountOf,
  walkIrStmt,
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

type NameAssign = AssignStmt & {
  target: ReadExpr & {place: Extract<Place, {kind: typeof PlaceKind.Name}>};
};

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
      IrKind.Assign,
      IrKind.InitName,
      IrKind.Assign,
    ]);
    const write = program.body[0] as NameAssign;
    expect(write.kind).toBe(IrKind.Assign);
    expect(write.target.place.name.name).toBe('x');
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
    const write = program.body[0] as NameAssign;
    const mul = write.value;
    expect(mul.kind).toBe(IrKind.Binary);
    if (mul.kind === IrKind.Binary) {
      expect(mul.y.kind).toBe(IrKind.Const);
    }
  });

  test('compound assignment desugars to the binary op', () => {
    const program = mustBuild('a = 0.0\na += close');
    const write = program.body[1] as NameAssign;
    expect(write.kind).toBe(IrKind.Assign);
    expect(write.op).toBe(IrOp.Add);
    expect(write.target.kind).toBe(IrKind.Read);
    expect(write.value.kind).toBe(IrKind.Read);
  });

  test('tuple declarations desugar through a temp and TupleGet', () => {
    const program = mustBuild('[a, b] = [close, open]\ns = a + b');
    const kinds = program.body.map(s => s.kind);
    expect(kinds).toEqual([
      IrKind.Assign, // $tuple temp
      IrKind.Assign, // a
      IrKind.Assign, // b
      IrKind.Assign, // s
    ]);
    const second = program.body[1] as NameAssign;
    expect(second.value.kind).toBe(IrKind.TupleGet);
  });

  test('statement expressions are direct nodes and block results stay separate', () => {
    const program = mustBuild(`
struct Point
    int x
inspect(Point point) =>
    point.x
    point.x + 1
point = Point.new(1)
inspect(point)
point.x
if close > 0
    inspect(point)
for i = 0 to 1
    inspect(point)
`);
    expect(program.body.map(stmt => stmt.kind)).toEqual([
      IrKind.Assign,
      IrKind.CallFunc,
      IrKind.Selector,
      IrKind.IfExpr,
      IrKind.ForExpr,
    ]);
    expect(funcsOf(program)[0].body).toMatchObject({
      kind: IrKind.BlockExpr,
      stmts: [{kind: IrKind.Selector}],
      value: {kind: IrKind.Binary},
    });
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
      (stmt): stmt is NameAssign =>
        stmt.kind === IrKind.Assign && stmt.target.kind === IrKind.Read,
    );
    const xValues = writes
      .filter(write => write.target.place.name.name === 'x')
      .map(write => write.value);
    expect(xValues).toHaveLength(2);
    for (const value of xValues) {
      expect(value.type.kind).toBe(TypeKind.Float);
      expect(value.kind).toBe(IrKind.Const);
      if (value.kind === IrKind.Const) {
        expect(isNaValue(value.value)).toBe(true);
      }
    }

    const y = writes.find(write => write.target.place.name.name === 'y')!.value;
    expect(y.kind).toBe(IrKind.IfExpr);
    if (y.kind === IrKind.IfExpr) {
      expect(y.then.type.kind).toBe(TypeKind.Float);
    }
    for (const name of ['z', 'isMissing', 'asText']) {
      const call = writes.find(
        write => write.target.place.name.name === name,
      )!.value;
      expect(call.kind).toBe(IrKind.CallNative);
      if (call.kind === IrKind.CallNative) {
        expect(call.args[0].type.kind).toBe(TypeKind.Float);
      }
    }
  });
});

// A control structure in statement position has its value discarded, so an na
// its blocks end in has no consumer to take a type from. These are valid Tea
// and common mid-typing states; each must node without an InternalError.
describe('na results nobody consumes', () => {
  const ARRAY = 'a = array.new<float>(3, 0.0)\n';
  const COUNTER = 'var int n = 0\n';
  const shapes: Readonly<Record<string, string>> = {
    'if ending in a typed na declaration': 'if close > 1\n    float y = na\n',
    'if ending in a bare na': 'if close > 1\n    na\n',
    'if ending in an na assignment':
      'var float v = 0.0\nif close > 1\n    v := na\n',
    'if/else with na in both arms': 'if close > 1\n    na\nelse\n    na\n',
    'if/else with typed na declarations in both arms':
      'if close > 1\n    float y = na\nelse\n    float z = na\n',
    'if/else with na in one arm': 'if close > 1\n    na\nelse\n    1.0\n',
    'if/else whose arms do not unify': 'if close > 1\n    na\nelse\n    true\n',
    'else-if chain of na':
      'if close > 1\n    na\nelse if close > 2\n    na\nelse\n    na\n',
    'else-if chain of na without a final else':
      'if close > 1\n    na\nelse if close > 2\n    float y = na\n',
    'for ending in a bare na': 'for i = 0 to 3\n    na\n',
    'for ending in a typed na declaration':
      'for i = 0 to 3\n    float y = na\n',
    'for-in ending in a bare na': `${ARRAY}for x in a\n    na\n`,
    'for-in ending in a typed na declaration': `${ARRAY}for x in a\n    float y = na\n`,
    'while ending in a bare na': `${COUNTER}while n < 3\n    n := n + 1\n    na\n`,
    'while ending in a typed na declaration': `${COUNTER}while n < 3\n    n := n + 1\n    float y = na\n`,
    'switch with na expression arms':
      'switch\n    close > 1 => na\n    => na\n',
    'switch on a subject with na expression arms':
      'int k = 1\nswitch k\n    1 => na\n    => na\n',
    'switch with na block arms':
      'switch\n    close > 1 =>\n        float y = na\n    =>\n        na\n',
    'ternary of na': 'close > 1 ? na : na\n',
    'nested if ending in na': 'if close > 1\n    if close > 2\n        na\n',
    'nested for ending in a typed na declaration':
      'if close > 1\n    for i = 0 to 2\n        float y = na\n',
    'nested switch ending in na':
      'for i = 0 to 2\n    switch\n        close > 1 => na\n',
    'nested ternary of na': 'if close > 1\n    close > 2 ? na : na\n',
    'nested na structure before another statement':
      'if close > 1\n    if close > 2\n        na\n    x = 1\n',
    'if inside a function body':
      'f() =>\n    if close > 1\n        na\n    1\ny = f()\n',
    'typed na declaration inside a function body':
      'f() =>\n    if close > 1\n        float q = na\n    1\ny = f()\n',
    'loop and switch inside a function body':
      'f() =>\n    for i = 0 to 2\n        na\n    switch\n        close > 1 => na\n    1\ny = f()\n',
    'nested structures inside a function body':
      'f() =>\n    if close > 1\n        while close > 2\n            float q = na\n    1\ny = f()\n',
  };

  test.each(Object.entries(shapes))('%s', (_shape, source) => {
    const program = mustBuild(source);
    const bodies = [
      ...program.body,
      ...funcsOf(program).map(func => func.body),
    ];
    for (const stmt of bodies) {
      walkIrStmt(stmt, {
        expr: expr => {
          // TypeKind.Na stays checker-only, and a discarded na leaves no
          // typeless constant behind.
          expect(expr.type.kind).not.toBe(TypeKind.Na);
          if (expr.kind === IrKind.Const && isNaValue(expr.value)) {
            expect(expr.type.kind).not.toBe(TypeKind.Void);
          }
        },
      });
    }
  });

  test('the discarded structure has no value and drops its dead na', () => {
    const program = mustBuild('if close > 1\n    na\n');
    expect(program.body).toMatchObject([
      {
        kind: IrKind.IfExpr,
        type: {kind: TypeKind.Void},
        then: {kind: IrKind.BlockExpr, stmts: [], value: null},
        else: null,
      },
    ]);
  });

  test('a typed na declaration keeps its write and its declared type', () => {
    const program = mustBuild('if close > 1\n    float y = na\n');
    expect(program.body).toMatchObject([
      {
        kind: IrKind.IfExpr,
        type: {kind: TypeKind.Void},
        then: {
          stmts: [{kind: IrKind.Assign, value: {type: {kind: TypeKind.Float}}}],
          value: {kind: IrKind.Const, type: {kind: TypeKind.Float}},
        },
      },
    ]);
  });

  test('a consumed na result still takes its type from the consumer', () => {
    const program = mustBuild('float x = if close > 1\n    na\n');
    const write = program.body[0] as NameAssign;
    expect(write.value).toMatchObject({
      kind: IrKind.IfExpr,
      type: {kind: TypeKind.Float},
      then: {value: {kind: IrKind.Const, type: {kind: TypeKind.Float}}},
    });
  });

  // The checker types a closing `Q q = na` as an untyped na, assignable to the
  // consumer's type, so the consumer's type — not Q — is what the block yields.
  test('a consumed na declaration takes the consumer type, not its own', () => {
    const structs = 'struct Q\n    int a\nstruct P\n    int x\n';
    const method = mustBuild(
      `${structs}    P make() =>\n        Q q = na\np = P.new(1)\nr = p.make()\n`,
    );
    expect(funcsOf(method)[0].body).toMatchObject({
      type: {kind: TypeKind.Struct, name: 'P'},
      value: {kind: IrKind.Const, type: {kind: TypeKind.Struct, name: 'P'}},
    });

    const join = mustBuild(
      `${structs}P r = if close > 1\n    Q q = na\nelse\n    P.new(1)\n`,
    );
    expect((join.body[0] as NameAssign).value).toMatchObject({
      kind: IrKind.IfExpr,
      then: {type: {kind: TypeKind.Struct, name: 'P'}},
    });
  });

  test('an unconsumable na result stays an ordinary positioned user error', () => {
    const {program, errors} = buildText('x = if close > 1\n    na\n');
    expect(program).toBeNull();
    expect(errors.map(error => `${error.pos.line}: ${error.msg}`)).toEqual([
      '1: na initializer requires a type annotation (e.g. float x = na)',
    ]);
  });
});

describe('structs', () => {
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
      (stmt): stmt is NameAssign =>
        stmt.kind === IrKind.Assign && stmt.target.kind === IrKind.Read,
    );
    expect(writes[0].value.kind).toBe(IrKind.NewStruct);
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
      kind: IrKind.NewStruct,
      args: [{kind: IrKind.Const, value: 1}],
    });
  });

  test('a field default nodes in a request child', () => {
    const program = mustBuild(
      [
        'type Point',
        '    int x = 1',
        'point = request.security("A", "D", Point.new().x)',
      ].join('\n'),
    );
    expect(program.requests[0].child.body[0]).toMatchObject({
      kind: IrKind.Assign,
      value: {
        kind: IrKind.Selector,
        fieldIndex: 0,
        x: {
          kind: IrKind.NewStruct,
          args: [{kind: IrKind.Const, value: 1}],
        },
      },
    });
  });

  test('field reads and stores project the captured object and canonical field', () => {
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
      kind: IrKind.Assign,
      target: {
        kind: IrKind.Selector,
        x: {kind: IrKind.Selector, fieldIndex: 0, x: {kind: IrKind.Read}},
        fieldIndex: 0,
      },
      value: {kind: IrKind.Const, value: 3},
    });
    expect(program.body[2]).toMatchObject({
      kind: IrKind.Assign,
      value: {
        kind: IrKind.Selector,
        fieldIndex: 0,
        x: {kind: IrKind.Selector, fieldIndex: 0},
      },
    });
  });

  test('collection mutators capture a writable location and keep their result', () => {
    const program = mustBuild(
      ['xs = array.from(1, 2)', 'xs.push(3)', 'last = xs.pop()'].join('\n'),
    );
    expect(program.body[1]).toMatchObject({
      kind: IrKind.CallNative,
      native: {name: 'array.push', effect: 'write'},
      receiver: {
        kind: IrKind.Read,
        place: {kind: PlaceKind.Name, name: {name: 'xs'}},
      },
      args: [{kind: IrKind.Const, value: 3}],
    });
    expect(program.body[2]).toMatchObject({
      kind: IrKind.Assign,
      target: {kind: IrKind.Read, place: {name: {name: 'last'}}},
      value: {
        kind: IrKind.CallNative,
        native: {name: 'array.pop', effect: 'write'},
        receiver: {
          kind: IrKind.Read,
          place: {kind: PlaceKind.Name, name: {name: 'xs'}},
        },
        args: [],
      },
    });
  });

  test('mutable methods project a shared hidden receiver and ordinary call result', () => {
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
        kind: IrKind.CallNative,
        native: {name: 'array.push', effect: 'write'},
        receiver: {
          kind: IrKind.Selector,
          x: {kind: IrKind.Read},
          fieldIndex: 0,
        },
      },
    });
    if (append?.callMode === 'mutable-method') {
      expect(append.params).not.toContain(append.receiver);
    }
    expect(program.body[1]).toMatchObject({
      kind: IrKind.CallFunc,
      func: append,
      receiver: {kind: IrKind.Read},
      args: [{kind: IrKind.Const, value: 2}],
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
      kind: IrKind.Assign,
      value: {
        kind: IrKind.CallFunc,
        func: inspect,
        receiver: {kind: IrKind.Read},
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
      kind: IrKind.Read,
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

  test('plain emit preserves raw scalar type and named column identity', () => {
    const program = mustBuild(
      'emit "value" close\nemit.append "events" 1\nemit.append "events" 2',
    );
    expect(
      program.outputs.map(output => [
        output.name,
        output.mode,
        output.valueType.kind,
      ]),
    ).toEqual([
      ['value', 'set', TypeKind.Float],
      ['events', 'append', TypeKind.Int],
    ]);
    const emits = program.body.filter(stmt => stmt.kind === IrKind.Emit);
    expect(emits).toHaveLength(3);
    expect(emits[1].output).toBe(emits[2].output);
  });

  test('plot and fill are ordinary functions producing visual values', () => {
    const program = mustBuild(
      'p = plot("high", high)\nq = plot("low", low)\nfill("area", p, q)',
    );
    expect(program.outputs.map(output => output.name)).toEqual([
      'high',
      'low',
      'area',
    ]);
    expect(
      program.outputs.every(
        output =>
          output.mode === 'set' && output.valueType.kind === TypeKind.Struct,
      ),
    ).toBe(true);
    expect(funcsOf(program).filter(func => func.name === 'plot')).toHaveLength(
      2,
    );
    expect(program.body.every(stmt => stmt.kind !== IrKind.Emit)).toBe(true);
  });

  test('constant and simple emitted values still have execution statements', () => {
    const program = mustBuild(
      'emit "literal" 1\nemit "context" timeframe.multiplier',
    );
    expect(program.outputs.map(output => output.valueType.kind)).toEqual([
      TypeKind.Int,
      TypeKind.Int,
    ]);
    expect(program.body.filter(stmt => stmt.kind === IrKind.Emit)).toHaveLength(
      2,
    );
  });
});

describe('history', () => {
  test('history uses a direct binding without synthesizing a hidden name', () => {
    const program = mustBuild(
      'source = high + low\nx = source[2]\nemit "output0" x',
    );
    const source = namesOf(program).find(name => name.name === 'source');
    expect(source?.depth).toEqual({kind: DepthKind.Const, bars: 2});
    expect(namesOf(program).some(name => name.name.startsWith('$hist@'))).toBe(
      false,
    );
  });

  test('history forces otherwise-foldable and typed-na variables into state', () => {
    const literal = mustBuild('source = 1\nx = source[1]\nemit "output0" x');
    expect(namesOf(literal).some(name => name.name === 'source')).toBe(true);
    expect(
      literal.body.some(
        stmt =>
          stmt.kind === IrKind.Assign &&
          stmt.target.kind === IrKind.Read &&
          stmt.target.place.name.name === 'source',
      ),
    ).toBe(true);

    const struct = mustBuild(
      ['struct Point', '    int x', 'Point point = na', 'x = point[0].x'].join(
        '\n',
      ),
    );
    expect(namesOf(struct).some(name => name.name === 'point')).toBe(true);
  });

  test('history on a computed expression is rejected at every nesting depth', () => {
    const top = buildText('x = (high + low)[1]');
    expect(top.program).toBeNull();
    expect(top.errors.some(e => e.msg.includes('history'))).toBe(true);

    const {program, errors} = buildText(
      'y = if close > 0\n\t(high + low)[1]\nelse\n\t0.0',
    );
    expect(program).toBeNull();
    expect(errors.some(e => e.msg.includes('history'))).toBe(true);
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
        'emit "output0" prev',
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
        '',
        'lookback = input.int(20)',
        'a = high[3]',
        'b = low[lookback]',
        'c = open[bar_index % 5]',
        'emit "output0" a + b + c',
      ].join('\n'),
    );
    const byId = new Map(seriesInputsOf(program).map(s => [s.id, s]));
    expect(byId.get('high')!.depth).toEqual({kind: DepthKind.Const, bars: 3});
    const low = byId.get('low')!.depth;
    expect(low.kind).toBe(DepthKind.Bound);
    const open = byId.get('open')!.depth;
    expect(open.kind).toBe(DepthKind.Capped);
    if (open.kind === DepthKind.Capped) {
      expect(open.bars).toMatchObject({kind: IrKind.Const, value: 500});
    }
  });

  test('an immutable root input alias remains an exact bound depth', () => {
    const program = mustBuild(
      [
        'identity(int value) => value',
        'len = input.int(1000)',
        'alias = identity(len) + 0',
        'base = close * 1',
        'emit "output0" base[alias]',
      ].join('\n'),
    );
    const base = namesOf(program).find(name => name.name === 'base');
    expect(base?.depth.kind).toBe(DepthKind.Bound);
  });

  test('a simple builtin remains an exact bound depth', () => {
    const program = mustBuild(
      ['length = timeframe.multiplier', 'emit "output0" close[length]'].join(
        '\n',
      ),
    );
    const close = seriesInputsOf(program).find(series => series.id === 'close');
    expect(close?.depth).toMatchObject({
      kind: DepthKind.Bound,
      expr: {
        kind: IrKind.Read,
        place: {kind: PlaceKind.Builtin},
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
        'emit "output0" value',
      ].join('\n'),
    );
    const base = namesOf(program).find(name => name.name === 'base')!;
    expect(base.depth.kind).toBe(DepthKind.Bound);
    if (base.depth.kind === DepthKind.Bound) {
      expect(base.depth.expr).toMatchObject({
        kind: IrKind.Binary,
        x: {kind: IrKind.Read, place: {kind: PlaceKind.Param}},
      });
    }
  });

  test('a direct root input UDF offset remains an exact bound depth', () => {
    const program = mustBuild(
      [
        'offset(int value) => value',
        'len = input.int(1000)',
        'emit "output0" close[offset(len)]',
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
        'emit "output0" sample(input.int(2)) + sample(input.int(1000))',
      ].join('\n'),
    );
    const close = seriesInputsOf(program).find(
      series => series.id === 'close',
    )!;
    expect(close.depth.kind).toBe(DepthKind.Bound);
    if (close.depth.kind === DepthKind.Bound) {
      expect(close.depth.expr).toMatchObject({
        kind: IrKind.CallNative,
        native: {name: 'math.max'},
        args: expect.arrayContaining([
          expect.objectContaining({
            kind: IrKind.CallNative,
            native: expect.objectContaining({name: '$historyDepth'}),
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
        'emit "output0" sample(input.int(1000))',
      ].join('\n'),
    );
    const base = namesOf(program).find(name => name.name === 'base')!;
    expect(base.depth.kind).toBe(DepthKind.Bound);
    if (base.depth.kind === DepthKind.Bound) {
      expect(base.depth.expr).toMatchObject({
        kind: IrKind.Read,
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
        kind: IrKind.Read,
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
        'emit "output0" base[short] + base[long] + base[1200]',
      ].join('\n'),
    );
    const base = namesOf(program).find(name => name.name === 'base')!;
    expect(base.depth.kind).toBe(DepthKind.Bound);
    if (base.depth.kind === DepthKind.Bound) {
      expect(base.depth.expr).toMatchObject({
        kind: IrKind.CallNative,
        native: {name: 'math.max'},
      });
      expect(JSON.stringify(base.depth.expr)).toContain('1200');
    }

    const invalid = mustBuild(
      'base = close * 1\nemit "output0" base[2] + base[9007199254740992]',
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
        'emit "output0" base[length] + base[bar_index % 2]',
        'emit "output1" other[1200] + other[bar_index % 2]',
      ].join('\n'),
    );
    const base = namesOf(program).find(name => name.name === 'base')!;
    expect(base.depth.kind).toBe(DepthKind.Bound);
    if (base.depth.kind === DepthKind.Bound) {
      expect(base.depth.expr).toMatchObject({
        kind: IrKind.CallNative,
        native: {name: 'math.max'},
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
    const program = mustBuild('c = close[bar_index % 5]\nemit "output0" c');
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
        'emit "output0" deep + shallow + root',
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
      'fast = ta.ema(close, 9)\nslow = ta.ema(close, 21)\nemit "output0" fast - slow',
    );
    const funcs = funcsOf(program);
    expect(funcs.map(f => f.name)).toEqual(['ta.ema', 'ta.ema']);
    // Two ema call sites in the program frame → slots 0 and 1.
    expect(slotCountOf(program)).toBe(2);
  });

  test('different signatures stencil separately', () => {
    const program = mustBuild(
      'a = ta.sma(close, 10)\nb = ta.sma(close, input.int(10))\nemit "output0" a + b',
    );
    // (series float, const int) and (series float, input int).
    expect(funcsOf(program).map(f => f.name)).toEqual(['ta.sma', 'ta.sma']);
  });

  test('var locals and param history are frame state', () => {
    const program = mustBuild(
      'x = ta.ema(close, 9)\ny = ta.sma(close, 10)\nemit "output0" x + y',
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
        'emit "output0" reverse_sum(close, input.int(5))',
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
        'emit "output0" mutated_index(close, input.int(5))',
      ].join('\n'),
    );
    const func = funcsOf(program).find(f => f.name === 'mutated_index')!;
    expect(func.params[0].depth.kind).toBe(DepthKind.Capped);
  });

  test('prelude functions call each other through the prelude scope', () => {
    const program = mustBuild('r = ta.rsi(close, 14)\nemit "output0" r');
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
        'emit "output0" c',
      ].join('\n'),
    );
    const clamp = funcsOf(program)[0];
    expect(clamp.params.map(p => p.name)).toEqual(['value', 'lo', 'hi']);
    const write = program.body[0] as NameAssign;
    expect(write.value.kind).toBe(IrKind.CallFunc);
    if (write.value.kind === IrKind.CallFunc) {
      expect(write.value.args.length).toBe(3);
      expect(write.value.args[1].kind).toBe(IrKind.Const);
    }
  });
});

describe('requests', () => {
  test('typed builtins use builtin places and reproject in request children', () => {
    const program = mustBuild(
      [
        'root = time + bar_index',
        'ticker = syminfo.tickerid',
        'child = request.security(ticker, "D", time)',
        'emit "output0" root + child',
      ].join('\n'),
    );
    expect(seriesInputsOf(program)).toEqual([]);
    const rootInputs = builtinInputsOf(program);
    const childInputs = builtinInputsOf(program.requests[0].child);
    expect(rootInputs.map(input => input.source)).toEqual([
      {domain: 'time', field: 'time'},
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
      'd = request.security("AAPL", "D", close)\nemit "output0" d',
    );
    expect(program.requests.length).toBe(1);
    const edge = program.requests[0];
    expect(edge.merge.mode).toBe(MergeMode.Sample);
    expect(edge.resultName.name).toBe('$result');
    expect(edge.child.body.length).toBe(1);
    expect(edge.child.body[0].kind).toBe(IrKind.Assign);
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
        'fill_policy = input.string("sparse")',
        'bars = input.int(25)',
        'd = request.security(',
        '    "AAPL", "D", close,',
        '    calc_bars_count=bars, fill=fill_policy)',
      ].join('\n'),
    );
    const edge = program.requests[0];
    expect(edge.optionArgumentEvaluationOrder).toEqual([2, 0, 1]);
    expect(edge.merge.fill).toMatchObject({
      kind: IrKind.Read,
      place: {kind: PlaceKind.Param},
    });
    expect(edge.merge.ignoreInvalidSymbol).toMatchObject({
      kind: IrKind.Const,
      value: false,
    });
    expect(edge.merge.calcBarsCount).toMatchObject({
      kind: IrKind.Read,
      place: {kind: PlaceKind.Param},
    });
  });

  test('parent history on the request result annotates the edge depth', () => {
    const program = mustBuild(
      'd = request.security("AAPL", "D", close)\np = d[2]\nemit "output0" p',
    );
    expect(program.requests[0].depth).toEqual({kind: DepthKind.Const, bars: 2});
  });

  test('bind-time inputs cross into captures; prelude state nests', () => {
    const program = mustBuild(
      [
        'len = input.int(9)',
        'd = request.security("AAPL", "D", ta.ema(close, len))',
        'emit "output0" d',
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
        'emit "output0" root + child',
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
        'emit "output0" child + root',
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
        kind: IrKind.Read,
        place: {
          kind: PlaceKind.Param,
          param: {defaultValue: {kind: ParamDefaultKind.Const, value: 2}},
        },
      },
    });
    expect(child.locals[0].depth).toMatchObject({
      kind: DepthKind.Bound,
      expr: {
        kind: IrKind.Read,
        place: {
          kind: PlaceKind.Param,
          param: {defaultValue: {kind: ParamDefaultKind.Const, value: 1000}},
        },
      },
    });
  });

  test('request edges retain distinct child and parent result types', () => {
    const program = mustBuild(
      [
        'price = request.security("X", "D", close)',
        'indices = request.security_lower_tf("X", "1", bar_index)',
      ].join('\n'),
    );
    expect(program.requests.map(edge => edge.resultType.kind)).toEqual([
      TypeKind.Float,
      TypeKind.Array,
    ]);
    expect(program.requests.map(edge => edge.captureType.kind)).toEqual([
      TypeKind.Float,
      TypeKind.Int,
    ]);
    expect(program.requests.map(edge => edge.name)).toEqual([
      'price',
      'indices',
    ]);
    expect(
      program.requests.map(edge => {
        const result = edge.child.body[0];
        return result.kind === IrKind.Assign ? result.value.type.kind : null;
      }),
    ).toEqual([TypeKind.Float, TypeKind.Int]);
  });

  test('request binding accepts root bind values and rejects function ownership', () => {
    const staticProgram = mustBuild(
      [
        'sym = input.string("X")',
        'alias = sym + ""',
        'value = request.security(alias, "D", close)',
      ].join('\n'),
    );
    expect(staticProgram.requests[0].dynamic).toBe(false);

    const local = buildText(
      [
        'fetch(string symbol) => request.security(symbol, "D", close)',
        'sym = input.string("X")',
        'emit "output0" fetch(sym)',
      ].join('\n'),
    );
    expect(local.program).toBeNull();
    expect(local.errors.map(error => error.msg)).toContainEqual(
      expect.stringContaining(
        'request call must directly initialize one plain top-level variable',
      ),
    );
  });

  test('request binding rejects series contexts but keeps simple builtins static', () => {
    const dynamic = buildText(
      [
        '',
        'rowSymbol = barstate.isfirst ? "X" : "Y"',
        'inline = request.security(barstate.isfirst ? "X" : "Y", "D", close)',
        'aliased = request.security(rowSymbol, "D", close)',
      ].join('\n'),
    );
    expect(dynamic.program).toBeNull();
    expect(
      dynamic.errors.filter(error =>
        error.msg.includes('dynamic requests are not supported yet'),
      ),
    ).toHaveLength(2);

    const staticProgram = mustBuild(
      [
        'simpleSymbol = syminfo.type == "stock" ? "X" : "Y"',
        'static = request.security(simpleSymbol, timeframe.period, close)',
      ].join('\n'),
    );
    expect(staticProgram.requests[0].dynamic).toBe(false);
  });

  test('nested request calls fail at the direct-declaration boundary', () => {
    const result = buildText(
      [
        'nested = request.security(',
        '    "OUTER", "D",',
        '    request.security(barstate.isfirst ? "X" : "Y", "W", close))',
      ].join('\n'),
    );
    expect(result.program).toBeNull();
    expect(result.errors.map(error => error.msg)).toContain(
      'request call must directly initialize one plain top-level variable',
    );
  });

  test('script series variables cannot cross into captures', () => {
    const {program, errors} = buildText(
      'x = close * 2\nd = request.security("A", "D", x)\nemit "output0" d',
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
  test('version comes from the declared //@version', () => {
    expect(mustBuild('//@version=1\nemit "output0" close').version).toBe(1);
    expect(mustBuild('emit "output0" close').version).toBe(1);
  });
});

describe('sparse effects', () => {
  test('one semantic call site owns one stable effect across call sites', () => {
    const program = mustBuild(
      [
        'emitValue(int value) =>',
        '    emit.append "effect0" value',
        '    value',
        'first = emitValue(1)',
        'second = emitValue(2)',
      ].join('\n'),
    );

    expect(program.outputs).toHaveLength(1);
    expect(program.outputs[0].valueType.kind).toBe(TypeKind.Int);
    const emitters = funcsOf(program).filter(func => func.name === 'emitValue');
    expect(emitters).toHaveLength(2);
    expect(emitters[0].body.kind).toBe(IrKind.BlockExpr);
    if (emitters[0].body.kind === IrKind.BlockExpr) {
      const emission = emitters[0].body.stmts[0];
      expect(emission.kind).toBe(IrKind.Emit);
      if (emission.kind === IrKind.Emit) {
        expect(emission.output).toBe(program.outputs[0]);
      }
    }
  });

  test('an imported struct method emits its nominal payload through ordinary noding', () => {
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
          '        emit.append "effect0" Event.new(this.commandId, this.barIndex)',
          '        this.barIndex',
        ].join('\n'),
      },
    );

    expect(program.outputs).toHaveLength(1);
    expect(program.outputs[0].valueType.kind).toBe(TypeKind.Struct);
    if (program.outputs[0].valueType.kind === TypeKind.Struct) {
      expect(program.outputs[0].valueType.name).toBe('Event');
    }
    expect(program.nominalIds.get(program.outputs[0].valueType)).toBe(
      'events.Event',
    );
    const publish = funcsOf(program).find(
      func => func.name === 'Event.publish',
    );
    expect(publish?.callMode).toBe('const-method');
    expect(publish?.body.kind).toBe(IrKind.BlockExpr);
    if (publish?.body.kind === IrKind.BlockExpr) {
      expect(publish.body.stmts[0].kind).toBe(IrKind.Emit);
    }
  });

  test('generic effect types retain canonical type argument identities', () => {
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
        'emit.append "effect0" event',
      ].join('\n'),
    );

    const payload = program.outputs[0].valueType;
    expect(program.nominalIds.get(payload)).toBe(
      '@entry.Envelope<@entry.Order>',
    );
    if (payload.kind === TypeKind.Struct) {
      expect(program.nominalIds.get(payload.fields[0].type)).toBe(
        '@entry.Order',
      );
    }
  });

  test('entry nominal ids do not depend on caller file-path spelling', () => {
    const source = [
      'type Event',
      '    int id',
      'emit.append "effect0" Event.new(1)',
    ].join('\n');
    const ids = ['strategy.tea', './strategy.tea', '/tmp/strategy.tea'].map(
      filename => {
        const result = buildText(source, filename);
        expect(result.errors).toEqual([]);
        const program = result.program;
        return program && program.nominalIds.get(program.outputs[0].valueType);
      },
    );

    expect(ids).toEqual(['@entry.Event', '@entry.Event', '@entry.Event']);
  });
});

describe('Arrow export boundaries', () => {
  test('rejects recursive exports while retaining recursive internal values', () => {
    const source = [
      'type Branch',
      '    array<Branch> children',
      'branch = Branch.new(array.new<Branch>())',
    ].join('\n');
    expect(buildText(source).errors).toEqual([]);
    for (const emission of [
      'emit.append "effect0" branch',
      'emit "tree" branch',
    ]) {
      expect(
        buildText(`${source}\n${emission}`).errors.map(error => error.msg),
      ).toEqual(['recursive value types cannot be exported as Arrow schemas']);
    }
  });
});
