// Purpose: The JS runtime — implements the Runtime ABI and owns the main loop: binding, frame trees, ring allocation, request-child scheduling, the provisional/commit protocol, and emission flushing. docs/runtime.md and docs/requests.md are the authorities.

import {fatal} from '../base/print';
import {Storage} from '../ir/node';
import {
  BindError,
  isContextError,
  type BindInputs,
  type BoundProgram,
  type ContextError,
  type DataProvider,
  type DepthSpec,
  type Frame,
  type FrameLayout,
  type ModuleCode,
  type ModuleManifest,
  type OutputSink,
  type ProviderContext,
  type RangeDemand,
  type Runtime,
  type SeriesData,
  type TeaModule,
  type Value,
} from './abi';
import {sampleMergeMap} from './merge';
import {Ring} from './ring';

// Slice scope: static requests resolve their full extent at bind; range
// narrowing (depth demands, calc_bars_count) is a later refinement.
const FULL_RANGE: RangeDemand = {from: null, to: null, bars: null};

// Bind a lowered module to parameter values, a data provider, and an output
// sink. Everything bind-time happens here: validation, context resolution,
// running the module's init section, request-child execution and merge,
// sizing rings, declaring outputs. Async because context resolution is the
// seam where drivers fetch; the per-row hot path never awaits.
export async function bind(
  module: TeaModule,
  inputs: BindInputs,
): Promise<BoundProgram> {
  if (module.abi !== 1) {
    throw new BindError(`unsupported module ABI ${String(module.abi)}`);
  }
  const symbol = inputs.symbol ?? '';
  const timeframe = inputs.timeframe ?? '';
  const context = await inputs.provider.resolveContext(
    symbol,
    timeframe,
    FULL_RANGE,
  );
  if (isContextError(context)) {
    throw new BindError(formatContextError('primary context', context));
  }
  const params = resolveParams(module.manifest, inputs.params);
  const rt = new JSRuntime(
    module,
    inputs.provider,
    inputs.sink,
    context,
    params,
  );
  await rt.bindRequests();
  rt.finishBind();
  return rt;
}

function formatContextError(what: string, error: ContextError): string {
  return `${what}: ${error.error} (${error.detail})`;
}

// Param resolution is a pure function of the manifest and the host's raw
// values; request children skip it — bind-time params are compilation-global
// and children inherit the parent's resolved values.
function resolveParams(
  manifest: ModuleManifest,
  raw: Readonly<Record<string, Value>>,
): Value[] {
  const specs = manifest.params;
  const known = new Set(specs.map(spec => spec.name));
  for (const name of Object.keys(raw)) {
    if (!known.has(name)) {
      throw new BindError(`unknown parameter '${name}'`);
    }
  }
  const values: Value[] = [];
  for (const spec of specs) {
    const provided = raw[spec.name];
    const value = provided !== undefined ? provided : spec.defaultValue;
    if (spec.type === 'int' || spec.type === 'float') {
      if (typeof value !== 'number') {
        throw new BindError(`parameter '${spec.name}' expects a number`);
      }
      if (spec.type === 'int' && !Number.isInteger(value)) {
        throw new BindError(`parameter '${spec.name}' expects an integer`);
      }
      const c = spec.constraints;
      if (c !== null) {
        if (c.minval !== null && value < c.minval) {
          throw new BindError(
            `parameter '${spec.name}' below minval ${c.minval}`,
          );
        }
        if (c.maxval !== null && value > c.maxval) {
          throw new BindError(
            `parameter '${spec.name}' above maxval ${c.maxval}`,
          );
        }
      }
    } else if (spec.type === 'bool' && typeof value !== 'boolean') {
      throw new BindError(`parameter '${spec.name}' expects a boolean`);
    } else if (
      (spec.type === 'string' ||
        spec.type === 'color' ||
        spec.type === 'source') &&
      typeof value !== 'string'
    ) {
      throw new BindError(`parameter '${spec.name}' expects a string`);
    }
    const c = spec.constraints;
    if (
      c !== null &&
      c.options !== null &&
      !c.options.some(option => option === value)
    ) {
      throw new BindError(
        `parameter '${spec.name}' must be one of ${c.options.map(String).join(', ')}`,
      );
    }
    values.push(value);
  }
  return values;
}

interface FrameImpl extends Frame {
  readonly fid: number;
  readonly layout: FrameLayout;
  readonly rings: Ring[];
  readonly subs: (FrameImpl | null)[];
}

// A merged request result: a parent-row-indexed view. Slice A materializes
// the mapping plus the child's result column; the contract (docs/requests.md)
// is the view, so a zero-copy mapping over child storage can replace this
// without touching the ABI.
interface MergedView {
  at(row: number): Value;
}

type Phase = 'binding' | 'executing';

class JSRuntime implements Runtime, BoundProgram {
  readonly rows: number;

  private phase: Phase = 'binding';
  private readonly paramValues: readonly Value[];
  private readonly seriesData: (SeriesData | null)[] = [];
  // Runtime-owned virtual series: the axis ordinal itself.
  private readonly barIndexSids = new Set<number>();
  // Bind-time depth reports from the module's init section.
  private readonly boundLocalDepths = new Map<string, number>();
  private readonly boundOutputArgs: {name: string; value: Value}[][];
  // Static request pairs declared by init (rt.bindRequest), then the merged
  // views bindRequests() builds from them.
  private readonly requestPairs = new Map<
    number,
    {symbol: string; timeframe: string}
  >();
  private readonly requestViews: MergedView[] = [];
  private rootFrame: FrameImpl | null = null;

  // Main-loop state.
  private cursor = -1;
  private committedRows = 0;
  private executedRow = -1;
  private emitBuf = new Map<number, Value[]>();

  // The runtime instance for one module against one resolved context —
  // request children recurse through the same class with a null sink and
  // the parent's resolved params.
  constructor(
    private readonly module: ModuleCode,
    private readonly provider: DataProvider,
    private readonly sink: OutputSink | null,
    private readonly context: ProviderContext,
    params: readonly Value[],
  ) {
    this.paramValues = params;
    this.boundOutputArgs = module.manifest.outputs.map(() => []);

    // Run the compiled bind-time expressions (bound depths, output
    // bind-args, static request contexts) before allocation: ring sizes may
    // depend on them, and request pairs must be known before bindRequests.
    this.module.init(this);

    this.bindSeries();

    // One context, one axis: the context owns the row space, and every
    // series it serves must fill it — the runtime refuses misaligned data
    // instead of silently truncating.
    this.rows = context.rows;
    this.seriesData.forEach((data, sid) => {
      if (data !== null && data.length !== this.rows) {
        throw new BindError(
          `series ${sid} has ${data.length} rows, context has ${this.rows}`,
        );
      }
    });
  }

  // ---- binding --------------------------------------------------------------

  // Resolve every static request edge: fetch the child context, bind and run
  // the child over its full history, and build the merged view. Recursion
  // handles nested requests; all awaits happen here, before row 0.
  async bindRequests(): Promise<void> {
    const specs = this.module.manifest.requests;
    for (let rid = 0; rid < specs.length; rid += 1) {
      const spec = specs[rid];
      const naValue = spec.ref ? null : NaN;
      const pair = this.requestPairs.get(rid);
      if (pair === undefined) {
        return fatal(`request ${rid} was never declared by init`);
      }
      const what = `request '${pair.symbol}','${pair.timeframe}'`;
      const resolved = await this.provider.resolveContext(
        pair.symbol,
        pair.timeframe,
        FULL_RANGE,
      );
      if (isContextError(resolved)) {
        const invalidSymbol =
          resolved.error === 'unknownSymbol' ||
          resolved.error === 'unknownSource';
        if (spec.merge.ignoreInvalidSymbol && invalidSymbol) {
          this.requestViews.push({at: () => naValue});
          continue;
        }
        throw new BindError(formatContextError(what, resolved));
      }

      const parentAxis = this.context.axis;
      const childAxis = resolved.axis;
      if (parentAxis === null || childAxis === null) {
        throw new BindError(
          `${what}: merge requires a time axis on both contexts` +
            " (a csv context needs a 'time' column)",
        );
      }

      const child = new JSRuntime(
        this.module.requests[rid],
        this.provider,
        null,
        resolved,
        this.paramValues,
      );
      await child.bindRequests();
      child.finishBind();

      // The child runs its full history now; each committed result lands in
      // the column the merged view reads through.
      const values: Value[] = [];
      const childRoot = child.root();
      for (let row = 0; row < child.rows; row += 1) {
        child.executeRow(row, false);
        values.push(child.read(childRoot, spec.resultSlot, 0));
        child.commitRow(row);
      }

      const map = sampleMergeMap(
        parentAxis,
        this.rows,
        childAxis,
        child.rows,
        spec.merge,
      );
      this.requestViews.push({
        at: row => {
          const childRow = map[row];
          return childRow < 0 ? naValue : values[childRow];
        },
      });
    }
  }

  // The bind barrier: everything after this is the synchronous execution
  // phase — outputs declared, program frame allocated, no more awaits.
  finishBind(): void {
    this.phase = 'executing';
    if (this.sink !== null) {
      this.sink.declare(
        this.module.manifest.outputs.map((spec, oid) => ({
          spec,
          boundArgs: this.boundOutputArgs[oid],
        })),
      );
    }
    this.rootFrame = this.newFrame(0);
  }

  private mustRoot(): FrameImpl {
    if (this.rootFrame === null) {
      return fatal('execution before finishBind');
    }
    return this.rootFrame;
  }

  private bindSeries(): void {
    const manifest = this.module.manifest;
    manifest.series.forEach((spec, sid) => {
      let id = spec.id;
      if (id === null) {
        const param = manifest.params.find(p => p.seriesSid === sid);
        if (param === undefined) {
          return fatal(`series slot ${sid} has neither host id nor param`);
        }
        id = this.paramValues[manifest.params.indexOf(param)] as string;
      }
      // bar_index is the runtime's own axis ordinal, never provider data.
      if (id === 'bar_index') {
        this.barIndexSids.add(sid);
        this.seriesData.push(null);
        return;
      }
      const data = this.context.series(id);
      if (data === null) {
        throw new BindError(`series '${id}' is not provided by this context`);
      }
      this.seriesData.push(data);
    });
  }

  // ---- frames ---------------------------------------------------------------

  private newFrame(fid: number): FrameImpl {
    const layout = this.module.manifest.frames[fid];
    if (layout === undefined) {
      return fatal(`module has no frame layout ${fid}`);
    }
    const frame: FrameImpl = {
      kind: 'frame',
      fid,
      layout,
      rings: layout.locals.map((local, slot) =>
        this.newRing(fid, slot, local.ref, local.storage, local.depth),
      ),
      subs: layout.subs.map(() => null),
    };
    // A frame created mid-execution seeds its scratch immediately (its
    // first execution is the current one).
    if (this.phase === 'executing' && this.cursor >= 0) {
      this.resetFrameScratch(frame, false);
    }
    return frame;
  }

  private newRing(
    fid: number,
    slot: number,
    ref: boolean,
    storage: string,
    depth: DepthSpec,
  ): Ring {
    let keep: number;
    switch (depth.kind) {
      case 'none':
        keep = 0;
        break;
      case 'const':
      case 'capped':
        keep = depth.bars;
        break;
      case 'bound': {
        const bound = this.boundLocalDepths.get(`${fid}:${slot}`);
        if (bound === undefined) {
          return fatal(
            `bound depth for frame ${fid} slot ${slot} was never reported by init`,
          );
        }
        keep = bound;
        break;
      }
    }
    // var/varip must retain at least the last committed value: the next
    // row's scratch seeds from it even when the body never reads history.
    if (storage === Storage.Var || storage === Storage.Varip) {
      keep = Math.max(keep, 1);
    }
    return new Ring(keep, ref ? null : NaN);
  }

  // Execution-start scratch protocol (docs/runtime.md): perBar resets to na;
  // var/varip seed from the last committed value — and until anything is
  // committed, their init thunks re-run each execution (a provisional first
  // row rolls back to its initializer). varip alone keeps its scratch
  // across same-row re-executions.
  private resetFrameScratch(frame: FrameImpl, sameRow: boolean): void {
    frame.layout.locals.forEach((local, slot) => {
      const ring = frame.rings[slot];
      if (local.storage === Storage.Varip && sameRow) {
        return;
      }
      if (local.storage === Storage.Var || local.storage === Storage.Varip) {
        if (ring.hasCommitted()) {
          ring.resetScratch(ring.lastCommitted());
          return;
        }
        ring.resetScratch(ring.naValue);
        const thunk = this.module.inits[`${frame.fid}:${slot}`];
        if (thunk !== undefined) {
          ring.setScratch(thunk(this, frame));
        }
        return;
      }
      ring.resetScratch(ring.naValue);
    });
    for (const sub of frame.subs) {
      if (sub !== null) {
        this.resetFrameScratch(sub, sameRow);
      }
    }
  }

  private commitFrame(frame: FrameImpl): void {
    for (const ring of frame.rings) {
      ring.commit();
    }
    for (const sub of frame.subs) {
      if (sub !== null) {
        this.commitFrame(sub);
      }
    }
  }

  // ---- main loop ------------------------------------------------------------

  executeRow(row: number, provisional: boolean): void {
    if (row !== this.committedRows) {
      return fatal(
        `executeRow(${row}) out of order: next committable row is ${this.committedRows}`,
      );
    }
    const sameRow = this.executedRow === row;
    this.cursor = row;
    this.executedRow = row;
    this.resetFrameScratch(this.mustRoot(), sameRow);
    this.emitBuf = new Map();
    this.module.main(this, this.mustRoot());
    this.flushEmissions(row, provisional);
  }

  commitRow(row: number): void {
    if (row !== this.executedRow || row !== this.committedRows) {
      return fatal(`commitRow(${row}) without a matching execute`);
    }
    this.commitFrame(this.mustRoot());
    this.committedRows = row + 1;
  }

  runAll(): void {
    for (let row = 0; row < this.rows; row += 1) {
      this.executeRow(row, false);
      this.commitRow(row);
    }
  }

  private flushEmissions(row: number, provisional: boolean): void {
    if (this.sink === null) {
      return;
    }
    for (const [oid, channels] of this.emitBuf) {
      this.sink.emit(row, oid, channels, provisional);
    }
  }

  // ---- rt surface -----------------------------------------------------------

  series(sid: number, offset: number): number {
    const index = this.cursor - offset;
    if (this.barIndexSids.has(sid)) {
      return index < 0 ? NaN : index;
    }
    const data = this.seriesData[sid];
    if (data === null || index < 0 || index >= data.length) {
      return NaN;
    }
    return data.at(index);
  }

  param(pid: number): Value {
    return this.paramValues[pid];
  }

  read(fr: Frame, slot: number, offset: number): Value {
    return (fr as FrameImpl).rings[slot].at(offset);
  }

  write(fr: Frame, slot: number, v: Value): void {
    (fr as FrameImpl).rings[slot].setScratch(v);
  }

  request(rid: number, offset: number): Value {
    const view = this.requestViews[rid];
    if (view === undefined) {
      return fatal(`request ${rid} has no merged view`);
    }
    const index = this.cursor - offset;
    const spec = this.module.manifest.requests[rid];
    if (index < 0) {
      return spec.ref ? null : NaN;
    }
    return view.at(index);
  }

  root(): Frame {
    return this.mustRoot();
  }

  frame(fr: Frame, slot: number): Frame {
    const impl = fr as FrameImpl;
    const existing = impl.subs[slot];
    if (existing !== null) {
      return existing;
    }
    const spec = impl.layout.subs[slot];
    if (spec === undefined) {
      return fatal(`frame ${impl.fid} has no call-site slot ${slot}`);
    }
    const created = this.newFrame(spec.fid);
    impl.subs[slot] = created;
    return created;
  }

  emit(oid: number, channel: number, v: Value): void {
    let channels = this.emitBuf.get(oid);
    if (channels === undefined) {
      const spec = this.module.manifest.outputs[oid];
      channels = new Array<Value>(spec.channels.length).fill(NaN);
      this.emitBuf.set(oid, channels);
    }
    channels[channel] = v;
  }

  bindDepth(fid: number, slot: number, bars: number): void {
    this.assertBinding('bindDepth');
    this.boundLocalDepths.set(`${fid}:${slot}`, bars);
  }

  bindSeriesDepth(sid: number, bars: number): void {
    this.assertBinding('bindSeriesDepth');
    // A contract to the provider, not an allocation: recorded for hosts
    // that page history; the csv provider ignores it.
    void sid;
    void bars;
  }

  bindOutput(oid: number, argName: string, v: Value): void {
    this.assertBinding('bindOutput');
    this.boundOutputArgs[oid].push({name: argName, value: v});
  }

  bindRequest(rid: number, symbol: Value, timeframe: Value): void {
    this.assertBinding('bindRequest');
    if (typeof symbol !== 'string' || typeof timeframe !== 'string') {
      throw new BindError(
        `request ${rid}: symbol and timeframe must bind to strings`,
      );
    }
    this.requestPairs.set(rid, {symbol, timeframe});
  }

  private assertBinding(what: string): void {
    if (this.phase !== 'binding') {
      fatal(`${what} outside the module's init section`);
    }
  }
}
