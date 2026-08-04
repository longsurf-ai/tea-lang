// Purpose: Noder unit tests — desugarings (compound assign, tuple patterns, history-on-expression), param/output extraction with reference binding, and depth resolution observed on the built Program.

import {describe, expect, test} from 'bun:test';
import {
  DepthKind,
  IrKind,
  IrOp,
  PlaceKind,
  Storage,
  type HistReadExpr,
  type WriteNameStmt,
} from '../ir/node';
import {MergeMode, ParamDefaultKind} from '../ir/program';
import {funcsOf, namesOf, seriesInputsOf, slotCountOf} from '../ir/visit';
import {buildText, mustBuild} from './testing';
import {DEFAULT_MAX_BARS_BACK} from './depth';

describe('declarations', () => {
  test('plain decls write per bar; var decls initialize once', () => {
    const program = mustBuild('x = close + 1\nvar acc = 0.0\nacc := acc + x');
    // The var declaration emits no body statement; only x's write and the
    // reassignment run per bar.
    expect(program.body.length).toBe(2);
    const write = program.body[0] as WriteNameStmt;
    expect(write.kind).toBe(IrKind.WriteName);
    expect(write.name.name).toBe('x');
    const acc = namesOf(program).find(n => n.name === 'acc');
    expect(acc).toBeDefined();
    expect(acc!.storage).toBe(Storage.Var);
    expect(acc!.init).not.toBeNull();
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

  test('the engine default cap applies without a declaration cap', () => {
    const program = mustBuild('c = close[bar_index % 5]\nplot(c)');
    const close = seriesInputsOf(program).find(s => s.id === 'close')!;
    expect(close.depth).toMatchObject({
      kind: DepthKind.Capped,
      bars: {value: DEFAULT_MAX_BARS_BACK},
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
    // sma reads source[i] with a loop-index offset → capped depth on the
    // param Name.
    expect(sma.params[0].depth.kind).toBe(DepthKind.Capped);
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

  test('script series variables cannot cross into captures', () => {
    const {program, errors} = buildText(
      'x = close * 2\nd = request.security("A", "D", x)\nplot(d)',
    );
    expect(program).toBeNull();
    expect(
      errors.some(e => e.msg.includes('cannot reference script variable')),
    ).toBe(true);
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

  test('version comes from the declared //@version', () => {
    expect(mustBuild('//@version=1\nplot(close)').version).toBe(1);
    expect(mustBuild('plot(close)').version).toBe(1);
  });
});
