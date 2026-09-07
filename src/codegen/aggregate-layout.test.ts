// Purpose: Generated aggregate classes retain nominal identities and recursive collection types.

import {describe, expect, test} from 'vitest';
import {DepthKind, IrKind, PlaceKind, Storage, type Name} from '../ir/node';
import type {Program} from '../ir/program';
import {RUNTIME_ABI_VERSION} from '../runtime/module-abi';
import {
  BoolType,
  ColorType,
  FloatType,
  IntType,
  LabelType,
  LineType,
  NA_VALUE,
  Qualifier,
  StringType,
  TypeKind,
  type ArrayType,
  type EnumType,
  type MapType,
  type MatrixType,
  type StructField,
  type StructType,
} from '../ir/type';
import {generate} from './codegen';
import {loadModule} from '../runtime/load';
import type {Value} from '../runtime/js/value';
import {Context} from '../runtime/js/context';
import {mustBuild} from '../noder/testing';
import {checkGenerated} from './check';

const pos = {base: {filename: 'aggregate-layout.test.tea'}, line: 1, col: 1};

function structType(name: string, fields: readonly StructField[]): StructType {
  return {kind: TypeKind.Struct, name, fields};
}

describe('aggregate class projection', () => {
  test('symbol brands reject structurally equal classes and preserve field types', () => {
    const source = generate(
      mustBuild(`
struct Left
    float value
struct Right
    float value
left = Left.new(close)
right = Right.new(close)
emit "left" left.value
emit "right" right.value
`),
    );
    const left = /class (Left\d+) \{/.exec(source)![1];
    const right = /class (Right\d+) \{/.exec(source)![1];
    expect(source).toContain('declare readonly [');
    expect(source).not.toMatch(/const layouts|StorageType/);
    expect(() => checkGenerated(source)).not.toThrow();
    expect(() =>
      checkGenerated(`${source}\nconst wrong: ${left} = new ${right}();`),
    ).toThrow(/missing.*required/s);
    expect(() =>
      checkGenerated(
        `${source}\nimport {text as wrongText} from 'tea/runtime';\nnew ${left}({value: wrongText('wrong')});`,
      ),
    ).toThrow(/not assignable/);
  });

  test('reserved JavaScript names remain ordinary Tea fields and enum members', () => {
    const source = generate(
      mustBuild(`
enum Status
    __proto__
    normal
struct Item
    int constructor
    int __proto__
item = Item.new(7, 11)
item.constructor += 1
item.__proto__ += 2
emit "constructor" item.constructor
emit "__proto__" item.__proto__
emit "status" Status.__proto__
`),
    );
    expect(() => checkGenerated(source)).not.toThrow();
    const context = new Context(loadModule(source).bind());
    expect(
      context.step({series: [], builtins: [], requests: [], provisional: false})
        .outputs,
    ).toEqual([8, 13, '__proto__']);
    context.dispose();
  });

  test('nested missing class values retain their owner through reads and iteration', () => {
    const source = generate(
      mustBuild(`
struct Leaf
    float value
struct Branch
    Leaf leaf
branches = array.new<Branch>(1)
branch = branches.get(0)
emit "read" branch.leaf.value
for item in branches
    emit.append "items" item.leaf.value
`),
    );
    expect(() => checkGenerated(source)).not.toThrow();
    const context = new Context(loadModule(source).bind());
    expect(
      context.step({series: [], builtins: [], requests: [], provisional: false})
        .outputs,
    ).toEqual([NaN, [NaN]]);
    context.dispose();
  });

  test('emits exact, nominal, collision-free classes and enums', () => {
    const left: EnumType = {
      kind: TypeKind.Enum,
      name: 'Mode',
      members: [{name: 'on', title: 'On'}],
    };
    const right: EnumType = {
      kind: TypeKind.Enum,
      name: 'Mode',
      members: [{name: 'on', title: 'On'}],
    };
    const recursiveFields: StructField[] = [];
    const recursive = structType('Node', recursiveFields);
    const children: ArrayType = {kind: TypeKind.Array, elem: recursive};
    recursiveFields.push(
      {name: 'value', type: IntType},
      {name: 'children', type: children},
    );
    const ints: ArrayType = {kind: TypeKind.Array, elem: IntType};
    const floats: MatrixType = {kind: TypeKind.Matrix, elem: FloatType};
    const nodes: MapType = {
      kind: TypeKind.Map,
      key: StringType,
      value: recursive,
    };
    const envelope = structType('Envelope', [
      {name: 'integer', type: IntType},
      {name: 'decimal', type: FloatType},
      {name: 'flag', type: BoolType},
      {name: 'text', type: StringType},
      {name: 'color', type: ColorType},
      {name: 'leftMode', type: left},
      {name: 'rightMode', type: right},
      {name: 'line', type: LineType},
      {name: 'label', type: LabelType},
      {name: 'ints', type: ints},
      {name: 'floats', type: floats},
      {name: 'nodes', type: nodes},
    ]);
    const root: Name = {
      name: 'root',
      storage: Storage.PerBar,
      type: envelope,
      qualifier: Qualifier.Series,
      depth: {kind: DepthKind.None},
    };
    const ir: Program = {
      version: 1,
      nominalIds: new Map(),
      params: [],
      requests: [],
      outputs: [],
      packageGlobals: [],
      init: [],
      body: [
        {
          kind: IrKind.Assign,
          pos,
          target: {
            kind: IrKind.Read,
            pos,
            type: root.type,
            qualifier: root.qualifier,
            place: {kind: PlaceKind.Name, name: root},
          },
          op: null,
          value: {
            kind: IrKind.NewStruct,
            pos,
            type: envelope,
            qualifier: Qualifier.Series,
            structType: envelope,
            args: envelope.fields.map(field => ({
              kind: IrKind.Const,
              pos,
              type: field.type,
              qualifier: Qualifier.Series,
              value: field.type.kind === TypeKind.Bool ? false : NA_VALUE,
            })),
            argumentEvaluationOrder: envelope.fields.map(
              (_field, index) => index,
            ),
          },
        },
      ],
    };

    const source = generate(ir);
    expect(() => checkGenerated(source)).not.toThrow();
    const module = loadModule(source);

    const enumNames = [...source.matchAll(/enum (ModeEnum\d+) \{/g)].map(
      match => match[1],
    );
    expect(enumNames).toHaveLength(2);
    expect(new Set(enumNames).size).toBe(2);

    expect(module.abi).toBe(RUNTIME_ABI_VERSION);
    expect(module.state).not.toHaveProperty('layout');
    const local = module.state.frames[0].locals[0];
    expect(local).toMatchObject({
      name: 'root',
      storage: Storage.PerBar,
      depth: {kind: 'none'},
    });
    const body = Reflect.construct(local.empty.ctor!, []) as Record<
      string,
      Value<unknown>
    >;
    expect(Object.keys(body)).toEqual(envelope.fields.map(field => field.name));
    expect(
      Object.values(body)
        .slice(0, 5)
        .map(value => value.kind),
    ).toEqual(['int', 'float', 'bool', 'string', 'color']);
    expect(body.integer.value).toBeNaN();
    expect(body.flag.value).toBe(false);
    expect(body.color.value).toBeNull();
    expect(body.leftMode.enumValues).toEqual(['on']);
    expect(body.leftMode.sameType(body.rightMode)).toBe(false);
    expect(body.line.kind).toBe(TypeKind.Line);
    expect(body.label.kind).toBe(TypeKind.Label);
    expect(body.ints.element?.kind).toBe('int');
    expect(body.floats.element?.kind).toBe('float');
    expect(body.nodes.key?.kind).toBe('string');
    const node = body.nodes.element!;
    const nodeBody = Reflect.construct(node.ctor!, []) as Record<
      string,
      Value<unknown>
    >;
    expect(nodeBody.value.kind).toBe('int');
    expect(nodeBody.children.element?.ctor).toBe(node.ctor);
    expect(generate(ir)).toBe(source);
  });
});
