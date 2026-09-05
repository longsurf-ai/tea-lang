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
import {Bool, DataType, Field, Float64, Schema, Utf8} from 'apache-arrow';

type FixtureManifest = Omit<
  ModuleManifest,
  'inputs' | 'series' | 'params' | 'outputs' | 'requests'
> & {
  readonly inputs?: Schema;
  readonly series: readonly (Omit<SeriesSpec, 'supplied'> & {
    readonly supplied?: boolean;
  })[];
  readonly params: readonly (ParamSpec & {
    readonly bindable?: boolean;
    readonly value?: ManifestValue;
    readonly active?: boolean | null;
  })[];
  readonly outputs: readonly (OutputSpec & {
    readonly layouts?: readonly number[];
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
    inputs:
      code.manifest.inputs ??
      new Schema(
        code.manifest.series.flatMap(series =>
          series.id === null
            ? []
            : [new Field(series.id, new Float64(), false)],
        ),
      ),
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
      layouts:
        output.layouts ??
        output.channels.map(field =>
          code.layout.findIndex(layout => {
            if (DataType.isFloat(field.type)) return layout.kind === 'number';
            if (DataType.isBool(field.type)) return layout.kind === 'boolean';
            if (DataType.isUtf8(field.type))
              return (
                layout.kind === 'nullable-scalar' || layout.kind === 'enum'
              );
            return (
              layout.kind === field.metadata.get('tea:type') &&
              (!('name' in layout) ||
                layout.name === field.metadata.get('tea:name'))
            );
          }),
        ),
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

/** A concise Arrow field for hand-authored scalar runtime fixtures. */
export function scalar(name: string, kind = 'float'): Field {
  return new Field(
    name,
    kind === 'bool'
      ? new Bool()
      : kind === 'string' || kind === 'color'
        ? new Utf8()
        : new Float64(),
    kind === 'string' || kind === 'color',
    new Map([['tea:type', kind]]),
  );
}
