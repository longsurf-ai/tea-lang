// Purpose: Nominal user-value construction, typed-empty field reads, and immutable rooted field-path rebuilding.

import {fatal} from '../base/print';
import {ExecutionError} from './errors';
import {isUserTypeValue, type UserTypeValue, type Value} from './value';
import {type LayoutId, ValueLayoutRegistry} from './value-layout';

export function newUserValue(
  layouts: ValueLayoutRegistry,
  layoutId: LayoutId,
  fields: readonly Value[],
): UserTypeValue {
  const layout = layouts.layout(layoutId);
  if (layout.kind !== 'user-type') {
    return fatal(`layout ${layoutId} is not a user type`);
  }
  if (fields.length !== layout.fields.length) {
    throw new ExecutionError(
      'VALUE_LAYOUT_MISMATCH',
      `constructor for '${layout.name}' received ${fields.length} fields, expected ${layout.fields.length}`,
    );
  }
  layout.fields.forEach((field, index) =>
    layouts.assertValue(
      field.layout,
      fields[index],
      `constructor '${layout.name}'.${field.name}`,
    ),
  );
  return Object.freeze({
    kind: 'user-type',
    layout: layoutId,
    fields: Object.freeze([...fields]),
  });
}

export function userField(
  layouts: ValueLayoutRegistry,
  value: Value,
  ownerLayout: LayoutId,
  index: number,
): Value {
  const layout = layouts.layout(ownerLayout);
  if (layout.kind !== 'user-type') {
    return fatal(`field read owner layout ${ownerLayout} is not a user type`);
  }
  if (
    !Number.isSafeInteger(index) ||
    index < 0 ||
    index >= layout.fields.length
  ) {
    return fatal(`field index ${index} is invalid for '${layout.name}'`);
  }
  const field = layout.fields[index];
  if (value === null) {
    return layouts.empty(field.layout);
  }
  layouts.assertValue(ownerLayout, value, `field read '${layout.name}'`);
  if (!isUserTypeValue(value)) {
    return fatal(`validated field owner '${layout.name}' is not a user value`);
  }
  return value.fields[index];
}

export function rebuildUserPath(
  layouts: ValueLayoutRegistry,
  root: Value,
  rootLayout: LayoutId,
  fieldIndices: readonly number[],
  leaf: Value,
): Value {
  return rebuild(layouts, root, rootLayout, fieldIndices, 0, leaf);
}

function rebuild(
  layouts: ValueLayoutRegistry,
  current: Value,
  currentLayout: LayoutId,
  fields: readonly number[],
  depth: number,
  leaf: Value,
): Value {
  if (depth === fields.length) {
    layouts.assertValue(currentLayout, leaf, 'replacement value');
    return leaf;
  }
  const layout = layouts.layout(currentLayout);
  if (layout.kind !== 'user-type') {
    return fatal(
      `field path enters non-user layout ${currentLayout} at depth ${depth}`,
    );
  }
  if (current === null) {
    throw new ExecutionError(
      'NA_USER_VALUE_WRITE',
      `cannot write field of na user value '${layout.name}'`,
    );
  }
  layouts.assertValue(currentLayout, current, `field path '${layout.name}'`);
  if (!isUserTypeValue(current)) {
    return fatal(`validated field path '${layout.name}' is not a user value`);
  }
  const index = fields[depth];
  if (
    !Number.isSafeInteger(index) ||
    index < 0 ||
    index >= layout.fields.length
  ) {
    return fatal(`field index ${index} is invalid for '${layout.name}'`);
  }
  const field = layout.fields[index];
  const replacement = rebuild(
    layouts,
    current.fields[index],
    field.layout,
    fields,
    depth + 1,
    leaf,
  );
  const values = [...current.fields];
  values[index] = replacement;
  return Object.freeze({
    kind: 'user-type',
    layout: currentLayout,
    fields: Object.freeze(values),
  });
}
