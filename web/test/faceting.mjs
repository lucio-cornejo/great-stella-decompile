/*
 * Direct-faceting regression tests.
 *
 * Run with:
 *   node web/test/faceting.mjs
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildFacetingPreview,
  canonicalCircuit,
  createFacetingEngine,
  facetingMeshSignature,
  validateFaceting,
} from '../js/faceting.js';
import { cross, dot, len, sub } from '../js/core.js';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, '..', 'data');
const geometry = JSON.parse(readFileSync(join(dataDir, 'geometry.json'), 'utf8'));
const symmetry = JSON.parse(readFileSync(join(dataDir, 'symmetry.json'), 'utf8'));

let assertions = 0;
function check(value, message) { assertions++; assert.ok(value, message); }
function equal(actual, expected, message) { assertions++; assert.equal(actual, expected, message); }
function deepEqual(actual, expected, message) { assertions++; assert.deepEqual(actual, expected, message); }
function throws(fn, expected, message) { assertions++; assert.throws(fn, expected, message); }

function flatVertices(mesh) {
  return mesh.vertices.flatMap(p => [p.x, p.y, p.z]);
}

function assertCandidateCoplanarity(engine) {
  for (const candidate of engine.candidates) {
    const ids = candidate.vertexIds;
    const a = engine.vertices[ids[0]], b = engine.vertices[ids[1]], c = engine.vertices[ids[2]];
    const n0 = cross(sub(b, a), sub(c, a));
    const n = len(n0) ? { x: n0.x / len(n0), y: n0.y / len(n0), z: n0.z / len(n0) } : n0;
    const d = dot(n, a);
    check(ids.every(id => Math.abs(dot(n, engine.vertices[id]) - d) < 1e-6),
      `candidate ${candidate.id} is coplanar`);
    equal(new Set(ids).size, ids.length, `candidate ${candidate.id} is a circuit`);
  }
}

function assertCatalogMatch(engine, presetId, targetKey, expected) {
  const preset = engine.presets.find(p => p.id === presetId);
  check(preset, `preset ${presetId} exists`);
  const preview = engine.applyPreset(presetId);

  // Direct faceting's defining invariant: no reciprocal/intersection vertices
  // may be introduced, compacted, moved, or omitted.
  equal(preview.vertices.length, expected.vertices, `${presetId}: fixed vertex count`);
  check(preview.vertices === engine.vertices, `${presetId}: fixed vertex table identity`);
  deepEqual(flatVertices(preview), engine.poly.vertices.flatMap(p => [p.x, p.y, p.z]),
    `${presetId}: exact base coordinates and order`);
  equal(preview.faces.length, expected.faces, `${presetId}: target face count`);
  check(preview.faces.every(f => f.length === expected.sides), `${presetId}: target face size`);
  equal(preview.faceSteps.length, preview.faces.length, `${presetId}: one step value per face`);
  equal(preview.faceStars.length, preview.faces.length, `${presetId}: one star flag per face`);
  check(preview.faceSteps.every(step => step === (expected.step ?? 1)),
    `${presetId}: circuit steps are preserved`);
  check(preview.faceStars.every(star => star === Boolean(expected.star)),
    `${presetId}: star flags are preserved`);
  equal(new Set(preview.faces.map(canonicalCircuit)).size, preview.faces.length,
    `${presetId}: no repeated face circuits`);

  const report = preview.validation;
  check(report.valid, `${presetId}: even edge incidence`);
  check(report.manifold, `${presetId}: exactly two faces per edge`);
  check(report.usesAllVertices, `${presetId}: every fixed vertex is used`);
  equal(report.edgeCount, expected.edges, `${presetId}: target edge count`);
  equal(report.eulerCharacteristic, expected.euler ?? 2, `${presetId}: abstract Euler characteristic`);
  equal(report.edgeBuckets.open.length, 0, `${presetId}: no boundary edges`);
  equal(report.edgeBuckets.odd.length, 0, `${presetId}: no odd-incidence edges`);

  // This signature checks the entire fixed vertex metric, cyclic edge-length
  // pattern of every face (so pentagon != pentagram), face-plane radii, vertex
  // degrees, and edge incidences.  It ignores only rigid orientation, uniform
  // scale, reflection, and catalog vertex labels.
  equal(facetingMeshSignature(preview), facetingMeshSignature(geometry[targetKey]),
    `${presetId}: catalog ${targetKey} topology and geometry`);

  const match = engine.findTarget(geometry[targetKey]);
  check(match.matched, `${targetKey}: target matcher finds an orbit`);
  deepEqual(match.orbitIds, preset.orbitIds, `${targetKey}: matcher finds the named preset`);
  equal(match.preset?.id, presetId, `${targetKey}: matcher labels the preset`);
  return preview;
}

console.log('=== dodecahedral vertex set ===');
const dodeca = createFacetingEngine(geometry.u28, symmetry.Ih.matrices);
equal(dodeca.vertices.length, 20, 'u28 vertex count');
equal(dodeca.planes.length, 319, 'u28 distinct coplanar vertex planes');
equal(dodeca.candidates.length, 343, 'u28 polygon/star circuits');
equal(dodeca.orbits.length, 12, 'u28 circuit orbits under Ih');
equal(dodeca.symmetry.permutations.length, 120, 'all Ih matrices map the vertex set');
equal(dodeca.symmetry.rejected.length, 0, 'no Ih matrix rejected');
equal(dodeca.mode, 'exhaustive', 'ordinary engine retains exhaustive mode');
check(dodeca.candidates.some(c => c.sides === 5 && c.step === 2 && c.star),
  'pentagram candidates are explicitly enumerated');
assertCandidateCoplanarity(dodeca);

const greatStellated = assertCatalogMatch(
  dodeca, 'great-stellated-dodecahedron', 'u57',
  { vertices: 20, faces: 12, sides: 5, edges: 30, step: 2, star: true },
);
const gsdOrbit = dodeca.orbits[dodeca.presets.find(p => p.id === 'great-stellated-dodecahedron').orbitIds[0]];
equal(gsdOrbit.step, 2, 'great stellated dodecahedron uses {5/2} circuits');
equal(gsdOrbit.faceCount, 12, 'great stellated dodecahedron is isohedral');
check(gsdOrbit.planeDistance < 0.2, 'great stellated faces use the inner plane orbit');

const ordinaryDodeca = assertCatalogMatch(
  dodeca, 'dodecahedron', 'u28',
  { vertices: 20, faces: 12, sides: 5, edges: 30 },
);
check(facetingMeshSignature(greatStellated) !== facetingMeshSignature(ordinaryDodeca),
  'pentagram and convex-pentagon circuits remain topologically distinct');

// Selection is orbit-based and previews update without changing the vertex set.
const empty = dodeca.clear();
equal(empty.faces.length, 0, 'clear removes selected face orbits');
equal(empty.vertices.length, 20, 'empty preview retains fixed vertices');
const toggledOn = dodeca.toggle(gsdOrbit.id);
equal(toggledOn.faces.length, 12, 'toggle selects a complete symmetry orbit');
const toggledOff = dodeca.toggle(gsdOrbit.id);
equal(toggledOff.faces.length, 0, 'second toggle deselects the orbit');

const oneFace = buildFacetingPreview(dodeca.poly, [{ id: 0, candidates: [gsdOrbit.representative] }], [0]);
const openReport = validateFaceting(oneFace);
check(!openReport.valid && !openReport.manifold, 'partial orbit is diagnosed as open');
equal(openReport.edgeBuckets.open.length, 5, 'one pentagram has five open abstract edges');

console.log('=== icosahedral vertex set ===');
const icosa = createFacetingEngine(geometry.u27, symmetry.Ih.matrices);
equal(icosa.vertices.length, 12, 'u27 vertex count');
equal(icosa.planes.length, 67, 'u27 distinct coplanar vertex planes');
equal(icosa.candidates.length, 79, 'u27 polygon/star circuits');
equal(icosa.orbits.length, 5, 'u27 circuit orbits under Ih');
equal(icosa.symmetry.permutations.length, 120, 'all Ih actions retained for u27');
assertCandidateCoplanarity(icosa);

assertCatalogMatch(
  icosa, 'great-icosahedron', 'u58',
  { vertices: 12, faces: 20, sides: 3, edges: 30 },
);
assertCatalogMatch(
  icosa, 'icosahedron', 'u27',
  { vertices: 12, faces: 20, sides: 3, edges: 30 },
);
assertCatalogMatch(
  icosa, 'great-dodecahedron', 'u40',
  { vertices: 12, faces: 12, sides: 5, edges: 30, euler: -6 },
);
assertCatalogMatch(
  icosa, 'small-stellated-dodecahedron', 'u39',
  { vertices: 12, faces: 12, sides: 5, edges: 30, euler: -6, step: 2, star: true },
);

const greatIco = icosa.presets.find(p => p.id === 'great-icosahedron');
const ordinaryIco = icosa.presets.find(p => p.id === 'icosahedron');
check(icosa.orbits[greatIco.orbitIds[0]].planeDistance <
      icosa.orbits[ordinaryIco.orbitIds[0]].planeDistance,
  'great icosahedron uses the inner triangle-plane orbit');

console.log('=== high-vertex native-only fallback ===');
throws(
  () => createFacetingEngine(geometry.u33, symmetry.Ih.matrices, {
    maxPlanes: 100,
    nativeFallback: false,
  }),
  /faceting plane limit/,
  'u33 demonstrates why exhaustive enumeration needs a safety limit',
);
const high = createFacetingEngine(geometry.u33, symmetry.Ih.matrices, {
  nativeOnly: true,
  maxPlanes: 0, // deliberately impossible for exhaustive mode; ignored here
});
equal(high.mode, 'native-only', 'native-only mode is exposed');
equal(high.vertices.length, 120, 'native-only u33 retains all 120 fixed vertices');
equal(high.candidates.length, geometry.u33.f.length, 'one candidate per explicit native face');
equal(high.planes.length, geometry.u33.f.length, 'native mode performs no triple-plane expansion');
equal(high.orbits.length, 3, 'u33 native faces group into its three face-type orbits');
equal(high.symmetry.rejected.length, 0, 'u33 native symmetry action is complete');
const highBasePreset = high.presets.find(p => p.id === 'base');
check(highBasePreset, 'every native-only engine exposes a base preset');
deepEqual(highBasePreset.orbitIds, [0, 1, 2], 'base preset selects every native face orbit');
const highBase = high.applyPreset('base');
check(highBase.vertices === high.vertices, 'high-vertex preview retains fixed table identity');
deepEqual(flatVertices(highBase), geometry.u33.v, 'high-vertex preview retains exact coordinates');
deepEqual(highBase.faces, geometry.u33.f, 'base preset restores exact native face circuits and order');
check(highBase.faceSteps.every(step => step === 1), 'u33 native ordinary face steps are inferred');
check(highBase.faceStars.every(star => star === false), 'u33 native faces are not mislabeled as stars');
check(highBase.validation.manifold && highBase.validation.usesAllVertices,
  'native high-vertex base remains a complete manifold');
const highMatch = high.findTarget(geometry.u33, { maxOrbitTypes: 3 });
check(highMatch.matched, 'bounded multi-orbit matcher recovers native u33');
equal(highMatch.preset?.id, 'base', 'native target matcher identifies the base preset');

const automaticHigh = createFacetingEngine(geometry.u33, symmetry.Ih.matrices);
equal(automaticHigh.mode, 'native-only', 'large catalog input automatically selects native fallback');
check(automaticHigh.fallbackReason?.includes('vertex count'), 'automatic fallback reports its reason');
deepEqual(automaticHigh.applyPreset('base').faces, geometry.u33.f,
  'automatic high-vertex fallback remains lossless');

// Vertex count alone is not enough: a few smaller catalog meshes have native
// circuits that are subsets of a larger coplanar set or are not constant-step
// angular polygons.  Detect that after exhaustive enumeration and fall back
// before an unrelated orbit can be mistaken for the base model.
const lowRecoveryFallback = createFacetingEngine(geometry.d18, symmetry.Oh.matrices);
equal(lowRecoveryFallback.mode, 'native-only',
  'small mesh falls back when exhaustive candidates cannot recover native faces');
check(lowRecoveryFallback.fallbackReason?.includes('native face circuits'),
  'native-recovery fallback reports its reason');
deepEqual(lowRecoveryFallback.applyPreset('base').faces, geometry.d18.f,
  'small recovery fallback restores exact native faces');
const forcedLowExhaustive = createFacetingEngine(geometry.d18, symmetry.Oh.matrices, {
  nativeFallback: false,
});
equal(forcedLowExhaustive.mode, 'exhaustive', 'nativeFallback:false preserves explicit exhaustive behavior');
check(!forcedLowExhaustive.presets.some(p => p.id === 'base'),
  'forced exhaustive mode does not claim an unrecoverable base preset');

// Native mode treats the supplied traversal as authoritative.  This catches a
// regression where sorting a crossed face angularly silently changed {5/2}
// into an ordinary pentagon.
const nativeStar = createFacetingEngine(geometry.u57, symmetry.Ih.matrices, { nativeOnly: true });
const nativeStarBase = nativeStar.applyPreset('base');
deepEqual(nativeStarBase.faces, geometry.u57.f, 'native pentagram circuits remain byte-for-byte ordered');
check(nativeStarBase.faceSteps.every(step => step === 2), 'native pentagrams infer step 2');
check(nativeStarBase.faceStars.every(Boolean), 'native pentagrams expose renderer star metadata');
equal(facetingMeshSignature(nativeStarBase), facetingMeshSignature(geometry.u57),
  'native star base remains catalog-identical');

// Several dual catalog meshes intentionally contain topologically distinct
// vertices at the same coordinates.  Symmetry matching must consume a nearest
// unused target instead of mapping both source slots onto the first duplicate.
let hasCoincidentPair = false;
for (let i = 0; i < geometry.d77.v.length / 3 && !hasCoincidentPair; i++) {
  for (let j = i + 1; j < geometry.d77.v.length / 3; j++) {
    let distance2 = 0;
    for (let axis = 0; axis < 3; axis++)
      distance2 += (geometry.d77.v[i * 3 + axis] - geometry.d77.v[j * 3 + axis]) ** 2;
    if (distance2 < 1e-20) { hasCoincidentPair = true; break; }
  }
}
check(hasCoincidentPair, 'd77 fixture contains coincident duplicate vertex coordinates');
const duplicateNative = createFacetingEngine(geometry.d77, symmetry.I.matrices, { nativeOnly: true });
equal(duplicateNative.symmetry.permutations.length, 60,
  'all proper icosahedral actions bijectively map duplicate coordinates');
equal(duplicateNative.symmetry.rejected.length, 0,
  'duplicate coordinates do not reject valid symmetry matrices');
deepEqual(duplicateNative.applyPreset('base').faces, geometry.d77.f,
  'duplicate-coordinate native base retains exact topology');

console.log(`\n${assertions} assertions passed`);
