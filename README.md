# Faceting — Great Stella reconstruction

This directory contains a browser-based faceting port of Vladimir Bulatov's
Great Stella / Stellation applet. A faceting keeps the selected base
polyhedron's vertices and replaces its faces with explicit closed circuits.

Live site: <https://yaroslavvb.github.io/great-stella-decompile/>

Interactive F² case study:
<https://yaroslavvb.github.io/great-stella-decompile/icosahedron-faceting.html>

The supplied target is available from the **Great Stella** button: twelve
pentagrams on the twenty canonical vertices of a dodecahedron. The resulting
geometry and abstract face topology match the catalog's great stellated
dodecahedron (`u57`). **base** restores the dodecahedron's twelve pentagons
without moving any vertex.

## Run locally

The app is static, but module workers require HTTP rather than `file://`:

```bash
python3 -m http.server 8732 --directory web
```

Then open <http://127.0.0.1:8732/>.

## What makes it faceting

- The final mesh always uses the chosen base polyhedron's canonical vertex set.
- Candidate faces are explicit vertex-index circuits repeated under the chosen
  symmetry group.
- Cycles are canonicalized modulo rotation and reversal.
- Validation checks closed circuits, repeated vertices, symmetry closure, and
  abstract edge incidence. A tidy closed faceting has two incident faces at
  every edge.
- Self-intersecting faces such as pentagrams retain their abstract edge order;
  they are not replaced by a convex hull.

The older plane-arrangement machinery remains useful as the reciprocal
faceting diagram and for importing original `.stel` constructions. It is a
candidate-discovery aid, not the final face topology: deeper stellation cell
unions can collapse multiple helper vertices onto one base vertex and need not
polarize into a tidy faceting.

## Catalog coverage

All 258 catalog bases restore their exact native face circuits and pass the
closed-manifold/uses-all-vertices checks. The original 121-model catalog retains
its 92 exhaustive circuit searches and 29 clearly labelled **native-only**
fallbacks. Another 137 entries complete Connor Hill's 146-member finite noble
polyhedron classification (the nine regular examples were already present).
New models use the same faceting engine and native-only fallback when needed;
the app does not pretend that a broader circuit enumeration is complete.

The four noble models with fissary duals keep their exact native faces but
explicitly disable the reciprocal diagram. Infinite disphenoid and stephanoid
families are not enumerated. See [`web/data/nobles.md`](web/data/nobles.md) for
source revision, coordinate/dual alignment, Appendix corrections, and the
separate GPLv3 license of the imported model data and derived thumbnails.

Run the regression suites with:

```bash
node web/test/faceting.mjs
node web/test/validate.mjs
node web/test/preset.mjs
node web/test/catalog.mjs
node web/test/nobles.mjs
```

## Files

- `web/js/faceting.js` — direct candidate, orbit, preset, and validity engine
- `web/js/app.js` — application state, URL/preset handling, and controls
- `web/js/worker.js` — off-main-thread arrangement and faceting work
- `web/js/render3d.js` — WebGL face-cycle and edge rendering
- `web/js/core.js` — the tested reciprocal plane-arrangement core
- `web/data/geometry.json` — canonical catalog geometry
- `web/data/catalog.json` — names, symmetry groups, noble symbols and explicit duals
- `web/data/nobles.md` — noble model sources, conversion notes, and asset licensing
- `web/test/` — algorithm and regression tests

## Provenance

The plane-arrangement code was ported from Vladimir Bulatov's Stellation applet
(1998–2001) and is distributed under the Apache License 2.0 in `LICENSE`. This
workspace adds the fixed-vertex faceting layer, explicit circuit topology,
validity diagnostics, and the Great Stella acceptance preset.
