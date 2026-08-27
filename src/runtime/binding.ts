// Purpose: Canonical concrete parameter values exposed after binding.

import type {ParamSpec} from './schema';
import type {Value} from './value';

export interface BoundInput {
  readonly spec: ParamSpec;
  readonly value: Value;
  readonly active: boolean;
}
