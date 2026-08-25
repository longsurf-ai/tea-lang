// Purpose: Internal bridge from the minimal public BoundModule value to the
// generated code and immutable facts consumed by runtime construction.

import type {TeaModule} from '../runtime/module-abi';
import type {BoundModule} from './binding';
import type {BoundModuleFacts} from '../runtime/module-binding';

interface BoundModuleState {
  readonly code: TeaModule;
  readonly facts: BoundModuleFacts | null;
}

const states = new WeakMap<BoundModule, BoundModuleState>();

export function installBoundModuleState(
  module: BoundModule,
  code: TeaModule,
  facts: BoundModuleFacts | null,
): void {
  states.set(module, {code, facts});
}

export function boundModuleCode(module: BoundModule): TeaModule {
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
