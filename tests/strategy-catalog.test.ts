// Purpose: Keep every checked-in TradingView strategy profile compileable and
// its declared stress grid structurally honest without fetching live data.

import {describe, expect, test} from 'bun:test';
import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {Errors} from '../src/base/print';
import {paramSpecsOf} from '../src/codegen/params';
import {compileProgramToWgsl} from '../src/codegen/wgsl';
import {compileToProgram} from '../src/compile';
import {loadConfig, resolveExecutionParameters} from '../src/execution';

const ROOT = join(import.meta.dir, '..');
const STRATEGY_ROOT = join(ROOT, 'examples/strategy');

const expectedStrategies = [
  'ai-supertrend-knn',
  'alice-grid',
  'alpha-regime-reversion',
  'atr-zigzag-breakout',
  'bb-spy-mean-reversion',
  'cluster-breakout-v6',
  'cowabunga',
  'donchian-close',
  'mtf-psar',
  'pair-spread-mean-reversion',
  'turtle-system',
  'vwap-suite',
] as const;

const expectedTradeFactory: Readonly<
  Record<(typeof expectedStrategies)[number], string>
> = {
  'ai-supertrend-knn': 'trade.ohlc(',
  'alice-grid': 'trade.lots(',
  'alpha-regime-reversion': 'trade.ohlc(',
  'atr-zigzag-breakout': 'trade.path(',
  'bb-spy-mean-reversion': 'trade.ohlc(',
  'cluster-breakout-v6': 'trade.ohlc(',
  cowabunga: 'trade.path(',
  'donchian-close': 'trade.nextOpen(',
  'mtf-psar': 'trade.nextOpen(',
  'pair-spread-mean-reversion': 'trade.nextOpen(',
  'turtle-system': 'trade.nextOpen(',
  'vwap-suite': 'trade.ohlc(',
};

const brokerLifecycleEffects = [
  'OrderSubmitted',
  'FillExecuted',
  'OrderExpired',
  'OrderCancelled',
  'OrderRejected',
] as const;

function strategySource(name: (typeof expectedStrategies)[number]): string {
  return readFileSync(join(STRATEGY_ROOT, name, 'strategy.tea'), 'utf8');
}

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function ownershipViolations(source: string): readonly string[] {
  const violations: string[] = [];
  for (const match of source.matchAll(
    /^\s*(?:export\s+)?(?:type|struct)\s+([A-Za-z_][A-Za-z0-9_]*(?:Account|Broker|Engine))\b/gm,
  )) {
    violations.push(`local execution type ${match[1]}`);
  }
  for (const match of source.matchAll(
    /\bbroker\s*\.\s*(Fill|Order|Account)\s*\.\s*new\s*\(/g,
  )) {
    violations.push(`direct broker.${match[1]}.new`);
  }
  for (const match of source.matchAll(/\bbroker\s*\.\s*stop_touched\s*\(/g)) {
    violations.push(`direct broker stop preflight ${match[0]}`);
  }

  const lifecycleNames = brokerLifecycleEffects.join('|');
  for (const match of source.matchAll(
    new RegExp(
      `\\beffect\\s*\\.\\s*emit\\s*\\(\\s*broker\\s*\\.\\s*(?:${lifecycleNames})\\s*\\.\\s*new\\s*\\(`,
      'g',
    ),
  )) {
    violations.push(`direct broker lifecycle emission ${match[0]}`);
  }

  for (const match of source.matchAll(
    /\b[A-Za-z_][A-Za-z0-9_]*\s*\.\s*portfolio\b/g,
  )) {
    violations.push(`direct configured portfolio access ${match[0]}`);
  }
  for (const match of source.matchAll(
    /\b[A-Za-z_][A-Za-z0-9_]*\s*\.\s*broker\b/g,
  )) {
    violations.push(`direct configured broker access ${match[0]}`);
  }

  const portfolioBindings = new Set(
    [
      ...source.matchAll(
        /^\s*(?:var\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*portfolio\s*\.\s*(?:new|basic|lots)\s*\(/gm,
      ),
    ].map(match => match[1]),
  );
  for (const binding of portfolioBindings) {
    const receiver = escaped(binding);
    if (
      new RegExp(`\\b${receiver}\\s*\\.\\s*(?:apply|account)\\s*\\(`).test(
        source,
      )
    ) {
      violations.push(`direct portfolio mutation through ${binding}`);
    }
    if (
      new RegExp(`\\b${receiver}\\s*\\.\\s*[A-Za-z_][A-Za-z0-9_]*\\s*:=`).test(
        source,
      )
    ) {
      violations.push(`direct portfolio field mutation through ${binding}`);
    }
  }
  return violations;
}

describe('clean-room strategy catalog', () => {
  test('ownership guard permits policy state and catches execution ownership leaks', () => {
    expect(
      ownershipViolations(
        [
          'type RegimeState',
          '    int stage',
          'var levels = array.new<float>(4, 0.0)',
        ].join('\n'),
      ),
    ).toEqual([]);

    const violations = ownershipViolations(
      [
        'type LocalAccount',
        'struct LocalBroker',
        'type FillEngine',
        'fill = broker.Fill.new()',
        'order = broker.Order.new()',
        'account = broker.Account.new()',
        'touched = broker.stop_touched(broker.Side.sell, high, low, close)',
        'effect.emit(broker.FillExecuted.new(fill))',
        'var book = portfolio.new(initialCash = 100.0)',
        'book.apply(fill)',
        'book.cashValue := 0.0',
        'strat.portfolio.account()',
        'strat.broker.execute(close, account, bar_index, true)',
      ].join('\n'),
    );
    expect(violations).toEqual(
      expect.arrayContaining([
        'local execution type LocalAccount',
        'local execution type LocalBroker',
        'local execution type FillEngine',
        'direct broker.Fill.new',
        'direct broker.Order.new',
        'direct broker.Account.new',
        'direct broker stop preflight broker.stop_touched(',
        'direct portfolio mutation through book',
        'direct portfolio field mutation through book',
      ]),
    );
    expect(
      violations.some(violation =>
        violation.startsWith('direct broker lifecycle emission'),
      ),
    ).toBe(true);
    expect(
      violations.some(violation =>
        violation.startsWith('direct configured portfolio access'),
      ),
    ).toBe(true);
    expect(
      violations.some(violation =>
        violation.startsWith('direct configured broker access'),
      ),
    ).toBe(true);
  });

  test('contains exactly the twelve audited TradingView profiles', () => {
    const catalog = readdirSync(STRATEGY_ROOT, {withFileTypes: true})
      .filter(
        entry =>
          entry.isDirectory() &&
          existsSync(join(STRATEGY_ROOT, entry.name, 'README.md')) &&
          existsSync(join(STRATEGY_ROOT, entry.name, 'sweep.yaml')),
      )
      .map(entry => entry.name)
      .sort();
    expect(catalog).toEqual([...expectedStrategies]);
  });

  test('routes every audited profile through the canonical trade components', () => {
    for (const name of expectedStrategies) {
      const source = strategySource(name);
      expect(source).toContain('import broker');
      expect(source).toContain('import portfolio');
      expect(source).toContain('import trade');
      expect(source).toContain(expectedTradeFactory[name]);
      expect(source).not.toContain('trade.net(');
      expect(source).not.toContain('broker.Fill.new');
      expect(source).not.toContain('effect.emit');
    }
  });

  for (const name of expectedStrategies) {
    test(`${name} keeps broker execution and portfolio accounting in canonical components`, () => {
      expect(ownershipViolations(strategySource(name))).toEqual([]);
    });
  }

  for (const name of expectedStrategies) {
    test(`${name} compiles and resolves its declared grid`, () => {
      const directory = join(STRATEGY_ROOT, name);
      const readme = readFileSync(join(directory, 'README.md'), 'utf8');
      expect(readme).toContain('tradingview.com/script/');

      const config = loadConfig(join(directory, 'sweep.yaml'));
      expect(config.program.source).toBe(join(directory, 'strategy.tea'));
      expect(config.runtime.kind).toBe(
        name === 'turtle-system' ? 'webgpu' : 'javascript',
      );
      expect(config.execution.kind).toBe('sweep');
      if (config.execution.kind !== 'sweep') {
        throw new Error('strategy catalog configs must be sweeps');
      }
      expect(config.execution.maxExecutions).toBeDefined();

      const errors = new Errors();
      const program = compileToProgram([config.program.source], errors);
      if (program === null) {
        throw new Error(
          errors
            .flushErrors()
            .map(error => error.msg)
            .join('; '),
        );
      }
      expect(errors.count).toBe(0);

      const resolved = resolveExecutionParameters(
        paramSpecsOf(program.params),
        config.execution,
      );
      expect(resolved.ranges.length).toBeGreaterThan(0);
      expect(new Set(resolved.ranges.map(range => range.name)).size).toBe(
        resolved.ranges.length,
      );
      expect(resolved.sets.length).toBeLessThanOrEqual(
        config.execution.maxExecutions!,
      );

      const outputTitles = new Set(
        program.outputs.flatMap(output =>
          output.staticArgs
            .filter(argument => argument.name === 'title')
            .map(argument => argument.value),
        ),
      );
      for (const title of [
        'equity',
        'round trips',
        'maximum drawdown',
        'total return',
      ]) {
        expect(outputTitles.has(title)).toBe(true);
      }
    });
  }

  test('Turtle publishes a CPU oracle subset while its GPU grid fails closed on structs', () => {
    const directory = join(STRATEGY_ROOT, 'turtle-system');
    const gpu = loadConfig(join(directory, 'sweep.yaml'));
    const cpu = loadConfig(join(directory, 'sweep-cpu.yaml'));
    expect(gpu.runtime.kind).toBe('webgpu');
    expect(cpu.runtime.kind).toBe('javascript');

    const errors = new Errors();
    const program = compileToProgram([gpu.program.source], errors);
    if (program === null) {
      throw new Error(
        errors
          .flushErrors()
          .map(error => error.msg)
          .join('; '),
      );
    }
    expect(errors.count).toBe(0);
    if (gpu.execution.kind !== 'sweep' || cpu.execution.kind !== 'sweep') {
      throw new Error('Turtle configs must both be sweeps');
    }
    const specs = paramSpecsOf(program.params);
    const gpuParameters = resolveExecutionParameters(specs, gpu.execution).sets;
    const cpuParameters = resolveExecutionParameters(specs, cpu.execution).sets;
    expect(gpuParameters).toHaveLength(780);
    expect(cpuParameters).toHaveLength(36);
    const gpuKeys = new Set(
      gpuParameters.map(parameters => JSON.stringify(parameters)),
    );
    expect(
      cpuParameters.every(parameters =>
        gpuKeys.has(JSON.stringify(parameters)),
      ),
    ).toBe(true);
    const compiled = compileProgramToWgsl(program);
    expect(compiled.status).toBe('staged-unsupported');
    if (compiled.status === 'staged-unsupported') {
      expect(compiled.artifact).toBeNull();
      expect(compiled.eligibility.issues[0]).toMatchObject({
        code: 'struct-reference-lowering-unimplemented',
        message: 'GPU struct-reference lowering is deferred for OrderRejected',
      });
    }
    const source = readFileSync(gpu.program.source, 'utf8');
    expect(source).toContain('trade.nextOpen(');
    expect(source).toContain('broker.new(');
    expect(source).toContain('portfolio.new(');
    expect(source).not.toContain('type TurtleAccount');
    expect(source).not.toContain('broker.Fill.new');
    expect(source).not.toContain('effect.emit');
    expect(source).not.toContain('date_allowed');
    expect(source).not.toContain('start_time');
    expect(source).not.toContain('end_time');
    expect(source).not.toContain('4102444800000');
  });

  test('Pair strategy composes the canonical broker and portfolio', () => {
    const source = readFileSync(
      join(STRATEGY_ROOT, 'pair-spread-mean-reversion', 'strategy.tea'),
      'utf8',
    );

    expect(source).toContain('broker.new(');
    expect(source).toContain('portfolio.new(');
    expect(source).toContain('qty = contracts');
    expect(source).not.toContain('type FixedContractBroker');
    expect(source).not.toContain('broker.Fill.new');
  });

  test('AI SuperTrend composes the canonical broker and portfolio', () => {
    const source = readFileSync(
      join(STRATEGY_ROOT, 'ai-supertrend-knn', 'strategy.tea'),
      'utf8',
    );

    expect(source).toContain('broker.new(');
    expect(source).toContain('portfolio.new(');
    expect(source).toContain('trade.ohlc(');
    expect(source).toContain('trade.percentOfEquity(');
    expect(source).toContain('strat.begin_bar(');
    expect(source).toContain('strat.exit(');
    expect(source).not.toContain('type LongStopEngine');
    expect(source).not.toContain('broker.Fill.new');
  });

  test('Alice Grid composes the canonical broker and bounded lot portfolio', () => {
    const source = readFileSync(
      join(STRATEGY_ROOT, 'alice-grid', 'strategy.tea'),
      'utf8',
    );

    expect(source).toContain('broker.new(');
    expect(source).toContain('portfolio.lots(');
    expect(source).toContain('trade.lots(');
    expect(source).toContain('maximum_open_trades = input.int(');
    expect(source).toContain('strat.entry(');
    expect(source).toContain('strat.close_trade(');
    expect(source).toContain('strat.snapshot()');
    expect(source).not.toContain('type GridLot');
    expect(source).not.toContain('type GridAccount');
    expect(source).not.toContain('broker.Fill.new');
    expect(source).not.toContain('effect.emit');
  });

  test('ATR ZigZag composes the canonical broker path and portfolio', () => {
    const source = readFileSync(
      join(STRATEGY_ROOT, 'atr-zigzag-breakout', 'strategy.tea'),
      'utf8',
    );

    expect(source).toContain('broker.new(');
    expect(source).toContain('portfolio.new(');
    expect(source).toContain('trade.path(');
    expect(source).toContain('strat.begin_bar(');
    expect(source).toContain('strat.continue_bar(');
    expect(source).toContain('strat.entry(');
    expect(source).toContain('strat.exit(');
    expect(source).not.toContain('type BracketAccount');
    expect(source).not.toContain('broker.Fill.new');
    expect(source).not.toContain('effect.emit');
  });

  test('BB mean reversion composes the canonical broker and portfolio', () => {
    const source = readFileSync(
      join(STRATEGY_ROOT, 'bb-spy-mean-reversion', 'strategy.tea'),
      'utf8',
    );

    expect(source).toContain('broker.new(');
    expect(source).toContain('portfolio.new(');
    expect(source).toContain('trade.ohlc(');
    expect(source).toContain('commissionIncluded = true');
    expect(source).toContain('strat.begin_bar(');
    expect(source).toContain('strat.exit(');
    expect(source).toContain('target = active_target');
    expect(source).not.toContain('type FillFactory');
    expect(source).not.toContain('broker.Fill.new');
  });

  test('Alpha regime reversion composes the canonical broker and portfolio', () => {
    const source = readFileSync(
      join(STRATEGY_ROOT, 'alpha-regime-reversion', 'strategy.tea'),
      'utf8',
    );

    expect(source).toContain('broker.new(');
    expect(source).toContain('portfolio.new(');
    expect(source).toContain('trade.ohlc(');
    expect(source).toContain('trade.targetPercentOfEquity(');
    expect(source).toContain('strat.begin_bar(');
    expect(source).toContain('strat.rebalance(');
    expect(source).toContain('strat.exit(');
    expect(source).not.toContain('type AllocationAccount');
    expect(source).not.toContain('broker.Fill.new');
    expect(source).not.toContain('effect.emit');
  });

  test('Cluster breakout composes the canonical broker and portfolio', () => {
    const source = readFileSync(
      join(STRATEGY_ROOT, 'cluster-breakout-v6', 'strategy.tea'),
      'utf8',
    );

    expect(source).toContain('broker.new(');
    expect(source).toContain('portfolio.new(');
    expect(source).toContain('trade.ohlc(');
    expect(source).toContain('strat.begin_bar(');
    expect(source).toContain('strat.exit(');
    expect(source).not.toContain('type SignedAccount');
    expect(source).not.toContain('broker.Fill.new');
    expect(source).not.toContain('effect.emit');
  });

  test('Cowabunga composes canonical target rebalances and path exits', () => {
    const source = readFileSync(
      join(STRATEGY_ROOT, 'cowabunga', 'strategy.tea'),
      'utf8',
    );

    expect(source).toContain('broker.new(');
    expect(source).toContain('portfolio.new(');
    expect(source).toContain('trade.path(');
    expect(source).toContain('strat.begin_bar(');
    expect(source).toContain('strat.continue_bar(');
    expect(source).toContain('strat.rebalance(');
    expect(source).toContain('strat.exit(');
    expect(source).not.toContain('type SignedBracketEngine');
    expect(source).not.toContain('broker.Fill.new');
    expect(source).not.toContain('effect.emit');
  });

  test('MTF PSAR composes the canonical broker and portfolio', () => {
    const source = readFileSync(
      join(STRATEGY_ROOT, 'mtf-psar', 'strategy.tea'),
      'utf8',
    );

    expect(source).toContain('broker.new(');
    expect(source).toContain('portfolio.new(');
    expect(source).toContain('trade.nextOpen(');
    expect(source).toContain('trade.percentOfEquityAtFill(');
    expect(source).not.toContain('type SignedPercentEngine');
    expect(source).not.toContain('broker.Fill.new');
    expect(source).not.toContain('effect.emit');
  });

  test('VWAP Suite composes the canonical broker and portfolio', () => {
    const source = readFileSync(
      join(STRATEGY_ROOT, 'vwap-suite', 'strategy.tea'),
      'utf8',
    );

    expect(source).toContain('broker.new(');
    expect(source).toContain('portfolio.new(');
    expect(source).toContain('trade.ohlc(');
    expect(source).toContain('strat.rebalance(');
    expect(source).toContain('strat.exit(');
    expect(source).not.toContain('type DirectionalAccount');
    expect(source).not.toContain('broker.Fill.new');
    expect(source).not.toContain('effect.emit');
  });
});
