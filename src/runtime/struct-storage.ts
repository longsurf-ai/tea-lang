// Purpose: Nominal struct storage over the unified Heap: fresh reference allocation, typed-empty reads, exact-layout validation, and journaled field mutation.

import {fatal} from '../base/print';
import {ExecutionError} from './errors';
import type {
  Heap,
  HeapTransaction,
  StorageDescriptor,
  StorageRef,
} from './heap';
import {isStructRef, isTupleValue, type Value} from './value';
import {
  type LayoutId,
  type StructLayoutId,
  ValueLayoutRegistry,
} from './value-layout';

export interface StructStorage {
  readonly layout: StructLayoutId;
  readonly fields: Value[];
  readonly logicalBytes: number;
}

interface StructStorageArgs {
  readonly layout: StructLayoutId;
  readonly fields: readonly Value[];
  readonly logicalBytes: number;
}

interface StructFieldEdit {
  readonly index: number;
  readonly fieldLayout: LayoutId;
  readonly value: Value;
}

export type StructRef = StorageRef<StructStorage>;

export class StructStorageRuntime {
  readonly descriptor: StorageDescriptor<
    StructStorage,
    StructStorageArgs,
    StructFieldEdit,
    Value
  >;

  constructor(
    private readonly heap: Heap,
    private readonly layouts: ValueLayoutRegistry,
  ) {
    this.descriptor = {
      id: Symbol('tea.struct.storage'),
      debugName: 'struct storage',
      logicalBytesFor: args => args.logicalBytes,
      create: args => ({
        layout: args.layout,
        fields: [...args.fields],
        logicalBytes: args.logicalBytes,
      }),
      trace: (payload, tracer) => {
        const layout = this.requireLayout(payload.layout, 'stored struct');
        layout.fields.forEach((field, index) =>
          this.layouts.visitStorageRefs(
            field.layout,
            payload.fields[index],
            ref => tracer.storage(ref),
          ),
        );
      },
      logicalBytes: payload => payload.logicalBytes,
      mutation: {
        prepare: (payload, edit) => {
          const layout = this.requireLayout(payload.layout, 'stored struct');
          const field = this.requireField(layout, edit.index);
          if (field.layout !== edit.fieldLayout) {
            return fatal(
              `struct field edit layout ${edit.fieldLayout} disagrees with '${layout.name}.${field.name}' layout ${field.layout}`,
            );
          }
          this.assertValue(
            field.layout,
            edit.value,
            `field store '${layout.name}.${field.name}'`,
          );
          return {key: edit.index, undo: payload.fields[edit.index]};
        },
        traceEdit: (edit, tracer) => {
          // prepare already proved the edit's field layout. The value walk is
          // type-neutral and checks every introduced StorageRef before apply.
          this.layouts.visitStorageRefs(edit.fieldLayout, edit.value, ref =>
            tracer.storage(ref),
          );
        },
        apply(payload, edit) {
          payload.fields[edit.index] = edit.value;
        },
        restore(payload, key, undo) {
          payload.fields[key as number] = undo;
        },
      },
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
      ),
    );
    return transaction.allocate(this.descriptor, {
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

  requireStruct(value: Value, ownerLayout: LayoutId): StructRef {
    const layout = this.requireLayout(ownerLayout, 'struct receiver');
    if (value === null) {
      throw new ExecutionError(
        'NA_STRUCT_WRITE',
        `cannot mutate na struct '${layout.name}'`,
      );
    }
    this.assertRef(value, ownerLayout, `struct receiver '${layout.name}'`);
    return value as StructRef;
  }

  field(value: Value, ownerLayout: LayoutId, index: number): Value {
    const layout = this.requireLayout(ownerLayout, 'field read owner');
    const field = this.requireField(layout, index);
    if (value === null) {
      return this.layouts.empty(field.layout);
    }
    const ref = this.assertRef(
      value,
      ownerLayout,
      `field read '${layout.name}'`,
    );
    return this.heap.read(ref, this.descriptor).fields[index];
  }

  storeField(
    transaction: HeapTransaction,
    value: Value,
    ownerLayout: LayoutId,
    index: number,
    replacement: Value,
  ): void {
    const ref = this.requireStruct(value, ownerLayout);
    const layout = this.requireLayout(ownerLayout, 'field store owner');
    this.requireField(layout, index);
    transaction.mutate(ref, this.descriptor, {
      index,
      fieldLayout: layout.fields[index].layout,
      value: replacement,
    });
  }

  assertValue(id: LayoutId, value: Value, where = 'runtime value'): void {
    this.layouts.assertValue(id, value, where);
    if (value === null) {
      return;
    }
    const layout = this.layouts.layout(id);
    if (layout.kind === 'struct') {
      this.assertRef(value, id, where);
      return;
    }
    if (layout.kind === 'tuple') {
      if (!isTupleValue(value)) {
        return fatal(`validated tuple layout ${id} lost its tuple shape`);
      }
      layout.elements.forEach((element, index) =>
        this.assertValue(element, value[index], `${where}[${index}]`),
      );
    }
  }

  private assertRef(
    value: Value,
    layoutId: LayoutId,
    where: string,
  ): StructRef {
    if (!isStructRef(value)) {
      throw new ExecutionError(
        'VALUE_LAYOUT_MISMATCH',
        `${where} does not carry a struct reference`,
      );
    }
    const payload = this.heap.read(value, this.descriptor);
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
