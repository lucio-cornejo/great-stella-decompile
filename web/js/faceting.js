/*
 * Direct faceting of a fixed vertex set.
 *
 * This is deliberately independent of the reciprocal-stellation path in
 * core.js.  It starts with the actual vertices of the base polyhedron, finds
 * planes containing three or more of them, makes polygon and star-polygon
 * circuits in those planes, and repeats each circuit with the supplied point
 * group.  Selecting one or more resulting face orbits produces a preview mesh
 * whose vertex table is *always* the base vertex table.
 *
 * The implementation is intended for the small, highly symmetric vertex sets
 * used by Stella (in particular the Platonic solids).  Enumerating planes is
 * O(V^4) in the worst case: there are O(V^3) triples and every new plane is
 * checked against V points.  Large explicit catalog meshes therefore fall
 * back to lossless native-face mode; `mode:'exhaustive'` disables that fallback.
 */

import {
  add, cross, dot, len, matMul, mul, normalize, sub, v3,
} from './core.js';

export const FACETING_TOLERANCE = 1e-7;

// Lets the engine pass its already-checked base object through preview builds
// without copying the fixed vertex table (and therefore without changing its
// object identity between selections).
const normalizedPolyhedra = new WeakSet();

const gcd = (a, b) => {
  a = Math.abs(a); b = Math.abs(b);
  while (b) { const t = a % b; a = b; b = t; }
  return a;
};

const edgeKey = (a, b) => a < b ? `${a}.${b}` : `${b}.${a}`;

function lexCompare(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

/** A cycle key invariant under cyclic shifts and reversal. */
export function canonicalCircuit(circuit) {
  if (!Array.isArray(circuit) || !circuit.length) return '';
  let best = null;
  const variants = [circuit, circuit.slice().reverse()];
  for (const seq of variants) {
    for (let shift = 0; shift < seq.length; shift++) {
      const rotated = seq.slice(shift).concat(seq.slice(0, shift));
      if (best === null || lexCompare(rotated, best) < 0) best = rotated;
    }
  }
  return best.join('.');
}

function polygonNormal(points) {
  let n = v3();
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    n = add(n, v3(
      (a.y - b.y) * (a.z + b.z),
      (a.z - b.z) * (a.x + b.x),
      (a.x - b.x) * (a.y + b.y),
    ));
  }
  return n;
}

function centroid(points) {
  let c = v3();
  for (const p of points) c = add(c, p);
  return points.length ? mul(c, 1 / points.length) : c;
}

function planeFromIndices(vertices, ids, tolerance) {
  let best = null, bestLength = 0;
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      for (let k = j + 1; k < ids.length; k++) {
        const n = cross(sub(vertices[ids[j]], vertices[ids[i]]),
                        sub(vertices[ids[k]], vertices[ids[i]]));
        const l = len(n);
        if (l > bestLength) { bestLength = l; best = n; }
      }
    }
  }
  if (!best || bestLength <= tolerance * tolerance) return null;
  let n = mul(best, 1 / bestLength);
  let d = dot(n, vertices[ids[0]]);

  // Give non-central planes an outward-looking normal.  Central planes use a
  // deterministic lexicographic sign; they have no intrinsic outside.
  const first = Math.abs(n.x) > tolerance ? n.x :
    Math.abs(n.y) > tolerance ? n.y : n.z;
  if (d < -tolerance || (Math.abs(d) <= tolerance && first < 0)) {
    n = mul(n, -1); d = -d;
  }
  return { n, d, distance: Math.abs(d) };
}

function scaleOf(vertices) {
  if (!vertices.length) return 1;
  const c = centroid(vertices);
  let scale = 0;
  for (const p of vertices) scale = Math.max(scale, len(sub(p, c)));
  return scale || 1;
}

/**
 * Accept both the application's `{vertices, faces}` shape and raw catalog
 * records (`{v: [x,y,z,...], f: [...]}`).
 */
export function normalizeFacetingPolyhedron(poly) {
  if (!poly || typeof poly !== 'object') throw new TypeError('polyhedron is required');
  if (normalizedPolyhedra.has(poly)) return poly;
  let sourceVertices = poly.vertices;
  if (!sourceVertices && Array.isArray(poly.v)) {
    if (poly.v.length % 3) throw new TypeError('flat vertex array length must be a multiple of 3');
    sourceVertices = [];
    for (let i = 0; i < poly.v.length; i += 3)
      sourceVertices.push(v3(poly.v[i], poly.v[i + 1], poly.v[i + 2]));
  }
  if (!Array.isArray(sourceVertices)) throw new TypeError('polyhedron has no vertex array');
  const vertices = sourceVertices.map((p, i) => {
    const q = Array.isArray(p) ? v3(p[0], p[1], p[2]) : v3(p.x, p.y, p.z);
    if (![q.x, q.y, q.z].every(Number.isFinite))
      throw new TypeError(`vertex ${i} is not finite`);
    return q;
  });
  const sourceFaces = poly.faces || poly.f || [];
  if (!Array.isArray(sourceFaces)) throw new TypeError('polyhedron faces must be an array');
  const faces = sourceFaces.map((face, fi) => {
    if (!Array.isArray(face)) throw new TypeError(`face ${fi} is not an array`);
    const copy = face.map(Number);
    for (const id of copy)
      if (!Number.isInteger(id) || id < 0 || id >= vertices.length)
        throw new RangeError(`face ${fi} contains invalid vertex ${id}`);
    return copy;
  });
  const normalized = { vertices, faces };
  normalizedPolyhedra.add(normalized);
  return normalized;
}

function angularOrder(vertices, ids, plane, tolerance) {
  const points = ids.map(i => vertices[i]);
  const c = centroid(points);
  let u = null, radius = 0;
  for (const p of points) {
    const q = sub(p, c), r = len(q);
    if (r > radius) { radius = r; u = q; }
  }
  if (!u || radius <= tolerance) return null;
  u = normalize(u);
  let w = normalize(cross(plane.n, u));
  if (len(w) <= tolerance) return null;
  u = normalize(cross(w, plane.n));

  const polar = ids.map(id => {
    const q = sub(vertices[id], c);
    return { id, angle: Math.atan2(dot(q, w), dot(q, u)), radius: len(q) };
  }).sort((a, b) => a.angle - b.angle || a.radius - b.radius || a.id - b.id);

  // Two vertices on exactly the same ray make angular step polygons ambiguous.
  for (let i = 0; i < polar.length; i++) {
    const a = polar[i], b = polar[(i + 1) % polar.length];
    let delta = b.angle - a.angle;
    if (i === polar.length - 1) delta += Math.PI * 2;
    if (Math.abs(delta) <= FACETING_TOLERANCE * 10) return null;
  }
  return polar.map(x => x.id);
}

function coefficientOfVariation(values) {
  if (!values.length) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean <= 1e-15) return 0;
  const variance = values.reduce((s, x) => s + (x - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}

/**
 * Enumerate maximal coplanar vertex sets, then their single-component angular
 * step circuits.  Step 1 is the ordinary polygon; coprime steps > 1 are star
 * polygons.  Non-coprime steps are polygon compounds, not individual facets,
 * and are intentionally omitted.
 */
export function enumerateFacetCandidates(polyInput, options = {}) {
  const poly = normalizeFacetingPolyhedron(polyInput);
  const vertices = poly.vertices;
  const scale = scaleOf(vertices);
  const tolerance = options.tolerance ?? FACETING_TOLERANCE * scale;
  const minSides = Math.max(3, options.minSides ?? 3);
  const maxSides = options.maxSides ?? Infinity;
  const includeStars = options.includeStars !== false;
  const includeCentral = options.includeCentral !== false;
  const maxPlanes = options.maxPlanes ?? 50000;
  const maxCandidates = options.maxCandidates ?? 100000;
  const planeSets = new Map();

  for (let i = 0; i < vertices.length; i++) {
    for (let j = i + 1; j < vertices.length; j++) {
      for (let k = j + 1; k < vertices.length; k++) {
        const raw = cross(sub(vertices[j], vertices[i]), sub(vertices[k], vertices[i]));
        const rawLength = len(raw);
        if (rawLength <= tolerance * tolerance) continue;
        const n = mul(raw, 1 / rawLength);
        const d = dot(n, vertices[i]);
        const ids = [];
        for (let q = 0; q < vertices.length; q++)
          if (Math.abs(dot(n, vertices[q]) - d) <= tolerance) ids.push(q);
        if (ids.length < minSides || ids.length > maxSides) continue;
        const key = ids.join('.');
        if (!planeSets.has(key)) {
          if (planeSets.size >= maxPlanes)
            throw new RangeError(`faceting plane limit (${maxPlanes}) exceeded`);
          planeSets.set(key, ids);
        }
      }
    }
  }

  const planes = [];
  const candidates = [];
  for (const ids of planeSets.values()) {
    const plane = planeFromIndices(vertices, ids, tolerance);
    if (!plane || (!includeCentral && plane.distance <= tolerance)) continue;
    const around = angularOrder(vertices, ids, plane, tolerance);
    if (!around) continue;
    const planeRecord = {
      id: planes.length,
      vertexIds: ids.slice(),
      n: plane.n,
      d: plane.d,
      distance: plane.distance,
    };
    planes.push(planeRecord);

    const points = ids.map(i => vertices[i]);
    const c = centroid(points);
    const radii = points.map(p => len(sub(p, c)));
    for (let step = 1; step <= Math.floor(ids.length / 2); step++) {
      if (step > 1 && !includeStars) continue;
      if (gcd(ids.length, step) !== 1) continue;
      const circuit = [];
      for (let q = 0, at = 0; q < ids.length; q++, at = (at + step) % ids.length)
        circuit.push(around[at]);

      // Orient non-central faces consistently away from the origin.  The key
      // remains orientation-free, as reflections reverse face winding.
      const pn = polygonNormal(circuit.map(i => vertices[i]));
      if (dot(pn, plane.n) < 0) circuit.reverse();
      const edgeLengths = circuit.map((id, q) =>
        len(sub(vertices[circuit[(q + 1) % circuit.length]], vertices[id])));
      const candidate = {
        id: candidates.length,
        key: canonicalCircuit(circuit),
        planeId: planeRecord.id,
        plane: planeRecord,
        vertexIds: circuit,
        vertexSet: ids.slice(),
        sides: ids.length,
        step,
        star: step > 1,
        central: plane.distance <= tolerance,
        edgeLengths,
        regularity: {
          radialCV: coefficientOfVariation(radii),
          edgeCV: coefficientOfVariation(edgeLengths),
        },
      };
      if (!options.candidateFilter || options.candidateFilter(candidate, poly)) {
        if (candidates.length >= maxCandidates)
          throw new RangeError(`faceting candidate limit (${maxCandidates}) exceeded`);
        candidates.push(candidate);
      }
    }
  }

  return { poly, vertices, planes, candidates, tolerance, scale, mode: 'exhaustive' };
}

function projectedFacePoints(vertices, circuit, plane, tolerance) {
  const origin = vertices[circuit[0]];
  let u = null;
  for (let i = 1; i < circuit.length; i++) {
    const q = sub(vertices[circuit[i]], origin);
    if (len(q) > tolerance) { u = normalize(q); break; }
  }
  if (!u) return null;
  const w = normalize(cross(plane.n, u));
  if (len(w) <= tolerance) return null;
  return circuit.map(id => {
    const q = sub(vertices[id], origin);
    return { x: dot(q, u), y: dot(q, w) };
  });
}

function circuitSelfIntersects(vertices, circuit, plane, tolerance) {
  const points = projectedFacePoints(vertices, circuit, plane, tolerance);
  if (!points) return false;
  const orient = (a, b, c) =>
    (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const areaTolerance = tolerance * tolerance;
  const opposite = (a, b) => a * b < 0 &&
    Math.abs(a) > areaTolerance && Math.abs(b) > areaTolerance;
  for (let i = 0; i < points.length; i++) {
    const i2 = (i + 1) % points.length;
    for (let j = i + 1; j < points.length; j++) {
      const j2 = (j + 1) % points.length;
      if (i === j || i2 === j || j2 === i) continue; // adjacent edges
      const a = orient(points[i], points[i2], points[j]);
      const b = orient(points[i], points[i2], points[j2]);
      const c = orient(points[j], points[j2], points[i]);
      const d = orient(points[j], points[j2], points[i2]);
      if (opposite(a, b) && opposite(c, d)) return true;
    }
  }
  return false;
}

function inferCircuitStep(vertices, circuit, plane, tolerance) {
  const unique = [...new Set(circuit)];
  if (unique.length !== circuit.length) return { step: 1, star: false };
  const around = angularOrder(vertices, unique, plane, tolerance);
  let step = 1;
  if (around) {
    const rank = new Map(around.map((id, i) => [id, i]));
    const deltas = circuit.map((id, i) => {
      const next = circuit[(i + 1) % circuit.length];
      return (rank.get(next) - rank.get(id) + circuit.length) % circuit.length;
    });
    if (deltas[0] > 0 && deltas.every(d => d === deltas[0]))
      step = Math.min(deltas[0], circuit.length - deltas[0]);
  }
  const crossed = circuitSelfIntersects(vertices, circuit, plane, tolerance);
  return { step: step || 1, star: step > 1 || crossed };
}

/**
 * Cheap, lossless fallback for large catalog models.  The input face circuits
 * are authoritative: no plane-triple enumeration is attempted, winding and
 * star traversal order are retained, and only symmetry grouping is added.
 */
export function enumerateNativeFacetCandidates(polyInput, options = {}) {
  const poly = normalizeFacetingPolyhedron(polyInput);
  const vertices = poly.vertices;
  const scale = scaleOf(vertices);
  const tolerance = options.tolerance ?? FACETING_TOLERANCE * scale;
  const maxCandidates = options.maxCandidates ?? 100000;
  const planes = [];
  const candidates = [];
  const keys = new Set();

  for (let fi = 0; fi < poly.faces.length; fi++) {
    const circuit = poly.faces[fi].slice();
    const unique = [...new Set(circuit)];
    if (unique.length < 3)
      throw new RangeError(`native face ${fi} has fewer than three distinct vertices`);
    const plane = planeFromIndices(vertices, unique, tolerance);
    if (!plane || unique.some(id => Math.abs(dot(plane.n, vertices[id]) - plane.d) > tolerance))
      throw new RangeError(`native face ${fi} is degenerate or non-coplanar`);
    const key = canonicalCircuit(circuit);
    if (keys.has(key)) throw new RangeError(`native face ${fi} duplicates an earlier circuit`);
    keys.add(key);

    const planeRecord = {
      id: planes.length,
      vertexIds: unique.slice().sort((a, b) => a - b),
      n: plane.n,
      d: plane.d,
      distance: plane.distance,
      nativeFaceIndex: fi,
    };
    planes.push(planeRecord);
    const inferred = inferCircuitStep(vertices, circuit, plane, tolerance);
    const points = unique.map(i => vertices[i]);
    const c = centroid(points);
    const radii = points.map(p => len(sub(p, c)));
    const edgeLengths = circuit.map((id, i) =>
      len(sub(vertices[circuit[(i + 1) % circuit.length]], vertices[id])));
    const candidate = {
      id: candidates.length,
      key,
      planeId: planeRecord.id,
      plane: planeRecord,
      vertexIds: circuit,
      vertexSet: planeRecord.vertexIds.slice(),
      sides: circuit.length,
      step: inferred.step,
      star: inferred.star,
      central: plane.distance <= tolerance,
      edgeLengths,
      regularity: {
        radialCV: coefficientOfVariation(radii),
        edgeCV: coefficientOfVariation(edgeLengths),
      },
      native: true,
      nativeFaceIndex: fi,
    };
    if (candidates.length >= maxCandidates)
      throw new RangeError(`faceting candidate limit (${maxCandidates}) exceeded`);
    candidates.push(candidate);
  }
  return { poly, vertices, planes, candidates, tolerance, scale, mode: 'native-only' };
}

function identityPermutation(n) {
  return Array.from({ length: n }, (_, i) => i);
}

/** Map symmetry matrices to exact permutations of the fixed vertex table. */
export function symmetryVertexPermutations(verticesInput, matrices = [], options = {}) {
  const vertices = verticesInput.map(p => Array.isArray(p) ? v3(p[0], p[1], p[2]) : p);
  const scale = scaleOf(vertices);
  const tolerance = options.tolerance ?? FACETING_TOLERANCE * 10 * scale;
  const tolerance2 = tolerance * tolerance;
  const permutations = [];
  const rejected = [];
  const seen = new Set();

  const source = matrices && matrices.length ? matrices : [null];
  for (let mi = 0; mi < source.length; mi++) {
    const matrix = source[mi];
    if (matrix && (!Array.isArray(matrix) || matrix.length < 9)) {
      rejected.push({ index: mi, reason: 'matrix is not a flat 3x3 matrix' });
      continue;
    }
    const permutation = [];
    const used = new Set();
    let reason = null;
    for (let i = 0; i < vertices.length; i++) {
      const q = matrix ? matMul(matrix, vertices[i]) : vertices[i];
      let best = -1, bestDistance = Infinity;
      for (let j = 0; j < vertices.length; j++) {
        // Coincident catalog vertices are topologically distinct, so a valid
        // point-group action must consume separate target slots even though
        // their geometric distances tie at zero.
        if (used.has(j)) continue;
        const d = dot(sub(q, vertices[j]), sub(q, vertices[j]));
        if (d < bestDistance) { bestDistance = d; best = j; }
      }
      if (best < 0 || bestDistance > tolerance2) {
        reason = `vertex ${i} has no image within tolerance`;
        break;
      }
      used.add(best); permutation.push(best);
    }
    if (reason) { rejected.push({ index: mi, reason }); continue; }
    const key = permutation.join('.');
    if (!seen.has(key)) { seen.add(key); permutations.push(permutation); }
  }

  // Orbit construction must remain useful when a caller accidentally supplies
  // no usable matrices.  The diagnostics still expose every rejected matrix.
  const identity = identityPermutation(vertices.length);
  const identityKey = identity.join('.');
  if (!seen.has(identityKey)) permutations.unshift(identity);
  return { permutations, rejected, tolerance };
}

/** Group candidate circuits into orbits of the supplied point group. */
export function groupFacetCandidates(candidateData, matrices = [], options = {}) {
  const candidates = candidateData.candidates || candidateData;
  const vertices = candidateData.vertices || options.vertices;
  if (!Array.isArray(candidates) || !Array.isArray(vertices))
    throw new TypeError('candidate data and vertices are required');
  const symmetry = symmetryVertexPermutations(vertices, matrices, options);
  const byKey = new Map(candidates.map(c => [c.key, c]));
  const unseen = new Set(candidates.map(c => c.id));
  const orbits = [];

  while (unseen.size) {
    const seedId = unseen.values().next().value;
    const seed = candidates[seedId];
    const members = new Map([[seed.key, seed]]);
    const queue = [seed];
    unseen.delete(seed.id);
    while (queue.length) {
      const current = queue.pop();
      for (const permutation of symmetry.permutations) {
        const key = canonicalCircuit(current.vertexIds.map(id => permutation[id]));
        const image = byKey.get(key);
        if (!image || members.has(image.key)) continue;
        members.set(image.key, image);
        unseen.delete(image.id);
        queue.push(image);
      }
    }
    const faces = [...members.values()].sort((a, b) => a.id - b.id);
    const distances = faces.map(f => f.plane.distance);
    const orbit = {
      id: orbits.length,
      key: `orbit-${orbits.length}`,
      representative: faces[0],
      candidates: faces,
      candidateIds: faces.map(f => f.id),
      faceCount: faces.length,
      sides: faces[0].sides,
      step: faces[0].step,
      star: faces[0].star,
      central: faces.every(f => f.central),
      planeDistance: distances.reduce((a, b) => a + b, 0) / distances.length,
    };
    for (const face of faces) face.orbitId = orbit.id;
    orbits.push(orbit);
  }
  return { orbits, symmetry };
}

function selectedOrbitIds(orbits, selection) {
  if (selection == null) return new Set();
  if (typeof selection === 'number' || typeof selection === 'string') selection = [selection];
  if (selection && !Array.isArray(selection) && !(selection instanceof Set)) {
    if (Array.isArray(selection.orbitIds)) selection = selection.orbitIds;
    else if (selection.id !== undefined) selection = [selection.id];
  }
  const values = selection instanceof Set ? [...selection] : selection;
  if (!Array.isArray(values)) throw new TypeError('selection must contain orbit ids');
  const ids = new Set();
  for (const item of values) {
    const raw = item && typeof item === 'object' ? item.id : item;
    let id = typeof raw === 'string' && /^orbit-\d+$/.test(raw) ? Number(raw.slice(6)) : Number(raw);
    if (Number.isInteger(id) && id >= 0 && id < orbits.length) ids.add(id);
  }
  return ids;
}

function facePlane(vertices, face, tolerance) {
  return planeFromIndices(vertices, face, tolerance);
}

/**
 * Edge-incidence diagnostics use the same categories as Great Stella's
 * faceting preview.  `valid` means every edge has even incidence; `manifold`
 * is the usual stricter requirement of exactly two faces per edge.
 */
export function validateFaceting(meshInput, options = {}) {
  const mesh = normalizeFacetingPolyhedron(meshInput);
  const vertices = mesh.vertices, faces = mesh.faces;
  const scale = scaleOf(vertices);
  const tolerance = options.tolerance ?? FACETING_TOLERANCE * 10 * scale;
  const edgeMap = new Map();
  const degenerateFaces = [];
  const repeatedVertexFaces = [];
  const nonCoplanarFaces = [];
  const vertexFaceUse = new Uint32Array(vertices.length);

  for (let fi = 0; fi < faces.length; fi++) {
    const face = faces[fi];
    if (face.length < 3 || new Set(face).size < 3) degenerateFaces.push(fi);
    if (new Set(face).size !== face.length) repeatedVertexFaces.push(fi);
    const plane = facePlane(vertices, face, tolerance);
    if (!plane) degenerateFaces.push(fi);
    else if (face.some(id => Math.abs(dot(plane.n, vertices[id]) - plane.d) > tolerance))
      nonCoplanarFaces.push(fi);
    for (const id of new Set(face)) vertexFaceUse[id]++;
    for (let i = 0; i < face.length; i++) {
      const a = face[i], b = face[(i + 1) % face.length];
      const key = edgeKey(a, b);
      let edge = edgeMap.get(key);
      if (!edge) edgeMap.set(key, edge = { key, a: Math.min(a, b), b: Math.max(a, b), faces: [] });
      edge.faces.push(fi);
    }
  }

  const buckets = { open: [], manifold: [], odd: [], even: [], coplanar: [] };
  for (const edge of edgeMap.values()) {
    edge.count = edge.faces.length;
    edge.coplanar = false;
    if (edge.count === 2) {
      const p = facePlane(vertices, faces[edge.faces[0]], tolerance);
      const q = facePlane(vertices, faces[edge.faces[1]], tolerance);
      edge.coplanar = Boolean(p && q &&
        (Math.abs(dot(p.n, q.n)) >= 1 - tolerance) &&
        Math.abs(Math.abs(p.d) - Math.abs(q.d)) <= tolerance);
    }
    if (edge.count === 1) edge.status = 'open';
    else if (edge.count === 2 && edge.coplanar) edge.status = 'coplanar';
    else if (edge.count === 2) edge.status = 'manifold';
    else if (edge.count % 2) edge.status = 'odd';
    else edge.status = 'even';
    buckets[edge.status].push(edge);
  }

  const usesAllVertices = vertexFaceUse.every(x => x > 0);
  const structurallyValid = !degenerateFaces.length && !repeatedVertexFaces.length &&
    !nonCoplanarFaces.length;
  const closed = structurallyValid && faces.length > 0 && edgeMap.size > 0 &&
    !buckets.open.length && !buckets.odd.length;
  const manifold = structurallyValid && edgeMap.size > 0 &&
    [...edgeMap.values()].every(e => e.count === 2);
  const usedVertices = vertexFaceUse.reduce((n, x) => n + (x > 0 ? 1 : 0), 0);
  return {
    valid: closed,
    closed,
    manifold,
    usesAllVertices,
    usedVertices,
    vertexCount: vertices.length,
    faceCount: faces.length,
    edgeCount: edgeMap.size,
    eulerCharacteristic: usedVertices - edgeMap.size + faces.length,
    edges: [...edgeMap.values()],
    edgeBuckets: buckets,
    vertexFaceUse: [...vertexFaceUse],
    degenerateFaces: [...new Set(degenerateFaces)],
    repeatedVertexFaces,
    nonCoplanarFaces,
  };
}

/** Build the fixed-vertex preview for a set of selected orbit ids. */
export function buildFacetingPreview(polyInput, orbitData, selection, options = {}) {
  const poly = normalizeFacetingPolyhedron(polyInput);
  const orbits = orbitData.orbits || orbitData;
  if (!Array.isArray(orbits)) throw new TypeError('facet orbits are required');
  const ids = selectedOrbitIds(orbits, selection);
  const picked = [];
  const seen = new Set();
  for (const id of [...ids].sort((a, b) => a - b)) {
    for (const candidate of orbits[id].candidates) {
      if (seen.has(candidate.key)) continue;
      seen.add(candidate.key);
      picked.push({ candidate, orbitId: id });
    }
  }
  // A native-only base selection may span several face-type orbits.  Restore
  // the catalog's original global face order while leaving exhaustive previews
  // byte-for-byte ordered as before.
  if (picked.length && picked.every(x => Number.isInteger(x.candidate.nativeFaceIndex)))
    picked.sort((a, b) => a.candidate.nativeFaceIndex - b.candidate.nativeFaceIndex);

  const faces = [];
  const faceOrbitIds = [];
  const faceCandidateIds = [];
  const faceSteps = [];
  const faceStars = [];
  for (const { candidate, orbitId } of picked) {
    faces.push(candidate.vertexIds.slice());
    faceOrbitIds.push(orbitId);
    faceCandidateIds.push(candidate.id);
    faceSteps.push(Number.isInteger(candidate.step) && candidate.step > 0 ? candidate.step : 1);
    faceStars.push(Boolean(candidate.star));
  }
  // Do not compact this table: retaining unused entries is part of the direct
  // faceting contract and lets selection changes preserve vertex identity.
  const mesh = {
    vertices: poly.vertices,
    faces,
    faceOrbitIds,
    faceCandidateIds,
    faceSteps,
    faceStars,
    selectedOrbitIds: [...ids].sort((a, b) => a - b),
  };
  mesh.validation = validateFaceting(mesh, options);
  return mesh;
}

function centeredScaled(vertices) {
  const c = centroid(vertices);
  const shifted = vertices.map(p => sub(p, c));
  const rms = Math.sqrt(shifted.reduce((s, p) => s + dot(p, p), 0) / Math.max(1, shifted.length)) || 1;
  return { points: shifted.map(p => mul(p, 1 / rms)), center: c, scale: rms };
}

const quantize = (x, tolerance) => Math.round(x / tolerance);

function canonicalNumericCycle(values) {
  if (!values.length) return '';
  let best = null;
  for (const seq of [values, values.slice().reverse()]) {
    for (let s = 0; s < seq.length; s++) {
      const q = seq.slice(s).concat(seq.slice(0, s));
      if (best === null || lexCompare(q, best) < 0) best = q;
    }
  }
  return best.join('.');
}

/**
 * A rigid-motion, reflection, uniform-scale, and vertex-label invariant mesh
 * signature.  It is deliberately stronger than just V/E/F: face edge cycles,
 * face-plane radii, vertex degrees, and edge incidences are all included.
 */
export function facetingMeshSignature(meshInput, options = {}) {
  const mesh = normalizeFacetingPolyhedron(meshInput);
  const tolerance = options.tolerance ?? 1e-6;
  const normalized = centeredScaled(mesh.vertices).points;
  const pairDistances = [];
  for (let i = 0; i < normalized.length; i++)
    for (let j = i + 1; j < normalized.length; j++)
      pairDistances.push(quantize(len(sub(normalized[i], normalized[j])), tolerance));
  pairDistances.sort((a, b) => a - b);

  const faceShapes = [];
  const planeDistances = [];
  for (const face of mesh.faces) {
    const lengths = face.map((id, i) => quantize(
      len(sub(normalized[id], normalized[face[(i + 1) % face.length]])), tolerance));
    faceShapes.push(`${face.length}:${canonicalNumericCycle(lengths)}`);
    const plane = planeFromIndices(normalized, face, tolerance);
    planeDistances.push(plane ? quantize(plane.distance, tolerance) : 'x');
  }
  faceShapes.sort();
  planeDistances.sort((a, b) => String(a).localeCompare(String(b), 'en', { numeric: true }));

  const validation = validateFaceting(mesh, { tolerance: tolerance * 10 });
  const incidence = validation.edges.map(e => e.count).sort((a, b) => a - b);
  const degrees = Array(mesh.vertices.length).fill(0);
  for (const e of validation.edges) { degrees[e.a]++; degrees[e.b]++; }
  degrees.sort((a, b) => a - b);
  return JSON.stringify({
    v: mesh.vertices.length,
    f: mesh.faces.length,
    pairs: pairDistances,
    shapes: faceShapes,
    planes: planeDistances,
    incidence,
    degrees,
  });
}

function orbitMatching(orbits, predicate) {
  return orbits.filter(predicate).sort((a, b) =>
    a.planeDistance - b.planeDistance || a.id - b.id);
}

/**
 * Structural presets for the dodecahedral and icosahedral vertex sets.  The
 * choices are located from orbit size, circuit step, and plane radius, so no
 * catalog face indices or orientation are baked into the engine.
 */
export function keplerPoinsotPresets(engine) {
  const { poly, orbits } = engine;
  const presets = [];
  const addPreset = (id, name, orbit) => {
    if (!orbit) return;
    const preview = buildFacetingPreview(poly, orbits, [orbit.id], { tolerance: engine.tolerance });
    presets.push({
      id, name, orbitIds: [orbit.id], faceCount: preview.faces.length,
      validation: preview.validation,
    });
  };
  const faceSizes = poly.faces.map(f => f.length);

  if (poly.vertices.length === 20 && poly.faces.length === 12 && faceSizes.every(n => n === 5)) {
    const convex = orbitMatching(orbits, o => o.faceCount === 12 && o.sides === 5 && o.step === 1);
    const stars = orbitMatching(orbits, o => o.faceCount === 12 && o.sides === 5 && o.step === 2 && o.planeDistance > engine.tolerance);
    addPreset('dodecahedron', 'Dodecahedron', convex[convex.length - 1]);
    addPreset('great-stellated-dodecahedron', 'Great stellated dodecahedron', stars[0]);
  }

  if (poly.vertices.length === 12 && poly.faces.length === 20 && faceSizes.every(n => n === 3)) {
    const triangles = orbitMatching(orbits, o => o.faceCount === 20 && o.sides === 3 && o.step === 1 && o.planeDistance > engine.tolerance);
    const pentagons = orbitMatching(orbits, o => o.faceCount === 12 && o.sides === 5 && o.planeDistance > engine.tolerance);
    addPreset('great-icosahedron', 'Great icosahedron', triangles[0]);
    addPreset('icosahedron', 'Icosahedron', triangles[triangles.length - 1]);
    addPreset('great-dodecahedron', 'Great dodecahedron', pentagons.find(o => o.step === 1));
    addPreset('small-stellated-dodecahedron', 'Small stellated dodecahedron', pentagons.find(o => o.step === 2));
  }
  return presets;
}

/** The lossless all-native-orbits selection used by native-only engines. */
export function nativeBasePreset(engine) {
  if (engine.mode !== 'native-only') return null;
  const orbitIds = engine.orbits.map(o => o.id);
  const preview = buildFacetingPreview(engine.poly, engine.orbits, orbitIds,
    { tolerance: engine.tolerance });
  return {
    id: 'base',
    name: 'Base polyhedron',
    orbitIds,
    faceCount: preview.faces.length,
    validation: preview.validation,
    native: true,
  };
}

/**
 * Find an orbit selection congruent to a target catalog mesh.  Isohedral
 * (single-orbit) matching is the fast path; a bounded combination search is
 * available with `maxOrbitTypes > 1` for small custom examples.
 */
export function findFacetingSelectionForTarget(engine, targetInput, options = {}) {
  const target = normalizeFacetingPolyhedron(targetInput);
  const tolerance = options.tolerance ?? 1e-6;
  const wanted = facetingMeshSignature(target, { tolerance });
  const maxOrbitTypes = Math.max(1, Math.min(options.maxOrbitTypes ?? 1, 4));
  const maxCombinations = options.maxCombinations ?? 10000;
  const targetFaceCount = target.faces.length;
  const eligible = engine.orbits.filter(o => o.faceCount <= targetFaceCount);
  let tried = 0;

  const test = ids => {
    tried++;
    const preview = engine.preview(ids);
    if (preview.faces.length !== targetFaceCount) return null;
    if (facetingMeshSignature(preview, { tolerance }) !== wanted) return null;
    const preset = engine.presets.find(p =>
      p.orbitIds.length === ids.length && p.orbitIds.every((id, i) => id === ids[i]));
    return { matched: true, orbitIds: ids.slice(), preview, preset: preset || null, tried };
  };

  for (const orbit of eligible) {
    const match = test([orbit.id]);
    if (match) return match;
  }

  if (maxOrbitTypes > 1) {
    const chosen = [];
    const search = (start, remainingFaces) => {
      if (tried >= maxCombinations || chosen.length >= maxOrbitTypes) return null;
      for (let i = start; i < eligible.length; i++) {
        const orbit = eligible[i];
        if (orbit.faceCount > remainingFaces) continue;
        chosen.push(orbit.id);
        const left = remainingFaces - orbit.faceCount;
        if (left === 0) {
          const match = test(chosen);
          if (match) return match;
        } else if (chosen.length < maxOrbitTypes) {
          const match = search(i + 1, left);
          if (match) return match;
        }
        chosen.pop();
        if (tried >= maxCombinations) break;
      }
      return null;
    };
    const match = search(0, targetFaceCount);
    if (match) return match;
  }
  return { matched: false, orbitIds: [], preview: null, preset: null, tried,
    reason: tried >= maxCombinations ? 'combination search limit reached' : 'no congruent orbit selection found' };
}

function missingNativeCircuits(enumerated) {
  const available = new Set(enumerated.candidates.map(c => c.key));
  let missing = 0;
  for (const face of enumerated.poly.faces)
    if (!available.has(canonicalCircuit(face))) missing++;
  return missing;
}

/** Stateful convenience facade for UI selection and previews. */
export function createFacetingEngine(polyInput, matrices = [], options = {}) {
  const nativeOnly = options.nativeOnly === true || options.mode === 'native-only';
  const sourceFaces = polyInput?.faces || polyInput?.f || [];
  const vertexCount = Array.isArray(polyInput?.vertices) ? polyInput.vertices.length :
    Array.isArray(polyInput?.v) ? polyInput.v.length / 3 : 0;
  const allowFallback = options.nativeFallback !== false && options.mode !== 'exhaustive' &&
    sourceFaces.length > 0;
  const autoNative = !nativeOnly && allowFallback &&
    vertexCount > (options.nativeVertexThreshold ?? 62);
  let enumerated;
  let fallbackReason = null;
  if (nativeOnly || autoNative) {
    enumerated = enumerateNativeFacetCandidates(polyInput, options);
    if (autoNative) fallbackReason = `vertex count ${vertexCount} exceeds exhaustive threshold`;
  } else {
    try {
      enumerated = enumerateFacetCandidates(polyInput, options);
      const missing = allowFallback ? missingNativeCircuits(enumerated) : 0;
      if (missing) {
        enumerated = enumerateNativeFacetCandidates(polyInput, options);
        fallbackReason = `${missing} native face circuit${missing === 1 ? '' : 's'} ` +
          'not recoverable by exhaustive angular-step candidates';
      }
    } catch (error) {
      const limited = error instanceof RangeError &&
        /^faceting (plane|candidate) limit/.test(error.message);
      if (!allowFallback || !limited) throw error;
      enumerated = enumerateNativeFacetCandidates(polyInput, options);
      fallbackReason = error.message;
    }
  }
  const grouped = groupFacetCandidates(enumerated, matrices, {
    tolerance: options.symmetryTolerance ?? enumerated.tolerance * 10,
  });
  const engine = {
    poly: enumerated.poly,
    vertices: enumerated.vertices,
    planes: enumerated.planes,
    candidates: enumerated.candidates,
    orbits: grouped.orbits,
    symmetry: grouped.symmetry,
    mode: enumerated.mode,
    fallbackReason,
    tolerance: enumerated.tolerance,
    scale: enumerated.scale,
    selection: new Set(),
    presets: [],
    select(selection) {
      this.selection = selectedOrbitIds(this.orbits, selection);
      return this.preview();
    },
    toggle(orbitId, force) {
      const ids = selectedOrbitIds(this.orbits, [orbitId]);
      if (!ids.size) return this.preview();
      const id = ids.values().next().value;
      const on = force === undefined ? !this.selection.has(id) : Boolean(force);
      if (on) this.selection.add(id); else this.selection.delete(id);
      return this.preview();
    },
    clear() { this.selection.clear(); return this.preview(); },
    applyPreset(presetOrId) {
      const preset = typeof presetOrId === 'string' ?
        this.presets.find(p => p.id === presetOrId) : presetOrId;
      if (!preset) throw new RangeError(`unknown faceting preset: ${presetOrId}`);
      return this.select(preset.orbitIds);
    },
    preview(selection = this.selection) {
      return buildFacetingPreview(this.poly, this.orbits, selection, { tolerance: this.tolerance });
    },
    findTarget(target, matchOptions = {}) {
      return findFacetingSelectionForTarget(this, target, matchOptions);
    },
  };
  engine.presets = keplerPoinsotPresets(engine);
  const base = nativeBasePreset(engine);
  if (base) engine.presets.unshift(base);
  return engine;
}
