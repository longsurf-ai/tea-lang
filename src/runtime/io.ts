// Arrow owns the data vocabulary; these functions handle its artifact and host boundaries.

import {
  DataType,
  Field,
  Schema,
  Table,
  tableFromIPC,
  tableToIPC,
} from 'apache-arrow';

/**
 * Encode a schema with Arrow's standard IPC writer, without any data rows.
 * Generated artifacts contain these bytes; execution never serializes each step.
 *
 * @example `decodeSchema(encodeSchema(schema))` preserves fields and metadata.
 */
export function encodeSchema(schema: Schema): number[] {
  const active = new Set<DataType>();
  const visit = (type: DataType): void => {
    if (active.has(type)) throw new TypeError('recursive Arrow schema');
    active.add(type);
    for (const field of type.children ?? []) visit(field.type);
    if (DataType.isDictionary(type)) visit(type.dictionary);
    active.delete(type);
  };
  schema.fields.forEach(field => visit(field.type));
  return Array.from(tableToIPC(new Table(schema)));
}

/**
 * Restore real Arrow classes from a schema-only IPC stream.
 *
 * @example `decodeSchema(bytes).fields[0].type` is an Arrow DataType instance.
 */
export function decodeSchema(bytes: readonly number[]): Schema {
  return tableFromIPC(Uint8Array.from(bytes)).schema;
}

/**
 * Give a caller its own schema, including nested fields and mutable metadata Maps.
 * Object freezing and structuredClone cannot provide this ownership boundary.
 *
 * @example `cloneSchema(schema).metadata.set('title', 'Copy')` leaves `schema` unchanged.
 */
export function cloneSchema(schema: Schema): Schema {
  return decodeSchema(encodeSchema(schema));
}

/**
 * Validate named host values against Arrow fields. Undeclared properties are
 * omitted; nullable fields may be absent. Parsing/coercion belongs to the source.
 *
 * @example With a non-null Float64 `close` field, `{close: 10}` passes and
 * `{close: '10'}` throws before Node executes.
 */
export function validateRecord(
  schema: Schema,
  value: unknown,
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Arrow record must be an object');
  }
  const record = value as Record<string, unknown>;
  const names = new Set<string>();
  const entries: [string, unknown][] = [];
  for (const field of schema.fields) {
    if (names.has(field.name))
      throw new TypeError(`duplicate Arrow field '${field.name}'`);
    names.add(field.name);
    const present = Object.hasOwn(record, field.name);
    const item = present ? record[field.name] : undefined;
    validateValue(field, item);
    if (present) entries.push([field.name, item]);
  }
  return Object.fromEntries(entries);
}

/**
 * Check a value using its Arrow type, without allocating column buffers or
 * inferring a second schema. Cycles fail; repeated non-cyclic references are valid.
 *
 * @example A List<Float64> field accepts `[1, NaN]` and rejects `[1, 'two']`.
 */
export function validateValue(field: Field, value: unknown): void {
  let active: Set<object> | undefined;
  const visit = (field: Field, value: unknown, path: string): void => {
    const bad = (): never => {
      throw new TypeError(`${path} must match ${field.type}`);
    };
    if (value === null || value === undefined) {
      if (!field.nullable) bad();
      return;
    }
    const type = field.type;
    if (DataType.isDictionary(type)) {
      visit(
        new Field(field.name, type.dictionary, field.nullable, field.metadata),
        value,
        path,
      );
      return;
    }
    if (DataType.isFloat(type)) {
      if (
        typeof value !== 'number' ||
        (!Number.isFinite(value) && !Number.isNaN(value))
      )
        bad();
    } else if (DataType.isInt(type)) {
      if (type.bitWidth === 64) {
        if (
          typeof value !== 'bigint' ||
          value < (type.isSigned ? -(1n << 63n) : 0n) ||
          value >= 1n << BigInt(type.isSigned ? 63 : 64)
        )
          bad();
      } else if (
        typeof value !== 'number' ||
        !Number.isInteger(value) ||
        value < (type.isSigned ? -(2 ** (type.bitWidth - 1)) : 0) ||
        value >= 2 ** (type.isSigned ? type.bitWidth - 1 : type.bitWidth)
      )
        bad();
    } else if (DataType.isBool(type)) {
      if (typeof value !== 'boolean') bad();
    } else if (DataType.isUtf8(type) || DataType.isLargeUtf8(type)) {
      if (typeof value !== 'string') bad();
      const members = field.metadata.get('tea:members');
      if (
        members !== undefined &&
        !(JSON.parse(members) as {name: string}[]).some(
          member => member.name === value,
        )
      )
        bad();
    } else if (
      DataType.isBinary(type) ||
      DataType.isLargeBinary(type) ||
      DataType.isFixedSizeBinary(type)
    ) {
      if (
        !(value instanceof Uint8Array) ||
        (DataType.isFixedSizeBinary(type) && value.length !== type.byteWidth)
      )
        bad();
    } else if (DataType.isTimestamp(type)) {
      if (
        (typeof value !== 'number' && typeof value !== 'bigint') ||
        !Number.isSafeInteger(Number(value))
      )
        bad();
    } else {
      if (typeof value !== 'object') bad();
      const object = value as object;
      active ??= new Set<object>();
      if (active.has(object)) throw new TypeError(`${path} contains a cycle`);
      active.add(object);
      if (DataType.isStruct(type)) {
        if (Array.isArray(value)) bad();
        for (const child of type.children)
          visit(
            child,
            Object.hasOwn(value, child.name)
              ? (value as Record<string, unknown>)[child.name]
              : undefined,
            `${path}.${child.name}`,
          );
      } else if (
        DataType.isList(type) ||
        DataType.isLargeList(type) ||
        DataType.isFixedSizeList(type)
      ) {
        if (
          !Array.isArray(value) ||
          (DataType.isFixedSizeList(type) && value.length !== type.listSize)
        )
          bad();
        for (const [i, item] of (value as unknown[]).entries())
          visit(type.children[0], item, `${path}[${i}]`);
      } else if (DataType.isMap(type)) {
        if (!(value instanceof Map)) bad();
        const [key, item] = type.children[0].type.children;
        for (const [k, v] of value as Map<unknown, unknown>) {
          visit(key, k, `${path}.key`);
          visit(item, v, `${path}.value`);
        }
      } else {
        throw new TypeError(`unsupported Arrow input type ${type}`);
      }
      active.delete(object);
    }
  };
  visit(field, value, field.name);
}
