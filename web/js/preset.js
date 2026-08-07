/*
 * Saving and loading faceting documents in the SymmHub preset envelope.
 *
 * SymmHub apps all write the same envelope — a document name, an `appInfo`
 * block naming the app and the file-format release, and a `params` object of
 * nested groups — so a faceting saved here sits alongside the attractor and
 * pattern presets without looking foreign:
 *
 *   {
 *     "name": "par-26-08-05-20-13-45-123",
 *     "appInfo": { "appName": "Faceting…_v2", "fileFormatRelease": 2 },
 *     "params": { "polyhedron": {…}, "symmetry": {…}, … }
 *   }
 *
 * The old `.stel` files still load: `parseStel` in core.js reads them, and
 * `readDocument` below takes either and hands back the same shape.
 */

import { parseStel } from './core.js';

export const APP_NAME = 'Faceting.PolyhedronCatalog.FixedVertices.FacetOrbits_v2';
export const FILE_FORMAT_RELEASE = 2;
const PARAM_PREFIX = 'par';

/** `-YY-MM-DD-HH-MM-SS-mmm`, the SymmHub date2s() format */
export function date2s(date = new Date(), sep = '-') {
  const p = (n, w) => String(n).padStart(w, '0');
  return sep + p(date.getFullYear() - 2000, 2) +
         sep + p(date.getMonth() + 1, 2) +
         sep + p(date.getDate(), 2) +
         sep + p(date.getHours(), 2) +
         sep + p(date.getMinutes(), 2) +
         sep + p(date.getSeconds(), 2) +
         sep + p(date.getMilliseconds(), 3);
}

export function newDocumentName(date = new Date()) {
  return PARAM_PREFIX + date2s(date);
}

/**
 * Everything needed to rebuild what is on screen. Only inputs go in `params` —
 * vertex, edge and face counts are derived, so they would only ever go stale.
 */
export function writePreset({
  name, polyhedron, file, polySymmetry, stellSymmetry,
  planeDepth, cells, facetOrbits, dualFile, diagramFace,
  showEdges = true, showAllFacets = true, spin = false,
  view = null,
  exportLengthUnit = 0.01,
}) {
  return JSON.stringify({
    name: name || newDocumentName(),
    appInfo: { appName: APP_NAME, fileFormatRelease: FILE_FORMAT_RELEASE },
    params: {
      polyhedron: { name: polyhedron, file },
      symmetry: { base: polySymmetry, faceting: stellSymmetry },
      faceting: {
        orbitSelection: facetOrbits ?? cells,
        representation: 'explicit-vertex-circuits',
        validationRelease: 1,
      },
      reciprocalDiagram: { dualFile, planeDepth, diagramFace },
      /*
       * `camera` is the orientation quaternion followed by the zoom distance —
       * «ориентация и все остальное это могло бы быть частью JSON файла: то есть
       * ориентация, zoom и еще что там». Saved so that reopening a document, or
       * sending someone a link, shows the solid from the angle it was chosen at
       * rather than from the default one.
       */
      display: { showEdges, showAllFacets, spin },
      camera: view ? { view } : undefined,
      export: { lengthUnit: exportLengthUnit },
    },
  }, null, 4) + '\n';
}

/**
 * Read a saved document. Accepts native JSON and the original program's `.stel`,
 * and is forgiving about which of the two you hand it — the caller should not
 * have to sniff the file itself.
 */
export function readDocument(text) {
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{') && looksLikeJSON(trimmed)) {
    return readPreset(JSON.parse(text));
  }
  const spec = parseStel(text);
  return {
    source: 'stel',
    name: null,
    polyhedron: spec.polyhedron,
    file: null,
    polySymmetry: spec.polySymmetry,
    stellSymmetry: spec.stellSymmetry,
    cells: spec.cells,
    planeDepth: null,
    diagramFace: 0,
    exportLengthUnit: spec.exportLengthUnit ? Number(spec.exportLengthUnit) : 0.01,
  };
}

/*
 * A `.stel` file also starts with `{` once its comments are stripped — the cell
 * string itself is braced. So test for a real JSON object, not just the brace.
 */
function looksLikeJSON(s) {
  try {
    const o = JSON.parse(s);
    return o && typeof o === 'object' && !Array.isArray(o);
  } catch {
    return false;
  }
}

export function readPreset(doc) {
  const p = doc.params || {};
  const release = doc.appInfo?.fileFormatRelease ?? 0;
  if (release > FILE_FORMAT_RELEASE) {
    throw new Error(`this file is format release ${release}; this build reads up to ${FILE_FORMAT_RELEASE}`);
  }
  return {
    source: 'json',
    nativeFaceting: Boolean(p.faceting),
    name: doc.name || null,
    polyhedron: p.polyhedron?.name ?? null,
    file: p.polyhedron?.file ?? null,
    // The fallbacks read release-1 stellation-port JSON. Its cell expression is
    // a reciprocal source and may only be interpreted as a native orbit string
    // when the caller explicitly chooses that compatibility route.
    polySymmetry: p.symmetry?.base ?? p.symmetry?.polyhedron ?? null,
    stellSymmetry: p.symmetry?.faceting ?? p.symmetry?.stellation ?? null,
    cells: p.faceting?.orbitSelection ?? p.cells?.selection ?? null,
    facetOrbits: p.faceting?.orbitSelection ?? null,
    dualFile: p.reciprocalDiagram?.dualFile ?? null,
    planeDepth: p.reciprocalDiagram?.planeDepth ?? p.arrangement?.planeDepth ?? null,
    diagramFace: p.reciprocalDiagram?.diagramFace ?? p.display?.diagramFace ?? 0,
    showEdges: p.display?.showEdges ?? true,
    showAllFacets: p.display?.showAllFacets ?? true,
    spin: p.display?.spin ?? false,
    view: Array.isArray(p.camera?.view) ? p.camera.view : null,
    exportLengthUnit: p.export?.lengthUnit ?? 0.01,
  };
}
