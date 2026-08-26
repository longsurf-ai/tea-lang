// Purpose: CLI-wide success, diagnostics, and operational-failure results.

import {OperationalError} from '../base/operational-error';
import type {ErrorMsg} from '../base/print';

export type CliResult =
  | {readonly ok: true}
  | {
      readonly ok: false;
      readonly kind: 'diagnostics';
      readonly errors: readonly ErrorMsg[];
    }
  | {
      readonly ok: false;
      readonly kind: 'failure';
      readonly message: string;
    };

export function cliFailure(error: unknown): CliResult | null {
  if (!(error instanceof OperationalError)) return null;
  return {ok: false, kind: 'failure', message: error.message};
}
