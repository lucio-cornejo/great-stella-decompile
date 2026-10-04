// Run with: node web/test/nobles.mjs
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { facePlanes, suggestDepth } from '../js/core.js';
import { canonicalCircuit, createFacetingEngine } from '../js/faceting.js';
import { readDocument, writePreset } from '../js/preset.js';

const data = new URL('../data/', import.meta.url);
const [catalog, geometry, symmetry] = await Promise.all(
  ['catalog', 'geometry', 'symmetry'].map(async name =>
    JSON.parse(await readFile(new URL(`${name}.json`, data), 'utf8'))));
const items = catalog.flatMap(section => section.items);
const added = items.filter(item => item.file.startsWith('n_'));
assert.equal(added.length, 137);
assert.equal(new Set(items.map(item => item.file)).size, items.length);
assert.equal(new Set(items.filter(item => item.nobleSymbol).map(item => item.nobleSymbol)).size, 146);
assert.equal(added.filter(item => item.dual === null).length, 4);
assert.equal(added.filter(item => item.dualInverted).length, 18);

const toPoly = g => ({
  vertices: Array.from({ length: g.v.length / 3 }, (_, i) =>
    ({ x: g.v[3 * i], y: g.v[3 * i + 1], z: g.v[3 * i + 2] })),
  faces: g.f,
});
const reciprocal = item => {
  const g = geometry[item.dual];
  return item.dualInverted ? { v: g.v.map(x => -x), f: g.f } : g;
};
for (const item of added) {
  assert.match(item.file, /^\w+$/, 'IDs must round-trip through existing URL parsing');
  await access(new URL(`../${item.thumbnail}`, import.meta.url));
  const g = geometry[item.file];
  const engine = createFacetingEngine(g, symmetry[item.symmetry].matrices, { nativeOnly: true });
  assert.equal(engine.symmetry.rejected.length, 0, item.file);
  assert.equal(engine.orbits.length, 1, `${item.file}: face-transitive under its declared group`);
  const mesh = engine.preview([0]);
  assert.equal(mesh.validation.manifold, true, item.file);
  assert.equal(mesh.validation.usesAllVertices, true, item.file);
  assert.equal(mesh.validation.edgeBuckets.coplanar.length, 0, item.file);
  assert.equal(item.schlafli, `{${g.f[0].length},${mesh.validation.vertexFaceUse[0]}}`, item.file);
  assert.deepEqual(new Set(mesh.faces.map(canonicalCircuit)), new Set(g.f.map(canonicalCircuit)), item.file);
  if (!item.dual) { assert.ok(item.reciprocalNote); continue; }
  const dual = toPoly(reciprocal(item));
  // The reciprocal helper's planes must be the base's vertex directions, not
  // merely an abstractly correct dual placed in the wrong chiral frame.
  const planes = facePlanes(dual);
  assert.equal(planes.length, g.v.length / 3, item.file);
  const base = toPoly(g);
  for (const { n } of planes)
    assert.ok(base.vertices.some(v => Math.hypot(n.x - v.x, n.y - v.y, n.z - v.z) < 1e-6), item.file);
}

// Exercise the actual worker protocol: nullable diagrams must not retain the
// preceding solid's diagram, disable native meshes, or poison subsequent builds.
globalThis.self = {};
await import('../js/worker.js');
const call = (type, payload) => {
  let result;
  self.postMessage = message => { if ('ok' in message) result = message; };
  self.onmessage({ data: { id: 1, type, payload } });
  assert.ok(result?.ok, result?.error || `no ${type} reply`);
  return result.data;
};
const builds = ['n_tC_1_1', 'n_D_4', 'n_D_5', 'n_gD_19_1', 'n_gD_28_1', 'n_sD_10_1', 'n_gD_1_1'];
for (const file of builds) {
  const item = added.find(item => item.file === file);
  const helper = item.dual ? reciprocal(item) : null;
  const info = call('build', {
    geometry: helper, baseGeometry: geometry[file], skipReciprocal: item.dual === null,
    matrices: symmetry[item.symmetry].matrices,
    subMatrices: symmetry[{ Ih: 'I', Oh: 'O' }[item.symmetry] || item.symmetry].matrices,
    maxIntersection: helper ? suggestDepth(facePlanes(toPoly(helper))) : 2, maxLayer: 1000,
  });
  assert.equal(info.diagnostics.diagramAvailable, Boolean(helper), file);
  assert.equal(info.diagnostics.symmetryRejected.length, 0, file);
  const { selected } = call('applyPreset', { preset: 'base' });
  const { mesh, diagram } = call('both', { selected, planeIndex: 0 });
  assert.equal(mesh.validation.manifold, true, file);
  assert.deepEqual(new Set(mesh.faces.map(canonicalCircuit)), new Set(geometry[file].f.map(canonicalCircuit)), file);
  assert.equal(Boolean(diagram), Boolean(helper), file);
  const doc = readDocument(writePreset({
    name: file, file, polyhedron: item.name, polySymmetry: item.symmetry,
    stellSymmetry: item.symmetry, facetOrbits: call('formatCells', { selected }).cells,
    dualFile: item.dual,
  }));
  assert.equal(doc.file, file);
  assert.equal(doc.dualFile, item.dual);
  console.log(`worker: ${item.nobleSymbol} (${info.ms} ms, ${info.diagnostics.enumerationMode})`);
}
// An accidentally missing dual is still an error, not an implicit opt-out.
let error;
self.postMessage = message => { if ('ok' in message) error = message; };
self.onmessage({ data: { id: 2, type: 'build', payload: { baseGeometry: geometry.n_D_4 } } });
assert.equal(error.ok, false);
assert.match(error.error, /reciprocal geometry is required/);
console.log('noble tests passed: 137 additions, geometry/symmetry/dual frames, worker transitions and JSON round trips');
