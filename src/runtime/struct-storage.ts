// Purpose: Nominal struct storage over the typed Heap: fresh reference allocation, typed-empty reads, exact-layout validation, and whole-payload transactional writes.

import {fatal} from '../base/print';
import {ExecutionError} from './errors';
import type {Heap, HeapTransaction, Ref, TypeInfo} from './heap';
import {isStructRef, isTupleValue, type Value} from './value';
import {
  type LayoutId,
  type StructLayoutId,
  ValueLayoutRegistry,
} from './value-layout';

export interface StructStorage {
  readonly layout: StructLayoutId;
  readonly fields: readonly Value[];
  readonly logicalBytes: number;
}

interface StructStorageArgs {
  readonly layout: StructLayoutId;
  readonly fields: readonly Value[];
  readonly logicalBytes: number;
}

interface HeapReader {
  read<V>(ref: Ref<V>): Readonly<V>;
}

export type StructRef = Ref<StructStorage>;

export class StructStorageRuntime {
  readonly typeInfo: TypeInfo<StructStorageArgs, StructStorage>;

  constructor(
    private readonly heap: Heap,
    private readonly layouts: ValueLayoutRegistry,
  ) {
    this.typeInfo = {
      id: Symbol('tea.struct.storage'),
      name: 'struct storage',
      bytesFor: args => args.logicalBytes,
      create: args =>
        Object.freeze({
          layout: args.layout,
          fields: Object.freeze([...args.fields]),
          logicalBytes: args.logicalBytes,
        }),
      trace: (payload, visit) => {
        const layout = this.requireLayout(payload.layout, 'stored struct');
        layout.fields.forEach((field, index) =>
          this.layouts.visitRefs(field.layout, payload.fields[index], visit),
        );
      },
      bytesOf: payload => payload.logicalBytes,
    };
  }

  newStruct(
    transaction: HeapTransaction,
    layoutId: LayoutId,
    fields: readonly Value[],
  ): StructRef {
    const layout = this.requireLayout(layoutId, 'constructor');
    if (fields.length !== layout.fields.length) {
      throw new ExecutionError(
        'VALUE_LAYOUT_MISMATCH',
        `constructor for '${layout.name}' received ${fields.length} fields, expected ${layout.fields.length}`,
      );
    }
    layout.fields.forEach((field, index) =>
      this.assertValue(
        field.layout,
        fields[index],
        `constructor '${layout.name}.${field.name}'`,
        transaction,
      ),
    );
    return transaction.allocate(this.typeInfo, {
      layout: layoutId,
      fields,
      logicalBytes:
        16 +
        layout.fields.reduce(
          (bytes, field) => bytes + this.layouts.shallowBytes(field.layout),
          0,
        ),
    });
  }

  requireStruct(
    value: Value,
    ownerLayout: LayoutId,
    reader: HeapReader = this.heap,
  ): StructRef {
    const layout = this.requireLayout(ownerLayout, 'struct receiver');
    if (value === null) {
      throw new ExecutionError(
        'NA_STRUCT_WRITE',
        `cannot mutate na struct '${layout.name}'`,
      );
    }
    this.assertRef(
      value,
      ownerLayout,
      `struct receiver '${layout.name}'`,
      reader,
    );
    return value as StructRef;
  }

  field(
    value: Value,
    ownerLayout: LayoutId,
    index: number,
    reader: HeapReader = this.heap,
  ): Value {
    const layout = this.requireLayout(ownerLayout, 'field read owner');
    const field = this.requireField(layout, index);
    if (value === null) {
      return this.layouts.empty(field.layout);
    }
    const ref = this.assertRef(
      value,
      ownerLayout,
      `field read '${layout.name}'`,
      reader,
    );
    return reader.read(ref).fields[index];
  }

  storeField(
    transaction: HeapTransaction,
    value: Value,
    ownerLayout: LayoutId,
    index: number,
    replacement: Value,
  ): void {
    const ref = this.requireStruct(value, ownerLayout, transaction);
    const layout = this.requireLayout(ownerLayout, 'field store owner');
    const field = this.requireField(layout, index);
    this.assertValue(
      field.layout,
      replacement,
      `field store '${layout.name}.${field.name}'`,
      transaction,
    );
    const payload = transaction.read(ref);
    const fields = [...payload.fields];
    fields[index] = replacement;
    transaction.write(
      ref,
      Object.freeze({
        layout: payload.layout,
        fields: Object.freeze(fields),
        logicalBytes: payload.logicalBytes,
      }),
    );
  }

  assertValue(
    id: LayoutId,
    value: Value,
    where = 'runtime value',
    reader: HeapReader = this.heap,
  ): void {
    this.layouts.assertValue(id, value, where);
    if (value === null) {
      return;
    }
    const layout = this.layouts.layout(id);
    if (layout.kind === 'struct') {
      this.assertRef(value, id, where, reader);
      return;
    }
    if (layout.kind === 'tuple') {
      if (!isTupleValue(value)) {
        return fatal(`validated tuple layout ${id} lost its tuple shape`);
      }
      layout.elements.forEach((element, index) =>
        this.assertValue(element, value[index], `${where}[${index}]`, reader),
      );
    }
  }

  private assertRef(
    value: Value,
    layoutId: LayoutId,
    where: string,
    reader: HeapReader,
  ): StructRef {
    if (!isStructRef(value)) {
      throw new ExecutionError(
        'VALUE_LAYOUT_MISMATCH',
        `${where} does not carry a struct reference`,
      );
    }
    const payload = reader.read(value as StructRef);
    if (payload.layout !== layoutId) {
      const expected = this.requireLayout(layoutId, where);
      throw new ExecutionError(
        'VALUE_LAYOUT_MISMATCH',
        `${where} references '${this.requireLayout(payload.layout, where).name}', expected '${expected.name}'`,
      );
    }
    return value as StructRef;
  }

  private requireLayout(
    id: LayoutId,
    where: string,
  ): Extract<ReturnType<ValueLayoutRegistry['layout']>, {kind: 'struct'}> {
    const layout = this.layouts.layout(id);
    if (layout.kind !== 'struct') {
      return fatal(`${where} layout ${id} is ${layout.kind}, expected struct`);
    }
    return layout;
  }

  private requireField(
    layout: Extract<
      ReturnType<ValueLayoutRegistry['layout']>,
      {kind: 'struct'}
    >,
    index: number,
  ): (typeof layout.fields)[number] {
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= layout.fields.length
    ) {
      return fatal(`field index ${index} is invalid for '${layout.name}'`);
    }
    return layout.fields[index];
  }
}
