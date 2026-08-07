import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  createFacetingEngine,
  facetingMeshSignature,
  normalizeFacetingPolyhedron,
} from '../js/faceting.js';
import { facePlanes } from '../js/core.js';

const data = new URL('../data/', import.meta.url);
const [geometry, symmetry, html, script] = await Promise.all([
  readFile(new URL('geometry.json', data), 'utf8').then(JSON.parse),
  readFile(new URL('symmetry.json', data), 'utf8').then(JSON.parse),
  readFile(new URL('../icosahedron-faceting.html', import.meta.url), 'utf8'),
  readFile(new URL('../js/icosahedron-example.js', import.meta.url), 'utf8'),
]);

assert.match(html, /One solid, two constructions/);
assert.match(html, /small stellated dodecahedron/i);
assert.match(html, /\{5\/2, 5\}/);
assert.match(html, /67 distinct planes/);
assert.match(html, /79 explicit circuits/);
assert.match(html, /index\.html#u27\/Ih\/I\/d2\/\{2\}/);
assert.match(script, /small-stellated-dodecahedron/);

const engine = createFacetingEngine(geometry.u27, symmetry.I.matrices, {
  mode: 'exhaustive',
});
assert.equal(engine.vertices.length, 12);
assert.equal(engine.planes.length, 67);
assert.equal(engine.candidates.length, 79);
assert.equal(engine.orbits.length, 5);
assert.equal(engine.symmetry.permutations.length, 60);

const preset = engine.presets.find(candidate =>
  candidate.id === 'small-stellated-dodecahedron');
assert.ok(preset);
assert.deepEqual(preset.orbitIds, [2]);

const orbit = engine.orbits[2];
assert.equal(orbit.faceCount, 12);
assert.equal(orbit.sides, 5);
assert.equal(orbit.step, 2);
assert.equal(orbit.star, true);
assert.ok(Math.abs(orbit.planeDistance - 1 / Math.sqrt(5)) < 1e-12);
assert.deepEqual(orbit.representative.vertexIds, [1, 8, 0, 6, 3]);

const result = engine.applyPreset(preset);
assert.strictEqual(result.vertices, engine.vertices,
  'the faceting must retain the exact icosahedron vertex table');
assert.equal(result.vertices.length, 12);
assert.equal(result.faces.length, 12);
assert.equal(result.validation.edgeCount, 30);
assert.equal(result.validation.eulerCharacteristic, -6);
assert.equal(result.validation.manifold, true);
assert.equal(result.validation.usesAllVertices, true);
assert.ok(result.faceSteps.every(step => step === 2));
assert.ok(result.faceStars.every(Boolean));
assert.equal(
  facetingMeshSignature(result),
  facetingMeshSignature(geometry.u39),
  'F2 must be congruent to catalog U39',
);

const dodecahedron = normalizeFacetingPolyhedron(geometry.u28);
const smallStellated = normalizeFacetingPolyhedron(geometry.u39);
const dodecaPlanes = facePlanes(dodecahedron);
const starPlanes = facePlanes(smallStellated);
assert.equal(dodecaPlanes.length, 12);
assert.equal(starPlanes.length, 12);

const pairs = dodecaPlanes.map(source => {
  let best = null;
  let bestError = Infinity;
  for (const candidate of starPlanes) {
    const dot = source.n.x * candidate.n.x +
      source.n.y * candidate.n.y + source.n.z * candidate.n.z;
    const error = Math.abs(1 - dot);
    if (error < bestError) {
      bestError = error;
      best = candidate;
    }
  }
  return { source, target: best, normalError: bestError };
});
const scale = pairs.reduce((sum, pair) => sum + pair.source.d / pair.target.d, 0) /
  pairs.length;
const expectedScale = Math.sqrt((5 + 2 * Math.sqrt(5)) / 3);
assert.ok(Math.abs(scale - expectedScale) < 1e-12);
for (const pair of pairs) {
  assert.ok(pair.normalError < 1e-12, 'a star face normal must match a dodecahedron face normal');
  assert.ok(Math.abs(pair.source.d - scale * pair.target.d) < 1e-12,
    'uniform scaling must put the star face in the dodecahedron face plane');
}

console.log('icosahedron F2 report checks passed: V12/E30/F12, U39, 12 aligned planes');
