// Purpose: Public fail-closed WGSL capability report projected from the authoritative Program compiler.

import type {Program} from '../../ir/program';
import {compileProgramToWgsl} from './lower';
import type {WgslEligibilityReport} from './types';

// Compilation is the single capability walk: reporting never maintains a
// parallel support table that can drift from the emitter.
export function analyzeWgslEligibility(
  program: Program,
): WgslEligibilityReport {
  return compileProgramToWgsl(program).eligibility;
}

export type {
  WgslEligibilityIssue,
  WgslEligibilityIssueCode,
  WgslEligibilityPhase,
  WgslEligibilityReport,
  WgslProgramInventory,
  WgslSourceLocation,
} from './types';
