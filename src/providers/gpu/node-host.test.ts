import {describe, expect, test} from 'bun:test';
import {needsNodeGpuHost} from './node-host';

describe('Node GPU CLI host selection', () => {
  test('relays only GPU execution verbs', () => {
    expect(needsNodeGpuHost(['sweep', 'x.tea', '-i', 'x.csv'])).toBe(true);
    expect(needsNodeGpuHost(['sweep', 'x.tea', '-i', 'x.csv', '--cpu'])).toBe(
      false,
    );
    expect(needsNodeGpuHost(['run', 'x.tea', '--gpu'])).toBe(true);
    expect(needsNodeGpuHost(['run', 'x.tea'])).toBe(false);
    expect(needsNodeGpuHost(['sweep', '--help'])).toBe(false);
  });
});
