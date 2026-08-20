// Purpose: Checker conformance tests for collection generics, canonical structs, reference-field stores, and receiver modes.

import {describe, expect, test} from 'vitest';
import {Qualifier, TypeKind, typesEqual} from '../ir/type';
import {NodeKind, type CallExpr, type DeclStmt} from '../syntax/nodes';
import {CallKind, SelectionKind, type NativeCall} from './info';
import {ObjectKind} from './object';
import {checkText, declaredName, type CheckResult} from './testing';

function declarationCall(result: CheckResult, name: string): CallExpr {
  const stmt = result.file.stmtList.find(
    (candidate): candidate is DeclStmt =>
      candidate.kind === NodeKind.DeclStmt &&
      candidate.target.kind === NodeKind.Name &&
      candidate.target.value === name,
  );
  if (stmt?.init.kind !== NodeKind.CallExpr) {
    throw new Error(`fixture declaration '${name}' has no direct call`);
  }
  return stmt.init;
}

function nativeCall(result: CheckResult, name: string): NativeCall {
  const call = [...result.info.calls.values()].find(
    candidate =>
      candidate.kind === CallKind.Native && candidate.native.name === name,
  );
  if (call?.kind !== CallKind.Native) {
    throw new Error(`fixture has no native call '${name}'`);
  }
  return call;
}

describe('canonical structs', () => {
  test('predeclaration resolves forward fields into one owned semantic graph', () => {
    const result = checkText(
      [
        'type Wrapper',
        '    Point point',
        'type Point',
        '    float x = 1.0',
        'value = Wrapper.new(Point.new())',
        'read = value.point.x',
      ].join('\n'),
    );
    expect(result.errors).toEqual([]);

    const wrapperDecl = result.file.stmtList[0];
    const pointDecl = result.file.stmtList[1];
    if (
      wrapperDecl.kind !== NodeKind.StructDecl ||
      pointDecl.kind !== NodeKind.StructDecl
    ) {
      throw new Error('fixture lost its type declarations');
    }
    const wrapperField = wrapperDecl.members[0];
    if (wrapperField?.kind !== NodeKind.FieldDecl) {
      throw new Error('fixture lost its wrapper field');
    }
    const wrapper = result.checked.pkg.scope.lookup('Wrapper');
    const point = result.checked.pkg.scope.lookup('Point');
    expect(wrapper?.kind).toBe(ObjectKind.Struct);
    expect(point?.kind).toBe(ObjectKind.Struct);
    if (
      wrapper?.kind !== ObjectKind.Struct ||
      point?.kind !== ObjectKind.Struct
    ) {
      throw new Error('fixture types did not resolve');
    }

    expect(result.info.defs.get(wrapperDecl.name)).toBe(wrapper);
    expect(result.info.defs.get(pointDecl.name)).toBe(point);
    expect(wrapper.fields[0]).toMatchObject({
      owner: wrapper,
      index: 0,
      name: 'point',
      type: point.type,
    });
    expect(point.fields[0]).toMatchObject({
      owner: point,
      index: 0,
      name: 'x',
    });
    expect(wrapper.type.fields[0]).toEqual({
      name: wrapper.fields[0].name,
      type: wrapper.fields[0].type,
    });
    expect(point.type.fields[0]).toEqual({
      name: point.fields[0].name,
      type: point.fields[0].type,
    });

    const fieldType = wrapperField.fieldType.name;
    expect(fieldType.kind).toBe(NodeKind.Name);
    if (fieldType.kind === NodeKind.Name) {
      expect(result.info.uses.get(fieldType)).toBe(point);
    }

    const constructor = result.info.calls.get(declarationCall(result, 'value'));
    expect(constructor?.kind).toBe(CallKind.Constructor);
    if (constructor?.kind === CallKind.Constructor) {
      expect(constructor.type).toBe(wrapper);
      expect(constructor.args[0].field).toBe(wrapper.fields[0]);
    }

    const read = result.file.stmtList[3];
    if (
      read.kind !== NodeKind.DeclStmt ||
      read.init.kind !== NodeKind.SelectorExpr ||
      read.init.x.kind !== NodeKind.SelectorExpr
    ) {
      throw new Error('fixture lost its nested field read');
    }
    const pointSelection = result.info.selections.get(read.init.x);
    const xSelection = result.info.selections.get(read.init);
    expect(pointSelection).toEqual({
      kind: SelectionKind.Field,
      field: wrapper.fields[0],
    });
    expect(xSelection).toEqual({
      kind: SelectionKind.Field,
      field: point.fields[0],
    });
  });

  test('permits direct, mutual, and collection-mediated recursion', () => {
    const result = checkText(
      [
        'type Direct',
        '    Direct child = na',
        'type A',
        '    B b',
        'type B',
        '    A a',
        'type Tree',
        '    array<Tree> children',
        'direct = Direct.new()',
      ].join('\n'),
    );
    expect(result.errors).toEqual([]);
  });

  test('keeps field signatures forward-visible while finalizing defaults in source order', () => {
    const signatures = checkText(
      ['type Earlier', '    Later later', 'type Later', '    int value'].join(
        '\n',
      ),
    );
    expect(signatures.errors).toEqual([]);

    const defaults = checkText(
      [
        'type Earlier',
        '    Later later = Later.new(1)',
        'type Later',
        '    int value',
      ].join('\n'),
    );
    expect(defaults.errors.map(error => error.msg)).toContain(
      "constructor 'Later.new' cannot be used before type 'Later' is declared",
    );

    const constructor = checkText(
      ['value = Later.new(1)', 'type Later', '    int value'].join('\n'),
    );
    expect(constructor.errors.map(error => error.msg)).toContain(
      "constructor 'Later.new' cannot be used before type 'Later' is declared",
    );
  });

  test('predeclares enum identities for earlier and forward field signatures', () => {
    const earlier = checkText(
      [
        'enum Mode',
        '    on',
        'type Foo',
        '    Mode mode = Mode.on',
        'value = Foo.new()',
      ].join('\n'),
    );
    expect(earlier.errors).toEqual([]);
    const earlierEnum = earlier.checked.pkg.scope.lookup('Mode');
    const earlierFoo = earlier.checked.pkg.scope.lookup('Foo');
    expect(earlierEnum?.kind).toBe(ObjectKind.Enum);
    expect(earlierFoo?.kind).toBe(ObjectKind.Struct);
    if (
      earlierEnum?.kind === ObjectKind.Enum &&
      earlierFoo?.kind === ObjectKind.Struct
    ) {
      expect(earlierFoo.fields[0].type).toBe(earlierEnum.type);
    }

    const forward = checkText(
      [
        'type Foo',
        '    Mode mode',
        'enum Mode',
        '    on',
        'value = Foo.new(Mode.on)',
      ].join('\n'),
    );
    expect(forward.errors).toEqual([]);
    const forwardEnum = forward.checked.pkg.scope.lookup('Mode');
    const forwardFoo = forward.checked.pkg.scope.lookup('Foo');
    expect(forwardEnum?.kind).toBe(ObjectKind.Enum);
    expect(forwardFoo?.kind).toBe(ObjectKind.Struct);
    if (
      forwardEnum?.kind === ObjectKind.Enum &&
      forwardFoo?.kind === ObjectKind.Struct
    ) {
      expect(forwardFoo.fields[0].type).toBe(forwardEnum.type);
    }

    const earlyDefault = checkText(
      ['type Foo', '    Mode mode = Mode.on', 'enum Mode', '    on'].join('\n'),
    );
    expect(earlyDefault.errors.map(error => error.msg)).toContain(
      "enum 'Mode' cannot be used before it is declared",
    );
  });
});

describe('collection type checking', () => {
  test('instantiates namespace and method calls into concrete call facts', () => {
    const result = checkText(
      [
        'array<float> xs = array.from(1, 2.5)',
        'xs.push(3)',
        'n = xs.size()',
        'matrix<int> grid = matrix.new<int>(2, 3, 0)',
        'grid.set(0, 0, 4)',
        'map<string, int> index = map.new<string, int>()',
        'index.put("answer", 42)',
        'keys = index.keys()',
        'loop = for [key, value] in index',
        '    value',
      ].join('\n'),
    );
    expect(result.errors).toEqual([]);

    const xs = declaredName(result, 'xs');
    expect(xs.type.kind).toBe(TypeKind.Array);
    if (xs.type.kind === TypeKind.Array) {
      expect(xs.type.elem.kind).toBe(TypeKind.Float);
    }
    expect(declaredName(result, 'n').type.kind).toBe(TypeKind.Int);
    expect(declaredName(result, 'grid').type.kind).toBe(TypeKind.Matrix);
    expect(declaredName(result, 'index').type.kind).toBe(TypeKind.Map);
    expect(declaredName(result, 'loop')).toMatchObject({
      type: {kind: TypeKind.Int},
      qualifier: Qualifier.Series,
    });
    const keys = declaredName(result, 'keys').type;
    expect(keys.kind).toBe(TypeKind.Array);
    if (keys.kind === TypeKind.Array) {
      expect(keys.elem.kind).toBe(TypeKind.String);
    }

    const from = nativeCall(result, 'array.from');
    expect(from.resultType.kind).toBe(TypeKind.Array);
    expect(from.argTypes.map(type => type.kind)).toEqual([
      TypeKind.Float,
      TypeKind.Float,
    ]);
    expect(from.receiver).toBeNull();

    const push = nativeCall(result, 'array.push');
    expect(push.argTypes).toHaveLength(2);
    expect(push.argTypes[0].kind).toBe(TypeKind.Array);
    expect(push.argTypes[1].kind).toBe(TypeKind.Float);
    expect(push.receiver?.mode).toBe('inout');
    if (push.receiver?.mode === 'inout') {
      expect(push.receiver.location).toEqual({kind: 'name', name: xs});
      expect(push.args[0]).toBe(push.receiver.value.expr);
    }
    expect(result.info.reassigned.has(xs)).toBe(true);
  });

  test('numeric inference widens but nested collection parameters stay invariant', () => {
    const valid = checkText(
      [
        'floats = array.from(1, 2.5)',
        'explicit = array.from<float>(na)',
        'nested = array.from(array.new<int>(), array.new<int>())',
      ].join('\n'),
    );
    expect(valid.errors).toEqual([]);
    const floats = declaredName(valid, 'floats').type;
    expect(floats.kind).toBe(TypeKind.Array);
    if (floats.kind === TypeKind.Array) {
      expect(floats.elem.kind).toBe(TypeKind.Float);
    }

    const invalidCases = [
      {
        src: 'empty = array.from()',
        error: "cannot infer type argument 'T'",
      },
      {
        src: 'empty = array.from(na)',
        error: "cannot infer type argument 'T'",
      },
      {
        src: 'mixed = array.from(1, "x")',
        error: 'cannot infer one type from int and string',
      },
      {
        src: [
          'ints = array.new<int>()',
          'floats = array.new<float>()',
          'mixed = array.from(ints, floats)',
        ].join('\n'),
        error: 'cannot infer one type from array<int> and array<float>',
      },
      {
        src: 'map<line, int> bad = map.new<line, int>()',
        error: "line does not satisfy map-key constraint for 'K'",
      },
      {
        src: 'map<int> bad = map.new<int, int>()',
        error: "generic type 'map' expects 2 type arguments, got 1",
      },
      {
        src: 'array<float> bad = array.new<int>()',
        error: 'cannot use array<int> as array<float>',
      },
    ];
    for (const {src, error} of invalidCases) {
      expect(
        checkText(src).errors.some(item => item.msg.includes(error)),
      ).toBe(true);
    }
  });

  test('array.new size-only calls retain a typed-empty initial slot', () => {
    const result = checkText(
      [
        'floats = array.new<float>(3)',
        'flags = array.new<bool>(2)',
        'type Point',
        '    int x',
        'points = array.new<Point>(1)',
      ].join('\n'),
    );
    expect(result.errors).toEqual([]);
    const calls = [...result.info.calls.values()].filter(
      (call): call is NativeCall =>
        call.kind === CallKind.Native && call.native.name === 'array.new',
    );
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.args).toHaveLength(2);
      expect(call.args[1]).toBeNull();
      expect(call.argumentEvaluationOrder).toEqual([0]);
    }

    expect(checkText('values = array.new(3)').errors).not.toEqual([]);
  });

  test('publishes concrete contextual types for polymorphic na arguments', () => {
    const result = checkText(
      ['missing = na(na)', 'text = str.tostring(na)'].join('\n'),
    );
    expect(result.errors).toEqual([]);
    expect(nativeCall(result, 'na').argTypes.map(type => type.kind)).toEqual([
      TypeKind.Float,
    ]);
    expect(
      nativeCall(result, 'str.tostring').argTypes.map(type => type.kind),
    ).toEqual([TypeKind.Float]);
  });

  test('rooted mutators are execution-qualified even when their scalar result is constant', () => {
    const result = checkText(
      [
        'type Holder',
        '    int marker',
        '    int constant() => 1',
        'values = array.from(1)',
        'popped = values.pop()',
        'holder = Holder.new(0)',
        'methodResult = holder.constant()',
      ].join('\n'),
    );
    expect(result.errors).toEqual([]);
    expect(declaredName(result, 'popped').qualifier).toBe(Qualifier.Series);
    expect(declaredName(result, 'methodResult').qualifier).toBe(
      Qualifier.Series,
    );
  });

  test('aggregate host representations are not string conversion semantics', () => {
    const array = checkText('text = str.tostring(array.from(1))');
    expect(array.errors.map(error => error.msg)).toContainEqual(
      expect.stringContaining('scalar, enum, or resource'),
    );

    const structValue = checkText(
      ['type Point', '    int x', 'text = str.tostring(Point.new(1))'].join(
        '\n',
      ),
    );
    expect(structValue.errors.map(error => error.msg)).toContainEqual(
      expect.stringContaining('scalar, enum, or resource'),
    );
  });
});

describe('struct field stores and collection locations', () => {
  test('records the direct object and final field for each store location', () => {
    const result = checkText(
      [
        'type Leaf',
        '    int value',
        'type Holder',
        '    Leaf leaf',
        '    array<int> values',
        'holder = Holder.new(Leaf.new(1), array.from(1))',
        'holder.leaf.value := 2',
        'holder.values.push(3)',
      ].join('\n'),
    );
    expect(result.errors).toEqual([]);
    const holder = declaredName(result, 'holder');

    const assignment = result.file.stmtList[3];
    if (assignment.kind !== NodeKind.AssignStmt) {
      throw new Error('fixture lost its field assignment');
    }
    const update = result.info.updates.get(assignment);
    expect(update?.owner.name).toBe('Leaf');
    expect(update?.field.name).toBe('value');
    expect(update?.object.expr.kind).toBe(NodeKind.SelectorExpr);
    expect(update?.object.tv.type.kind).toBe(TypeKind.Struct);
    expect(update?.object.info).toBe(result.info);

    const push = nativeCall(result, 'array.push');
    expect(push.receiver?.mode).toBe('inout');
    if (push.receiver?.mode === 'inout') {
      expect(push.receiver.location.kind).toBe('structField');
      if (push.receiver.location.kind === 'structField') {
        expect(push.receiver.location.owner.name).toBe('Holder');
        expect(push.receiver.location.field.name).toBe('values');
        expect(push.receiver.location.object.expr.kind).toBe(NodeKind.Name);
      }
    }
    expect(result.info.reassigned.has(holder)).toBe(false);
  });

  test('allows struct stores through arbitrary refs and rejects collection rvalues', () => {
    const valid = checkText(
      [
        'type Point',
        '    int x',
        'points = array.from(Point.new(1))',
        'point = Point.new(1)',
        'points.get(0).x := 2',
        'point[1].x := 3',
        'change() =>',
        '    point.x := 4',
        'change()',
      ].join('\n'),
    );
    expect(valid.errors).toEqual([]);

    for (const src of [
      ['xs = array.from(1)', 'xs[1].push(2)'].join('\n'),
      'array.from(1).push(2)',
    ]) {
      expect(
        checkText(src).errors.some(item =>
          item.msg.includes(
            'collection mutation requires a writable name or struct field',
          ),
        ),
      ).toBe(true);
    }
  });

  test('rejects compound fields, field persistence, equality, and implicit struct copies', () => {
    const result = checkText(
      [
        'type Point',
        '    varip int x',
        'point = Point.new(1)',
        'point.x += 1',
        'same = point == point',
        'copied = point.copy()',
        'xs = array.from(1)',
        'sameArray = xs != xs',
      ].join('\n'),
    );
    const messages = result.errors.map(error => error.msg);
    expect(messages).toContain(
      "field-level 'varip' is not supported; persistence belongs to the containing variable",
    );
    expect(messages).toContain(
      'compound assignment to a field is not supported',
    );
    expect(
      messages.some(message =>
        message.includes('aggregate equality is not defined'),
      ),
    ).toBe(true);
    expect(messages).toContain("Point has no method 'copy'");
    expect(result.info.updates.size).toBe(0);
  });
});

describe('method receivers', () => {
  test('owns nested methods and keeps the hidden receiver separate from source arguments', () => {
    const result = checkText(
      [
        'struct Foo',
        '    int x',
        '    int read() const => this.x',
        '    int set(int value) =>',
        '        this.x := value',
        'type Bar',
        '    int x',
        '    int read() const => this.x',
        'foo = Foo.new(1)',
        'before = foo.read()',
        'foo.set(2)',
        'bar = Bar.new(3)',
        'after = bar.read()',
      ].join('\n'),
    );
    expect(result.errors).toEqual([]);
    const foo = declaredName(result, 'foo');
    const methods = result.checked.pkg.scope.lookupMethods('read');
    expect(methods).toHaveLength(2);
    expect(
      typesEqual(
        methods[0].receiver.owner.type,
        methods[1].receiver.owner.type,
      ),
    ).toBe(false);
    expect(methods[0].receiver.owner.methods).toContain(methods[0]);
    expect(methods[1].receiver.owner.methods).toContain(methods[1]);

    const before = result.info.calls.get(declarationCall(result, 'before'));
    expect(before?.kind).toBe(CallKind.Function);
    if (before?.kind === CallKind.Function) {
      expect(before.receiver?.mode).toBe('const');
      expect(before.instance.template.receiver?.mode).toBe('const');
      expect(before.args).toEqual([]);
      expect(before.argumentEvaluationOrder).toEqual([]);
      expect(before.instance.params).toEqual([]);
      expect(before.instance.receiver).toMatchObject({
        name: 'this',
        constDecl: true,
      });
    }

    const setCall = [...result.info.calls.values()].find(
      call =>
        call.kind === CallKind.Function &&
        call.instance.template.name === 'set',
    );
    expect(setCall?.kind).toBe(CallKind.Function);
    if (
      setCall?.kind === CallKind.Function &&
      setCall.receiver?.mode === 'mutable'
    ) {
      expect(setCall.args).toHaveLength(1);
      expect(setCall.args[0]).not.toBe(setCall.receiver.value.expr);
      expect(setCall.argumentEvaluationOrder).toEqual([0]);
      expect(setCall.instance.template.receiver?.mode).toBe('mutable');
      expect(setCall.instance.receiver).toMatchObject({
        name: 'this',
        constDecl: false,
      });
      expect(setCall.instance.params[0].name).toBe('value');
    }
    expect(result.info.reassigned.has(foo)).toBe(false);
  });

  test('mutable methods accept temporary, historical, and accessor references', () => {
    const valid = checkText(
      [
        'type Foo',
        '    int x',
        '    int read() const => this.x',
        'root = Foo.new(1)',
        'temporary = Foo.new(2).read()',
        'historical = root[1].read()',
      ].join('\n'),
    );
    expect(valid.errors).toEqual([]);
    expect(declaredName(valid, 'historical').qualifier).toBe(Qualifier.Series);

    const mutable = checkText(
      [
        'type Foo',
        '    int x',
        '    int set(int value) =>',
        '        this.x := value',
        'root = Foo.new(1)',
        'roots = array.from(root)',
        'Foo.new(2).set(3)',
        'root[1].set(4)',
        'roots.get(0).set(5)',
      ].join('\n'),
    );
    expect(mutable.errors).toEqual([]);
  });

  test('const receivers are shallow: direct fields are readonly, child refs remain mutable', () => {
    const result = checkText(
      [
        'type Child',
        '    int value',
        '    int bump() =>',
        '        this.value := this.value + 1',
        'type Holder',
        '    int value',
        '    Child child',
        '    array<int> values',
        '    int bump() =>',
        '        this.value := this.value + 1',
        '    int inspect() const =>',
        '        this.child.value := 9',
        '        this.child.bump()',
        '        this.child.value',
        '    int badField() const =>',
        '        this.value := 9',
        '        this.value',
        '    void badCollection() const =>',
        '        this.values.push(1)',
        '    int badMethod() const =>',
        '        this.bump()',
        'holder = Holder.new(0, Child.new(0), array.new<int>())',
        'allowed = holder.inspect()',
        'field = holder.badField()',
        'holder.badCollection()',
        'holder.badMethod()',
      ].join('\n'),
    );
    const messages = result.errors.map(error => error.msg);
    expect(
      messages.filter(message => message.includes('in a const method')),
    ).toHaveLength(3);
  });

  test('rejects bare this, invalid declared results, duplicate members, and aliases at their owners', () => {
    const result = checkText(
      [
        'struct Foo',
        '    int value',
        '    int value() const => 1',
        '    int duplicate() const => 1',
        '    int duplicate() const => 2',
        '    string wrong() const => 1',
        '    Foo leak() const => this',
        'foo = Foo.new(1)',
        'wrong = foo.wrong()',
        'leaked = foo.leak()',
        'type Alias = Foo',
      ].join('\n'),
    );
    const messages = result.errors.map(error => error.msg);
    expect(messages).toContain("duplicate member 'value' in type 'Foo'");
    expect(messages).toContain("duplicate member 'duplicate' in type 'Foo'");
    expect(messages).toContain("method 'Foo.wrong' returns int, want string");
    expect(messages).toContain(
      "bare 'this' cannot be used as a value; select a field or method",
    );
    expect(
      messages.filter(message => message.includes('type aliases')),
    ).toEqual(['type aliases are not supported yet']);
  });

  test('rejects this outside methods and the legacy top-level method spelling', () => {
    const outside = checkText('value = this');
    expect(outside.errors.map(error => error.msg)).toEqual([
      "'this' is available only inside a method",
    ]);

    const legacy = checkText(
      [
        'type Foo',
        '    int value',
        'method set(inout Foo self) => self.value',
      ].join('\n'),
    );
    expect(legacy.errors.map(error => error.msg)).toContain(
      "expected end of statement, found 'name'",
    );
    expect(legacy.checked.pkg.scope.lookupMethods('set')).toEqual([]);

    const ordinaryNames = checkText(
      [
        'method = 1',
        'identity(inout) => inout',
        'value = identity(method)',
      ].join('\n'),
    );
    expect(ordinaryNames.errors).toEqual([]);
  });

  test('method defaults use declaration scope and cannot capture this or sibling parameters', () => {
    const result = checkText(
      [
        'const base = 7',
        'offset = 2',
        'type Box',
        '    int value',
        '    int valid(int amount = base + offset) const => this.value + amount',
        '    int badThis(int amount = this.value) const => amount',
        '    int badSibling(int left, int right = left) const => right',
        'box = Box.new(1)',
        'ok = box.valid()',
        'badThis = box.badThis()',
        'badSibling = box.badSibling(1)',
      ].join('\n'),
    );
    const messages = result.errors.map(error => error.msg);
    expect(messages).toContain(
      "method parameter default cannot reference 'this'",
    );
    expect(messages).toContain(
      "method parameter default cannot reference method parameter 'left'",
    );
    expect(messages).not.toContain("undeclared name 'base'");
    expect(messages).not.toContain("undeclared name 'offset'");

    const valid = result.info.calls.get(declarationCall(result, 'ok'));
    expect(valid?.kind).toBe(CallKind.Function);
    // A poisoned omitted default has no semantic call owner, so noding cannot
    // accidentally project or lower it in the caller's frame.
    expect(
      result.info.calls.has(declarationCall(result, 'badThis')),
    ).toBe(false);
    expect(
      result.info.calls.has(declarationCall(result, 'badSibling')),
    ).toBe(false);
  });

  test('validates every method body without requiring a call site', () => {
    const result = checkText(
      [
        'type Broken',
        '    int value',
        '    string wrong() const => 1',
        '    int mutates() const =>',
        '        this.value := 2',
        '        this.value',
        '    int missing() const => notDeclared',
      ].join('\n'),
    );
    const messages = result.errors.map(error => error.msg);
    expect(messages).toContain(
      "method 'Broken.wrong' returns int, want string",
    );
    expect(messages).toContain(
      "cannot mutate a direct field of 'this' in a const method",
    );
    expect(messages).toContain("undeclared name 'notDeclared'");
    expect(result.info.calls.size).toBe(0);
  });
});

describe('tuple transport boundary', () => {
  test('requires immediate destructuring instead of storing a tuple in one name', () => {
    const stored = checkText('pair = [1, 2]');
    expect(stored.errors.map(error => error.msg)).toContain(
      'tuple values are transport-only and must be destructured at declaration',
    );

    const destructured = checkText('[left, right] = [1, 2]');
    expect(destructured.errors).toEqual([]);
  });

  test('rejects tuple equality and tuple history', () => {
    const result = checkText(
      ['same = [1, 2] == [1, 2]', '[left, right] = [1, 2][1]'].join('\n'),
    );
    const messages = result.errors.map(error => error.msg);
    expect(
      messages.some(message =>
        message.startsWith('aggregate equality is not defined'),
      ),
    ).toBe(true);
    expect(messages).toContain(
      'history operand must be a direct readable binding',
    );
  });
});

describe('history binding boundary', () => {
  test('accepts direct bindings and rejects computed operands at offset zero', () => {
    const valid = checkText(
      [
        'type Foo',
        '    int x',
        'foo = Foo.new(1)',
        'historicalField = foo[0].x',
        'observation = foo.x',
        'historicalObservation = observation[0]',
        'historicalClose = close[0]',
      ].join('\n'),
    );
    expect(valid.errors).toEqual([]);
    expect(declaredName(valid, 'historicalField').qualifier).toBe(
      Qualifier.Series,
    );

    for (const source of [
      ['type Foo', '    int x', 'foo = Foo.new(1)', 'bad = foo.x[0]'].join(
        '\n',
      ),
      ['type Foo', '    int x', 'bad = Foo.new(1)[0]'].join('\n'),
      [
        'type Foo',
        '    int x',
        'foo = Foo.new(1)',
        'bad = array.from(foo).get(0)[0]',
      ].join('\n'),
      ['read() => close', 'bad = read()[0]'].join('\n'),
      'bad = (close + open)[0]',
    ]) {
      expect(
        checkText(source).errors.some(error =>
          error.msg.includes(
            'history operand must be a direct readable binding',
          ),
        ),
      ).toBe(true);
    }
  });

  test('requires runtime bindings while retaining foldable and typed-na names', () => {
    const valid = checkText(
      [
        'literal = 1',
        'literalHistory = literal[1]',
        'struct Foo',
        '    int x',
        'Foo foo = na',
        'fooHistory = foo[0].x',
      ].join('\n'),
    );
    expect(valid.errors).toEqual([]);

    const constant = checkText('const int value = 1\nbad = value[0]');
    expect(constant.errors.map(error => error.msg)).toContain(
      'const bindings do not have runtime history',
    );

    const output = checkText('plotRef = plot(close)\nbad = plotRef[0]');
    expect(output.errors.map(error => error.msg)).toContain(
      'output references do not have runtime history',
    );
  });
});

describe('reserved future aggregate surfaces', () => {
  test('rejects aggregate output channels and pointer syntax in V1', () => {
    const output = checkText('values = array.from(1)\nplot(values)');
    expect(
      output.errors.some(error =>
        error.msg.startsWith("argument 'series' to 'plot':"),
      ),
    ).toBe(true);

    const pointer = checkText(
      ['type Point', '    int x', '*Point pointer = na'].join('\n'),
    );
    expect(pointer.errors.map(error => error.msg)).toContain(
      "expected expression, found 'operator'",
    );
  });
});
