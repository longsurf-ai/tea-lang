// Purpose: Internal bridge from the minimal public BoundModule value to the
// generated code and immutable facts consumed by runtime construction.

import type {JSModule} from '../runtime/module-abi';
import type {BoundModule} from './binding';
import type {BoundModuleFacts} from '../runtime/module-binding';

interface BoundModuleState {
  readonly code: JSModule;
  readonly facts: BoundModuleFacts | null;
}

const states = new WeakMap<BoundModule, BoundModuleState>();

export function installBoundModuleState(
  module: BoundModule,
  code: JSModule,
  facts: BoundModuleFacts | null,
): void {
  states.set(module, {code, facts});
}

export function boundModuleCode(module: BoundModule): JSModule {
  const state = states.get(module);
  if (state === undefined) {
    throw new Error('foreign BoundModule implementation');
  }
  return state.code;
}

export function boundModuleFacts(
  module: BoundModule,
): BoundModuleFacts | null {
  const state = states.get(module);
  if (state === undefined) {
    throw new Error('foreign BoundModule implementation');
  }
  return state.facts;
}
