import {
  createFacetingEngine,
  facetingMeshSignature,
  normalizeFacetingPolyhedron,
} from './faceting.js';
import { facePlanes } from './core.js';
import { Renderer3D } from './render3d.js';

const $ = selector => document.querySelector(selector);

const ORBIT_COPY = [
  {
    name: 'Icosahedron',
    short: 'base triangles',
    explanation: 'Three coplanar points in the outer triangle plane; step 1 restores the convex base.',
  },
  {
    name: 'Great dodecahedron',
    short: 'convex pentagons',
    explanation: 'The same five-point planes used by F2, connected around their convex rim with step 1.',
  },
  {
    name: 'Small stellated dodecahedron',
    short: 'pentagrams',
    explanation: 'Five coplanar vertices, connected by step 2 rather than around the convex rim.',
  },
  {
    name: 'Central square orbit',
    short: 'open orbit',
    explanation: 'Four-point circuits through the origin. This orbit alone has open abstract edges and is non-manifold.',
  },
  {
    name: 'Great icosahedron',
    short: 'inner triangles',
    explanation: 'Three-point circuits in the inner triangle-plane orbit; the vertices still do not move.',
  },
];

const ORBIT_COLORS = ['#d13ca4', '#df5a49', '#cc8a00', '#42c9a2', '#d13ca4'];

const [geometry, symmetry] = await Promise.all([
  fetch('./data/geometry.json').then(response => {
    if (!response.ok) throw new Error(`geometry: HTTP ${response.status}`);
    return response.json();
  }),
  fetch('./data/symmetry.json').then(response => {
    if (!response.ok) throw new Error(`symmetry: HTTP ${response.status}`);
    return response.json();
  }),
]);

/* Proper icosahedral rotations match the F0–F4 table in the supplied direct
   faceting screenshot. Full Ih produces the same five orbits for this base. */
const engine = createFacetingEngine(geometry.u27, symmetry.I.matrices, {
  mode: 'exhaustive',
});

const targetPreset = engine.presets.find(preset =>
  preset.id === 'small-stellated-dodecahedron');
if (!targetPreset || targetPreset.orbitIds.length !== 1 || targetPreset.orbitIds[0] !== 2) {
  throw new Error('Expected the small stellated dodecahedron at direct orbit F2');
}

let renderer = null;
try {
  renderer = new Renderer3D($('#solid'));
  renderer.autoRotate = false;
  renderer.edgeWidth = 1.5;
  renderer.start();
} catch (error) {
  $('#solid').hidden = true;
  $('#webglFallback').hidden = false;
  $('#webglFallback').title = error.message;
}

function circuitSymbol(orbit) {
  if (orbit.step > 1) return `{${orbit.sides}/${orbit.step}}`;
  return `{${orbit.sides}}`;
}

function circuitName(orbit) {
  if (orbit.sides === 3) return 'triangle';
  if (orbit.sides === 4) return 'square';
  if (orbit.sides === 5 && orbit.step === 2) return 'pentagram';
  if (orbit.sides === 5) return 'pentagon';
  return `${orbit.sides}-gon`;
}

function drawFaceDiagram(orbit) {
  const n = orbit.sides;
  const step = orbit.step;
  const radius = 42;
  const points = Array.from({ length: n }, (_, index) => {
    const angle = -Math.PI / 2 + index * Math.PI * 2 / n;
    return { x: 60 + Math.cos(angle) * radius, y: 60 + Math.sin(angle) * radius };
  });
  const order = [];
  let index = 0;
  do {
    order.push(index);
    index = (index + step) % n;
  } while (index !== 0 && order.length <= n);
  const polygon = ids => ids.map((id, i) =>
    `${i ? 'L' : 'M'}${points[id].x.toFixed(3)},${points[id].y.toFixed(3)}`).join(' ') + ' Z';
  const labels = points.map((point, id) =>
    `<circle cx="${point.x}" cy="${point.y}" r="5.4"></circle>` +
    `<text x="${point.x}" y="${point.y + 0.2}">${id}</text>`).join('');
  $('#faceDiagram').innerHTML =
    `<svg viewBox="0 0 120 120" role="img" aria-label="${circuitSymbol(orbit)} circuit">` +
      `<path class="rim" d="${polygon([...points.keys()])}"></path>` +
      `<path class="circuit" d="${polygon(order)}"></path>${labels}` +
    `</svg>`;
}

const orbitButtons = $('#orbitButtons');
for (const orbit of engine.orbits) {
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.orbit = orbit.id;
  button.style.setProperty('--orbit-color', ORBIT_COLORS[orbit.id]);
  button.innerHTML = `<b>F${orbit.id}</b><small>${orbit.faceCount} × ${circuitSymbol(orbit)}</small>`;
  button.title = `${ORBIT_COPY[orbit.id].name}: ${orbit.faceCount} ${circuitName(orbit)} faces`;
  button.setAttribute('aria-label', button.title);
  button.onclick = () => showOrbit(orbit.id, true);
  orbitButtons.append(button);
}

function showOrbit(orbitId, updateUrl = false) {
  const orbit = engine.orbits[orbitId];
  if (!orbit) return;
  const mesh = engine.preview([orbitId]);

  if (renderer) {
    renderer.resetScale();
    renderer.setMesh(mesh, mesh.faceOrbitIds);
  }

  for (const button of orbitButtons.querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(Number(button.dataset.orbit) === orbitId));
  }

  const copy = ORBIT_COPY[orbitId];
  $('#activeName').textContent = copy.name;
  $('#statV').textContent = mesh.vertices.length;
  $('#statE').textContent = mesh.validation.edgeCount;
  $('#statF').textContent = mesh.faces.length;
  $('#statTidy').textContent = mesh.validation.manifold ? 'tidy' : 'non-manifold';
  $('#statTidy').classList.toggle('bad', !mesh.validation.manifold);
  $('#faceSymbol').textContent = `${circuitSymbol(orbit)} ${circuitName(orbit)}`;
  $('#faceExplanation').textContent = copy.explanation;
  $('#faceCycle').textContent = `[${orbit.representative.vertexIds.join(', ')}]`;
  $('#orbitNote').textContent =
    `F${orbitId} contains ${orbit.faceCount} symmetry-equivalent circuits at plane radius ` +
    `${orbit.planeDistance.toFixed(10)}. Its single-orbit preview has Euler count ` +
    `${mesh.validation.eulerCharacteristic}.`;
  drawFaceDiagram(orbit);

  if (updateUrl) {
    const url = new URL(location.href);
    url.searchParams.set('orbit', orbitId);
    history.replaceState(null, '', url);
  }
}

$('#viewFit').onclick = () => renderer?.fit();
$('#viewHome').onclick = () => renderer?.home();
$('#viewSpin').onclick = event => {
  if (!renderer) return;
  renderer.autoRotate = !renderer.autoRotate;
  event.currentTarget.setAttribute('aria-pressed', String(renderer.autoRotate));
};

function applyRendererTheme() {
  if (!renderer) return;
  const dark = document.documentElement.dataset.theme === 'dark';
  renderer.background = dark ? [0.043, 0.051, 0.067] : [0.953, 0.961, 0.973];
  renderer.edgeColor = dark ? [0.03, 0.035, 0.045, 1] : [0.02, 0.025, 0.035, 1];
  renderer.draw();
}

$('#reportTheme').onclick = () => {
  const root = document.documentElement;
  const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
  root.dataset.theme = next;
  root.dataset.themePref = next;
  localStorage.setItem('theme', next);
  applyRendererTheme();
};

function closestPlane(source, candidates) {
  let best = null;
  let bestError = Infinity;
  for (const candidate of candidates) {
    const dot = source.n.x * candidate.n.x +
      source.n.y * candidate.n.y + source.n.z * candidate.n.z;
    const error = 1 - dot;
    if (error < bestError) {
      bestError = error;
      best = candidate;
    }
  }
  return { plane: best, normalError: bestError };
}

function markCheck(id, pass) {
  const node = $(id);
  node.textContent = pass ? '✓' : '×';
  node.className = pass ? 'pass' : 'fail';
}

function runCertificate() {
  const f2 = engine.preview(targetPreset.orbitIds);
  const target = normalizeFacetingPolyhedron(geometry.u39);
  const dodecahedron = normalizeFacetingPolyhedron(geometry.u28);
  const targetPlanes = facePlanes(target);
  const dodecaPlanes = facePlanes(dodecahedron);
  const pairs = dodecaPlanes.map(plane => ({ source: plane, ...closestPlane(plane, targetPlanes) }));
  const scale = pairs.reduce((sum, pair) => sum + pair.source.d / pair.plane.d, 0) / pairs.length;
  const normalError = Math.max(...pairs.map(pair => Math.abs(pair.normalError)));
  const supportError = Math.max(...pairs.map(pair =>
    Math.abs(pair.source.d - scale * pair.plane.d)));

  const checks = {
    vertices: f2.vertices === engine.vertices && f2.vertices.length === 12,
    catalog: facetingMeshSignature(f2) === facetingMeshSignature(target),
    planes: dodecaPlanes.length === 12 && targetPlanes.length === 12 &&
      normalError < 1e-12 && supportError < 1e-12,
    edges: f2.validation.manifold && f2.validation.usesAllVertices &&
      f2.validation.edgeCount === 30,
  };
  markCheck('#checkVertices', checks.vertices);
  markCheck('#checkCatalog', checks.catalog);
  markCheck('#checkPlanes', checks.planes);
  markCheck('#checkEdges', checks.edges);
  const passed = Object.values(checks).every(Boolean);
  $('#certificateStatus').textContent = passed ? '4 / 4 checks pass' : 'check failed';
  $('#certificateStatus').className = `certificate-status ${passed ? 'pass' : 'fail'}`;
  $('#certificateDetail').textContent =
    `engine: 67 planes → 79 circuits → 5 I-orbits · F2 support 0.4472135955 ` +
    `· plane-alignment scale λ=${scale.toFixed(10)} · max normal error ${normalError.toExponential(1)}`;
  return { checks, scale, normalError, supportError, f2 };
}

const requestedValue = new URL(location.href).searchParams.get('orbit');
const requested = requestedValue === null ? NaN : Number(requestedValue);
const initialOrbit = Number.isInteger(requested) && engine.orbits[requested] ? requested : 2;
showOrbit(initialOrbit);
applyRendererTheme();
const certificate = runCertificate();

/* Deliberately exposed for browser-level regression checks and for readers who
   want to inspect the exact computed circuits from their developer console. */
window.icosahedronFacetingExample = { engine, certificate, showOrbit };
