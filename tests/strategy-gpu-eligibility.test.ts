// Purpose: Pin the offline strategy catalog's real WGSL eligibility boundary
// while reference-struct GPU lowering is deliberately deferred.

import {expect, test} from 'bun:test';
import {existsSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {Errors} from '../src/base/print';
import {
  compileProgramToWgsl,
  type WgslEligibilityIssueCode,
} from '../src/codegen/wgsl';
import {compileToProgram} from '../src/compile';
import type {Program} from '../src/ir/program';

const STRATEGY_ROOT = join(import.meta.dir, '../examples/strategy');

interface FirstBlocker {
  readonly code: WgslEligibilityIssueCode;
  readonly message: string;
}

const EXPECTED_FIRST_BLOCKERS: Readonly<Record<string, FirstBlocker>> = {
  'ai-supertrend-knn': {
    code: 'struct-reference-lowering-unimplemented',
    message: 'GPU struct-reference lowering is deferred for OrderRejected',
  },
  'alice-grid': {
    code: 'effect-transport-lowering-unimplemented',
    message: 'GPU effect transport cannot prove a bound for while iteration',
  },
  'alpha-regime-reversion': {
    code: 'struct-reference-lowering-unimplemented',
    message: 'GPU struct-reference lowering is deferred for OrderRejected',
  },
  'atr-zigzag-breakout': {
    code: 'struct-reference-lowering-unimplemented',
    message: 'GPU struct-reference lowering is deferred for OrderRejected',
  },
  'bb-spy-mean-reversion': {
    code: 'struct-reference-lowering-unimplemented',
    message: 'GPU struct-reference lowering is deferred for OrderRejected',
  },
  'cluster-breakout-v6': {
    code: 'struct-reference-lowering-unimplemented',
    message: 'GPU struct-reference lowering is deferred for OrderRejected',
  },
  cowabunga: {
    code: 'struct-reference-lowering-unimplemented',
    message: 'GPU struct-reference lowering is deferred for OrderRejected',
  },
  'cpu-gpu-next-open': {
    code: 'struct-reference-lowering-unimplemented',
    message: 'GPU struct-reference lowering is deferred for OrderRejected',
  },
  'donchian-close': {
    code: 'struct-reference-lowering-unimplemented',
    message: 'GPU struct-reference lowering is deferred for OrderRejected',
  },
  'ema-cross': {
    code: 'struct-reference-lowering-unimplemented',
    message: 'GPU struct-reference lowering is deferred for OrderRejected',
  },
  'mtf-psar': {
    code: 'struct-reference-lowering-unimplemented',
    message: 'GPU struct-reference lowering is deferred for OrderRejected',
  },
  'pair-spread-mean-reversion': {
    code: 'struct-reference-lowering-unimplemented',
    message: 'GPU struct-reference lowering is deferred for OrderRejected',
  },
  'turtle-system': {
    code: 'struct-reference-lowering-unimplemented',
    message: 'GPU struct-reference lowering is deferred for OrderRejected',
  },
  'vwap-suite': {
    code: 'struct-reference-lowering-unimplemented',
    message: 'GPU struct-reference lowering is deferred for OrderRejected',
  },
};

test('pins every strategy example at the real WGSL eligibility boundary', () => {
  const strategyNames = readdirSync(STRATEGY_ROOT, {withFileTypes: true})
    .filter(
      entry =>
        entry.isDirectory() &&
        existsSync(join(STRATEGY_ROOT, entry.name, 'strategy.tea')),
    )
    .map(entry => entry.name)
    .sort();
  const expectedNames = Object.keys(EXPECTED_FIRST_BLOCKERS).sort();
  expect(strategyNames).toEqual(expectedNames);

  const compiled: string[] = [];
  const firstBlockers: Record<string, FirstBlocker> = {};

  for (const strategyName of strategyNames) {
    const program = compileStrategy(strategyName);
    const result = compileProgramToWgsl(program);
    if (result.status === 'compiled') {
      compiled.push(strategyName);
      continue;
    }

    const first = result.eligibility.issues[0];
    if (first === undefined) {
      throw new Error(`${strategyName}: unsupported without a WGSL diagnostic`);
    }
    firstBlockers[strategyName] = {
      code: first.code,
      message: first.message,
    };
  }

  expect(compiled).toEqual([]);
  expect(firstBlockers).toEqual(EXPECTED_FIRST_BLOCKERS);
});

function compileStrategy(strategyName: string): Program {
  const source = join(STRATEGY_ROOT, strategyName, 'strategy.tea');
  const errors = new Errors();
  const program = compileToProgram([source], errors);
  if (program === null || errors.count !== 0) {
    const diagnostics = errors
      .flushErrors()
      .map(error => error.msg)
      .join('; ');
    throw new Error(
      `${strategyName}: frontend compilation failed: ${diagnostics}`,
    );
  }
  return program;
}
