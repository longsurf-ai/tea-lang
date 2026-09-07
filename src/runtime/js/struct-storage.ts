// Purpose: Nominal class bodies and transactional field access over the Heap.

import {fatal} from '../../base/print';
import {ExecutionError} from '../errors';
import type {Heap, HeapTransaction, Ref, TypeInfo} from './heap';
import {isStructRef, type Stored, visitValueRefs} from '../value';
import {Value} from './value';

const BYTES = Symbol('struct bytes');

/**
 * Store generated class instances without a parallel description of their type.
 * The constructor identifies the nominal type; named fields contain captured
 * Values. Heap owns identity, accounting, reference tracing, and transactions.
 */
export class StructStorageRuntime {
  readonly typeInfo: TypeInfo<
    readonly [body: object, logicalBytes: number],
    {readonly [BYTES]: number}
  > = {
    id: Symbol('tea.struct.storage'),
    name: 'struct storage',
    bytesFor: args => args[1],
    create: ([body, logicalBytes]) => {
      // newStruct admits only own enumerable data fields. Spread preserves
      // even '__proto__' as a field; freezing supplies the stored descriptors.
      const copy = Object.setPrototypeOf(
        {...body},
        Object.getPrototypeOf(body),
      );
      Object.defineProperty(copy, BYTES, {value: logicalBytes});
      return Object.freeze(copy);
    },
    trace: (body, visit) => {
      for (const value of Object.values(body)) {
        if (!(value instanceof Value)) {
          return fatal('managed class field is not a captured Value');
        }
        visitValueRefs(value, visit);
      }
    },
    bytesOf: body => body[BYTES],
  };

  constructor(private readonly heap: Heap) {}

  /**
   * Allocate a frozen clone preserving the supplied class prototype and fields.
   * The caller's instance is unchanged. Lowering supplies its logical byte size;
   * this accounts for Tea's storage budget, not JavaScript object overhead.
   * @example `newStruct(transaction, new Point({x: float(1)}), 24)`.
   */
  newStruct<T extends object>(
    transaction: HeapTransaction,
    body: T,
    byteSize: number,
  ): Ref<T> {
    for (const key of Reflect.ownKeys(body)) {
      const field = Reflect.getOwnPropertyDescriptor(body, key)!;
      if (
        typeof key !== 'string' ||
        !('value' in field) ||
        !field.enumerable ||
        !(field.value instanceof Value)
      ) {
        throw new ExecutionError(
          'VALUE_LAYOUT_MISMATCH',
          `constructor field '${String(key)}' must be an own captured Value`,
        );
      }
    }
    return transaction.allocate(this.typeInfo, [body, byteSize]) as Ref<T>;
  }

  /** Validate a mutation receiver before evaluating its right-hand side. */
  requireStruct(
    value: Stored,
    ctor: Function,
    reader: Pick<Heap, 'read'> = this.heap,
  ): Ref<object> {
    if (value === null) {
      throw new ExecutionError(
        'NA_STRUCT_WRITE',
        `cannot mutate na struct '${ctor.name}'`,
      );
    }
    return this.assertRef(value, ctor, reader);
  }

  /**
   * Read a captured field, or return its declared empty value through NA.
   * @example `field(null, Point, 'x', float(NaN))` returns that missing float.
   */
  field(
    value: Stored,
    ctor: Function,
    name: string,
    empty: Value<unknown>,
    reader: Pick<Heap, 'read'> = this.heap,
  ): Value<unknown> {
    if (value === null) return empty;
    return this.member(reader.read(this.assertRef(value, ctor, reader)), name);
  }

  /**
   * Replace one named field through the authoritative Heap transaction.
   * The old capture stays unchanged, while aliases observe the replacement.
   * @example `storeField(transaction, point, Point, 'x', float(2))`.
   */
  storeField(
    transaction: HeapTransaction,
    value: Stored,
    ctor: Function,
    name: string,
    replacement: Value<unknown>,
  ): void {
    const ref = this.requireStruct(value, ctor, transaction);
    const view = transaction.view(ref);
    const previous = this.member(view, name);
    if (!previous.sameType(replacement)) {
      throw new ExecutionError(
        'VALUE_LAYOUT_MISMATCH',
        `field '${ctor.name}.${name}' received an incompatible Value`,
      );
    }
    previous.assertStored(replacement.value as Stored, transaction);
    Reflect.set(view, name, replacement);
  }

  private assertRef(
    value: Stored,
    ctor: Function,
    reader: Pick<Heap, 'read'>,
  ): Ref<object> {
    if (!isStructRef(value)) {
      throw new ExecutionError(
        'VALUE_LAYOUT_MISMATCH',
        `receiver does not carry a '${ctor.name}' reference`,
      );
    }
    const body = reader.read(value);
    if (
      typeof body !== 'object' ||
      body === null ||
      !Object.hasOwn(body, BYTES) ||
      Object.getPrototypeOf(body) !== ctor.prototype
    ) {
      throw new ExecutionError(
        'VALUE_LAYOUT_MISMATCH',
        `receiver does not reference '${ctor.name}'`,
      );
    }
    return value;
  }

  private member(body: object, name: string): Value<unknown> {
    const field = Reflect.getOwnPropertyDescriptor(body, name);
    if (!field || !('value' in field) || !(field.value instanceof Value)) {
      return fatal(`unknown captured struct field '${name}'`);
    }
    return field.value;
  }
}
