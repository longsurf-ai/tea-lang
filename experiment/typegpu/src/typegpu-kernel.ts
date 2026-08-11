// Purpose: Own the TypeGPU SMA sweep shader contract and its typed GPU resource layout.

import tgpu, {d, std} from 'typegpu';

export const GPU_BACKTEST_STATUS_INVALID = 0;
export const GPU_BACKTEST_STATUS_SUCCESS = 1;

export const GPU_EVENT_ORDER_SUBMITTED = 1;
export const GPU_EVENT_FILL = 2;
export const GPU_EVENT_ORDER_EXPIRED = 3;

export const GPU_SIDE_BUY = 1;
export const GPU_SIDE_SELL = 2;

export const TYPEGPU_SWEEP_WORKGROUP_SIZE = 64;

export const GpuSeriesDescriptor = d.struct({
  offset: d.u32,
  length: d.u32,
});

export const GpuParameterPair = d.struct({
  fastPeriod: d.u32,
  slowPeriod: d.u32,
});

export const GpuBacktestSettings = d.struct({
  initialCash: d.f32,
  slippageRate: d.f32,
  feeRate: d.f32,
  reserved: d.f32,
});

export const GpuBacktestSummary = d.struct({
  status: d.u32,
  seriesIndex: d.u32,
  parameterIndex: d.u32,
  eventCount: d.u32,
  finalEquity: d.f32,
  totalReturn: d.f32,
  maxDrawdown: d.f32,
  feesPaid: d.f32,
  orderCount: d.u32,
  fillCount: d.u32,
  roundTripCount: d.u32,
  reserved: d.u32,
});

export const GpuBacktestEvent = d.struct({
  jobIndex: d.u32,
  sequence: d.u32,
  barIndex: d.u32,
  kind: d.u32,
  side: d.u32,
  price: d.f32,
  quantity: d.f32,
  fee: d.f32,
});

export const GpuJournalState = d.struct({
  cursor: d.atomic(d.u32),
  overflow: d.atomic(d.u32),
  capacity: d.u32,
});

export const backtestSweepLayout = tgpu.bindGroupLayout({
  opens: {storage: d.arrayOf(d.f32), access: 'readonly'},
  closes: {storage: d.arrayOf(d.f32), access: 'readonly'},
  series: {storage: d.arrayOf(GpuSeriesDescriptor), access: 'readonly'},
  parameters: {storage: d.arrayOf(GpuParameterPair), access: 'readonly'},
  settings: {storage: GpuBacktestSettings, access: 'readonly'},
  summaries: {storage: d.arrayOf(GpuBacktestSummary), access: 'mutable'},
  events: {storage: d.arrayOf(GpuBacktestEvent), access: 'mutable'},
  journal: {storage: GpuJournalState, access: 'mutable'},
});

const appendBacktestEvent = tgpu.fn([
  d.u32,
  d.u32,
  d.u32,
  d.u32,
  d.u32,
  d.f32,
  d.f32,
  d.f32,
])((jobIndex, sequence, barIndex, kind, side, price, quantity, fee) => {
  'use gpu';

  const slot = std.atomicAdd(backtestSweepLayout.$.journal.cursor, 1);
  if (slot >= backtestSweepLayout.$.journal.capacity) {
    std.atomicStore(backtestSweepLayout.$.journal.overflow, 1);
    return;
  }

  backtestSweepLayout.$.events[slot] = GpuBacktestEvent({
    jobIndex,
    sequence,
    barIndex,
    kind,
    side,
    price,
    quantity,
    fee,
  });
});

export const backtestSweepKernel = tgpu.computeFn({
  in: {gid: d.builtin.globalInvocationId},
  workgroupSize: [TYPEGPU_SWEEP_WORKGROUP_SIZE, 1, 1],
})(({gid}) => {
  'use gpu';

  const parameterCount = std.arrayLength(backtestSweepLayout.$.parameters);
  const seriesCount = std.arrayLength(backtestSweepLayout.$.series);
  if (gid.x >= parameterCount || gid.y >= seriesCount) {
    return;
  }

  const parameterIndex = gid.x;
  const seriesIndex = gid.y;
  const jobIndex = seriesIndex * parameterCount + parameterIndex;
  const descriptor = backtestSweepLayout.$.series[seriesIndex];
  const parameter = backtestSweepLayout.$.parameters[parameterIndex];
  const settings = backtestSweepLayout.$.settings;

  if (
    descriptor.length === 0 ||
    parameter.fastPeriod === 0 ||
    parameter.slowPeriod === 0 ||
    parameter.fastPeriod >= parameter.slowPeriod ||
    parameter.slowPeriod > descriptor.length
  ) {
    backtestSweepLayout.$.summaries[jobIndex] = GpuBacktestSummary({
      status: GPU_BACKTEST_STATUS_INVALID,
      seriesIndex,
      parameterIndex,
      eventCount: 0,
      finalEquity: settings.initialCash,
      totalReturn: 0,
      maxDrawdown: 0,
      feesPaid: 0,
      orderCount: 0,
      fillCount: 0,
      roundTripCount: 0,
      reserved: 0,
    });
    return;
  }

  let cash = settings.initialCash;
  let quantity = d.f32(0);
  let feesPaid = d.f32(0);
  let finalEquity = settings.initialCash;
  let peakEquity = settings.initialCash;
  let maxDrawdown = d.f32(0);
  let fastSum = d.f32(0);
  let slowSum = d.f32(0);
  let previousFast = d.f32(0);
  let previousSlow = d.f32(0);
  let hasPreviousSma = d.u32(0);
  let isLong = d.u32(0);
  let pendingSide = d.u32(0);
  let orderCount = d.u32(0);
  let fillCount = d.u32(0);
  let roundTripCount = d.u32(0);
  let eventCount = d.u32(0);
  let sequence = d.u32(0);

  for (
    let localBarIndex = d.u32(0);
    localBarIndex < descriptor.length;
    localBarIndex++
  ) {
    const barIndex = descriptor.offset + localBarIndex;
    const open = backtestSweepLayout.$.opens[barIndex];
    const close = backtestSweepLayout.$.closes[barIndex];

    if (pendingSide === GPU_SIDE_BUY) {
      const fillPrice = open * (d.f32(1) + settings.slippageRate);
      const buyQuantity = cash / (fillPrice * (d.f32(1) + settings.feeRate));
      const grossCost = buyQuantity * fillPrice;
      const fee = grossCost * settings.feeRate;
      cash -= grossCost + fee;
      quantity = buyQuantity;
      feesPaid += fee;
      isLong = 1;
      pendingSide = 0;
      fillCount++;
      appendBacktestEvent(
        jobIndex,
        sequence,
        localBarIndex,
        GPU_EVENT_FILL,
        GPU_SIDE_BUY,
        fillPrice,
        buyQuantity,
        fee,
      );
      sequence++;
      eventCount++;
    } else if (pendingSide === GPU_SIDE_SELL) {
      const fillPrice = open * (d.f32(1) - settings.slippageRate);
      const sellQuantity = quantity;
      const grossProceeds = sellQuantity * fillPrice;
      const fee = grossProceeds * settings.feeRate;
      cash += grossProceeds - fee;
      quantity = 0;
      feesPaid += fee;
      isLong = 0;
      pendingSide = 0;
      fillCount++;
      roundTripCount++;
      appendBacktestEvent(
        jobIndex,
        sequence,
        localBarIndex,
        GPU_EVENT_FILL,
        GPU_SIDE_SELL,
        fillPrice,
        sellQuantity,
        fee,
      );
      sequence++;
      eventCount++;
    }

    fastSum += close;
    slowSum += close;
    if (localBarIndex >= parameter.fastPeriod) {
      fastSum -= backtestSweepLayout.$.closes[barIndex - parameter.fastPeriod];
    }
    if (localBarIndex >= parameter.slowPeriod) {
      slowSum -= backtestSweepLayout.$.closes[barIndex - parameter.slowPeriod];
    }

    if (localBarIndex + 1 >= parameter.slowPeriod) {
      const fastSma = fastSum / d.f32(parameter.fastPeriod);
      const slowSma = slowSum / d.f32(parameter.slowPeriod);

      if (hasPreviousSma === 1) {
        const bullishCross = previousFast <= previousSlow && fastSma > slowSma;
        const bearishCross = previousFast >= previousSlow && fastSma < slowSma;

        if (isLong === 0 && bullishCross) {
          pendingSide = GPU_SIDE_BUY;
          orderCount++;
          appendBacktestEvent(
            jobIndex,
            sequence,
            localBarIndex,
            GPU_EVENT_ORDER_SUBMITTED,
            GPU_SIDE_BUY,
            0,
            0,
            0,
          );
          sequence++;
          eventCount++;
        } else if (isLong === 1 && bearishCross) {
          pendingSide = GPU_SIDE_SELL;
          orderCount++;
          appendBacktestEvent(
            jobIndex,
            sequence,
            localBarIndex,
            GPU_EVENT_ORDER_SUBMITTED,
            GPU_SIDE_SELL,
            0,
            0,
            0,
          );
          sequence++;
          eventCount++;
        }
      }

      previousFast = fastSma;
      previousSlow = slowSma;
      hasPreviousSma = 1;
    }

    finalEquity = cash + quantity * close;
    if (finalEquity > peakEquity) {
      peakEquity = finalEquity;
    } else {
      const drawdown = (peakEquity - finalEquity) / peakEquity;
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
      }
    }
  }

  if (pendingSide !== 0) {
    appendBacktestEvent(
      jobIndex,
      sequence,
      descriptor.length - 1,
      GPU_EVENT_ORDER_EXPIRED,
      pendingSide,
      0,
      0,
      0,
    );
    eventCount++;
  }

  backtestSweepLayout.$.summaries[jobIndex] = GpuBacktestSummary({
    status: GPU_BACKTEST_STATUS_SUCCESS,
    seriesIndex,
    parameterIndex,
    eventCount,
    finalEquity,
    totalReturn: finalEquity / settings.initialCash - d.f32(1),
    maxDrawdown,
    feesPaid,
    orderCount,
    fillCount,
    roundTripCount,
    reserved: 0,
  });
});
