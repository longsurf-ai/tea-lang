// Purpose: Target-neutral binding inputs and the bound Program lifecycle.

import type {OutputSink} from './output';
import type {DataProvider} from './provider';
import type {ParamSpec} from './schema';
import type {Value} from './value';

export interface BindInputs {
  readonly params: Readonly<Record<string, unknown>>;
  readonly provider: DataProvider;
  readonly sink: OutputSink;
  readonly timeNow: number;
  readonly symbol?: string;
  readonly timeframe?: string;
  readonly maxRequestContexts?: number;
  readonly maxCollectionElements?: number;
  readonly maxHeapStorageCells?: number;
  readonly maxHeapLogicalBytes?: number;
  readonly maxHeapTransientStorageCells?: number;
  readonly maxHeapTransientLogicalBytes?: number;
  readonly maxFixedValueLogicalBytes?: number;
}

export interface BoundInput {
  readonly spec: ParamSpec;
  readonly value: Value;
  readonly active: boolean;
}

/** Host control surface for one finite, provider-backed historical run. */
export interface FixedHistoryExecution {
  readonly rows: number;
  readonly inputs: readonly BoundInput[];
  executeRow(row: number, provisional: boolean): void;
  commitRow(row: number): void;
  dispose(): void;
  runAll(): Promise<void>;
}
