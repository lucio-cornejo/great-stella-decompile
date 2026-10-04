# Noble polyhedra: sources and conversion

The catalog retains its original 121 entries and adds 137 models from Connor
Hill's **The complete set of noble polyhedra**, arXiv:2607.28711v1 (2026).
Nine existing regular models already belong to the paper's 146-member finite
nonprismatic classification; their `nobleSymbol` fields supply the correspondence.
The infinite disphenoid and stephanoid families are not enumerated here.

- Paper: https://arxiv.org/abs/2607.28711
- Model library and exact-coordinate resources:
  https://github.com/Plasmath/noble-tools-revised/tree/a801da7582fa927ba07e0af74d7c9c39445b7264/library
- Source revision: `a801da7582fa927ba07e0af74d7c9c39445b7264`
- Imported geometry and derived SVG thumbnails: GPLv3, supplied without warranty;
  see `nobles-GPL-3.0.txt`. Preserve these attribution and license notices when
  redistributing these assets. The existing application code retains its Apache
  2.0 license; this notice does not relicense the imported assets as Apache.

## Storage

`catalog.json` keeps the existing category/items structure. New entries use
URL-safe IDs (`n_sD_10_1` for `sD-10.1`), the paper's symbol as their name,
existing point-group names, and explicit `dual` references. `dualSymbol` retains
the paper's notation. `schlafli` records the abstract face size and number of
faces incident to each vertex, not a star polygon's winding fraction.

`geometry.json` keeps the existing flattened `v` coordinates and ordered `f`
vertex-index circuits. Source files are `library/<degrees>/<orbit type>/<symbol>.off`.
The OFF edge-count header is zero (unspecified); actual edges are computed from
face circuits. No convex hull, face triangulation, or vertex merging is applied.

Coordinates are transformed `(x,y,z) -> (y,x,z)` to match the application's
existing symmetry matrices, then uniformly scaled to a unit circumradius.
Individual SVG thumbnails under `img/poly/` are orthographic, depth-sorted
projections of those native face circuits, using even-odd fills for crossings.
The original GIF thumbnails and original geometry tables remain unchanged.

## Duals and limitations

Dual references and point groups come from Appendix A. Eighteen chiral dual
pairs need central inversion to align their reciprocal diagram with the base:
`dualInverted: true` applies this only to the reciprocal helper, not the selected
model. Regression checks compare reciprocal plane directions with base vertices.

`D-4`, `D-5`, `gD-19.1`, and `gD-28.1` have fissary duals with coincident vertices
(Section 5.2). Their catalog entries explicitly use `dual: null`. The exact base
and direct faceting remain available, while the reciprocal diagram and its
exports are disabled and labelled unavailable. The two supplemental fissary OFF
models in the source library are not members of the 146-model classification
and are not added as ordinary catalog solids.

Existing native-only fallbacks retain exact models when the circuit search is
limited. This import does not reproduce the paper's symbolic enumeration or
claim exhaustive faceting for arbitrary new vertex sets.

## Appendix corrections

Metadata uses the actual OFF circuits rather than copying inconsistent printed
entries from Appendix A:

| Symbol | Geometry-derived V / E / F | Abstract Schläfli type |
|---|---|---|
| D-2 | 20 / 90 / 60 | {3,9} |
| D-7 | 20 / 90 / 60 | {3,9} |
| tI-5.6 | 60 / 180 / 60 | {6,6} |
| rD-5.2 | 60 / 120 / 30 | {8,4} |

For exact reconstruction, consult the library's `coordinates.txt` and
`summary.txt` files alongside Appendix B; the browser uses numerical coordinates,
as it does for the original catalog.
