// Purpose: Parser unit tests for expressions and simple statements — exact AST dumps for small sources, precedence shapes, and recovery behavior.

import {describe, expect, test} from 'bun:test';
import {dumpFile} from './dumper';
import {parseText} from './testing';

function dump(src: string): string {
  const {file, errors} = parseText(src);
  expect(errors).toEqual([]);
  return dumpFile(file);
}

describe('simple statements', () => {
  test('untyped declaration', () => {
    expect(dump('x = 1\n')).toBe(
      [
        'File @1:1 eof=@2:1',
        '  stmtList[0]: DeclStmt @1:1 mode="none"',
        '    target: Name @1:1 value="x"',
        '    init: BasicLit @1:5 litKind="int" value="1" bad=false',
      ].join('\n'),
    );
  });

  test('typed var declaration', () => {
    expect(dump('var float b = 1.4\n')).toBe(
      [
        'File @1:1 eof=@2:1',
        '  stmtList[0]: DeclStmt @1:1 mode="var"',
        '    declType: TypeAnnotation @1:5',
        '      name: Name @1:5 value="float"',
        '    target: Name @1:11 value="b"',
        '    init: BasicLit @1:15 litKind="float" value="1.4" bad=false',
      ].join('\n'),
    );
  });

  test('reassignment and compound assignment', () => {
    const out = dump('y := 1\ny += 2\n');
    expect(out).toContain('AssignStmt @1:1 op=":="');
    expect(out).toContain('AssignStmt @2:1 op="+="');
  });

  test('tuple declaration', () => {
    const out = dump('[a, b] = f()\n');
    expect(out).toContain('target: TuplePattern @1:1');
    expect(out).toContain('elems[0]: Name @1:2 value="a"');
    expect(out).toContain('elems[1]: Name @1:5 value="b"');
  });

  test('expression statement', () => {
    const out = dump('plot(close)\n');
    expect(out).toContain('stmtList[0]: ExprStmt @1:1');
    expect(out).toContain('fun: Name @1:1 value="plot"');
  });

  test('inout and method are ordinary names', () => {
    const ordinary = dump('identity(inout) => inout\n');
    expect(ordinary).toContain('stmtList[0]: FuncDecl @1:1 exported=false');
    expect(ordinary).toContain('name: Name @1:10 value="inout"');

    expect(dump('method = 1\n')).toContain('target: Name @1:1 value="method"');
  });

  test('struct is contextual while this stays reserved', () => {
    const functions = dump('struct(x) => x\nexport struct(y) => y\n');
    expect(functions).toContain('stmtList[0]: FuncDecl @1:1 exported=false');
    expect(functions).toContain('name: Name @1:1 value="struct"');
    expect(functions).toContain('stmtList[1]: FuncDecl @2:1 exported=true');
    expect(functions).toContain('name: Name @2:8 value="struct"');

    const userType = dump(
      ['struct Holder', '    int struct', '    int value', ''].join('\n'),
    );
    expect(userType).toContain(
      'UserTypeDecl @1:1 exported=false writtenKeyword="struct"',
    );
    expect(userType).toContain('name: Name @2:9 value="struct"');

    const reserved = parseText('this(x) => x\n');
    expect(reserved.errors.length).toBeGreaterThan(0);
    expect(dumpFile(reserved.file)).not.toContain('FuncDecl');
  });
});

describe('user types and methods', () => {
  test('struct members retain field and method source order', () => {
    const out = dump(
      [
        'struct Counter',
        '    int value',
        '    int add(int qty) =>',
        '        this.value += qty',
        '        this.value',
        '    string label = "counter"',
        '    int size() const => this.value',
        '',
      ].join('\n'),
    );
    expect(out).toContain(
      'UserTypeDecl @1:1 exported=false writtenKeyword="struct"',
    );
    expect(out).toContain('members[0]: FieldDecl @2:5');
    expect(out).toContain('members[1]: MethodDecl @3:5 receiverMode="mutable"');
    expect(out).toContain('result: TypeAnnotation @3:5');
    expect(out).toContain('params[0]: Param @3:13');
    expect(out).toContain('members[2]: FieldDecl @6:5');
    expect(out).toContain('members[3]: MethodDecl @7:5 receiverMode="const"');
    expect(out).toContain('x: ThisExpr @4:9');
    expect(out).toContain('x: ThisExpr @7:25');
  });

  test('block-form type has the same member AST shape', () => {
    const out = dump(
      ['type Point', '    float x', '    float getX() => this.x', ''].join(
        '\n',
      ),
    );
    expect(out).toContain(
      'UserTypeDecl @1:1 exported=false writtenKeyword="type"',
    );
    expect(out).toContain('members[0]: FieldDecl @2:5');
    expect(out).toContain('members[1]: MethodDecl @3:5 receiverMode="mutable"');
  });

  test('type alias is a distinct reserved declaration', () => {
    const out = dump('type Prices = array<float>\n');
    expect(out).toContain('stmtList[0]: TypeAliasDecl @1:1 exported=false');
    expect(out).toContain('aliasedType: GenericType @1:15');

    const invalid = parseText('struct Prices = array<float>\n');
    expect(invalid.errors.length).toBeGreaterThan(0);
    expect(dumpFile(invalid.file)).not.toContain('TypeAliasDecl');
  });

  test('method parameters must carry explicit type annotations', () => {
    const {file, errors} = parseText(
      ['struct Counter', '    int add(qty) => qty', ''].join('\n'),
    );
    expect(errors.map(error => error.msg)).toContain(
      'method parameters require explicit types',
    );
    expect(dumpFile(file)).toContain('paramType: TypeAnnotation @2:13');
  });
});

describe('expressions', () => {
  test('precedence: * binds tighter than +', () => {
    expect(dump('r = a + b * c\n')).toBe(
      [
        'File @1:1 eof=@2:1',
        '  stmtList[0]: DeclStmt @1:1 mode="none"',
        '    target: Name @1:1 value="r"',
        '    init: BinaryExpr @1:5 op="+"',
        '      x: Name @1:5 value="a"',
        '      y: BinaryExpr @1:9 op="*"',
        '        x: Name @1:9 value="b"',
        '        y: Name @1:13 value="c"',
      ].join('\n'),
    );
  });

  test('and/or/not precedence', () => {
    const out = dump('r = not a and b or c\n');
    const lines = out.split('\n');
    expect(lines[3]).toContain('BinaryExpr @1:5 op="or"');
    expect(out).toContain('op="and"');
    expect(out).toContain('UnaryExpr @1:5 op="not"');
  });

  test('nested ternary is right-nested', () => {
    const out = dump('h = a >= 0 ? b > 1 ? 1 : 2 : 3\n');
    const cond = out.indexOf('CondExpr @1:5');
    const inner = out.indexOf('CondExpr @1:14');
    expect(cond).toBeGreaterThan(-1);
    expect(inner).toBeGreaterThan(cond);
  });

  test('history binds tighter than unary minus', () => {
    const out = dump('d = -close[1]\n');
    expect(out).toContain('UnaryExpr @1:5 op="-"');
    expect(out).toContain('x: HistoryExpr @1:6');
  });

  test('history on a call result', () => {
    const out = dump('m = math.max(a, b)[2]\n');
    expect(out).toContain('HistoryExpr @1:5');
    expect(out).toContain('CallExpr @1:5');
    expect(out).toContain('sel: Name @1:10 value="max"');
  });

  test('named arguments', () => {
    const out = dump('plot(d, title = "D", color = col)\n');
    expect(out).toContain('args[1]: Arg @1:9');
    expect(out).toContain('name: Name @1:9 value="title"');
    expect(out).toContain('args[2]: Arg @1:22');
  });

  test('generic call vs comparison', () => {
    const call = dump('xs = array.new<float>(0)\n');
    expect(call).toContain('CallExpr @1:6');
    expect(call).toContain('typeArgs[0]: Name @1:16 value="float"');
    const cmp = dump('q = a < b\n');
    expect(cmp).toContain('BinaryExpr @1:5 op="<"');
    expect(cmp).not.toContain('CallExpr');
  });

  test('float[] shorthand annotation', () => {
    const out = dump('float[] fs = f()\n');
    expect(out).toContain('declType: TypeAnnotation @1:1');
    expect(out).toContain('name: ArrayType @1:1');
    expect(out).toContain('elem: Name @1:1 value="float"');
  });

  test('tuple expression in value position', () => {
    const out = dump('t = [x, y]\n');
    expect(out).toContain('init: TupleExpr @1:5');
  });
});

describe('recovery', () => {
  test('missing expression', () => {
    const {errors} = parseText('x = \ny = 2\n');
    expect(errors.map(e => e.msg)).toEqual([
      "expected expression, found 'newline'",
    ]);
  });

  test('invalid declaration target', () => {
    const {errors} = parseText('2 = 3\n');
    expect(errors.map(e => e.msg)).toEqual([
      'cannot declare this expression as a variable',
    ]);
  });

  test('parsing continues after a broken statement', () => {
    const {file, errors} = parseText('x = )\ny = 2\n');
    expect(errors.length).toBeGreaterThan(0);
    expect(file.stmtList.length).toBe(2);
    expect(dumpFile(file)).toContain('value="y"');
  });

  test('unterminated call recovers at line end', () => {
    const {file, errors} = parseText('f(a,\ny = 2\n');
    expect(errors.length).toBeGreaterThan(0);
    expect(file.stmtList.length).toBeGreaterThan(0);
  });
});

describe('file metadata', () => {
  test('version pragma lands on File', () => {
    const out = dump('//@version=1\nx = 1\n');
    expect(out.split('\n')[0]).toContain('version="1"');
  });
});
