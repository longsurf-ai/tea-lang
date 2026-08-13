import {describe, expect, test} from 'bun:test';
import {expectedRelayedConfigHash, needsNodeGpuHost} from './node-host';

describe('Node GPU CLI host selection', () => {
  test('relays only GPU execution verbs', () => {
    expect(needsNodeGpuHost(['sweep', 'x.tea', '-i', 'x.csv'])).toBe(true);
    expect(needsNodeGpuHost(['sweep', 'x.tea', '-i', 'x.csv', '--cpu'])).toBe(
      false,
    );
    expect(needsNodeGpuHost(['run', 'x.tea', '--gpu'])).toBe(true);
    expect(needsNodeGpuHost(['run', 'x.tea'])).toBe(false);
    expect(
      needsNodeGpuHost(['execute', 'run.yaml'], {
        executionRuntime: 'webgpu',
      }),
    ).toBe(true);
    expect(
      needsNodeGpuHost(['execute', 'run.yaml'], {
        executionRuntime: 'javascript',
      }),
    ).toBe(false);
    expect(
      needsNodeGpuHost(['execute', '--help'], {
        executionRuntime: 'webgpu',
      }),
    ).toBe(false);
    expect(needsNodeGpuHost(['sweep', '--help'])).toBe(false);
  });

  test('exposes the private relayed config hash', () => {
    expect(
      expectedRelayedConfigHash({TEA_GPU_CONFIG_SHA256: 'a'.repeat(64)}),
    ).toBe('a'.repeat(64));
    expect(expectedRelayedConfigHash({})).toBeNull();
  });
});
