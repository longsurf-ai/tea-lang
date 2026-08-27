// Purpose: Shared executable contract for configured Tea runs.

/**
 * A Tea run whose program, inputs, outputs, and execution rules have already
 * been chosen.
 *
 * A Recipe keeps those choices together so the same kind of run does not have
 * to be wired by hand each time. Calling `execute()` carries out that wiring
 * through Tea's public Node API.
 *
 * @typeParam R - The value returned after the run finishes.
 * @example `const result = await recipe.execute()` runs the saved wiring once.
 */
export interface Recipe<R> {
  /**
   * Starts the configured run and waits for it to finish.
   *
   * Resolves with the run's result, or rejects if the run fails.
   *
   * @example `await recipe.execute()` does not require the caller to repeat
   * the Recipe's binding and subscription calls.
   */
  execute(): Promise<R>;
}
