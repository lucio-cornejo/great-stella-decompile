import assert from 'node:assert/strict';
import {
  APP_NAME, FILE_FORMAT_RELEASE, date2s, newDocumentName,
  readDocument, writePreset,
} from '../js/preset.js';

assert.equal(APP_NAME, 'Faceting.PolyhedronCatalog.FixedVertices.FacetOrbits_v2');
assert.equal(FILE_FORMAT_RELEASE, 2);
assert.equal(date2s(new Date(2026, 7, 6, 17, 4, 3, 12)), '-26-08-06-17-04-03-012');
assert.equal(newDocumentName(new Date(2026, 7, 6, 17, 4, 3, 12)), 'par-26-08-06-17-04-03-012');

const saved = writePreset({
  name: 'great-stella',
  polyhedron: 'dodecahedron',
  file: 'u28',
  polySymmetry: 'Ih',
  stellSymmetry: 'I',
  facetOrbits: '{8}',
  dualFile: 'u27',
  planeDepth: 60,
  diagramFace: 0,
  view: [-0.1991, 0.289, 0.0616, 0.9343, 1],
});
const opened = readDocument(saved);
assert.equal(opened.source, 'json');
assert.equal(opened.nativeFaceting, true);
assert.equal(opened.name, 'great-stella');
assert.equal(opened.file, 'u28');
assert.equal(opened.polySymmetry, 'Ih');
assert.equal(opened.stellSymmetry, 'I');
assert.equal(opened.cells, '{8}');
assert.equal(opened.facetOrbits, '{8}');
assert.equal(opened.dualFile, 'u27');
assert.equal(opened.planeDepth, 60);
assert.deepEqual(opened.view, [-0.1991, 0.289, 0.0616, 0.9343, 1]);

const legacy = readDocument(JSON.stringify({
  name: 'old',
  appInfo: { appName: 'Stellation.PolyhedronCatalog.PlaneArrangement.CellSelection_v1', fileFormatRelease: 1 },
  params: {
    polyhedron: { name: 'icosahedron', file: 'u27' },
    symmetry: { polyhedron: 'Ih', stellation: 'I' },
    arrangement: { planeDepth: 60 },
    cells: { selection: '{0,1}' },
  },
}));
assert.equal(legacy.nativeFaceting, false);
assert.equal(legacy.cells, '{0,1}');

const stel = readDocument(`
polyhedron "icosahedron"
symmetry "Ih / I"
cells "{0,1,2,3,4,5,6}"
`);
assert.equal(stel.source, 'stel');
assert.equal(stel.polyhedron, 'icosahedron');
assert.equal(stel.cells, '{0,1,2,3,4,5,6}');

console.log('preset tests passed');
