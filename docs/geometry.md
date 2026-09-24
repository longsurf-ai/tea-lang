---
title: 'Geometry predicates'
---

`import geometry` loads ordinary Tea functions. Geometry is not implicit, and
there is no native geometry evaluator. The CPU target executes ordered Float64
operations; the exact predicates are not a Float32/GPU promise.

```tea
import geometry
hit = geometry.segmentContact(0.0, 100.0, 2.0, 110.0, 0.0, close[1], 1.0, close)
emit "hit" hit
```

## Contract

- `coordinateSupported(value)` admits zero and finite coordinates with absolute
  magnitude from `1e-70` through `1e70`. This conservative range keeps expansion
  products normal and avoids splitter/product overflow. Hosts must reject
  unsupported geometry; missing price data should skip evaluation. Inputs are
  Cartesian coordinates: the library assigns no market/time/pixel meaning.
- `orient2d(ax,ay,bx,by,cx,cy)` returns a clockwise-positive determinant. Use its
  sign, not its magnitude: the adaptive exact branch returns the leading
  nonzero expansion term. Unsupported coordinates return `na`.
- `segmentContact(ax,ay,bx,by,px,py,qx,qy)` includes endpoints, zero-length
  segments and bounded collinear overlap. Unsupported coordinates return false.
- `segmentContacts(...)` and
  `quadraticContacts(ax,ay,bx,by,cx,cy,px,py,qx,qy)` return a fresh array of
  `Contact {boundaryParameter, observationParameter, transverse, overlap}`.
  Quadratic A/B/C are start/control/end; observation P/Q is finite. Empty means
  no contact (or unsupported input). Parameters are in `[0,1]`; a zero-length
  observation has parameter zero. An overlap returns its two observation
  interval endpoints, with `boundaryParameter = na` because there is no unique
  inverse on a backtracking curve. A collapsed coincidence returns one contact.
  Do not assume contact ordering. Arrays/results from different calls are
  independent and ordinary provisional rollback rules apply.
- `transverse` distinguishes curve crossings from tangency, not shared-vertex
  path behavior. A path consumer must consider adjacent primitives together,
  and choose its endpoint/arrival/overlap policy. The library does not close
  paths, simplify strokes, snap prices or implement alert conditions.
- `rectangleContacts(ax,ay,bx,by,cx,cy,quadratic,left,bottom,right,top)` tests
  a closed rectangle including its interior. With `quadratic = false`, A/C
  form a line; otherwise A/B/C form a quadratic. It reuses the finite contact
  kernels on all four sides and checks endpoint containment. Returned
  `Point {x,y}` values contain at most one geometric witness per primitive:
  a rectangle-edge contact, or a contained endpoint when the primitive lies
  wholly inside. This bounded result proves intersection without enumerating
  every clipping point; it has no first-contact ordering. Degenerate rectangles are valid; inverted
  bounds or unsupported coordinates return an empty array. No pixel width,
  time interval or trading meaning belongs to this primitive.

## Algorithms and numerical limits

The linear kernel ports the 2D specialization of **robust-orientation 1.2.1**,
including its error bound and exact expansion fallback; **two-product 1.0.2**
uses Dekker splitting and **robust-sum 1.0.0 / robust-subtract 1.0.0** provide
ordered zero-eliminating expansion merges. Sum and subtraction share the same
merge with an explicit sign. **robust-segment-intersect 1.0.1** supplies the
four orientation tests and collinear bounding-box decision. Only hit parameters
use division after the exact existence decision.

Quadratic construction follows **kld-intersections 0.7.0**: substitute Bézier's
power-basis coefficients into the observation's supporting line. Solve the
resulting degree-two polynomial, reduce exact zero coefficients to a line,
retain bounded roots and evaluate points using de Casteljau. A normalized,
expansion-evaluated discriminant and cancellation-resistant `q/a, c/q` roots
preserve near-tangent roots without an epsilon that invents intersections.
Coincident and point observations are treated separately, including a
backtracking quadratic's interior extremum. KLD's `Coincident` status alone
is deliberately not used as a finite intersection oracle.

Quadratic coefficient construction and root locations still use Float64; they
are not exact algebraic-number arithmetic. Parameter acceptance/rounding uses
32 machine epsilons (`7.105427357601002e-15`), never a pixel/price hit radius.
An out-of-range curve or observation parameter within that bound is clamped
only if the resulting curve point passes the exact finite-segment predicate.
Curve endpoints are evaluated from the original coordinates, so clamping cannot
extend a disjoint primitive or observation into a contact.
Point observations additionally check the evaluated coordinates against the
same relative rounding bound. Ill-conditioned curves can retain root-location
uncertainty; the tests pin tangency, degree reduction, nonmonotone X and bounded
coincidence behavior instead of promising arbitrary-precision curve geometry.

Pinned upstream packages are development-only independent test oracles.
`tests/geometry.test.ts` exercises public Node binding/emission, fast and exact
branches, adversarial signs, degeneracy, root classification and rejected
coordinates. `tests/fixtures/execution/differential/geometry` supplies the
hash-pinned, independently derived compile-through reference. Upstream MIT
copyright/license notices are retained under `LICENSES/`.
