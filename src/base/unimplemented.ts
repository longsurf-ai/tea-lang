// Purpose: Typed not-implemented failure for skeleton pipeline stages; carries the stage's inputs for debugging.

export class UnimplementedError extends Error {
  constructor(
    readonly stage: string,
    readonly stageInputs: readonly unknown[],
  ) {
    super(`${stage} is not implemented yet`);
    this.name = 'UnimplementedError';
  }
}

export function unimplemented(
  stage: string,
  ...stageInputs: readonly unknown[]
): never {
  throw new UnimplementedError(stage, stageInputs);
}
