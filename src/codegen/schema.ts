// Purpose: The single checked-Type to Arrow projection for both backends.

import {
  Bool,
  Field,
  Float64,
  List,
  Map_ as ArrowMap,
  Struct,
  Utf8,
  DataType,
  Schema,
  Precision,
  TimeUnit,
} from 'apache-arrow';
import {fatal} from '../base/print';
import {formatType, IntType, TypeKind, type Type} from '../ir/type';

/**
 * Describe one exported Tea value using Arrow's actual nested types. Metadata
 * preserves Tea distinctions such as int versus float and nominal identity;
 * it never contains a second structural schema. Each call owns fresh fields.
 *
 * @example
 * ```ts
 * const prices = fieldOf('prices', {kind: TypeKind.Array, elem: IntType}, new Map());
 * prices.type.toString(); // "List<Float64>"
 * prices.type.children[0].metadata.get('tea:type'); // "int"
 * ```
 */
export function fieldOf(
  name: string,
  type: Type,
  nominalIds: ReadonlyMap<Type, string>,
): Field {
  const active = new Set<Type>();
  const field = (name: string, type: Type): Field => {
    if (active.has(type))
      return fatal('recursive export reached Arrow projection');
    active.add(type);
    const metadata = new Map([['tea:type', type.kind.toLowerCase()]]);
    const nominal = () => {
      const id = nominalIds.get(type);
      if (id === undefined)
        return fatal(`exported ${formatType(type)} has no nominal identity`);
      metadata.set('tea:typeId', id);
      if (type.kind === TypeKind.Struct || type.kind === TypeKind.Enum) {
        metadata.set('tea:name', type.name);
      }
    };
    const result = (): Field => {
      switch (type.kind) {
        case TypeKind.Int:
        case TypeKind.Float:
          // Tea's numeric missing value is NaN, never Arrow null.
          return new Field(name, new Float64(), false, metadata);
        case TypeKind.Bool:
          return new Field(name, new Bool(), false, metadata);
        case TypeKind.String:
        case TypeKind.Color:
          return new Field(name, new Utf8(), true, metadata);
        case TypeKind.Enum:
          nominal();
          metadata.set('tea:members', JSON.stringify(type.members));
          return new Field(name, new Utf8(), true, metadata);
        case TypeKind.Struct:
          nominal();
          return new Field(
            name,
            new Struct(
              type.fields.map(member => field(member.name, member.type)),
            ),
            true,
            metadata,
          );
        case TypeKind.Array:
          return new Field(
            name,
            new List(field('item', type.elem)),
            true,
            metadata,
          );
        case TypeKind.Matrix:
          return new Field(
            name,
            new Struct([
              field('rows', IntType),
              field('columns', IntType),
              new Field('values', new List(field('item', type.elem)), false),
            ]),
            true,
            metadata,
          );
        case TypeKind.Map:
          return new Field(
            name,
            new ArrowMap(
              new Field(
                'entries',
                new Struct<{key: DataType; value: DataType}>([
                  field('key', type.key).clone({nullable: false}),
                  field('value', type.value),
                ]),
                false,
              ),
            ),
            true,
            metadata,
          );
        case TypeKind.Tuple:
          return new Field(
            name,
            new Struct(type.elems.map((element, i) => field(`_${i}`, element))),
            true,
            metadata,
          );
        case TypeKind.Line:
        case TypeKind.Label:
        case TypeKind.Box:
        case TypeKind.Table:
        case TypeKind.Polyline:
        case TypeKind.Linefill:
        case TypeKind.Plot:
        case TypeKind.Hline:
          metadata.set(
            'tea:type',
            type.kind === TypeKind.Plot || type.kind === TypeKind.Hline
              ? 'output-ref'
              : 'resource',
          );
          metadata.set('tea:name', type.kind.toLowerCase());
          return new Field(
            name,
            new Struct([
              new Field('kind', new Utf8(), false),
              new Field('id', new Float64(), false),
            ]),
            true,
            metadata,
          );
        default:
          return fatal(
            `non-value type ${formatType(type)} reached Arrow projection`,
          );
      }
    };
    const value = result();
    active.delete(type);
    return value;
  };
  return field(name, type);
}

/**
 * Print compiler-owned Arrow objects as ordinary constructor expressions.
 * This preserves the existing schema rather than projecting Tea types again.
 * @example `schemaSource(new Schema([new Field('price', new Float64(), false)]))`
 * produces a Schema containing the same non-nullable Float64 field.
 */
export function schemaSource(schema: Schema): string {
  const metadata = (entries: ReadonlyMap<string, string>): string =>
    entries.size === 0 ? '' : `, new Map(${JSON.stringify([...entries])})`;
  const fields = (items: readonly Field[]): string =>
    `[\n${items.map(field).join(',\n')}\n]`;
  const type = (value: DataType): string => {
    if (DataType.isFloat(value) && value.precision === Precision.DOUBLE)
      return 'new Float64()';
    if (DataType.isBool(value)) return 'new Bool()';
    if (DataType.isUtf8(value)) return 'new Utf8()';
    if (DataType.isList(value)) return `new List(${field(value.children[0])})`;
    if (DataType.isStruct(value))
      return `new Struct(${fields(value.children)})`;
    if (DataType.isMap(value))
      return `new Map_(${field(value.children[0])}, ${value.keysSorted})`;
    if (DataType.isTimestamp(value) && value.unit === TimeUnit.MILLISECOND)
      return `new TimestampMillisecond(${value.timezone == null ? '' : JSON.stringify(value.timezone)})`;
    return fatal(`unsupported generated Arrow type ${value}`);
  };
  const field = (value: Field): string =>
    `new Field(${JSON.stringify(value.name)}, ${type(value.type)}, ${value.nullable}${metadata(value.metadata)})`;
  return `new Schema(${fields(schema.fields)}${metadata(schema.metadata)})`;
}
