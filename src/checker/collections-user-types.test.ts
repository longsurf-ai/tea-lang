// Purpose: Checker conformance tests for collection generics, canonical user types, rooted updates, and receiver modes.

import {describe, expect, test} from 'bun:test';
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

describe('canonical user types', () => {
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
      wrapperDecl.kind !== NodeKind.UserTypeDecl ||
      pointDecl.kind !== NodeKind.UserTypeDecl
    ) {
      throw new Error('fixture lost its type declarations');
    }
    const wrapperField = wrapperDecl.members[0];
    if (wrapperField?.kind !== NodeKind.FieldDecl) {
      throw new Error('fixture lost its wrapper field');
    }
    const wrapper = result.checked.pkg.scope.lookup('Wrapper');
    const point = result.checked.pkg.scope.lookup('Point');
    expect(wrapper?.kind).toBe(ObjectKind.UserType);
    expect(point?.kind).toBe(ObjectKind.UserType);
    if (
      wrapper?.kind !== ObjectKind.UserType ||
      point?.kind !== ObjectKind.UserType
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
    expect(wrapper.type.fields[0]).toBe(wrapper.fields[0]);
    expect(point.type.fields[0]).toBe(point.fields[0]);

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

  test('rejects direct value cycles but permits collection-mediated recursion', () => {
    const result = checkText(
      [
        'type Direct',
        '    Direct child',
        'type A',
        '    B b',
        'type B',
        '    A a',
        'type Tree',
        '    array<Tree> children',
      ].join('\n'),
    );
    const cycles = result.errors.filter(error =>
      error.msg.includes('infinite value layout'),
    );
    expect(cycles).toHaveLength(2);
    expect(
      cycles.some(error => error.msg.includes("field 'child'")),
    ).toBeTrue();
    expect(cycles.some(error => error.msg.includes("field 'a'"))).toBeTrue();
    expect(
      cycles.some(error => error.msg.includes("field 'children'")),
    ).toBeFalse();
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
    expect(earlierFoo?.kind).toBe(ObjectKind.UserType);
    if (
      earlierEnum?.kind === ObjectKind.Enum &&
      earlierFoo?.kind === ObjectKind.UserType
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
    expect(forwardFoo?.kind).toBe(ObjectKind.UserType);
    if (
      forwardEnum?.kind === ObjectKind.Enum &&
      forwardFoo?.kind === ObjectKind.UserType
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
      expect(push.receiver.writeback.root).toBe(xs);
      expect(push.receiver.writeback.fields).toEqual([]);
      expect(push.args[0]).toBe(push.receiver.value.expr);
    }
    expect(result.info.reassigned.has(xs)).toBeTrue();
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
      ).toBeTrue();
    }
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

    const user = checkText(
      ['type Point', '    int x', 'text = str.tostring(Point.new(1))'].join(
        '\n',
      ),
    );
    expect(user.errors.map(error => error.msg)).toContainEqual(
      expect.stringContaining('scalar, enum, or resource'),
    );
  });
});

describe('rooted aggregate updates', () => {
  test('records one canonical field path for direct and collection updates', () => {
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
    expect(update?.root).toBe(holder);
    expect(update?.fields.map(field => field.name)).toEqual(['leaf', 'value']);
    expect(update?.receiver.tv.type.kind).toBe(TypeKind.Int);
    expect(update?.receiver.info).toBe(result.info);

    const push = nativeCall(result, 'array.push');
    expect(push.receiver?.mode).toBe('inout');
    if (push.receiver?.mode === 'inout') {
      expect(push.receiver.writeback.root).toBe(holder);
      expect(push.receiver.writeback.fields.map(field => field.name)).toEqual([
        'values',
      ]);
      expect(push.receiver.writeback.receiver.tv.type.kind).toBe(
        TypeKind.Array,
      );
    }
  });

  test('rejects historical, temporary, and nonlocal update roots', () => {
    const cases = [
      {
        src: [
          'type Point',
          '    int x',
          'points = array.from(Point.new(1))',
          'points.get(0).x := 2',
        ].join('\n'),
        error: 'mutation requires a current rooted value',
      },
      {
        src: [
          'type Point',
          '    int x',
          'point = Point.new(1)',
          'point[1].x := 2',
        ].join('\n'),
        error: 'mutation requires a current rooted value',
      },
      {
        src: ['xs = array.from(1)', 'xs[1].push(2)'].join('\n'),
        error: 'mutation requires a current rooted value',
      },
      {
        src: 'array.from(1).push(2)',
        error: 'mutation requires a current rooted value',
      },
      {
        src: [
          'type Point',
          '    int x',
          'point = Point.new(1)',
          'change() =>',
          '    point.x := 2',
          'change()',
        ].join('\n'),
        error: "cannot modify global variable 'point' inside a function",
      },
    ];
    for (const {src, error} of cases) {
      expect(
        checkText(src).errors.some(item => item.msg.includes(error)),
      ).toBeTrue();
    }
  });

  test('rejects compound fields, field persistence, equality, and implicit user copies', () => {
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
    ).toBeTrue();
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
    ).toBeFalse();
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
      expect(setCall.receiver.writeback.root).toBe(foo);
      expect(setCall.receiver.writeback.fields).toEqual([]);
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
    expect(result.info.reassigned.has(foo)).toBeTrue();
  });

  test('const methods accept rvalues and history while mutable methods require a current rooted place', () => {
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

    const invalid = checkText(
      [
        'type Foo',
        '    int x',
        '    int set(int value) =>',
        '        this.x := value',
        'root = Foo.new(1)',
        'Foo.new(2).set(3)',
        'root[1].set(4)',
      ].join('\n'),
    );
    expect(
      invalid.errors.filter(error =>
        error.msg.includes('mutation requires a current rooted value'),
      ),
    ).toHaveLength(2);
  });

  test('rejects mutation through a const this, including nested collection and method writes', () => {
    const result = checkText(
      [
        'type Child',
        '    int value',
        '    int bump() =>',
        '        this.value := this.value + 1',
        'type Holder',
        '    Child child',
        '    array<int> values',
        '    int badField() const =>',
        '        this.child.value := 9',
        '        this.child.value',
        '    void badCollection() const =>',
        '        this.values.push(1)',
        '    int badMethod() const =>',
        '        this.child.bump()',
        'holder = Holder.new(Child.new(0), array.new<int>())',
        'field = holder.badField()',
        'holder.badCollection()',
        'holder.badMethod()',
      ].join('\n'),
    );
    const messages = result.errors.map(error => error.msg);
    expect(
      messages.filter(message =>
        message.includes("cannot mutate 'this' in a const method"),
      ),
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
    ).toBeFalse();
    expect(
      result.info.calls.has(declarationCall(result, 'badSibling')),
    ).toBeFalse();
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
    expect(messages).toContain("cannot mutate 'this' in a const method");
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
    ).toBeTrue();
    expect(messages).toContain(
      'tuple values are transport-only and cannot be read through history',
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
    ).toBeTrue();

    const pointer = checkText(
      ['type Point', '    int x', '*Point pointer = na'].join('\n'),
    );
    expect(pointer.errors.map(error => error.msg)).toContain(
      "expected expression, found 'operator'",
    );
  });
});
