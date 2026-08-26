// Purpose: Test-only builders for hand-authored generated-module fixtures.

import type {
  JSModule,
  ModuleManifest,
  RequestSpec,
  SeriesSpec,
} from './module-abi';
import {initializeModuleTree} from './module-binding';
import type {OutputSpec} from './output';
import type {ParamSpec} from './schema';
import type {ManifestValue, Value} from './value';

type FixtureManifest = Omit<
  ModuleManifest,
  'series' | 'params' | 'outputs' | 'requests'
> & {
  readonly series: readonly (Omit<SeriesSpec, 'supplied'> & {
    readonly supplied?: boolean;
  })[];
  readonly params: readonly (ParamSpec & {
    readonly bindable?: boolean;
    readonly value?: ManifestValue;
    readonly active?: boolean | null;
  })[];
  readonly outputs: readonly (OutputSpec & {
    readonly boundArgs?:
      | readonly {readonly name: string; readonly value: Value}[]
      | null;
  })[];
  readonly requests: readonly (Omit<
    RequestSpec,
    'context' | 'name' | 'resultLayout'
  > & {
    readonly context?: RequestSpec['context'];
    readonly name?: string;
    readonly resultLayout?: number;
  })[];
};

type GeneratedModuleFixture = Omit<
  Pick<
    JSModule,
    'abi' | 'layout' | 'manifest' | 'requests' | 'concretize' | 'funcs' | 'main'
  >,
  'manifest' | 'concretize'
> & {
  readonly manifest: FixtureManifest;
  readonly concretize?: JSModule['concretize'];
};

/**
 * Normalize concise hand-authored fixtures into the concrete-manifest ABI.
 * Runtime tests start with supplied series and statically complete declarations
 * unless a fixture explicitly models an incomplete field.
 */
export function testModule(code: GeneratedModuleFixture): JSModule {
  const manifest: ModuleManifest = {
    ...code.manifest,
    series: code.manifest.series.map(series => ({
      ...series,
      supplied: series.supplied ?? true,
    })),
    params: code.manifest.params.map(param => ({
      ...param,
      bindable: param.bindable ?? true,
      active: param.active ?? true,
    })),
    outputs: code.manifest.outputs.map(output => ({
      ...output,
      boundArgs: output.boundArgs === undefined ? [] : output.boundArgs,
    })),
    requests: code.manifest.requests.map((request, requestId) => ({
      ...request,
      name: request.name ?? `request@${requestId}`,
      resultLayout: request.resultLayout ?? request.layout,
      context: request.context ?? null,
    })),
  };
  return initializeModuleTree({
    ...code,
    manifest,
    concretize: code.concretize ?? (() => {}),
  });
}
