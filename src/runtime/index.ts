// Public typed execution library, independent of the Tea frontend and Node host.
export {Module} from './module-binding';
export {Color} from './color';
export {Context, type StepInput, type StepResult} from './js/context';
export {Input, Series} from './js/series';
export {
  type Value,
  type Numeric,
  int,
  float,
  bool,
  text,
  color,
  enumeration,
  resource,
  struct,
  array,
  matrix,
  map,
  tuple,
} from './js/value';
export * from './native';
export {decodeSchema, encodeSchema, cloneSchema} from './io';
export {outputSchema} from './output';
export type {Ref} from './js/heap';
export type {ArrayValue, MatrixValue, MapValue, ResourceHandle} from './value';

export {RUNTIME_ABI_VERSION, type Frame} from './module-abi';

export {
  Schema,
  Field,
  Float64,
  Uint8,
  Bool,
  Utf8,
  List,
  Struct,
  Map_,
  TimestampMillisecond,
} from 'apache-arrow';
