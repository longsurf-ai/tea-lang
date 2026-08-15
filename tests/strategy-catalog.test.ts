// Purpose: Keep every checked-in TradingView strategy profile compileable and
// its declared stress grid structurally honest without fetching live data.

import {describe, expect, test} from 'bun:test';
import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {Errors} from '../src/base/print';
import {paramSpecsOf} from '../src/codegen/params';
import {compileProgramToWgsl} from '../src/codegen/wgsl';
import {compileToProgram} from '../src/compile';
import {
  loadExecutionConfig,
  resolveExecutionParameters,
} from '../src/execution';

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

describe('clean-room strategy catalog', () => {
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

  for (const name of expectedStrategies) {
    test(`${name} compiles and resolves its declared grid`, () => {
      const directory = join(STRATEGY_ROOT, name);
      const readme = readFileSync(join(directory, 'README.md'), 'utf8');
      expect(readme).toContain('tradingview.com/script/');

      const loaded = loadExecutionConfig(join(directory, 'sweep.yaml'));
      expect(loaded.config.program.source).toBe(
        join(directory, 'strategy.tea'),
      );
      expect(loaded.config.runtime.kind).toBe(
        name === 'turtle-system' ? 'webgpu' : 'javascript',
      );
      expect(loaded.config.execution.kind).toBe('sweep');
      if (loaded.config.execution.kind !== 'sweep') {
        throw new Error('strategy catalog configs must be sweeps');
      }
      expect(loaded.config.execution.maxExecutions).toBeDefined();

      const errors = new Errors();
      const program = compileToProgram([loaded.config.program.source], errors);
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
        loaded.config.execution,
      );
      expect(resolved.axes.length).toBeGreaterThan(0);
      expect(new Set(resolved.axes.map(axis => axis.name)).size).toBe(
        resolved.axes.length,
      );
      expect(
        resolved.axes.every(
          axis => axis.type === 'int' || axis.type === 'float',
        ),
      ).toBe(true);
      expect(resolved.parameterSets).toHaveLength(
        loaded.config.execution.maxExecutions!,
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

  test('Turtle publishes an equivalent checked-in CPU oracle grid', () => {
    const directory = join(STRATEGY_ROOT, 'turtle-system');
    const gpu = loadExecutionConfig(join(directory, 'sweep.yaml'));
    const cpu = loadExecutionConfig(join(directory, 'sweep-cpu.yaml'));
    expect(cpu.config.execution).toEqual(gpu.config.execution);
    expect(gpu.config.runtime.kind).toBe('webgpu');
    expect(cpu.config.runtime.kind).toBe('javascript');

    const errors = new Errors();
    const program = compileToProgram([gpu.config.program.source], errors);
    if (program === null) {
      throw new Error(
        errors
          .flushErrors()
          .map(error => error.msg)
          .join('; '),
      );
    }
    expect(errors.count).toBe(0);
    const compiled = compileProgramToWgsl(program);
    expect(compiled.status).toBe('compiled');
    if (compiled.status !== 'compiled') {
      throw new Error(JSON.stringify(compiled.eligibility.issues));
    }
    expect(compiled.artifact.bindingModule.source.length).toBeGreaterThan(0);
    expect(compiled.artifact.state.frames.length).toBeGreaterThan(1);
    const source = readFileSync(gpu.config.program.source, 'utf8');
    expect(source).not.toContain('date_allowed');
    expect(source).not.toContain('start_time');
    expect(source).not.toContain('end_time');
    expect(source).not.toContain('4102444800000');
  });
});
