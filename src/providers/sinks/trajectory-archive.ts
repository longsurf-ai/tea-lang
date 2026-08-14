// Purpose: Compact, budgeted full-trajectory capture for lazy sweep drill-down.

import type {ExecutionBindingSummary} from '../../execute';
import type {SweepReportSnapshot} from '../../reporting/sweep';
import type {SweepCell} from '../../reporting/sweep';
import {
  buildTrajectoryResultFromColumns,
  normalizeTrajectoryValue,
  type TrajectoryEffectEmission,
  type TrajectoryResult,
} from '../../reporting/trajectory';
import type {
  EffectValue,
  EffectValueSchema,
  ExecutionDeclaration,
  OutputChannelTransport,
  OutputSink,
  RowPublication,
  Value,
} from '../../runtime/abi';

const DEFAULT_CHUNK_ROWS = 256;
const MAX_CHUNK_ROWS = 1 << 20;
const EFFECT_CHUNK_ENTRIES = 64;
const COLUMN_BYTES = 96;
const CHUNK_BYTES = 64;
const EFFECT_VALUE_BYTES = 24;
const MISSING = Symbol('missing trajectory value');

export interface TrajectoryArchiveOptions {
  // Maximum charged retained bytes. This is a deterministic capacity model,
  // not a claim about engine-specific JavaScript object RSS.
  readonly maxBytes: number;
  // Bounds one selected TrajectoryResult's expanded row arrays and logical
  // payloads. Defaults to maxBytes.
  readonly maxProjectionBytes?: number;
  readonly chunkRows?: number;
}

export class TrajectoryArchiveBudgetError extends Error {
  constructor(
    readonly maxBytes: number,
    readonly usedBytes: number,
    readonly requestedBytes: number,
  ) {
    super(
      `trajectory archive byte budget exceeded: ${usedBytes} used + ${requestedBytes} requested > ${maxBytes} maximum`,
    );
    this.name = 'TrajectoryArchiveBudgetError';
  }
}

export class TrajectoryArchiveUnsupportedTransportError extends Error {
  constructor(
    readonly outputId: number,
    readonly channel: number,
    readonly transport: OutputChannelTransport['kind'],
  ) {
    super(
      `trajectory archive does not support output ${outputId} channel ${channel} transport ${transport}`,
    );
    this.name = 'TrajectoryArchiveUnsupportedTransportError';
  }
}

export class TrajectoryArchiveProjectionBudgetError extends Error {
  constructor(
    readonly maxBytes: number,
    readonly estimatedBytes: number,
  ) {
    super(
      `trajectory projection requires an estimated ${estimatedBytes} bytes above the ${maxBytes} byte maximum`,
    );
    this.name = 'TrajectoryArchiveProjectionBudgetError';
  }
}

/**
 * Owns one strict charged-retention budget shared by all sweep executions.
 * Resetting the archive releases every child sink in creation order.
 */
export class TrajectoryArchive {
  readonly maxBytes: number;
  readonly maxProjectionBytes: number;
  readonly chunkRows: number;
  private readonly children: TrajectoryArchiveSink[] = [];
  private occupiedBytes = 0;

  constructor(options: TrajectoryArchiveOptions) {
    this.maxBytes = nonNegativeSafeInteger(options.maxBytes, 'maxBytes');
    this.maxProjectionBytes = nonNegativeSafeInteger(
      options.maxProjectionBytes ?? options.maxBytes,
      'maxProjectionBytes',
    );
    this.chunkRows = positiveSafeInteger(
      options.chunkRows ?? DEFAULT_CHUNK_ROWS,
      'chunkRows',
    );
    if (this.chunkRows > MAX_CHUNK_ROWS) {
      throw new Error(`chunkRows cannot exceed ${MAX_CHUNK_ROWS}`);
    }
  }

  get usedBytes(): number {
    return this.occupiedBytes;
  }

  createSink(): TrajectoryArchiveSink {
    const sink = new TrajectoryArchiveSink(this, this.chunkRows);
    this.children.push(sink);
    return sink;
  }

  reset(): void {
    for (const sink of this.children) sink.reset();
  }

  /** @internal Used only by archive-owned sinks. */
  reserve(bytes: number): void {
    bytes = nonNegativeSafeInteger(bytes, 'archive reservation');
    if (bytes > this.maxBytes - this.occupiedBytes) {
      throw new TrajectoryArchiveBudgetError(
        this.maxBytes,
        this.occupiedBytes,
        bytes,
      );
    }
    this.occupiedBytes += bytes;
  }

  /** @internal Used only by archive-owned sinks. */
  release(bytes: number): void {
    bytes = nonNegativeSafeInteger(bytes, 'archive release');
    if (bytes > this.occupiedBytes) {
      throw new Error('trajectory archive released more bytes than it owns');
    }
    this.occupiedBytes -= bytes;
  }

  /** @internal Checks expansion before a child creates result arrays. */
  assertProjection(bytes: number): void {
    bytes = nonNegativeSafeInteger(bytes, 'trajectory projection');
    if (bytes > this.maxProjectionBytes) {
      throw new TrajectoryArchiveProjectionBudgetError(
        this.maxProjectionBytes,
        bytes,
      );
    }
  }
}

/**
 * Captures one execution in row-aligned typed columns. A budget overflow is
 * terminal for this sink until reset, so callers can never consume a partial
 * trajectory after an allocation was refused.
 */
export class TrajectoryArchiveSink implements OutputSink {
  readonly capabilities = {denseRows: 'all', effects: 'all'} as const;
  private declaration: ExecutionDeclaration | null = null;
  private outputs: OutputArchive[] = [];
  private times: NumberColumn | null = null;
  private effects: EffectArchive | null = null;
  private rowCount = 0;
  private reservedBytes = 0;
  private failure: Error | null = null;

  constructor(
    private readonly archive: TrajectoryArchive,
    private readonly chunkRows: number,
  ) {}

  get bytesUsed(): number {
    return this.reservedBytes;
  }

  declare(declaration: ExecutionDeclaration): void {
    this.assertHealthy();
    if (this.declaration !== null) {
      throw new Error('trajectory archive sink was declared more than once');
    }
    assertSupportedDeclaration(declaration);
    const columns = declaration.outputs.reduce(
      (count, output) => count + output.spec.channels.length,
      0,
    );
    const declarationBytes = checkedAdd(
      estimateDeclarationBytes(declaration),
      checkedMultiply(columns + 1, COLUMN_BYTES, 'trajectory columns'),
      'trajectory declaration',
    );

    this.allocate(declarationBytes, () => {
      const cloned = cloneDeclaration(declaration);
      const outputs = cloned.outputs.map((output, outputId) => ({
        outputId,
        latestRow: -1,
        columns: output.spec.channels.map((channel, channelId) =>
          createColumn(
            this,
            channel.transport,
            this.chunkRows,
            outputId,
            channelId,
          ),
        ),
      }));
      this.declaration = cloned;
      this.outputs = outputs;
      this.times = new NumberColumn(this, this.chunkRows);
      this.effects = new EffectArchive(this);
    });
  }

  publish(publication: RowPublication): void {
    this.assertReady();
    if (publication.provisional) return;
    assertRow(publication.row);
    if (
      publication.time !== undefined &&
      publication.time !== null &&
      !Number.isSafeInteger(publication.time)
    ) {
      throw new Error(
        `trajectory timestamp at row ${publication.row} is not a safe integer`,
      );
    }

    this.times!.set(publication.row, publication.time ?? null);
    for (const emission of publication.outputs) {
      const output = this.outputs[emission.outputId];
      if (output === undefined) {
        throw new Error(
          `trajectory received unknown output ${emission.outputId}`,
        );
      }
      if (emission.channels.length !== output.columns.length) {
        throw new Error(
          `trajectory output ${emission.outputId} has ${emission.channels.length} channels; expected ${output.columns.length}`,
        );
      }
      emission.channels.forEach((value, channel) =>
        output.columns[channel]!.set(publication.row, value),
      );
      output.latestRow = publication.row;
    }
    for (const effect of publication.effects) {
      if (this.declaration!.effects[effect.effectId] === undefined) {
        throw new Error(
          `trajectory received unknown effect ${effect.effectId}`,
        );
      }
      this.effects!.push(publication.row, effect.effectId, effect.payload);
    }
    this.rowCount = Math.max(this.rowCount, publication.row + 1);
  }

  snapshot(bindingIndex: number): SweepReportSnapshot {
    this.assertReadable();
    assertBindingIndex(bindingIndex);
    const finalOutputs = this.outputs.flatMap(output =>
      output.latestRow < 0
        ? []
        : [this.denseOutputAt(output, output.latestRow)],
    );
    return {
      bindingIndex,
      declaration: cloneDeclaration(this.declaration!),
      rows: this.rowCount,
      finalOutputs,
    };
  }

  trajectory(
    binding: ExecutionBindingSummary,
    bindingIndex: number = binding.bindingIndex,
  ): TrajectoryResult {
    this.assertReadable();
    assertBindingIndex(bindingIndex);
    if (binding.rows !== this.rowCount) {
      throw new Error(
        `trajectory has ${this.rowCount} timestamps for ${binding.rows} rows`,
      );
    }
    this.archive.assertProjection(this.estimatedProjectionBytes());
    const times = Array.from({length: this.rowCount}, (_, row) => {
      const value = this.times!.get(row);
      return value === MISSING ? null : (value as number | null);
    });
    const values = this.outputs.flatMap(output =>
      output.columns.map(column =>
        Array.from({length: this.rowCount}, (_, row): SweepCell => {
          const value = column.get(row);
          return value === MISSING ? null : normalizeTrajectoryValue(value);
        }),
      ),
    );
    const effects: TrajectoryEffectEmission[] = this.effects!.values();
    return buildTrajectoryResultFromColumns(
      binding,
      {
        declaration: this.declaration!,
        times,
        values,
        effects,
      },
      bindingIndex,
    );
  }

  reset(): void {
    if (this.reservedBytes > 0) {
      this.archive.release(this.reservedBytes);
    }
    this.reservedBytes = 0;
    this.declaration = null;
    this.outputs = [];
    this.times = null;
    this.effects = null;
    this.rowCount = 0;
    this.failure = null;
  }

  /** @internal Reserves before constructing any retained archive storage. */
  allocate<T>(bytes: number, factory: () => T): T {
    try {
      this.archive.reserve(bytes);
    } catch (error) {
      if (error instanceof TrajectoryArchiveBudgetError) this.failure = error;
      throw error;
    }
    this.reservedBytes += bytes;
    try {
      return factory();
    } catch (error) {
      this.archive.release(bytes);
      this.reservedBytes -= bytes;
      this.failure =
        error instanceof Error
          ? error
          : new Error('trajectory allocation failed');
      throw error;
    }
  }

  /** @internal Charges retained variable-sized scalar/effect values. */
  retain(bytes: number): void {
    try {
      this.archive.reserve(bytes);
      this.reservedBytes += bytes;
    } catch (error) {
      if (error instanceof TrajectoryArchiveBudgetError) this.failure = error;
      throw error;
    }
  }

  private denseOutputAt(output: OutputArchive, row: number) {
    const values = output.columns.map(column => column.get(row));
    if (values.some(value => value === MISSING)) {
      throw new Error(
        `trajectory output ${output.outputId} is missing a channel at row ${row}`,
      );
    }
    return {
      row,
      outputId: output.outputId,
      channels: values as Value[],
    };
  }

  private estimatedProjectionBytes(): number {
    let bytes = checkedAdd(
      checkedAdd(
        512,
        estimateDeclarationBytes(this.declaration!),
        'trajectory schema projection',
      ),
      checkedMultiply(this.rowCount, 32, 'trajectory time projection'),
      'trajectory projection',
    );
    for (const output of this.outputs) {
      bytes = checkedAdd(bytes, 128, 'trajectory output projection');
      for (const column of output.columns) {
        bytes = checkedAdd(
          bytes,
          column.estimatedProjectionBytes(this.rowCount),
          'trajectory output projection',
        );
      }
    }
    return checkedAdd(
      bytes,
      this.effects!.estimatedProjectionBytes(),
      'trajectory effect projection',
    );
  }

  private assertHealthy(): void {
    if (this.failure !== null) {
      throw new Error(
        'trajectory archive sink failed and must be reset before reuse',
        {cause: this.failure},
      );
    }
  }

  private assertReady(): void {
    this.assertHealthy();
    if (this.declaration === null) {
      throw new Error('trajectory archive sink was used before declaration');
    }
  }

  private assertReadable(): void {
    this.assertReady();
  }
}

interface OutputArchive {
  readonly outputId: number;
  readonly columns: ScalarColumn[];
  latestRow: number;
}

interface ScalarColumn {
  set(row: number, value: Value): void;
  get(row: number): Value | typeof MISSING;
  estimatedProjectionBytes(rows: number): number;
}

interface ScalarChunk<T extends ArrayBufferView> {
  readonly values: T;
  readonly present: Uint8Array;
  readonly nulls: Uint8Array;
}

class NumberColumn implements ScalarColumn {
  private readonly chunks = new Map<number, ScalarChunk<Float64Array>>();

  constructor(
    private readonly owner: TrajectoryArchiveSink,
    private readonly chunkRows: number,
  ) {}

  set(row: number, value: Value): void {
    if (value !== null && typeof value !== 'number') {
      throw new Error(
        `trajectory numeric channel received ${valueType(value)}`,
      );
    }
    const {chunk, index} = this.writable(row);
    setBit(chunk.present, index, true);
    setBit(chunk.nulls, index, value === null);
    if (value !== null) chunk.values[index] = value;
  }

  get(row: number): Value | typeof MISSING {
    const location = this.readable(row);
    if (location === null || !getBit(location.chunk.present, location.index)) {
      return MISSING;
    }
    return getBit(location.chunk.nulls, location.index)
      ? null
      : location.chunk.values[location.index]!;
  }

  estimatedProjectionBytes(rows: number): number {
    return checkedAdd(
      64,
      checkedMultiply(rows, 32, 'numeric trajectory projection'),
      'numeric trajectory projection',
    );
  }

  private writable(row: number) {
    const chunkIndex = Math.floor(row / this.chunkRows);
    let chunk = this.chunks.get(chunkIndex);
    if (chunk === undefined) {
      const bits = bitBytes(this.chunkRows);
      const bytes = checkedAdd(
        checkedMultiply(
          this.chunkRows,
          Float64Array.BYTES_PER_ELEMENT,
          'numeric chunk',
        ),
        checkedAdd(bits * 2, CHUNK_BYTES, 'numeric validity'),
        'numeric chunk',
      );
      chunk = this.owner.allocate(bytes, () => ({
        values: new Float64Array(this.chunkRows),
        present: new Uint8Array(bits),
        nulls: new Uint8Array(bits),
      }));
      this.chunks.set(chunkIndex, chunk);
    }
    return {chunk, index: row % this.chunkRows};
  }

  private readable(row: number) {
    const chunk = this.chunks.get(Math.floor(row / this.chunkRows));
    return chunk === undefined ? null : {chunk, index: row % this.chunkRows};
  }
}

class BooleanColumn implements ScalarColumn {
  private readonly chunks = new Map<number, ScalarChunk<Uint8Array>>();

  constructor(
    private readonly owner: TrajectoryArchiveSink,
    private readonly chunkRows: number,
  ) {}

  set(row: number, value: Value): void {
    if (value !== null && typeof value !== 'boolean') {
      throw new Error(
        `trajectory boolean channel received ${valueType(value)}`,
      );
    }
    const {chunk, index} = this.writable(row);
    setBit(chunk.present, index, true);
    setBit(chunk.nulls, index, value === null);
    if (value !== null) setBit(chunk.values, index, value);
  }

  get(row: number): Value | typeof MISSING {
    const location = this.readable(row);
    if (location === null || !getBit(location.chunk.present, location.index)) {
      return MISSING;
    }
    return getBit(location.chunk.nulls, location.index)
      ? null
      : getBit(location.chunk.values, location.index);
  }

  estimatedProjectionBytes(rows: number): number {
    return checkedAdd(
      64,
      checkedMultiply(rows, 16, 'boolean trajectory projection'),
      'boolean trajectory projection',
    );
  }

  private writable(row: number) {
    const chunkIndex = Math.floor(row / this.chunkRows);
    let chunk = this.chunks.get(chunkIndex);
    if (chunk === undefined) {
      const bits = bitBytes(this.chunkRows);
      const bytes = checkedAdd(bits * 3, CHUNK_BYTES, 'boolean chunk');
      chunk = this.owner.allocate(bytes, () => ({
        values: new Uint8Array(bits),
        present: new Uint8Array(bits),
        nulls: new Uint8Array(bits),
      }));
      this.chunks.set(chunkIndex, chunk);
    }
    return {chunk, index: row % this.chunkRows};
  }

  private readable(row: number) {
    const chunk = this.chunks.get(Math.floor(row / this.chunkRows));
    return chunk === undefined ? null : {chunk, index: row % this.chunkRows};
  }
}

class StringColumn implements ScalarColumn {
  private readonly chunks = new Map<number, ScalarChunk<Uint32Array>>();
  private readonly ids = new Map<string, number>();
  private readonly values: string[] = [];

  constructor(
    private readonly owner: TrajectoryArchiveSink,
    private readonly chunkRows: number,
  ) {}

  set(row: number, value: Value): void {
    if (value !== null && typeof value !== 'string') {
      throw new Error(`trajectory string channel received ${valueType(value)}`);
    }
    const {chunk, index} = this.writable(row);
    setBit(chunk.present, index, true);
    setBit(chunk.nulls, index, value === null);
    if (value === null) return;
    let id = this.ids.get(value);
    if (id === undefined) {
      if (this.values.length >= 0xffff_ffff) {
        throw new Error(
          'trajectory string dictionary exceeded uint32 capacity',
        );
      }
      this.owner.retain(stringBytes(value));
      id = this.values.length;
      this.values.push(value);
      this.ids.set(value, id);
    }
    chunk.values[index] = id;
  }

  get(row: number): Value | typeof MISSING {
    const location = this.readable(row);
    if (location === null || !getBit(location.chunk.present, location.index)) {
      return MISSING;
    }
    if (getBit(location.chunk.nulls, location.index)) return null;
    const value = this.values[location.chunk.values[location.index]!];
    if (value === undefined) {
      throw new Error('trajectory string dictionary contains an unknown id');
    }
    return value;
  }

  estimatedProjectionBytes(rows: number): number {
    let bytes = checkedAdd(
      64,
      checkedMultiply(rows, 8, 'string trajectory projection'),
      'string trajectory projection',
    );
    for (let row = 0; row < rows; row += 1) {
      const value = this.get(row);
      if (typeof value === 'string') {
        bytes = checkedAdd(
          bytes,
          projectedStringBytes(value),
          'string trajectory projection',
        );
      }
    }
    return bytes;
  }

  private writable(row: number) {
    const chunkIndex = Math.floor(row / this.chunkRows);
    let chunk = this.chunks.get(chunkIndex);
    if (chunk === undefined) {
      const bits = bitBytes(this.chunkRows);
      const bytes = checkedAdd(
        checkedMultiply(
          this.chunkRows,
          Uint32Array.BYTES_PER_ELEMENT,
          'string chunk',
        ),
        checkedAdd(bits * 2, CHUNK_BYTES, 'string validity'),
        'string chunk',
      );
      chunk = this.owner.allocate(bytes, () => ({
        values: new Uint32Array(this.chunkRows),
        present: new Uint8Array(bits),
        nulls: new Uint8Array(bits),
      }));
      this.chunks.set(chunkIndex, chunk);
    }
    return {chunk, index: row % this.chunkRows};
  }

  private readable(row: number) {
    const chunk = this.chunks.get(Math.floor(row / this.chunkRows));
    return chunk === undefined ? null : {chunk, index: row % this.chunkRows};
  }
}

interface EffectChunk {
  readonly rows: Float64Array;
  readonly ids: Uint32Array;
  readonly payloads: (EffectValue | undefined)[];
  length: number;
}

class EffectArchive {
  private readonly chunks: EffectChunk[] = [];

  constructor(private readonly owner: TrajectoryArchiveSink) {}

  push(row: number, effectId: number, payload: EffectValue): void {
    if (
      !Number.isSafeInteger(effectId) ||
      effectId < 0 ||
      effectId > 0xffff_ffff
    ) {
      throw new Error(`trajectory has invalid effect id ${effectId}`);
    }
    let chunk = this.chunks.at(-1);
    if (chunk === undefined || chunk.length === EFFECT_CHUNK_ENTRIES) {
      const bytes =
        EFFECT_CHUNK_ENTRIES *
          (Float64Array.BYTES_PER_ELEMENT + Uint32Array.BYTES_PER_ELEMENT + 8) +
        CHUNK_BYTES;
      chunk = this.owner.allocate(bytes, () => ({
        rows: new Float64Array(EFFECT_CHUNK_ENTRIES),
        ids: new Uint32Array(EFFECT_CHUNK_ENTRIES),
        payloads: new Array<EffectValue | undefined>(EFFECT_CHUNK_ENTRIES),
        length: 0,
      }));
      this.chunks.push(chunk);
    }
    this.owner.retain(estimateEffectValueBytes(payload));
    const index = chunk.length;
    chunk.rows[index] = row;
    chunk.ids[index] = effectId;
    chunk.payloads[index] = cloneEffectValue(payload);
    chunk.length += 1;
  }

  values(): TrajectoryEffectEmission[] {
    const values: TrajectoryEffectEmission[] = [];
    for (const chunk of this.chunks) {
      for (let index = 0; index < chunk.length; index += 1) {
        values.push({
          row: chunk.rows[index]!,
          effectId: chunk.ids[index]!,
          payload: cloneEffectValue(chunk.payloads[index]!),
        });
      }
    }
    return values;
  }

  estimatedProjectionBytes(): number {
    let bytes = 64;
    for (const chunk of this.chunks) {
      for (let index = 0; index < chunk.length; index += 1) {
        bytes = checkedAdd(
          bytes,
          checkedAdd(
            96,
            checkedMultiply(
              estimateEffectProjectionBytes(chunk.payloads[index]!),
              2,
              'effect projection copies',
            ),
            'effect projection',
          ),
          'effect projection',
        );
      }
    }
    return bytes;
  }
}

function createColumn(
  owner: TrajectoryArchiveSink,
  transport: OutputChannelTransport,
  chunkRows: number,
  outputId: number,
  channelId: number,
): ScalarColumn {
  switch (transport.kind) {
    case 'int':
    case 'float':
      return new NumberColumn(owner, chunkRows);
    case 'bool':
      return new BooleanColumn(owner, chunkRows);
    case 'string':
    case 'color':
    case 'enum':
      return new StringColumn(owner, chunkRows);
    default:
      throw new TrajectoryArchiveUnsupportedTransportError(
        outputId,
        channelId,
        transport.kind,
      );
  }
}

function assertSupportedDeclaration(declaration: ExecutionDeclaration): void {
  declaration.outputs.forEach((output, outputId) => {
    output.spec.channels.forEach((channel, channelId) => {
      switch (channel.transport.kind) {
        case 'int':
        case 'float':
        case 'bool':
        case 'string':
        case 'color':
        case 'enum':
          return;
        default:
          throw new TrajectoryArchiveUnsupportedTransportError(
            outputId,
            channelId,
            channel.transport.kind,
          );
      }
    });
  });
}

function cloneDeclaration(
  declaration: ExecutionDeclaration,
): ExecutionDeclaration {
  return {
    outputs: declaration.outputs.map(output => ({
      spec: {
        ...output.spec,
        staticArgs: output.spec.staticArgs.map(arg => ({...arg})),
        channels: output.spec.channels.map(channel => ({
          ...channel,
          transport:
            channel.transport.kind === 'enum'
              ? {...channel.transport, members: [...channel.transport.members]}
              : {...channel.transport},
        })),
      },
      // Bound values may contain runtime heap/resource identity. Reporting
      // consumes only output specs, so the archive deliberately retains none.
      boundArgs: [],
    })),
    effects: declaration.effects.map(effect => ({
      payload: cloneEffectSchema(effect.payload),
    })),
  };
}

function cloneEffectSchema(schema: EffectValueSchema): EffectValueSchema {
  switch (schema.kind) {
    case 'enum':
      return {...schema, members: schema.members.map(member => ({...member}))};
    case 'user-type':
      return {
        ...schema,
        fields: schema.fields.map(field => ({
          name: field.name,
          value: cloneEffectSchema(field.value),
        })),
      };
    default:
      return {...schema};
  }
}

function cloneEffectValue(value: EffectValue): EffectValue {
  if (typeof value !== 'object' || value === null) return value;
  return {
    kind: 'user-type',
    fields: value.fields.map(cloneEffectValue),
  };
}

function estimateDeclarationBytes(declaration: ExecutionDeclaration): number {
  let bytes = 128;
  for (const output of declaration.outputs) {
    bytes = checkedAdd(
      bytes,
      128 + stringBytes(output.spec.effect),
      'output declaration',
    );
    for (const arg of output.spec.staticArgs) {
      bytes = checkedAdd(
        bytes,
        48 + stringBytes(arg.name) + estimateScalarBytes(arg.value),
        'static output argument',
      );
    }
    for (const channel of output.spec.channels) {
      bytes = checkedAdd(
        bytes,
        96 + stringBytes(channel.name) + stringBytes(channel.type),
        'output channel declaration',
      );
      if (channel.transport.kind === 'enum') {
        bytes = checkedAdd(
          bytes,
          stringBytes(channel.transport.name),
          'enum transport',
        );
        for (const member of channel.transport.members) {
          bytes = checkedAdd(
            bytes,
            stringBytes(member),
            'enum transport member',
          );
        }
      }
    }
  }
  for (const effect of declaration.effects) {
    bytes = checkedAdd(
      bytes,
      64 + estimateEffectSchemaBytes(effect.payload),
      'effect declaration',
    );
  }
  return bytes;
}

function estimateEffectSchemaBytes(schema: EffectValueSchema): number {
  let bytes = 48 + stringBytes(schema.kind);
  if (schema.kind === 'enum') {
    bytes += stringBytes(schema.typeId) + stringBytes(schema.displayName);
    for (const member of schema.members) {
      bytes += 48 + stringBytes(member.name) + stringBytes(member.title);
    }
  } else if (schema.kind === 'user-type') {
    bytes += stringBytes(schema.typeId) + stringBytes(schema.displayName);
    for (const field of schema.fields) {
      bytes +=
        48 + stringBytes(field.name) + estimateEffectSchemaBytes(field.value);
    }
  }
  return nonNegativeSafeInteger(bytes, 'effect schema');
}

function estimateEffectValueBytes(value: EffectValue): number {
  return estimateEffectValue(value, new Set<object>());
}

function estimateEffectProjectionBytes(value: EffectValue): number {
  if (typeof value === 'string') return projectedStringBytes(value);
  if (value === null || typeof value !== 'object') return 16;
  let bytes = 64;
  for (const field of value.fields) {
    bytes = checkedAdd(
      bytes,
      estimateEffectProjectionBytes(field),
      'effect projection',
    );
  }
  return bytes;
}

function estimateEffectValue(value: EffectValue, seen: Set<object>): number {
  if (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return EFFECT_VALUE_BYTES;
  }
  if (typeof value === 'string') return EFFECT_VALUE_BYTES + stringBytes(value);
  if (seen.has(value)) throw new Error('trajectory effect payload is cyclic');
  seen.add(value);
  let bytes = 48 + value.fields.length * 8;
  for (const field of value.fields) {
    bytes = checkedAdd(
      bytes,
      estimateEffectValue(field, seen),
      'effect payload',
    );
  }
  seen.delete(value);
  return bytes;
}

function estimateScalarBytes(value: string | number | boolean | null): number {
  return typeof value === 'string' ? stringBytes(value) : 16;
}

function stringBytes(value: string): number {
  return checkedAdd(
    32,
    checkedMultiply(value.length, 3, 'string payload'),
    'string payload',
  );
}

// JSON/string encoding can expand a UTF-16 code unit to a six-character
// escape. Charge that worst case per occurrence because result serialization
// repeats dictionary values even when retained storage does not.
function projectedStringBytes(value: string): number {
  return checkedAdd(
    32,
    checkedMultiply(value.length, 12, 'projected string payload'),
    'projected string payload',
  );
}

function bitBytes(rows: number): number {
  return Math.ceil(rows / 8);
}

function getBit(values: Uint8Array, index: number): boolean {
  return (values[index >> 3]! & (1 << (index & 7))) !== 0;
}

function setBit(values: Uint8Array, index: number, state: boolean): void {
  const byte = index >> 3;
  const mask = 1 << (index & 7);
  values[byte] = state ? values[byte]! | mask : values[byte]! & ~mask;
}

function assertRow(row: number): void {
  if (!Number.isSafeInteger(row) || row < 0) {
    throw new Error(`trajectory has invalid row ${row}`);
  }
}

function assertBindingIndex(bindingIndex: number): void {
  if (!Number.isSafeInteger(bindingIndex) || bindingIndex < 0) {
    throw new Error(`trajectory has invalid binding index ${bindingIndex}`);
  }
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function checkedAdd(left: number, right: number, name: string): number {
  const value = left + right;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} byte size exceeds the safe integer range`);
  }
  return value;
}

function checkedMultiply(left: number, right: number, name: string): number {
  const value = left * right;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} byte size exceeds the safe integer range`);
  }
  return value;
}

function valueType(value: Value): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'tuple';
  if (typeof value === 'object' && 'kind' in value) return value.kind;
  return typeof value;
}
