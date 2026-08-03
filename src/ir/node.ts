// Purpose: Tea IR node definitions — the mid-end vocabulary between noder and codegen; placeholder until lowering lands.

export interface IrNodeBase<K extends string = string> {
  readonly kind: K;
}

// Placeholder: real IR node kinds land with the noder.
export type IrNode = IrNodeBase;

export interface IrProgram {
  readonly nodes: readonly IrNode[];
}
