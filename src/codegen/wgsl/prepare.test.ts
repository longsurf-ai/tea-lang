// Purpose: Lock generic Program-to-WGSL capability reporting to the authoritative compiler path.

import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, test} from 'vitest';
import {mustBuild} from '../../noder/testing';
import {compileProgramToWgsl} from './lower';
import {analyzeWgslEligibility} from './prepare';

function componentProgram() {
  return mustBuild(
    readFileSync(
      join(
        fileURLToPath(new URL('.', import.meta.url)),
        '../../../tests/fixtures/execution/compile/strategy-components/source.tea',
      ),
      'utf8',
    ),
  );
}

describe('generic WGSL capability boundary', () => {
  test('inventories the exact graph and fails closed at its first struct reference', () => {
    const report = analyzeWgslEligibility(componentProgram());

    expect(report.inventory).toEqual({
      parameterCount: 0,
      requestCount: 0,
      seriesInputCount: 2,
      builtinInputCount: 2,
      persistentRootCount: 1,
      functionCount: 38,
      mutableMethodCount: 15,
      callSiteSlotCount: 14,
      outputCount: 14,
      resultChannelCount: 9,
    });
    expect(report.eligible).toBe(false);
    expect(report.issues[0]?.code).toBe(
      'struct-reference-lowering-unimplemented',
    );
  });

  test('is the same authoritative result returned by compilation', () => {
    const program = mustBuild('\nlength = input.int(2)\nemit "output0" length');
    expect(analyzeWgslEligibility(program)).toEqual(
      compileProgramToWgsl(program).eligibility,
    );
  });

  test('fails closed for unsupported target requirements', () => {
    const cases = [
      {
        source: '\nlabel = input.string("x")\nemit "output0" close',
        code: 'parameter-packing-unimplemented',
      },
      {
        source: '\nvar float keep = 1.0\nemit "output1" keep',
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
      mustBuild('\nvar float x = close\nemit "output0" x'),
    );
    expect(result.status).toBe('compiled');
  });

  test('accepts fixed-width parameters and parameterized persistent initialization', () => {
    const result = compileProgramToWgsl(
      mustBuild(
        [
          '',
          'length = input.int(2)',
          'scale = input.float(1.5)',
          'enabled = input.bool(true)',
          'var float keep = length + scale',
          'emit "output0" enabled ? close * length + keep : 0',
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
    const resultless = compileProgramToWgsl(mustBuild('\nclose'));
    const stateless = compileProgramToWgsl(mustBuild('\nemit "output0" close'));

    expect(resultless.status).toBe('compiled');
    expect(stateless.status).toBe('compiled');
  });

  test('fails closed for every reachable struct reference operation', () => {
    const oneLevel = compileProgramToWgsl(
      mustBuild(
        [
          '',
          'type Point',
          '    float x',
          'var Point p = Point.new(0.0)',
          'p.x := close',
          'emit "output0" p.x',
        ].join('\n'),
      ),
    );
    expect(oneLevel.status).toBe('staged-unsupported');
    expect(oneLevel.eligibility.issues[0]?.code).toBe(
      'struct-reference-lowering-unimplemented',
    );

    const deeper = compileProgramToWgsl(
      mustBuild(
        [
          '',
          'type Point',
          '    float x',
          'type Holder',
          '    Point p',
          'var Holder h = Holder.new(Point.new(0.0))',
          'h.p.x := close',
          'emit "output0" h.p.x',
        ].join('\n'),
      ),
    );
    expect(deeper.status).toBe('staged-unsupported');
    expect(deeper.eligibility.issues[0]?.code).toBe(
      'struct-reference-lowering-unimplemented',
    );
  });
});
