# Faceting — Great Stella reconstruction

This directory contains a browser-based faceting port of Vladimir Bulatov's
Great Stella / Stellation applet. A faceting keeps the selected base
polyhedron's vertices and replaces its faces with explicit closed circuits.

Live site: <https://yaroslavvb.github.io/great-stella-decompile/>

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

All 121 catalog bases restore their exact native face circuits and pass the
closed-manifold/uses-all-vertices checks. Ninety-two small and medium vertex
sets expose exhaustive coplanar circuit families. Twenty-nine difficult models
(large vertex tables or native faces lying inside larger coplanar sets) switch
to a clearly labelled **native-only** mode: the base remains exact, while the
app does not pretend that a broader faceting enumeration is complete.

Run the regression suites with:

```bash
node web/test/faceting.mjs
node web/test/validate.mjs
node web/test/preset.mjs
node web/test/catalog.mjs
```

## Files

- `web/js/faceting.js` — direct candidate, orbit, preset, and validity engine
- `web/js/app.js` — application state, URL/preset handling, and controls
- `web/js/worker.js` — off-main-thread arrangement and faceting work
- `web/js/render3d.js` — WebGL face-cycle and edge rendering
- `web/js/core.js` — the tested reciprocal plane-arrangement core
- `web/data/geometry.json` — canonical catalog geometry
- `web/test/` — algorithm and regression tests

## Provenance

The plane-arrangement code was ported from Vladimir Bulatov's Stellation applet
(1998–2001) and is distributed under the Apache License 2.0 in `LICENSE`. This
workspace adds the fixed-vertex faceting layer, explicit circuit topology,
validity diagnostics, and the Great Stella acceptance preset.
