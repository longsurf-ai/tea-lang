// Purpose: ABI value-layout registry — validates shallow runtime carriers, owns typed empties, and walks values to their Heap storage roots.

import {fatal} from '../base/print';
import {
  isArrayValue,
  isMapValue,
  isMatrixValue,
  isResourceHandle,
  isStructRef,
  isTupleValue,
  ValueClass,
  type Value,
  type ValueClass as ValueClassType,
} from './value';
import {ExecutionError} from './errors';
import type {StorageRef} from './heap';

export type LayoutId = number;
export type StructLayoutId = LayoutId;

export type ValueLayout =
  | {readonly kind: 'number'; readonly numeric: 'int' | 'float'}
  | {readonly kind: 'boolean'}
  | {
      readonly kind: 'nullable-scalar';
      readonly scalar: 'string' | 'color';
    }
  | {
      readonly kind: 'enum';
      readonly name: string;
      // Present when this physical layout backs a host-declared logical
      // value. It is checker-owned nominal identity, never a layout id.
      readonly typeId?: string;
      readonly members: readonly string[];
    }
  | {readonly kind: 'resource'; readonly handle: string}
  | {
      readonly kind: 'struct';
      readonly name: string;
      // See the enum case above. Ordinary internal-only layouts need no
      // nominal host identity.
      readonly typeId?: string;
      readonly fields: readonly {
        readonly name: string;
        readonly layout: LayoutId;
      }[];
    }
  | {readonly kind: 'array'; readonly element: LayoutId}
  | {readonly kind: 'matrix'; readonly element: LayoutId}
  | {
      readonly kind: 'map';
      readonly key: LayoutId;
      readonly value: LayoutId;
    }
  | {readonly kind: 'tuple'; readonly elements: readonly LayoutId[]};

export interface AggregateLayoutManifest {
  readonly layouts: readonly ValueLayout[];
}

function layoutId(id: number, length: number, where: string): void {
  if (!Number.isSafeInteger(id) || id < 0 || id >= length) {
    fatal(`${where} refers to invalid layout ${id}`);
  }
}

function sealLayout(layout: ValueLayout): ValueLayout {
  switch (layout.kind) {
    case 'number':
      return Object.freeze({kind: 'number', numeric: layout.numeric});
    case 'boolean':
      return Object.freeze({kind: 'boolean'});
    case 'nullable-scalar':
      return Object.freeze({kind: 'nullable-scalar', scalar: layout.scalar});
    case 'enum':
      return Object.freeze({
        kind: 'enum',
        name: layout.name,
        ...(layout.typeId === undefined ? {} : {typeId: layout.typeId}),
        members: Object.freeze([...layout.members]),
      });
    case 'resource':
      return Object.freeze({kind: 'resource', handle: layout.handle});
    case 'struct':
      return Object.freeze({
        kind: 'struct',
        name: layout.name,
        ...(layout.typeId === undefined ? {} : {typeId: layout.typeId}),
        fields: Object.freeze(
          layout.fields.map(field =>
            Object.freeze({name: field.name, layout: field.layout}),
          ),
        ),
      });
    case 'array':
      return Object.freeze({kind: 'array', element: layout.element});
    case 'matrix':
      return Object.freeze({kind: 'matrix', element: layout.element});
    case 'map':
      return Object.freeze({
        kind: 'map',
        key: layout.key,
        value: layout.value,
      });
    case 'tuple':
      return Object.freeze({
        kind: 'tuple',
        elements: Object.freeze([...layout.elements]),
      });
  }
}

export class ValueLayoutRegistry {
  readonly manifest: AggregateLayoutManifest;
  private readonly shallowByteCache = new Map<LayoutId, number>();

  constructor(manifest: AggregateLayoutManifest) {
    if (
      typeof manifest !== 'object' ||
      manifest === null ||
      !Array.isArray(manifest.layouts)
    ) {
      fatal('invalid aggregate layout manifest');
    }
    this.manifest = Object.freeze({
      // Generated module objects remain caller-owned. Clone and freeze the
      // registry so later mutation cannot change runtime type semantics.
      layouts: Object.freeze(manifest.layouts.map(sealLayout)),
    });
    this.validateManifest();
  }

  get length(): number {
    return this.manifest.layouts.length;
  }

  layout(id: LayoutId): ValueLayout {
    const layout = this.manifest.layouts[id];
    if (layout === undefined || !Number.isSafeInteger(id) || id < 0) {
      return fatal(`unknown runtime value layout ${id}`);
    }
    return layout;
  }

  empty(id: LayoutId): Value {
    return emptyValue(this.layout(id));
  }

  valueClass(id: LayoutId): ValueClassType {
    return valueClassOfLayout(this.layout(id));
  }

  assertValue(id: LayoutId, value: Value, where = 'runtime value'): void {
    const layout = this.layout(id);
    if (value === null) {
      if (layout.kind !== 'number' && layout.kind !== 'boolean') {
        return;
      }
      throw new ExecutionError(
        'VALUE_LAYOUT_MISMATCH',
        `${where} is null for non-nullable ${layout.kind} layout ${id}`,
      );
    }
    switch (layout.kind) {
      case 'number':
        // Runtime int/float values share the finite-or-na representation.
        // Host int inputs are safe integers, but finite arithmetic results may
        // exceed that domain and remain ordinary numeric values.
        if (
          typeof value !== 'number' ||
          (!Number.isFinite(value) && !Number.isNaN(value))
        ) {
          this.mismatch(where, id, layout.kind);
        }
        return;
      case 'boolean':
        if (typeof value !== 'boolean') {
          this.mismatch(where, id, layout.kind);
        }
        return;
      case 'nullable-scalar':
        if (typeof value !== 'string') {
          this.mismatch(where, id, layout.kind);
        }
        return;
      case 'enum':
        if (typeof value !== 'string' || !layout.members.includes(value)) {
          this.mismatch(where, id, `enum '${layout.name}'`);
        }
        return;
      case 'resource':
        if (!isResourceHandle(value) || value.handle !== layout.handle) {
          this.mismatch(where, id, `resource '${layout.handle}'`);
        }
        return;
      case 'struct':
        // Exact nominal layout and arena ownership need Heap metadata and are
        // checked by StructStorageRuntime. This registry validates only the
        // fixed-width carrier shape.
        if (!isStructRef(value)) {
          this.mismatch(where, id, `struct '${layout.name}'`);
        }
        return;
      case 'array':
        if (
          !isArrayValue(value) ||
          value.layout !== id ||
          !Number.isSafeInteger(value.length) ||
          value.length < 0 ||
          !Number.isSafeInteger(value.capacity) ||
          value.capacity < value.length
        ) {
          this.mismatch(where, id, 'array');
        }
        return;
      case 'matrix':
        if (
          !isMatrixValue(value) ||
          value.layout !== id ||
          !Number.isSafeInteger(value.rows) ||
          value.rows < 0 ||
          !Number.isSafeInteger(value.columns) ||
          value.columns < 0
        ) {
          this.mismatch(where, id, 'matrix');
        }
        return;
      case 'map':
        if (
          !isMapValue(value) ||
          value.layout !== id ||
          !Number.isSafeInteger(value.size) ||
          value.size < 0
        ) {
          this.mismatch(where, id, 'map');
        }
        return;
      case 'tuple':
        if (!isTupleValue(value) || value.length !== layout.elements.length) {
          this.mismatch(where, id, 'tuple');
        }
        layout.elements.forEach((element, index) =>
          this.assertValue(element, value[index], `${where}[${index}]`),
        );
    }
  }

  visitStorageRefs(
    id: LayoutId,
    value: Value,
    visit: (ref: StorageRef<unknown>) => void,
  ): void {
    this.assertValue(id, value);
    if (value === null) {
      return;
    }
    const layout = this.layout(id);
    switch (layout.kind) {
      case 'struct':
        if (!isStructRef(value)) {
          return fatal(`validated layout ${id} lost its struct-ref shape`);
        }
        visit(value);
        return;
      case 'array': {
        if (!isArrayValue(value)) {
          return fatal(`validated layout ${id} lost its array shape`);
        }
        visit(value.storage);
        return;
      }
      case 'matrix': {
        if (!isMatrixValue(value)) {
          return fatal(`validated layout ${id} lost its matrix shape`);
        }
        visit(value.storage);
        return;
      }
      case 'map': {
        if (!isMapValue(value)) {
          return fatal(`validated layout ${id} lost its map shape`);
        }
        visit(value.storage);
        return;
      }
      case 'tuple':
        if (!isTupleValue(value)) {
          return fatal(`validated layout ${id} lost its tuple shape`);
        }
        layout.elements.forEach((element, index) =>
          this.visitStorageRefs(element, value[index], visit),
        );
        return;
      case 'number':
      case 'boolean':
      case 'nullable-scalar':
      case 'enum':
      case 'resource':
        return;
    }
  }

  shallowBytes(id: LayoutId): number {
    const cached = this.shallowByteCache.get(id);
    if (cached !== undefined) {
      return cached;
    }
    const layout = this.layout(id);
    let bytes: number;
    switch (layout.kind) {
      case 'number':
      case 'boolean':
      case 'nullable-scalar':
      case 'enum':
      case 'resource':
        bytes = 8;
        break;
      case 'array':
        bytes = 32;
        break;
      case 'matrix':
        bytes = 32;
        break;
      case 'map':
        bytes = 24;
        break;
      case 'struct':
        bytes = 8;
        break;
      case 'tuple':
        bytes = layout.elements.reduce(
          (total, element) => total + this.shallowBytes(element),
          16,
        );
        break;
    }
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      return fatal(`value layout ${id} shallow size overflowed`);
    }
    this.shallowByteCache.set(id, bytes);
    return bytes;
  }

  private validateManifest(): void {
    const layouts = this.manifest.layouts;
    layouts.forEach((layout, id) => {
      switch (layout.kind) {
        case 'array':
        case 'matrix':
          layoutId(layout.element, layouts.length, `layout ${id}`);
          return;
        case 'map':
          layoutId(layout.key, layouts.length, `layout ${id}`);
          layoutId(layout.value, layouts.length, `layout ${id}`);
          return;
        case 'struct': {
          const names = new Set<string>();
          layout.fields.forEach(field => {
            if (names.has(field.name)) {
              fatal(`struct layout ${id} has duplicate field '${field.name}'`);
            }
            names.add(field.name);
            layoutId(
              field.layout,
              layouts.length,
              `layout ${id}.${field.name}`,
            );
          });
          return;
        }
        case 'tuple':
          layout.elements.forEach((element, index) =>
            layoutId(element, layouts.length, `layout ${id}[${index}]`),
          );
          return;
        case 'enum':
          if (new Set(layout.members).size !== layout.members.length) {
            fatal(`enum layout ${id} has duplicate members`);
          }
          return;
        case 'number':
        case 'boolean':
        case 'nullable-scalar':
        case 'resource':
          return;
      }
    });
    this.rejectInlineLayoutCycles();
  }

  private rejectInlineLayoutCycles(): void {
    const layouts = this.manifest.layouts;
    const complete = new Set<LayoutId>();
    const active = new Set<LayoutId>();
    const visit = (id: LayoutId): void => {
      if (complete.has(id)) {
        return;
      }
      if (active.has(id)) {
        return fatal(`value layout ${id} has an infinite inline cycle`);
      }
      active.add(id);
      const layout = layouts[id];
      // Collection headers and struct references are finite carriers, so
      // neither form inline-containment edges.
      if (layout.kind === 'tuple') {
        layout.elements.forEach(visit);
      }
      active.delete(id);
      complete.add(id);
    };
    layouts.forEach((_layout, id) => visit(id));
  }

  private mismatch(where: string, id: number, expected: string): never {
    throw new ExecutionError(
      'VALUE_LAYOUT_MISMATCH',
      `${where} does not match ${expected} layout ${id}`,
    );
  }
}

export function emptyValue(layout: ValueLayout): Value {
  switch (layout.kind) {
    case 'number':
      return NaN;
    case 'boolean':
      return false;
    case 'nullable-scalar':
    case 'enum':
    case 'resource':
    case 'struct':
    case 'array':
    case 'matrix':
    case 'map':
    case 'tuple':
      return null;
  }
}

export function valueClassOfLayout(layout: ValueLayout): ValueClassType {
  switch (layout.kind) {
    case 'number':
      return ValueClass.Numeric;
    case 'boolean':
      return ValueClass.Boolean;
    case 'nullable-scalar':
    case 'enum':
    case 'resource':
    case 'struct':
    case 'array':
    case 'matrix':
    case 'map':
    case 'tuple':
      return ValueClass.Nullable;
  }
}

export function visitRuntimeValueStorageRefs(
  value: Value,
  visit: (ref: StorageRef<unknown>) => void,
): void {
  if (value === null || typeof value !== 'object') {
    return;
  }
  if (isTupleValue(value)) {
    value.forEach(item => visitRuntimeValueStorageRefs(item, visit));
    return;
  }
  if (isStructRef(value)) {
    visit(value);
    return;
  }
  if (isArrayValue(value) || isMatrixValue(value) || isMapValue(value)) {
    visit(value.storage);
  }
}
