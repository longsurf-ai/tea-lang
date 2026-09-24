import {createRequire} from 'node:module';
import {expect, test} from 'vitest';
import {Bool, Field, Float64, Schema} from 'apache-arrow';
import {from} from 'rxjs';
import {DataStream} from '../src/api/stream';
import {tea} from '../src/api/tea';

function execute(source: string, rows: Record<string, number>[]) {
  const node = tea`${source}`;
  let failure: unknown;
  const result: Record<string, unknown>[] = [];
  const bound = node.bind(
    new DataStream(
      new Schema(
        Object.keys(rows[0]).map(key => new Field(key, new Float64(), false)),
      ),
      from(rows),
    ),
  );
  bound.to({
    next: row => result.push(row),
    error: error => {
      failure = error;
    },
  });
  bound.dispose();
  node.dispose();
  if (failure) throw failure;
  return result;
}

test('geometry executes through public Node with ordinary Float64 inputs', () => {
  const rows = execute(
    `import geometry
emit "orientation" geometry.orient2d(open, high, low, close, volume, 1.0)
emit "segment" geometry.segmentContact(0.0, 0.0, 2.0, 2.0, 0.0, 2.0, 2.0, 0.0)
emit "contacts" geometry.segmentContacts(0.0, 0.0, 2.0, 2.0, 0.0, 2.0, 2.0, 0.0)
emit "quadratic" geometry.quadraticContacts(0.0, 0.0, 1.0, 2.0, 2.0, 0.0, 0.0, 0.5, 2.0, 0.5)
`,
    [{open: 0, high: 0, low: 1, close: 0, volume: 0}],
  );
  expect(rows[0].orientation).toBe(-1);
  expect(rows[0].segment).toBe(true);
  expect(rows[0].contacts).toEqual([
    {
      boundaryParameter: 0.5,
      observationParameter: 0.5,
      transverse: true,
      overlap: false,
    },
  ]);
  expect(rows[0].quadratic).toHaveLength(2);
});

// Pinned development dependencies are independent upstream oracles; runtime
// geometry imports none of them.
const require = createRequire(import.meta.url);
const orient = require('robust-orientation') as (
  a: number[],
  b: number[],
  c: number[],
) => number;
const intersect = require('robust-segment-intersect') as (
  a: number[],
  b: number[],
  p: number[],
  q: number[],
) => boolean;
const {Intersection, Shapes} = require('kld-intersections');

function casesSource(cases: number[][], expression: string): string {
  return `import geometry\n${cases[0].map((_, i) => `var x${i} = array.from(${cases.map(row => `${row[i]}`).join(', ')})`).join('\n')}\nemit "result" ${expression}\nemit "clock" close`;
}
function evaluateCases(cases: number[][], expression: string) {
  return execute(
    casesSource(cases, expression),
    cases.map(() => ({close: 1})),
  ).map(row => row.result);
}
function args(count: number) {
  return Array.from({length: count}, (_, i) => `x${i}.get(bar_index)`).join(
    ', ',
  );
}
function randomSource() {
  let state = 0x1a2b3c4d;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

test('adaptive orientation agrees with the upstream exact branch and an independent integer determinant', () => {
  const random = randomSource();
  const cases = [
    [0, 0, 1, 0, 0, 1],
    [0, 0, 1, 1, 2, 2],
    [0, 0, 1e20, 1e20, 2e20, 2e20 + 32768],
    [0, 0, 1, 1 + Number.EPSILON, 1 - Number.EPSILON, 1],
  ];
  // Adjacent exactly representable integers force cancellation. A BigInt
  // determinant independently establishes the signs, not just library parity.
  const integers: number[][] = [];
  for (let i = 0; i < 128; i++) {
    const n = 2 ** 40 + i * 17;
    integers.push([n, n + 1, 2 * n, 2 * n + 2, 3 * n + 1, 3 * n + 4]);
  }
  cases.push(...integers);
  for (const scale of [1e-70, 1e-30, 1, 1e30, 1e69]) {
    for (let i = 0; i < 64; i++) {
      const x = 1 + random();
      const y = 1 + random();
      const t = 2 + random();
      cases.push([
        scale,
        scale,
        x * scale,
        y * scale,
        (1 + (x - 1) * t) * scale,
        (1 + (y - 1) * t + (random() - 0.5) * Number.EPSILON * 8) * scale,
      ]);
    }
  }
  const forwardCount = cases.length;
  cases.push(...cases.map(row => [...row.slice(2, 4), ...row.slice(0, 2), ...row.slice(4)]));
  const actual = evaluateCases(cases, `geometry.orient2d(${args(6)})`);
  for (let i = 0; i < forwardCount; i++) {
    expect(Math.sign(actual[i + forwardCount] as number) || 0).toBe(-Math.sign(actual[i] as number) || 0);
  }
  cases.forEach((row, i) =>
    expect(Math.sign(actual[i] as number), JSON.stringify(row)).toBe(
      Math.sign(orient(row.slice(0, 2), row.slice(2, 4), row.slice(4))),
    ),
  );
  integers.forEach((row, i) => {
    const [ax, ay, bx, by, cx, cy] = row.map(BigInt);
    const determinant = (ay - cy) * (bx - cx) - (ax - cx) * (by - cy);
    expect(Math.sign(actual[i + 4] as number)).toBe(
      determinant === 0n ? 0 : determinant > 0n ? 1 : -1,
    );
  });
});

test('segment contact matches the pinned package for endpoints, reversals, degeneracy and adversarial scales', () => {
  const random = randomSource();
  const base = [
    [0, 0, 2, 2, 0, 2, 2, 0],
    [0, 0, 1, 1, 1, 1, 2, 0],
    [0, 0, 1, 1, 2, 2, 3, 3],
    [0, 0, 2, 2, 1, 1, 3, 3],
    [1, 0, 1, 2, 0, 1, 2, 1],
    [1, 1, 1, 1, 0, 0, 2, 2],
    [1, 2, 1, 2, 0, 0, 2, 2],
    [1, 1, 1, 1, 1, 1, 1, 1],
    [0, 0, 1, 1 + Number.EPSILON, 1 - Number.EPSILON, 1, 2, 2],
  ];
  for (let i = 0; i < 80; i++)
    base.push(Array.from({length: 8}, () => Math.round(random() * 100) - 50));
  const cases = [1e-68, 1, 1e68].flatMap(scale =>
    base.flatMap(row => [
      row.map(v => v * scale),
      [
        ...row.slice(2, 4),
        ...row.slice(0, 2),
        ...row.slice(6, 8),
        ...row.slice(4, 6),
      ].map(v => v * scale),
    ]),
  );
  const actual = evaluateCases(cases, `geometry.segmentContact(${args(8)})`);
  cases.forEach((row, i) =>
    expect(actual[i], JSON.stringify(row)).toBe(
      intersect(
        row.slice(0, 2),
        row.slice(2, 4),
        row.slice(4, 6),
        row.slice(6),
      ),
    ),
  );
});

test('quadratic bounded roots distinguish crossing, tangency, degree reduction, coincidence and points', () => {
  const cases = [
    [0, 0, 1, 2, 2, 0, 0, 0.5, 2, 0.5], // two crossings
    [0, 0, 1, 2, 2, 0, 0, 1, 2, 1], // tangent
    [0, 0, 1, 2, 2, 0, 0, 1.1, 2, 1.1], // disjoint
    [0, 0, 1, 1, 2, 2, 0, 2, 2, 0], // linear reduction
    [0, 0, 1, 0, 2, 0, 1, 0, 3, 0], // overlap
    [0, 0, 1, 0, 2, 0, 3, 0, 4, 0], // disjoint coincidence
    [0, 0, 4, 0, 0, 0, 1.5, 0, 3, 0], // backtracking overlap
    [0, 0, 1, 2, 2, 0, 1, 1, 1, 1], // point tangent
    [0, 0, 1, 2, 2, 0, 0.1, 0.1, 0.1, 0.1], // missing point
    [1, 1, 1, 1, 1, 1, 0, 1, 2, 1], // collapsed curve
    [0, 0, 1, 2, 2, 0, 0, 0, 2, 0], // endpoints
    [0, 0, 2, 1, 0, 2, 0.5, 0, 0.5, 2], // nonmonotone x
  ];
  const actual = evaluateCases(
    cases,
    `geometry.quadraticContacts(${args(10)})`,
  ) as {
    boundaryParameter: number;
    observationParameter: number;
    transverse: boolean;
    overlap: boolean;
  }[][];
  expect(actual.map(row => row.length)).toEqual([
    2, 1, 0, 1, 2, 0, 2, 1, 0, 1, 2, 2,
  ]);
  expect(actual[0].every(row => row.transverse && !row.overlap)).toBe(true);
  expect(actual[1][0]).toEqual({
    boundaryParameter: 0.5,
    observationParameter: 0.5,
    transverse: false,
    overlap: false,
  });
  expect(actual[3][0].boundaryParameter).toBe(0.5);
  expect(actual[4].map(row => row.observationParameter)).toEqual([0, 0.5]);
  expect(actual[6][1].observationParameter).toBeCloseTo(1 / 3, 14);
  for (const i of [0, 1, 2, 3, 10, 11]) {
    const row = cases[i];
    const ref = Intersection.intersect(
      Shapes.quadraticBezier(...row.slice(0, 6)),
      Shapes.line(...row.slice(6)),
    );
    expect(actual[i]).toHaveLength(ref.points.length);
    for (const contact of actual[i]) {
      const u = contact.boundaryParameter;
      const x =
        (1 - u) * (1 - u) * row[0] + 2 * u * (1 - u) * row[2] + u * u * row[4];
      const y =
        (1 - u) * (1 - u) * row[1] + 2 * u * (1 - u) * row[3] + u * u * row[5];
      expect(
        ref.points.some(
          (p: {x: number; y: number}) =>
            Math.abs(p.x - x) < 1e-12 && Math.abs(p.y - y) < 1e-12,
        ),
      ).toBe(true);
    }
  }
});

test('unsupported coordinates cannot produce an orientation or hit', () => {
  const rows = execute(
    `import geometry
emit "supported" geometry.coordinateSupported(close)
emit "side" geometry.orient2d(close, 0.0, 1.0, 1.0, 2.0, 0.0)
emit "hit" geometry.segmentContact(close, 0.0, 1.0, 1.0, 0.0, 0.0, 2.0, 2.0)
`,
    [NaN, 1e71, 1e-71].map(close => ({close})),
  );
  for (const close of [Infinity, -Infinity]) {
    expect(() => execute('emit "result" close', [{close}])).toThrow(
      'must match Float64',
    );
  }
  for (const row of rows) {
    expect(row.supported).toBe(false);
    expect(row.side).toBeNaN();
    expect(row.hit).toBe(false);
  }
});

test('quadratic roots preserve near-tangent crossings and reject near-tangent misses', () => {
  const cases = [1 - 2 ** -48, 1, 1 + 2 ** -48].map(y => [
    0,
    0,
    1,
    2,
    2,
    0,
    0,
    y,
    2,
    y,
  ]);
  const actual = evaluateCases(
    cases,
    `geometry.quadraticContacts(${args(10)})`,
  ) as {transverse: boolean}[][];
  expect(actual.map(row => row.length)).toEqual([2, 1, 0]);
  expect(actual[0].every(hit => hit.transverse)).toBe(true);
  expect(actual[1][0].transverse).toBe(false);
});

test('geometry arrays stay detached through provisional rollback and independent calls', () => {
  const node = tea`
    import geometry
    var seen = array.new<float>()
    side = geometry.orient2d(0.0, 0.0, 1.0, 1.0000000000000002, 0.9999999999999998, close)
    seen.push(side)
    emit "seen" seen
    emit "contacts" geometry.quadraticContacts(0.0, 0.0, 1.0, 2.0, 2.0, 0.0, 0.0, close, 2.0, close)
    emit "other" geometry.segmentContacts(0.0, 0.0, 1.0, 1.0, 0.0, 1.0, 1.0, 0.0)
  `;
  const data = [
    {close: 1, provisional: true},
    {close: 0.5, provisional: false},
    {close: 2, provisional: false},
  ];
  const bound = node.bind(
    new DataStream(
      new Schema([
        new Field('close', new Float64(), false),
        new Field('provisional', new Bool(), false),
      ]),
      from(data),
    ),
  );
  const rows: Record<string, unknown>[] = [];
  let failure: unknown;
  bound.to({
    next: row => rows.push(row),
    error: error => {
      failure = error;
    },
  });
  bound.dispose();
  node.dispose();
  if (failure) throw failure;
  expect(rows.map(row => (row.seen as unknown[]).length)).toEqual([1, 1, 2]);
  expect(rows.map(row => (row.contacts as unknown[]).length)).toEqual([
    1, 2, 0,
  ]);
  expect(rows.every(row => (row.other as unknown[]).length === 1)).toBe(true);
  expect(Object.isFrozen(rows[0].contacts)).toBe(true);
});

test('quadratic intersections agree with KLD on deterministic noncoincident curves', () => {
  const random = randomSource();
  const cases = Array.from({length: 128}, () => [
    -2, random() * 4 - 2, random() * 4 - 2, random() * 4 - 2,
    2, random() * 4 - 2, -3, 0, 3, 0,
  ]);
  const actual = evaluateCases(cases, `geometry.quadraticContacts(${args(10)})`) as {observationParameter: number}[][];
  cases.forEach((row, i) => {
    const ref = Intersection.intersect(Shapes.quadraticBezier(...row.slice(0, 6)), Shapes.line(...row.slice(6)));
    expect(actual[i], JSON.stringify(row)).toHaveLength(ref.points.length);
    for (const hit of actual[i]) {
      expect(ref.points.some((point: {x: number}) => Math.abs(point.x - (-3 + 6 * hit.observationParameter)) < 1e-12)).toBe(true);
    }
  });
});
