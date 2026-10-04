/*
 * Faceting worker.
 *
 * The selectable model is a direct faceting of `baseGeometry`: every preview
 * keeps that geometry's vertex table and selects complete symmetry-orbits of
 * polygon/star-polygon circuits.  A reciprocal stellation of `geometry` (the
 * base's polar dual) is still built for the familiar plane diagram, but its
 * volumetric cells no longer define the rendered solid.
 */

import {
  buildStellation, createDiagram, diagramFaces,
} from './core.js';
import { canonicalCircuit, createFacetingEngine } from './faceting.js';

let stel = null;
let engine = null;
let meta = null;
let baseOrbitIds = [];
let basePreset = null;

function toPoly(g) {
  const vertices = [];
  for (let i = 0; i < g.v.length; i += 3)
    vertices.push({ x: g.v[i], y: g.v[i + 1], z: g.v[i + 2] });
  return { vertices, faces: g.f };
}

const orbitKey = id => `0.${id}.0`;

function orbitIdsFromSelection(selected) {
  const ids = new Set();
  for (const value of selected || []) {
    if (Number.isInteger(value) && value >= 0 && value < (engine?.orbits.length || 0)) {
      ids.add(value);
      continue;
    }
    const match = String(value).match(/^0\.(\d+)\.0$/);
    const id = match ? Number(match[1]) : NaN;
    if (Number.isInteger(id) && id >= 0 && id < (engine?.orbits.length || 0)) ids.add(id);
  }
  return [...ids].sort((a, b) => a - b);
}

const selectionKeys = ids => [...new Set(ids)].sort((a, b) => a - b).map(orbitKey);

function validationSummary(report) {
  return {
    valid: report.valid,
    closed: report.closed,
    manifold: report.manifold,
    usesAllVertices: report.usesAllVertices,
    usedVertices: report.usedVertices,
    vertexCount: report.vertexCount,
    edgeCount: report.edgeCount,
    faceCount: report.faceCount,
    eulerCharacteristic: report.eulerCharacteristic,
    edgeBuckets: Object.fromEntries(
      Object.entries(report.edgeBuckets).map(([name, edges]) => [name, edges.length])),
    degenerateFaces: report.degenerateFaces.length,
    repeatedVertexFaces: report.repeatedVertexFaces.length,
    nonCoplanarFaces: report.nonCoplanarFaces.length,
  };
}

function orbitSummary(orbit) {
  const validation = engine.preview([orbit.id]).validation;
  return {
    id: orbit.id,
    key: orbitKey(orbit.id),
    name: `${orbit.faceCount} × {${orbit.sides}${orbit.star ? `/${orbit.step}` : ''}}`,
    faceCount: orbit.faceCount,
    sides: orbit.sides,
    step: orbit.step,
    star: orbit.star,
    central: orbit.central,
    planeDistance: orbit.planeDistance,
    representative: orbit.representative.vertexIds.slice(),
    validation: validationSummary(validation),
  };
}

function presetSummary(preset) {
  return {
    id: preset.id,
    name: preset.name,
    orbitIds: preset.orbitIds.slice(),
    keys: selectionKeys(preset.orbitIds),
    faceCount: preset.faceCount,
    validation: validationSummary(preset.validation),
  };
}

/**
 * CellsPanel compatibility: one synthetic layer, one cell/sub-cell per facet
 * orbit.  There is no support graph because facet orbits are independent
 * choices, so Shift and Ctrl simply add/remove the chosen orbit.
 */
function outline() {
  return [{
    layer: 0,
    kind: 'facet-orbits',
    label: 'F',
    cells: engine.orbits.map(orbit => {
      const validation = engine.preview([orbit.id]).validation;
      return {
        index: orbit.id,
        kind: 'facet-orbit',
        label: `orbit ${orbit.id}`,
        primitives: orbit.faceCount,
        facets: orbit.faceCount,
        vertices: orbit.sides,
        volume: orbit.planeDistance,
        sides: orbit.sides,
        step: orbit.step,
        faceCount: orbit.faceCount,
        manifold: validation.manifold,
        closed: validation.closed,
        subCells: [{
          index: 0,
          primitives: orbit.faceCount,
          volume: orbit.planeDistance,
          bottom: [],
          top: [],
        }],
      };
    }),
  }];
}

/** Direct fixed-vertex mesh for a selection of synthetic orbit keys. */
function meshFor(selected) {
  const orbitIds = orbitIdsFromSelection(selected);
  const mesh = engine.preview(orbitIds);
  const faceKeys = mesh.faceOrbitIds.map(orbitKey);
  const faceSteps = mesh.faceOrbitIds.map(id => engine.orbits[id].step);
  const faceStars = mesh.faceOrbitIds.map(id => engine.orbits[id].star);
  const validation = mesh.validation;
  return {
    vertices: mesh.vertices,
    faces: mesh.faces,
    fixedVertices: true,
    selectedOrbitIds: mesh.selectedOrbitIds,
    faceOrbitIds: mesh.faceOrbitIds,
    faceCandidateIds: mesh.faceCandidateIds,
    faceSteps,
    faceStars,
    // The renderer already colours by `faceLayers`; orbit ids are the direct
    // faceting equivalent of the old reciprocal cell layer.
    faceLayers: mesh.faceOrbitIds,
    // A visible face belongs to its selected orbit.  Removing takes that orbit
    // away; adding names the same orbit, making the operation an idempotent no-op
    // rather than referring to an unrelated reciprocal cell.
    faceInside: faceKeys,
    faceOutside: faceKeys,
    validation,
    stats: {
      V: mesh.vertices.length,
      E: validation.edgeCount,
      F: mesh.faces.length,
      vertices: mesh.vertices.length,
      edges: validation.edgeCount,
      faces: mesh.faces.length,
      regions: orbitIds.length,
    },
  };
}

/**
 * Keep the reciprocal plane diagram as a construction aid.  It is deliberately
 * read-only: its old cell references do not correspond to direct facet orbits.
 */
function diagramFor(planeIndex) {
  if (!stel) return null;
  const d = createDiagram(stel, planeIndex, [], 0);
  if (!d) return null;
  return {
    planeIndex: d.planeIndex,
    extent: d.extent,
    readOnly: true,
    facets: d.facets.map(f => ({
      poly: f.poly,
      layer: f.layer,
      selected: false,
      facing: f.facing,
      ref: null,
    })),
  };
}

function findBaseSelection() {
  // Recover the base from its exact abstract face circuits. This is both
  // stronger and much cheaper than a bounded geometric combination search:
  // a merely congruent sub-solid is not the selected catalog topology.
  const nativeKeys = new Set(engine.poly.faces.map(canonicalCircuit));
  const candidateByKey = new Map(engine.candidates.map(c => [c.key, c]));
  const nativeOrbitIds = new Set();
  for (const key of nativeKeys) {
    const candidate = candidateByKey.get(key);
    if (candidate && Number.isInteger(candidate.orbitId)) nativeOrbitIds.add(candidate.orbitId);
  }
  if (nativeOrbitIds.size) {
    const previewKeys = new Set(engine.preview(nativeOrbitIds).faces.map(canonicalCircuit));
    if (previewKeys.size === nativeKeys.size &&
        [...nativeKeys].every(key => previewKeys.has(key)))
      return { ids: [...nativeOrbitIds].sort((a, b) => a - b), matched: true };
  }
  return { ids: [], matched: false };
}

function parseOrbitCells(str) {
  const ids = (String(str || '').match(/\d+/g) || []).map(Number)
    .filter(id => Number.isInteger(id) && id >= 0 && id < engine.orbits.length);
  // Orbit numbers must round-trip literally. For the supplied historical u27/I
  // target, orbit 0 is already the native icosahedral face family. Expanding
  // `{0}` into every base sub-orbit would corrupt links under lower symmetries.
  return selectionKeys(ids);
}

function formatOrbitCells(selected) {
  return `{${orbitIdsFromSelection(selected).join(',')}}`;
}

self.onmessage = (e) => {
  const { id, type, payload = {} } = e.data;
  const reply = (data, transfer) => self.postMessage({ id, ok: true, data }, transfer || []);
  const fail = (err) => self.postMessage({ id, ok: false, error: String(err && err.message || err) });

  try {
    switch (type) {

      case 'build': {
        const {
          geometry, baseGeometry, matrices, subMatrices, maxIntersection, maxLayer,
          skipReciprocal = false,
        } = payload;
        if (!geometry && !skipReciprocal) throw new TypeError('reciprocal geometry is required');
        if (!baseGeometry) throw new TypeError('baseGeometry is required for direct faceting');

        const t0 = performance.now();
        const basePoly = toPoly(baseGeometry);
        const facetMatrices = subMatrices || matrices;
        let fallbackReason = null;
        try {
          engine = createFacetingEngine(basePoly, facetMatrices);
        } catch (err) {
          if (!(err instanceof RangeError) || !/limit/i.test(err.message)) throw err;
          fallbackReason = err.message;
          engine = createFacetingEngine(basePoly, facetMatrices, { nativeOnly: true });
        }
        fallbackReason ||= engine.fallbackReason;

        let baseSelection = findBaseSelection();
        if (!baseSelection.matched && engine.mode !== 'native-only') {
          fallbackReason = 'native faces are strict subsets of exhaustive coplanar circuits';
          engine = createFacetingEngine(basePoly, facetMatrices, { nativeOnly: true });
          baseSelection = findBaseSelection();
        }
        if (!baseSelection.matched)
          throw new Error('could not recover the catalog base from explicit native face circuits');
        baseOrbitIds = baseSelection.ids;
        const namedBase = engine.presets.find(p =>
          p.orbitIds.length === baseOrbitIds.length &&
          p.orbitIds.every((orbitId, i) => orbitId === baseOrbitIds[i]));
        basePreset = namedBase ? presetSummary(namedBase) : {
          id: 'base',
          name: 'Base polyhedron',
          orbitIds: baseOrbitIds.slice(),
          keys: selectionKeys(baseOrbitIds),
          faceCount: engine.preview(baseOrbitIds).faces.length,
          validation: validationSummary(engine.preview(baseOrbitIds).validation),
        };

        // Fissary duals have coincident vertices; do not invent a reciprocal solid.
        stel = skipReciprocal ? null : buildStellation(toPoly(geometry), matrices, {
          subMatrices, maxIntersection, maxLayer,
          onProgress: (done, total) =>
            self.postMessage({ id, progress: { done, total } }),
        });
        meta = { ms: performance.now() - t0 };

        const orbits = engine.orbits.map(orbitSummary);
        const presets = engine.presets.map(presetSummary);
        reply({
          // Reciprocal diagram metadata retained for the existing controls.
          planes: stel?.planes.length ?? 0,
          planesTotal: stel?.planes.total ?? stel?.planes.length ?? 0,
          planesCentral: stel?.planes.central ?? 0,
          planesDegenerate: stel?.planes.degenerate ?? 0,
          planesDuplicate: stel?.planes.duplicate ?? 0,
          faces: stel ? diagramFaces(stel, subMatrices || matrices) : [],
          maxRadius: stel?.maxRadius ?? 0,
          diagramLayers: stel?.cellLayers.length ?? 0,
          diagramFacets: stel?.arrangement.reduce((sum, a) => sum + a.length, 0) ?? 0,

          // Direct faceting metadata.
          layers: 1,
          vertices: engine.vertices.length,
          facets: engine.candidates.length,
          facetCandidates: engine.candidates.length,
          outline: outline(),
          orbits,
          presets,
          basePreset,
          baseOrbitIds: baseOrbitIds.slice(),
          baseKeys: selectionKeys(baseOrbitIds),
          allKeys: selectionKeys(engine.orbits.map(o => o.id)),
          diagnostics: {
            diagramAvailable: Boolean(stel),
            fixedVertexCount: engine.vertices.length,
            planeCount: engine.planes.length,
            candidateCount: engine.candidates.length,
            orbitCount: engine.orbits.length,
            baseMatched: baseSelection.matched,
            enumerationMode: engine.mode,
            partialCandidates: engine.mode === 'native-only',
            fallbackReason,
            symmetryPermutations: engine.symmetry.permutations.length,
            symmetryRejected: engine.symmetry.rejected,
            tolerance: engine.tolerance,
          },
          ms: Math.round(meta.ms),
        });
        break;
      }

      case 'mesh':
        reply(meshFor(payload.selected));
        break;

      case 'diagram':
        reply(diagramFor(payload.planeIndex));
        break;

      case 'both':
        reply({
          mesh: meshFor(payload.selected),
          diagram: diagramFor(payload.planeIndex),
        });
        break;

      case 'parseCells':
        reply({ selected: parseOrbitCells(payload.cells) });
        break;

      case 'formatCells':
        reply({ cells: formatOrbitCells(payload.selected) });
        break;

      /** The first synthetic layer is the native/base facet orbit. */
      case 'layerKeys':
        reply({ keys: payload.n > 0 ? selectionKeys(baseOrbitIds) : [] });
        break;

      case 'applyPreset': {
        let orbitIds;
        if (payload.preset === 'base') orbitIds = baseOrbitIds;
        else if (payload.preset === 'all') orbitIds = engine.orbits.map(o => o.id);
        else {
          const preset = engine.presets.find(p => p.id === payload.preset);
          if (!preset) throw new RangeError(`unknown faceting preset: ${payload.preset}`);
          orbitIds = preset.orbitIds;
        }
        const selected = selectionKeys(orbitIds);
        reply({ selected, cells: formatOrbitCells(selected), orbitIds: orbitIds.slice() });
        break;
      }

      default:
        fail('unknown message: ' + type);
    }
  } catch (err) {
    fail(err);
  }
};
