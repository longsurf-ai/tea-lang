// Purpose: Lock generic Program-to-WGSL capability reporting to the authoritative compiler path.

import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, test} from 'bun:test';
import {mustBuild} from '../../noder/testing';
import {compileProgramToWgsl} from './lower';
import {analyzeWgslEligibility} from './prepare';

function componentProgram() {
  return mustBuild(
    readFileSync(
      join(
        import.meta.dir,
        '../../../tests/fixtures/execution/compile/strategy-components/source.tea',
      ),
      'utf8',
    ),
  );
}

describe('generic WGSL capability boundary', () => {
  test('accepts the exact closed deterministic Program graph', () => {
    const report = analyzeWgslEligibility(componentProgram());

    expect(report.inventory).toEqual({
      parameterCount: 0,
      requestCount: 0,
      seriesInputCount: 2,
      executionInputCount: 2,
      persistentRootCount: 1,
      functionCount: 40,
      mutableMethodCount: 11,
      callSiteSlotCount: 16,
      outputCount: 10,
      resultChannelCount: 9,
    });
    expect(report).toMatchObject({eligible: true, issues: []});
  });

  test('is the same authoritative result returned by compilation', () => {
    const program = mustBuild(
      'strategy("parameterized")\nlength = input.int(2)\nplot(length)',
    );
    expect(analyzeWgslEligibility(program)).toEqual(
      compileProgramToWgsl(program).eligibility,
    );
  });

  test('fails closed for unsupported target requirements', () => {
    const cases = [
      {
        source:
          'strategy("parameterized")\nlabel = input.string("x")\nplot(close)',
        code: 'parameter-packing-unimplemented',
      },
      {
        source: 'strategy("no series")\nvar float keep = 1.0\nplot(keep)',
        code: 'series-row-count-unavailable',
      },
    ] as const;

    for (const entry of cases) {
      const report = analyzeWgslEligibility(mustBuild(entry.source));
      expect(report.eligible).toBe(false);
      expect(report.issues.map(issue => issue.code)).toContain(entry.code);
    }
  });

  test('accepts declaration-site persistent initialization from the first active row', () => {
    const result = compileProgramToWgsl(
      mustBuild('strategy("row init")\nvar float x = close\nplot(x)'),
    );
    expect(result.status).toBe('compiled');
  });

  test('accepts fixed-width parameters and parameterized persistent initialization', () => {
    const result = compileProgramToWgsl(
      mustBuild(
        [
          'strategy("parameterized")',
          'length = input.int(2)',
          'scale = input.float(1.5)',
          'enabled = input.bool(true)',
          'var float keep = length + scale',
          'plot(enabled ? close * length + keep : 0)',
        ].join('\n'),
      ),
    );
    expect(result.status).toBe('compiled');
    if (result.status === 'compiled') {
      expect(result.artifact.params.map(param => param.type)).toEqual([
        'int',
        'float',
        'bool',
      ]);
      expect(result.artifact.module.source).toContain('tea_job.params_offset');
    }
  });

  test('does not require a dense result or a user persistent root', () => {
    const resultless = compileProgramToWgsl(
      mustBuild('strategy("resultless")\nclose'),
    );
    const stateless = compileProgramToWgsl(
      mustBuild('strategy("stateless")\nplot(close)'),
    );

    expect(resultless.status).toBe('compiled');
    expect(stateless.status).toBe('compiled');
  });

  test('captures one-level rooted updates before RHS and fails closed for deeper paths', () => {
    const oneLevel = compileProgramToWgsl(
      mustBuild(
        [
          'strategy("rooted")',
          'type Point',
          '    float x',
          'var Point p = Point.new(0.0)',
          'p.x := close',
          'plot(p.x)',
        ].join('\n'),
      ),
    );
    expect(oneLevel.status).toBe('compiled');
    if (oneLevel.status === 'compiled') {
      expect(oneLevel.artifact.module.source).toContain('.valid != 0u');
    }

    const deeper = compileProgramToWgsl(
      mustBuild(
        [
          'strategy("nested")',
          'type Point',
          '    float x',
          'type Holder',
          '    Point p',
          'var Holder h = Holder.new(Point.new(0.0))',
          'h.p.x := close',
          'plot(h.p.x)',
        ].join('\n'),
      ),
    );
    expect(deeper.status).toBe('staged-unsupported');
  });
});
