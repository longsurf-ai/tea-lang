// Purpose: Test-only builders for hand-authored generated-module fixtures.

import type {
  DepthSpec,
  JSModule,
  JSModuleBinding,
} from './module-abi';

interface StaticBindingOverrides {
  readonly retention?: Partial<JSModuleBinding['retention']>;
  readonly activeParams?: JSModuleBinding['activeParams'];
  readonly outputs?: JSModuleBinding['outputs'];
  readonly requests?: JSModuleBinding['requests'];
}

/** Build binding data for a hand-authored module with statically known depth. */
export function staticModuleBinding(
  module: Pick<JSModule, 'manifest'>,
  overrides: StaticBindingOverrides = {},
): JSModuleBinding {
  const manifest = module.manifest;
  return {
    retention: {
      frames:
        overrides.retention?.frames ??
        manifest.frames.map(frame => frame.locals.map(local => bars(local.depth))),
      series:
        overrides.retention?.series ??
        manifest.series.map(series => bars(series.depth)),
      builtins:
        overrides.retention?.builtins ??
        manifest.builtin.map(builtin => bars(builtin.depth)),
      requests:
        overrides.retention?.requests ??
        manifest.requests.map(request => bars(request.depth)),
    },
    activeParams:
      overrides.activeParams ?? manifest.params.map(() => true),
    outputs: overrides.outputs ?? manifest.outputs.map(() => []),
    requests: overrides.requests ?? [],
  };
}

function bars(depth: DepthSpec): number {
  switch (depth.kind) {
    case 'none':
      return 0;
    case 'const':
    case 'capped':
      return Number.isSafeInteger(depth.bars) && depth.bars >= 0
        ? depth.bars
        : 0;
    case 'bound':
      throw new Error('hand-authored bound depth requires a retention override');
  }
}
