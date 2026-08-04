// Purpose: The Tea runtime kernel — implements the rt ABI and owns the main loop: binding, frame trees, ring allocation, the provisional/commit protocol, and emission flushing. docs/runtime.md is the authority.

import {fatal} from '../base/print';
import {Storage} from '../ir/node';
import {
  BindError,
  type BindInputs,
  type BoundProgram,
  type DepthSpec,
  type Frame,
  type FrameLayout,
  type Rt,
  type SeriesData,
  type TeaModule,
  type Value,
} from './abi';
import {Ring} from './ring';

// Bind a lowered module to parameter values, a data provider, and an output
// sink. Everything bind-time happens here: validation, series resolution,
// running the module's init section, sizing rings, declaring outputs.
export function bind(module: TeaModule, inputs: BindInputs): BoundProgram {
  if (module.abi !== 1) {
    throw new BindError(`unsupported module ABI ${String(module.abi)}`);
  }
  return new Kernel(module, inputs);
}

interface FrameImpl extends Frame {
  readonly fid: number;
  readonly layout: FrameLayout;
  readonly rings: Ring[];
  readonly subs: (FrameImpl | null)[];
}

type Phase = 'binding' | 'executing';

class Kernel implements Rt, BoundProgram {
  readonly rows: number;

  private phase: Phase = 'binding';
  private readonly paramValues: Value[] = [];
  private readonly seriesData: (SeriesData | null)[] = [];
  // Kernel-owned virtual series: the axis ordinal itself.
  private readonly barIndexSids = new Set<number>();
  // Bind-time depth reports from the module's init section.
  private readonly boundLocalDepths = new Map<string, number>();
  private readonly boundOutputArgs: {name: string; value: Value}[][];
  private readonly rootFrame: FrameImpl;

  // Main-loop state.
  private cursor = -1;
  private committedRows = 0;
  private executedRow = -1;
  private emitBuf = new Map<number, Value[]>();

  constructor(
    private readonly module: TeaModule,
    private readonly inputs: BindInputs,
  ) {
    const manifest = module.manifest;
    this.boundOutputArgs = manifest.outputs.map(() => []);

    this.bindParams();

    // Run the compiled bind-time expressions (bound depths, output
    // bind-args) before allocation: ring sizes may depend on them.
    this.module.init(this);

    this.bindSeries();
    this.phase = 'executing';

    this.inputs.sink.declare(
      manifest.outputs.map((spec, oid) => ({
        spec,
        boundArgs: this.boundOutputArgs[oid],
      })),
    );

    // One context, one axis: every series of a binding shares one row
    // space — the alignment CONTRACT sits on the DataProvider, and the
    // kernel refuses misaligned data instead of silently truncating.
    const provided = this.seriesData.filter(
      (data): data is SeriesData => data !== null,
    );
    const lengths = new Set(provided.map(data => data.length));
    if (lengths.size > 1) {
      throw new BindError(
        `provider series are not row-aligned (lengths ${[...lengths].join(', ')})`,
      );
    }
    this.rows = provided.length === 0 ? 0 : provided[0].length;

    this.rootFrame = this.newFrame(0);
  }

  // ---- binding --------------------------------------------------------------

  private bindParams(): void {
    const specs = this.module.manifest.params;
    const known = new Set(specs.map(spec => spec.name));
    for (const name of Object.keys(this.inputs.params)) {
      if (!known.has(name)) {
        throw new BindError(`unknown parameter '${name}'`);
      }
    }
    for (const spec of specs) {
      const provided = this.inputs.params[spec.name];
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
      this.paramValues.push(value);
    }
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
      // bar_index is the kernel's own axis ordinal, never provider data.
      if (id === 'bar_index') {
        this.barIndexSids.add(sid);
        this.seriesData.push(null);
        return;
      }
      const data = this.inputs.provider.series(id);
      if (data === null) {
        throw new BindError(`series '${id}' is not provided by this host`);
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
    this.resetFrameScratch(this.rootFrame, sameRow);
    this.emitBuf = new Map();
    this.module.main(this, this.rootFrame);
    this.flushEmissions(row, provisional);
  }

  commitRow(row: number): void {
    if (row !== this.executedRow || row !== this.committedRows) {
      return fatal(`commitRow(${row}) without a matching execute`);
    }
    this.commitFrame(this.rootFrame);
    this.committedRows = row + 1;
  }

  runAll(): void {
    for (let row = 0; row < this.rows; row += 1) {
      this.executeRow(row, false);
      this.commitRow(row);
    }
  }

  private flushEmissions(row: number, provisional: boolean): void {
    for (const [oid, channels] of this.emitBuf) {
      this.inputs.sink.emit(row, oid, channels, provisional);
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

  request(): Value {
    return fatal('request execution is not part of this slice');
  }

  root(): Frame {
    return this.rootFrame;
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

  private assertBinding(what: string): void {
    if (this.phase !== 'binding') {
      fatal(`${what} outside the module's init section`);
    }
  }
}
