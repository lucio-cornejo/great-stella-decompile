import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { canonicalCircuit, createFacetingEngine } from '../js/faceting.js';

const here = new URL('../data/', import.meta.url);
const [catalog, geometry, symmetry] = await Promise.all([
  readFile(new URL('catalog.json', here), 'utf8').then(JSON.parse),
  readFile(new URL('geometry.json', here), 'utf8').then(JSON.parse),
  readFile(new URL('symmetry.json', here), 'utf8').then(JSON.parse),
]);

const proper = { Ih: 'I', I: 'I', Oh: 'O', O: 'O', Td: 'T', Th: 'T', T: 'T' };
const items = catalog.flatMap(section => section.items);
assert.equal(items.length, 258, 'visible catalog size');
assert.equal(items.filter(item => item.nobleSymbol).length, 146, 'complete finite noble classification');

let exhaustive = 0, nativeOnly = 0;
const started = performance.now();
for (const item of items) {
  const group = proper[item.symmetry] || item.symmetry;
  const engine = createFacetingEngine(geometry[item.file], symmetry[group]?.matrices || []);
  if (!item.file.startsWith('n_'))
    engine.mode === 'native-only' ? nativeOnly++ : exhaustive++;

  const wanted = new Set(engine.poly.faces.map(canonicalCircuit));
  const byKey = new Map(engine.candidates.map(candidate => [candidate.key, candidate]));
  const orbitIds = new Set();
  for (const key of wanted) {
    const candidate = byKey.get(key);
    assert.ok(candidate, `${item.file}: native circuit is selectable`);
    orbitIds.add(candidate.orbitId);
  }
  const preview = engine.preview(orbitIds);
  const actual = new Set(preview.faces.map(canonicalCircuit));
  assert.deepEqual(actual, wanted, `${item.file}: exact native face set`);
  assert.equal(preview.vertices.length, geometry[item.file].v.length / 3,
    `${item.file}: fixed canonical vertex table`);
  assert.equal(preview.validation.manifold, true, `${item.file}: manifold base`);
  assert.equal(preview.validation.usesAllVertices, true, `${item.file}: every vertex used`);
  assert.equal(engine.symmetry.rejected.length, 0, `${item.file}: symmetry actions accepted`);
}

assert.equal(exhaustive, 92, 'exhaustive catalog models');
assert.equal(nativeOnly, 29, 'lossless native-only fallbacks');
console.log(`catalog tests passed: ${items.length} bases (original catalog: ${exhaustive} exhaustive, ${nativeOnly} native-only) in ${((performance.now() - started) / 1000).toFixed(1)}s`);
