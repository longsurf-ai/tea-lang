// Purpose: Prove TypeGPU can express every WebGPU capability required by the backtest experiment.

import tgpu, {d, std} from 'typegpu';

const SeriesDescriptor = d.struct({
  offset: d.u32,
  length: d.u32,
});

const CapabilitySummary = d.struct({
  sum: d.f32,
  eventCount: d.u32,
});

const CapabilityEvent = d.struct({
  jobIndex: d.u32,
  sequence: d.u32,
  barIndex: d.u32,
  value: d.f32,
});

const JournalState = d.struct({
  cursor: d.atomic(d.u32),
  overflow: d.atomic(d.u32),
  capacity: d.u32,
});

const capabilityLayout = tgpu.bindGroupLayout({
  values: {storage: d.arrayOf(d.f32), access: 'readonly'},
  series: {storage: d.arrayOf(SeriesDescriptor), access: 'readonly'},
  thresholds: {storage: d.arrayOf(d.f32), access: 'readonly'},
  summaries: {storage: d.arrayOf(CapabilitySummary), access: 'mutable'},
  events: {storage: d.arrayOf(CapabilityEvent), access: 'mutable'},
  journal: {storage: JournalState, access: 'mutable'},
});

const capabilityKernel = tgpu.computeFn({
  in: {gid: d.builtin.globalInvocationId},
  workgroupSize: [2, 1, 1],
})(({gid}) => {
  'use gpu';

  const parameterCount = std.arrayLength(capabilityLayout.$.thresholds);
  const seriesCount = std.arrayLength(capabilityLayout.$.series);
  if (gid.x >= parameterCount || gid.y >= seriesCount) {
    return;
  }

  const jobIndex = gid.y * parameterCount + gid.x;
  const descriptor = capabilityLayout.$.series[gid.y];
  const threshold = capabilityLayout.$.thresholds[gid.x];
  let sum = d.f32(0);
  let eventCount = d.u32(0);
  let sequence = d.u32(0);

  for (
    let barIndex = descriptor.offset;
    barIndex < descriptor.offset + descriptor.length;
    barIndex++
  ) {
    const value = capabilityLayout.$.values[barIndex];
    sum += value;
    if (value <= threshold) {
      continue;
    }

    const slot = std.atomicAdd(capabilityLayout.$.journal.cursor, 1);
    if (slot >= capabilityLayout.$.journal.capacity) {
      std.atomicStore(capabilityLayout.$.journal.overflow, 1);
      continue;
    }

    capabilityLayout.$.events[slot] = CapabilityEvent({
      jobIndex,
      sequence,
      barIndex,
      value,
    });
    eventCount++;
    sequence++;
  }

  capabilityLayout.$.summaries[jobIndex] = CapabilitySummary({
    sum,
    eventCount,
  });
});

export interface TypeGpuCapabilityResult {
  readonly events: readonly {
    readonly barIndex: number;
    readonly jobIndex: number;
    readonly sequence: number;
    readonly value: number;
  }[];
  readonly journal: {
    readonly capacity: number;
    readonly cursor: number;
    readonly overflow: number;
  };
  readonly summaries: readonly {
    readonly eventCount: number;
    readonly sum: number;
  }[];
}

export async function runTypeGpuCapabilitySmoke(
  device: GPUDevice,
): Promise<TypeGpuCapabilityResult> {
  const root = tgpu.initFromDevice({device});
  const values = root
    .createBuffer(d.arrayOf(d.f32, 6), [1, 2, 3, 4, 5, 6])
    .$usage('storage');
  const series = root
    .createBuffer(d.arrayOf(SeriesDescriptor, 2), [
      {offset: 0, length: 3},
      {offset: 3, length: 3},
    ])
    .$usage('storage');
  const thresholds = root
    .createBuffer(d.arrayOf(d.f32, 2), [2, 4])
    .$usage('storage');
  const summaries = root
    .createBuffer(d.arrayOf(CapabilitySummary, 4))
    .$usage('storage');
  const events = root
    .createBuffer(d.arrayOf(CapabilityEvent, 6))
    .$usage('storage');
  const journal = root
    .createBuffer(JournalState, {cursor: 0, overflow: 0, capacity: 6})
    .$usage('storage');
  const group = root.createBindGroup(capabilityLayout, {
    values,
    series,
    thresholds,
    summaries,
    events,
    journal,
  });
  const pipeline = root.createComputePipeline({compute: capabilityKernel});
  const encoder = device.createCommandEncoder({
    label: 'TypeGPU capability smoke',
  });

  pipeline.with(group).with(encoder).dispatchWorkgroups(1, 2, 1);
  device.queue.submit([encoder.finish()]);

  // TypeGPU 0.11.9's concurrent mapped-buffer readers can race Dawn cleanup on
  // Node 24/25. Sequential reads keep this public-API qualification probe safe.
  const summaryValues = await summaries.read();
  const eventValues = await events.read();
  const journalValue = await journal.read();
  root.destroy();

  return {
    summaries: summaryValues,
    events: eventValues.slice(0, journalValue.cursor),
    journal: journalValue,
  };
}
