// Purpose: GPU preparation consumes concrete arrays and derives physical resources.

import {DataType, Field, Struct, Utf8} from 'apache-arrow';
import {encodeSchema} from '../io';
import {loadModule} from '../load';
import {outputFields, publicationSchema} from '../output';
import {RUNTIME_ABI_VERSION} from '../module-abi';
import {GPU_ARTIFACT_ABI_VERSION} from '../../gpu/contract';
import {describe, expect, test} from 'vitest';
import {compileProgramToWgsl} from '../../codegen/wgsl';
import type {CompiledWgslProgram} from '../../gpu/contract';
import {mustBuild} from '../../noder/testing';
import {OutputCapture} from '../../testing/output';
import {
  GpuBindingError,
  prepareGpuExecutionInputs,
  type GpuBinding,
} from './session';

function strategyArtifact(): CompiledWgslProgram {
  const result = compileProgramToWgsl(
    mustBuild(
      [
        'strategy("GPU session")',
        'for i = 0 to 19',
        '    effect.emit(open + i)',
        'var float sum = 0',
        'sum := sum + close',
        'plot(sum)',
      ].join('\n'),
    ),
  );
  if (result.status !== 'compiled') {
    throw new Error(JSON.stringify(result.eligibility.issues));
  }
  return result.artifact;
}

function parameterArtifact(): CompiledWgslProgram {
  const result = compileProgramToWgsl(
    mustBuild(
      [
        'strategy("parameters")',
        'enum Mode',
        '    fast = "Fast"',
        '    slow = "Slow"',
        'length = input.int(2, minval=1, maxval=5)',
        'scale = input.float(1.5)',
        'enabled = input.bool(true)',
        'mode = input.enum(Mode.fast)',
        'plot(enabled and mode == Mode.fast ? close * length + scale : 0)',
      ].join('\n'),
    ),
  );
  if (result.status !== 'compiled') {
    throw new Error(JSON.stringify(result.eligibility.issues));
  }
  return result.artifact;
}

function binding(
  series: Readonly<Record<string, readonly number[]>>,
  params: Readonly<Record<string, unknown>> = {},
): GpuBinding {
  return {
    params,
    indices: Object.values(series)[0]?.length ?? 0,
    series,
    sink: new OutputCapture(),
  };
}

describe('GPU execution preparation', () => {
  test('retains real Arrow schemas across JSON artifact transport', async () => {
    const artifact: CompiledWgslProgram = JSON.parse(
      JSON.stringify(strategyArtifact()),
    );
    const fields = outputFields(
      loadModule(artifact.bindingModule.source).outputs.schema,
    );
    const field = fields[1]!.type.children[0]!;
    expect(artifact.abi).toBe(GPU_ARTIFACT_ABI_VERSION);
    expect(field).toBeInstanceOf(Field);
    expect(DataType.isFloat(field.type)).toBe(true);
    expect(field.type.toString()).toBe('Float64');
    expect(field.metadata.get('tea:type')).toBe('float');
    expect(
      fields[artifact.events[0]!.outputId]!.type.children[0]!.type.children[1]!
        .name,
    ).toBe('payload');
    await expect(
      prepareGpuExecutionInputs(artifact, [binding({open: [1], close: [2]})]),
    ).resolves.toMatchObject({chunkRows: 1});
  });

  test('rejects stale artifacts and logical types that disagree with physical codecs', async () => {
    const artifact = strategyArtifact();
    await expect(
      prepareGpuExecutionInputs(
        {...artifact, abi: 4} as unknown as CompiledWgslProgram,
        [],
      ),
    ).rejects.toThrow(/ABI|abi/);
    const fields = outputFields(
      loadModule(artifact.bindingModule.source).outputs.schema,
    );
    const output = fields[1]!;
    const channel = output.type.children[0]!;
    const schema = publicationSchema(
      fields.map((field, id) =>
        id === 1
          ? output.clone({
              type: new Struct([channel.clone({type: new Utf8()})]),
            })
          : field,
      ),
    );
    const broken = {
      ...artifact,
      bindingModule: {
        ...artifact.bindingModule,
        source: `const module = (function(){${artifact.bindingModule.source}})(); module.outputs.schema = ${JSON.stringify(encodeSchema(schema))}; return module;`,
      },
    };
    await expect(prepareGpuExecutionInputs(broken, [])).rejects.toThrow(
      'disagrees with result cell',
    );
  });

  test('packs concrete series in binding and artifact order', async () => {
    const artifact = strategyArtifact();
    const first = binding({open: [10, 11, 12], close: [20, 21, 22]});
    const second = binding({open: [30, 31, 32], close: [40, 41, 42]});

    const prepared = await prepareGpuExecutionInputs(artifact, [first, second]);

    expect(prepared.chunkRows).toBe(3);
    expect(prepared.effectCapacity).toBe(60);
    expect(
      prepared.executions.map(execution => execution.seriesOffset),
    ).toEqual([0, 6]);
    expect(
      prepared.executions.map(execution => execution.resultCapacity),
    ).toEqual([3, 3]);
    expect(prepared.resources.total).toBeGreaterThan(0);
  });

  test('resolves parameters from one concrete binding', async () => {
    const artifact = parameterArtifact();
    const prepared = await prepareGpuExecutionInputs(artifact, [
      binding(
        {close: [10, 20]},
        {length: 4, scale: 2.25, enabled: false, mode: 'slow'},
      ),
    ]);

    expect(
      prepared.executions[0]?.boundInputs.map(input => input.value),
    ).toEqual([4, 2.25, false, 'slow']);
  });

  test('rejects invalid defaults and job values through module binding', async () => {
    const artifact = parameterArtifact();
    await expect(
      prepareGpuExecutionInputs(artifact, [binding({close: [1]}, {length: 0})]),
    ).rejects.toThrow("parameter 'length' below minval 1");
    await expect(
      prepareGpuExecutionInputs(artifact, [
        binding({close: [1]}, {unknown: 1}),
      ]),
    ).rejects.toThrow("unknown parameter 'unknown'");
    const broken = {
      ...artifact,
      params: artifact.params.map((parameter, id) =>
        id === 0 ? {...parameter, defaultValue: 0} : parameter,
      ),
      bindingModule: {
        ...artifact.bindingModule,
        source: `const module = (function(){${artifact.bindingModule.source}})(); module.parameters[0].defaultValue = 0; return module;`,
      },
    };
    await expect(prepareGpuExecutionInputs(broken, [])).rejects.toThrow(
      "parameter 'length' below minval 1",
    );
  });

  test('sizes each binding and call site from its own concrete state', async () => {
    const compiled = compileProgramToWgsl(
      mustBuild(
        [
          'lag = input.int(3, minval=0, maxval=8)',
          'previous(float value) => value[lag]',
          'var float total = 0',
          'total += close',
          'left = previous(close)',
          'right = previous(open)',
          'plot(left + right + total)',
        ].join('\n'),
      ),
    );
    if (compiled.status !== 'compiled')
      throw new Error(JSON.stringify(compiled.eligibility.issues));
    const artifact = compiled.artifact;
    const prepared = await prepareGpuExecutionInputs(artifact, [
      binding({close: [1, 2, 3, 4, 5], open: [1, 2, 3, 4, 5]}, {lag: 4}),
      binding({close: [1, 2], open: [1, 2]}, {lag: 8}),
    ]);
    expect(
      prepared.executions.map(execution =>
        execution.stateDescriptors.map(local => local.capacity),
      ),
    ).toEqual([
      [1, 4, 4],
      [1, 2, 2],
    ]);
    const [first, second] = prepared.executions;
    expect(second!.stateOffset).toBe(first!.stateWords);
    expect(first!.stateWords - second!.stateWords).toBe(8);
  });

  test('rejects stale embedded modules and divergent parameter contracts', async () => {
    const artifact = parameterArtifact();
    const stale = artifact.bindingModule.source.replace(
      `abi: ${RUNTIME_ABI_VERSION}`,
      'abi: 8',
    );
    expect(stale).not.toBe(artifact.bindingModule.source);
    await expect(
      prepareGpuExecutionInputs(
        {
          ...artifact,
          bindingModule: {...artifact.bindingModule, source: stale},
        },
        [],
      ),
    ).rejects.toThrow(/ABI|abi/);
    await expect(
      prepareGpuExecutionInputs(
        {
          ...artifact,
          params: artifact.params.map((param, id) =>
            id === 0 ? {...param, name: 'other'} : param,
          ),
        },
        [],
      ),
    ).rejects.toThrow('binding module disagrees with the GPU artifact');
    await expect(
      prepareGpuExecutionInputs(
        {
          ...artifact,
          paramActive: artifact.paramActive.map(active => !active),
        },
        [binding({close: [1]})],
      ),
    ).rejects.toThrow(
      'generated bind results disagree with the artifact parameter contract',
    );
  });

  test('rejects missing or misaligned concrete series', async () => {
    const artifact = strategyArtifact();
    await expect(
      prepareGpuExecutionInputs(artifact, [binding({close: [1, 2]})]),
    ).rejects.toThrow("missing required series 'open'");

    await expect(
      prepareGpuExecutionInputs(artifact, [
        {
          ...binding({open: [1, 2], close: [3, 4]}),
          series: {open: [1], close: [3, 4]},
        },
      ]),
    ).rejects.toThrow("series 'open' has 1 values; expected 2");
  });

  test('validates finite index and time lengths', async () => {
    const artifact = parameterArtifact();
    await expect(
      prepareGpuExecutionInputs(artifact, [
        {...binding({close: [1]}), indices: -1},
      ]),
    ).rejects.toBeInstanceOf(GpuBindingError);
    await expect(
      prepareGpuExecutionInputs(artifact, [
        {...binding({close: [1, 2]}), time: [100]},
      ]),
    ).rejects.toThrow('has 1 times for 2 indices');
  });

  test('keeps zero-index executions allocation-free', async () => {
    const artifact = parameterArtifact();
    const prepared = await prepareGpuExecutionInputs(artifact, [
      {params: {}, indices: 0, series: {close: []}, sink: new OutputCapture()},
    ]);

    expect(prepared.chunkRows).toBe(0);
    expect(prepared.resources.total).toBe(0);
  });
});
