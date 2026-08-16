// Purpose: Pin the offline strategy catalog's real WGSL eligibility boundary
// and keep GPU-eligible closures on the shared scalar execution components.

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
import {formatType, TypeKind, type Type} from '../src/ir/type';
import {
  executionInputsOf,
  funcsOf,
  namesOf,
  seriesInputsOf,
  walkIrExpr,
  walkIrStmt,
} from '../src/ir/visit';

const STRATEGY_ROOT = join(import.meta.dir, '../examples/strategy');

const EXPECTED_ELIGIBLE = [
  'atr-zigzag-breakout',
  'cpu-gpu-next-open',
  'ema-cross',
  'turtle-system',
] as const;

interface FirstBlocker {
  readonly code: WgslEligibilityIssueCode;
  readonly message: string;
}

interface ClosureCeiling {
  readonly functionCount: number;
  readonly frameCount: number;
  readonly fixedBytes: number;
  readonly sourceBytes: number;
  readonly maxEffectsPerRow: number;
}

// These are the direct NetTrade baselines captured before the lifecycle
// family split. A narrower abstraction may improve them, but never enlarge a
// previously eligible Program merely because its coordinator became clearer.
const CLOSURE_CEILINGS: Readonly<
  Record<(typeof EXPECTED_ELIGIBLE)[number], ClosureCeiling>
> = {
  'atr-zigzag-breakout': {
    functionCount: 48,
    frameCount: 49,
    fixedBytes: 23_848,
    sourceBytes: 5_292_152,
    maxEffectsPerRow: 25,
  },
  'cpu-gpu-next-open': {
    functionCount: 32,
    frameCount: 33,
    fixedBytes: 13_648,
    sourceBytes: 3_330_144,
    maxEffectsPerRow: 20,
  },
  'ema-cross': {
    functionCount: 38,
    frameCount: 39,
    fixedBytes: 12_992,
    sourceBytes: 3_284_208,
    maxEffectsPerRow: 18,
  },
  'turtle-system': {
    functionCount: 41,
    frameCount: 42,
    fixedBytes: 19_300,
    sourceBytes: 3_943_996,
    maxEffectsPerRow: 24,
  },
};

const EXPECTED_FIRST_BLOCKERS: Readonly<Record<string, FirstBlocker>> = {
  'ai-supertrend-knn': {
    code: 'collection-layout-unimplemented',
    message: 'GPU collection layout is unsupported for array<float>',
  },
  'alice-grid': {
    code: 'effect-transport-lowering-unimplemented',
    message: 'GPU effect transport cannot prove a bound for while iteration',
  },
  'alpha-regime-reversion': {
    code: 'parameter-packing-unimplemented',
    message:
      "GPU fixed-width parameters do not support 'benchmark_symbol' of type string",
  },
  'bb-spy-mean-reversion': {
    code: 'tuple-layout-unimplemented',
    message: 'GPU tuple layout is unsupported for [float, float, float]',
  },
  'cluster-breakout-v6': {
    code: 'execution-input-mapping-unimplemented',
    message: 'execution input time.time is not derived by this GPU target',
  },
  cowabunga: {
    code: 'execution-input-mapping-unimplemented',
    message: 'execution input time.time is not derived by this GPU target',
  },
  'donchian-close': {
    code: 'execution-input-mapping-unimplemented',
    message: 'execution input time.time is not derived by this GPU target',
  },
  'mtf-psar': {
    code: 'parameter-packing-unimplemented',
    message:
      "GPU fixed-width parameters do not support 'request_symbol' of type string",
  },
  'pair-spread-mean-reversion': {
    code: 'parameter-packing-unimplemented',
    message:
      "GPU fixed-width parameters do not support 'symbol_one' of type string",
  },
  'vwap-suite': {
    code: 'tuple-layout-unimplemented',
    message: 'GPU tuple layout is unsupported for [float, float, float]',
  },
};

// These nominal values are all declared by the canonical broker, portfolio,
// and trade libraries. Any other reachable user type is strategy-owned
// state and must be reviewed before it becomes part of an eligible GPU frame.
const SHARED_SCALAR_EXECUTION_TYPES = new Set([
  'Account',
  'BarMatches',
  'BrokerEmulator',
  'Command',
  'Commission',
  'Fill',
  'FillExecuted',
  'FinishResult',
  'NetPortfolio',
  'NextOpenTrade<BrokerEmulator, NetPortfolio>',
  'OhlcTrade<BrokerEmulator, NetPortfolio>',
  'Order',
  'OrderCancelled',
  'OrderExpired',
  'OrderRejected',
  'OrderSubmitted',
  'PositionTarget',
  'PortfolioSnapshot',
  'PathTrade<BrokerEmulator, NetPortfolio>',
  'Sizing',
  'Slippage',
]);

test('pins every strategy example at the real WGSL eligibility boundary', () => {
  const strategyNames = readdirSync(STRATEGY_ROOT, {withFileTypes: true})
    .filter(
      entry =>
        entry.isDirectory() &&
        existsSync(join(STRATEGY_ROOT, entry.name, 'strategy.tea')),
    )
    .map(entry => entry.name)
    .sort();
  const expectedNames = [
    ...EXPECTED_ELIGIBLE,
    ...Object.keys(EXPECTED_FIRST_BLOCKERS),
  ].sort();
  expect(strategyNames).toEqual(expectedNames);

  const eligible: string[] = [];
  const firstBlockers: Record<string, FirstBlocker> = {};

  for (const strategyName of strategyNames) {
    const program = compileStrategy(strategyName);
    const result = compileProgramToWgsl(program);
    if (result.status === 'compiled') {
      eligible.push(strategyName);
      expectScalarSharedClosure(strategyName, program);
      expectNoExecutionAbstractionRegression(
        strategyName as (typeof EXPECTED_ELIGIBLE)[number],
        program,
        result,
      );
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

  expect(eligible).toEqual([...EXPECTED_ELIGIBLE]);
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

function expectNoExecutionAbstractionRegression(
  strategyName: (typeof EXPECTED_ELIGIBLE)[number],
  program: Program,
  result: Extract<
    ReturnType<typeof compileProgramToWgsl>,
    {status: 'compiled'}
  >,
): void {
  const ceiling = CLOSURE_CEILINGS[strategyName];
  expect(result.eligibility.inventory.functionCount).toBeLessThanOrEqual(
    ceiling.functionCount,
  );
  expect(result.artifact.state.frames.length).toBeLessThanOrEqual(
    ceiling.frameCount,
  );
  expect(result.artifact.executionStateFixedByteSize).toBeLessThanOrEqual(
    ceiling.fixedBytes,
  );
  expect(result.artifact.module.source.length).toBeLessThanOrEqual(
    ceiling.sourceBytes,
  );
  expect(result.artifact.maxEffectsPerRow).toBeLessThanOrEqual(
    ceiling.maxEffectsPerRow,
  );

  const rootTrade = result.artifact.state.frames[0]?.locals.find(
    local => local.name === 'strat',
  );
  expect(rootTrade?.valueWordCount).toBeLessThanOrEqual(175);

  const functionNames = funcsOf(program).map(func => func.name);
  const forbidden =
    strategyName === 'atr-zigzag-breakout'
      ? ['.on_open', '.on_close', '.match_pending', '.execute_now']
      : ['.match_pending', '.match_exit', '.match_path_', '.execute_now'];
  expect(
    functionNames.filter(name =>
      forbidden.some(fragment => name.includes(fragment)),
    ),
  ).toEqual([]);
}

function expectScalarSharedClosure(
  strategyName: string,
  program: Program,
): void {
  const types = typesInProgramClosure(program);
  const collections = [...types]
    .filter(
      type =>
        type.kind === TypeKind.Array ||
        type.kind === TypeKind.Matrix ||
        type.kind === TypeKind.Map,
    )
    .map(formatType)
    .sort();
  expect(collections, `${strategyName}: collection types`).toEqual([]);

  const strategyOwnedTypes = [...types]
    .filter(type => type.kind === TypeKind.UserType)
    .map(type => type.name)
    .filter(name => !SHARED_SCALAR_EXECUTION_TYPES.has(name))
    .sort();
  expect(
    strategyOwnedTypes,
    `${strategyName}: strategy-owned user types`,
  ).toEqual([]);

  const lotOrCollectionFunctions = funcsOf(program)
    .map(func => func.name)
    .filter(
      name =>
        name.includes('LotPortfolio') ||
        /\bOpenTrade\b/.test(name) ||
        /\.(?:entry_now|close_trade|open_trade|update_open_trade)(?:<|$)/.test(
          name,
        ) ||
        /^(?:array|matrix|map)\./.test(name),
    )
    .sort();
  expect(
    lotOrCollectionFunctions,
    `${strategyName}: lot or collection functions`,
  ).toEqual([]);
}

function typesInProgramClosure(program: Program): ReadonlySet<Type> {
  const types = new Set<Type>();
  const programs = new Set<Program>();
  collectProgramTypes(program, types, programs);
  return types;
}

function collectProgramTypes(
  program: Program,
  types: Set<Type>,
  programs: Set<Program>,
): void {
  if (programs.has(program)) return;
  programs.add(program);

  const visitExpression = (expr: {readonly type: Type}): void => {
    collectType(expr.type, types);
  };
  for (const param of program.params) {
    collectType(param.type, types);
    walkIrExpr(param.active, {expr: visitExpression});
  }
  for (const output of program.outputs) {
    for (const channel of output.channels) collectType(channel.type, types);
    for (const argument of output.bindArgs) {
      walkIrExpr(argument.expr, {expr: visitExpression});
    }
  }
  for (const effect of program.effects) collectType(effect.payloadType, types);
  for (const statement of [...program.init, ...program.body]) {
    walkIrStmt(statement, {expr: visitExpression});
  }
  for (const name of namesOf(program)) collectType(name.type, types);
  for (const func of funcsOf(program)) {
    collectType(func.resultType, types);
    walkIrExpr(func.body, {expr: visitExpression});
  }
  for (const series of seriesInputsOf(program)) collectType(series.type, types);
  for (const execution of executionInputsOf(program)) {
    collectType(execution.type, types);
  }
  for (const request of program.requests) {
    collectType(request.resultType, types);
    for (const expression of [
      request.symbol,
      request.timeframe,
      request.merge.gaps,
      request.merge.lookahead,
      request.merge.ignoreInvalidSymbol,
      request.merge.calcBarsCount,
    ]) {
      walkIrExpr(expression, {expr: visitExpression});
    }
    collectProgramTypes(request.child, types, programs);
  }
}

function collectType(type: Type, types: Set<Type>): void {
  if (types.has(type)) return;
  types.add(type);

  switch (type.kind) {
    case TypeKind.Array:
    case TypeKind.Matrix:
      collectType(type.elem, types);
      return;
    case TypeKind.Map:
      collectType(type.key, types);
      collectType(type.value, types);
      return;
    case TypeKind.UserType:
      for (const field of type.fields) collectType(field.type, types);
      return;
    case TypeKind.Tuple:
      for (const element of type.elems) collectType(element, types);
      return;
    case TypeKind.Func:
      for (const param of type.params) collectType(param.type, types);
      collectType(type.result, types);
      return;
    default:
      return;
  }
}
