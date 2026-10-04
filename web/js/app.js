/*
 * Faceting: pick a polyhedron, explore the reciprocal arrangement of its dual,
 * and connect the base polyhedron's fixed vertices with new facet circuits.
 *
 * The arrangement engine remains Vladimir Bulatov's stellation algorithm. The
 * visible mesh is its polar reciprocal, so this is a real faceting rather than
 * a terminology swap: vertices stay fixed while faces change.
 */

import { Renderer3D } from './render3d.js';
import { DiagramView } from './diagram.js';
import { CellsPanel } from './cells.js';
import { labelKeys } from './platform.js';
import { toOFF, toOBJ, toSTL, writeStel, facePlanes, suggestDepth } from './core.js';
import { writePreset, readDocument, newDocumentName } from './preset.js';

const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];

/*
 * Which build you are looking at.
 *
 * Shown in the help dialog because a good part of the 6 August session went on
 * a bug that had been fixed an hour earlier — the browser was serving an old
 * app.js and there was no way to tell from the screen. `_headers` stops that
 * happening; this makes it checkable when it does.
 */
export const BUILD = '2026-10-04 · noble polyhedra catalog';

const state = {
  catalog: null, symmetry: null, geometry: null,
  current: null, dualFile: null,
  polySym: 'Ih', stellSym: 'I',
  depth: 20,
  depthAuto: true,          // until the user moves the slider
  outline: null,
  orbits: [], presets: [], basePreset: null,
  selected: new Set(),
  planeIndex: 0,
  building: false,
};

// ------------------------------------------------------------------ worker

let worker = null, msgId = 0;
const pending = new Map();

function startWorker(reason = 'worker restarted') {
  if (worker) {
    worker.terminate();
    for (const [, p] of pending) p.reject(new Error(reason));
    pending.clear();
  }
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const { id, ok, data, error, progress } = e.data;
    const p = pending.get(id);
    if (!p) return;
    if (progress) { p.onProgress?.(progress); return; }
    pending.delete(id);
    ok ? p.resolve(data) : p.reject(new Error(error));
  };
  worker.onerror = (e) => {
    for (const [, p] of pending) p.reject(new Error(e.message || 'worker failed'));
    pending.clear();
  };
}

function call(type, payload, onProgress) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    worker.postMessage({ id, type, payload });
  });
}

// ------------------------------------------------------------------ boot

let renderer, diagram, cells;

async function boot() {
  const [catalog, symmetry, geometry] = await Promise.all([
    fetch('data/catalog.json').then(r => r.json()),
    fetch('data/symmetry.json').then(r => r.json()),
    fetch('data/geometry.json').then(r => r.json()),
  ]);
  Object.assign(state, { catalog, symmetry, geometry });
  $('#search').placeholder = `Search ${catalog.reduce((n, section) => n + section.items.length, 0)} base solids by name, file or symmetry…`;

  try {
    renderer = new Renderer3D($('#view3d'));
    renderer.autoRotate = false;             // still by default; spin is opt-in
    const savedEdge = Number(localStorage.getItem('edgeWidth'));
    if (savedEdge > 0) {
      renderer.edgeWidth = savedEdge;
      $('#edgeWidth').value = savedEdge;
      $('#edgeWidthLabel').textContent = savedEdge.toFixed(1);
    }
    renderer.start();
    renderer.onPick = onPick3D;
    renderer.onPickHover = onHover3D;
  } catch (err) {
    $('#view3d').replaceWith(Object.assign(document.createElement('div'), {
      className: 'nogl', textContent: '3D view needs WebGL2, which this browser did not provide.',
    }));
  }

  diagram = new DiagramView($('#diagram'), {
    onToggle: (facet, mod) => applyToFacet(facet, mod),
    onHover: (facet) => {
      $('#hover2d').textContent = facet
        ? `layer ${facet.layer}${facet.ref ? ` · cell ${facet.ref[1]}${facet.ref[2] ? '[' + facet.ref[2] + ']' : ''}` : ''}`
        : '';
    },
  });

  cells = new CellsPanel($('#cells'), {
    onBeforeChange: () => mark(),
    onChange: () => refresh(),
    onHover: (hit) => { $('#cellInfo').textContent = cells.describe(hit); },
  });

  labelKeys();          // name the carve modifier for this platform

  wireControls();
  startWorker();
  applyTheme(localStorage.getItem('theme') || 'auto');   // now that the views exist

  // handy from the console, and what the browser tests drive
  window.faceting = { state, orbits: cells, diagram, renderer, call, select, refresh, applyToCell, openDocument };

  /*
   * file / polyGroup / stellGroup / dDEPTH / vQX,QY,QZ,QW,ZOOM / {cells}
   *
   * The `v` segment is the camera, added so that a reload keeps the angle you
   * were looking from and so that a link shows the recipient the same picture
   * — «ориентация, конечно, хорошо, чтобы можно было человеку послать». Every
   * segment stays optional, so links written before it existed still open.
   */
  const hash = decodeURIComponent(location.hash.slice(1));
  const m = hash.match(
    /^([\w]+)(?:\/([\w()]+))?(?:\/([\w()]+))?(?:\/d(\d+))?(?:\/v([-\d.,eE]+))?(?:\/(\{.*\}))?$/);
  if (m && geometry[m[1]]) {
    await select(findItem(m[1]) || { file: m[1], name: m[1], symmetry: m[2] || 'Ih' },
                 { polySym: m[2], stellSym: m[3], cells: m[6],
                   depth: m[4] ? Number(m[4]) : undefined,
                   view: m[5] ? m[5].split(',').map(Number) : null });
  } else {
    // The photograph in the brief is the Great Stella target: twelve explicit
    // pentagram circuits on the dodecahedron's twenty fixed vertices.
    await select(findItem('u28'), { preset: 'great-stellated-dodecahedron' });
  }

  /*
   * The camera is not part of the app's state, it lives in the renderer and
   * changes sixty times a second while you drag. Rather than write the URL from
   * inside the draw loop, notice after the fact that it settled somewhere new.
   * replaceState, so turning the solid does not fill the back button.
   */
  const catchUp = () => {
    if (!renderer || !state.current) return;
    const v = renderer.getView().join(',');
    if (v === lastView) return;
    lastView = v;
    syncHash();
  };
  setInterval(catchUp, 900);
  // and immediately on the way out, so the last position is never the one lost
  addEventListener('pagehide', catchUp);
  addEventListener('visibilitychange', catchUp);
}

let lastView = '';

function syncHash() {
  if (!state.current) return;
  const v = renderer ? `/v${renderer.getView().join(',')}` : '';
  const h = `${state.current.file}/${state.polySym}/${state.stellSym}` +
            `/d${state.depth}${v}/${state.cellsString || ''}`;
  try { history.replaceState(null, '', '#' + h); }
  catch { location.hash = h; }     // file:// URLs reject replaceState
}

function findItem(file) {
  for (const cat of state.catalog)
    for (const it of cat.items) if (it.file === file) return { ...it, category: cat.category };
  return null;
}

/*
 * Catalog file containing the polar dual used by the arrangement engine.
 * Most uNN/dNN pairs are literal duals. The regular solids also have their
 * familiar `u` names in the catalog, and using those preserves the original
 * port's tested orientation and cell ordering.
 */
const REGULAR_DUAL = {
  u06: 'u06', u10: 'u11', u11: 'u10', u27: 'u28', u28: 'u27',
  u39: 'u40', u40: 'u39', u57: 'u58', u58: 'u57',
};

function dualFile(file) {
  const item = findItem(file);
  if (item && 'dual' in item) return item.dual; // null explicitly marks a fissary dual
  if (REGULAR_DUAL[file]) return REGULAR_DUAL[file];
  if (/^u\d+$/.test(file)) return 'd' + file.slice(1);
  if (/^d\d+$/.test(file)) return 'u' + file.slice(1);
  return file;
}

// ------------------------------------------------------------------ undo

/*
 * Undo and redo over the cell selection.
 *
 * «Я вот сейчас раз удалил, у меня всё сломалось… удалил центральную ячейку.
 * Думаю: что случилось?» — carving with ctrl takes the clicked cell's whole
 * supporting set, which from a high cell reaches all the way to the core, and
 * one keystroke can undo a quarter of an hour's building. There is no way to
 * work that out backwards from the result, so the result is not what we keep:
 * every operation banks the selection it started from.
 *
 * Snapshots, not deltas. A selection is a set of short strings and even the
 * densest arrangement has a few thousand of them, so a hundred snapshots cost
 * less than a single rebuild — and a snapshot cannot drift out of step with the
 * thing it describes the way a replayed delta can.
 */
const undoStack = { past: [], future: [], limit: 100 };

function mark() {
  undoStack.past.push(new Set(state.selected));
  if (undoStack.past.length > undoStack.limit) undoStack.past.shift();
  undoStack.future.length = 0;
  syncUndo();
}

/** a new arrangement is a new document: nothing before it can be restored */
function clearHistory() {
  undoStack.past.length = 0;
  undoStack.future.length = 0;
  syncUndo();
}

function syncUndo() {
  const u = $('#undoBtn'), r = $('#redoBtn');
  if (u) u.disabled = !undoStack.past.length;
  if (r) r.disabled = !undoStack.future.length;
}

function undo() {
  if (!undoStack.past.length) return;
  undoStack.future.push(new Set(state.selected));
  state.selected = undoStack.past.pop();
  syncUndo();
  refresh();
}

function redo() {
  if (!undoStack.future.length) return;
  undoStack.past.push(new Set(state.selected));
  state.selected = undoStack.future.pop();
  syncUndo();
  refresh();
}

// ------------------------------------------------------------------ picking

/**
 * Toggle, add, or remove an explicit facet orbit. Facet-orbit keys have no
 * volumetric dependency relation: their support closure is just themselves.
 */
function applyToCell(key, mod) {
  if (!key) return;
  mark();
  const sel = state.selected;
  if (mod.shift) {
    for (const k of cells.supportKeys(key)) sel.add(k);
  } else if (mod.ctrl) {
    for (const k of cells.supportKeys(key)) sel.delete(k);
  } else {
    sel.has(key) ? sel.delete(key) : sel.add(key);
  }
  refresh();
}

/** add or remove a set of keys, returning exactly what changed, so it can be undone */
function applyChange(keys, add) {
  const sel = state.selected, changed = new Set();
  for (const k of keys) {
    if (add ? !sel.has(k) : sel.has(k)) { add ? sel.add(k) : sel.delete(k); changed.add(k); }
  }
  return changed;
}

/** everything resting on `key`, transitively — mirror of CellsPanel.supportKeys */
function dependentKeys(key) {
  const out = new Set([key]);
  const stack = [key];
  while (stack.length) {
    const k = stack.pop();
    for (const t of (cells.byKey.get(k)?.sub.top || [])) {
      if (!out.has(t)) { out.add(t); stack.push(t); }
    }
  }
  return out;
}

function applyToFacet(facet, mod) {
  if (!facet?.ref) return;
  applyToCell(facet.ref.join('.'), mod);
}

/*
 * Clicking any face edits the complete symmetry orbit that generated it.
 */

function onPick3D(hit, mod) {
  const mesh = state.mesh;
  if (!mesh) return;
  const inside = mesh.faceInside[hit.face];
  const outside = mesh.faceOutside[hit.face];

  if (mod.shift) {
    if (!outside) return;
    mark();
    applyChange(cells.supportKeys(outside), true);
  } else if (mod.ctrl) {
    if (!inside) return;
    mark();
    applyChange(cells.supportKeys(inside), false);
  } else {
    applyToCell(inside || outside, {});
    return;
  }
  refresh();
}

/*
 * What a click here would do, said in colour before it is spent.
 *
 * Green adds, red removes — «зеленое и красное, наверное, более натуральное».
 * And when the gesture has nothing to work on the outline is dimmed rather than
 * dropped: «делать highlight, если ячейки можно добавить», but you still want to
 * see which face you are pointing at, so it stays visible and stops looking like
 * a live target.
 */
function onHover3D(hit, mod) {
  const mesh = state.mesh;
  if (!hit || !mesh) {
    $('#hover3d').textContent = '';
    renderer?.setHighlight(-1);
    return;
  }
  const action = mod?.shift ? 'add' : (mod?.ctrl ? 'remove' : null);
  const key = mod?.shift ? mesh.faceOutside[hit.face] : mesh.faceInside[hit.face];
  const live = !!key && !!action;
  renderer?.setHighlight(hit.face, action, live || !action);
  $('#hover3d').textContent = !action ? ''
    : key ? `${mod.shift ? 'add' : 'remove'} facet orbit ${key.split('.')[1]}`
    : 'no facet orbit on this face';
}

// ------------------------------------------------------------------ catalog

/*
 * The catalog is a specimen sheet: nothing but thumbnails, densely packed, with
 * the name of whatever you are pointing at spelled out along the bottom. Names
 * under every tile would triple the height and turn the catalog into a scroll.
 *
 * It is built the first time the picker opens rather than at start-up — the
 * thumbnails have no business delaying the first
 * render of the solid. Built that late, the images can load eagerly, so the
 * sheet never shows the half-filled grid lazy loading gives you inside a dialog.
 */
let catalogBuilt = false;
function ensureCatalog() {
  if (!catalogBuilt) { buildCatalog(); catalogBuilt = true; }
  $$('.poly').forEach(b => b.classList.toggle('active', b.dataset.file === state.current?.file));
}

function buildCatalog() {
  const host = $('#catalog');
  const chips = $('#catChips');
  host.innerHTML = '';
  chips.innerHTML = '';

  for (const cat of state.catalog) {
    const slug = cat.category.replace(/\W+/g, '-');

    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.textContent = cat.category;
    chip.onclick = () => host.querySelector(`#sec-${slug}`)
      .scrollIntoView({ behavior: 'smooth', block: 'start' });
    chips.appendChild(chip);

    const section = document.createElement('section');
    section.className = 'cat';
    section.id = `sec-${slug}`;
    section.innerHTML = `<h3><span>${cat.category}</span><em>${cat.items.length}</em></h3>`;

    const grid = document.createElement('div');
    grid.className = 'grid';
    for (const item of cat.items) {
      const b = document.createElement('button');
      b.className = 'poly';
      b.dataset.file = item.file;
      b.dataset.name = `${item.name} ${item.nobleSymbol || ''}`;
      b.dataset.sym = item.symmetry;
      b.dataset.cat = cat.category;
      b.setAttribute('aria-label', item.name);
      b.innerHTML = `<img src="${thumbnail(item)}" alt="" width="46" height="46">`;
      b.onmouseenter = () => showFoot(item, cat.category);
      b.onfocus = () => showFoot(item, cat.category);
      b.onclick = () => {
        $('#catalogDialog').close();
        state.depthAuto = true;          // a new solid gets its own suggested depth
        select({ ...item, category: cat.category });
      };
      grid.appendChild(b);
    }
    section.appendChild(grid);
    host.appendChild(section);
  }

  host.onmouseleave = () => showFoot(state.current, state.current?.category);
  updateCatCount();
}

const thumbnail = item => item.thumbnail || `img/poly/${item.file}_tmb.gif`;

function showFoot(item, category) {
  if (!item) return;
  $('#footThumb').src = thumbnail(item);
  $('#footName').textContent = item.name;
  $('#footMeta').textContent = [item.file, item.symmetry, item.nobleSymbol,
    item.schlafli, item.dualSymbol && `dual ${item.dualSymbol}`, category].filter(Boolean).join(' · ');
}

function updateCatCount() {
  const items = $$('.poly');
  const vis = items.filter(b => b.style.display !== 'none').length;
  $('#footCount').textContent = vis === items.length ? `${vis} solids` : `${vis} of ${items.length}`;
}

// ------------------------------------------------------------------ selection

async function select(item, opts = {}) {
  if (!item) return;
  state.current = item;
  state.dualFile = dualFile(item.file);
  state.polySym = opts.polySym || item.symmetry || 'Ih';
  state.stellSym = opts.stellSym || defaultStellSym(state.polySym);

  $$('.poly').forEach(b => b.classList.toggle('active', b.dataset.file === item.file));
  $('#pickName').textContent = item.name;
  $('#pickThumb').src = thumbnail(item);
  $('#depth').disabled = $('#showAllFacets').disabled = state.dualFile === null;
  $('#diagramNote').textContent = item.reciprocalNote ||
    'reciprocal faceting diagram · read-only guide · drag to pan · double-click resets';

  if (opts.depth != null) {
    setDepth(opts.depth, false);           // an opened document or a link fixes it
  } else if (state.depthAuto && state.dualFile !== null) {
    setDepth(suggestDepth(facePlanes(toPoly(state.geometry[state.dualFile]))), true);
  }

  syncSymmetrySelects();
  const built = await build(opts.cells, opts.preset);
  if (!built) return;
  // after the build, so the mesh (and therefore the model scale) already exists
  if (opts.view && renderer?.setView(opts.view)) lastView = renderer.getView().join(',');
}

const NO_LIMIT = 60;   // slider top = build every layer there is

function toPoly(g) {
  const vertices = [];
  for (let i = 0; i < g.v.length; i += 3) vertices.push({ x: g.v[i], y: g.v[i + 1], z: g.v[i + 2] });
  return { vertices, faces: g.f };
}

function setDepth(depth, auto) {
  state.depth = depth < 0 ? NO_LIMIT : depth;
  state.depthAuto = !!auto;
  $('#depth').value = state.depth;
  $('#depthLabel').textContent = state.depth >= NO_LIMIT ? 'every' : state.depth;
}

/** the rotation-only subgroup is the usual choice for symmetric facetings */
function defaultStellSym(poly) {
  const map = { Ih: 'I', Oh: 'O', Td: 'T', Th: 'T', I: 'I', O: 'O', T: 'T' };
  return map[poly] || poly;
}

/*
 * Which symmetry groups may be offered.
 *
 * Not every group makes sense for every solid: asking for I (order 60) as the
 * stellation symmetry of a T-symmetric arrangement is not a lower symmetry at
 * all, and the result is meaningless. The Java applet lists, for a given solid,
 * only the subgroups of its own point group, and this reproduces that — but by
 * testing actual matrix containment rather than by carrying a hand-written
 * subgroup lattice, so it stays correct for the oriented variants (the "(O)"
 * groups are cubic-frame copies and belong to the octahedral families only).
 *
 * Cached: 85 groups against 5 parents is a few hundred thousand comparisons,
 * worth doing once rather than on every rebuild.
 */
const subgroupCache = new Map();

function matrixKey(m) {
  // quantised so that 0.9999999 and 1.0 are the same rotation
  let k = '';
  for (const v of m) k += (Math.round(v * 1e4) / 1e4 + 0) + ',';
  return k;
}

function subgroupsOf(parent) {
  if (subgroupCache.has(parent)) return subgroupCache.get(parent);
  const P = state.symmetry[parent];
  const names = Object.keys(state.symmetry).filter(n => state.symmetry[n].order > 0);
  let out;
  if (!P?.matrices?.length) {
    out = names;
  } else {
    const inParent = new Set(P.matrices.map(matrixKey));
    out = names.filter(n => {
      const G = state.symmetry[n];
      if (G.order > P.order) return false;
      return (G.matrices || []).every(m => inParent.has(matrixKey(m)));
    });
  }
  out.sort((a, b) => state.symmetry[b].order - state.symmetry[a].order || a.localeCompare(b));
  subgroupCache.set(parent, out);
  return out;
}

function fillSelect(id, names, value) {
  $(id).innerHTML = names.map(n =>
    `<option value="${n}"${n === value ? ' selected' : ''}>${n} (${state.symmetry[n].order})</option>`
  ).join('');
}

function syncSymmetrySelects() {
  // the solid's own point group bounds the polyhedron symmetry; that in turn
  // bounds the stellation symmetry, which must be a subgroup of it
  const own = state.current?.symmetry || 'Ih';
  const polyNames = subgroupsOf(own);
  if (!polyNames.includes(state.polySym)) state.polySym = polyNames[0] || own;
  fillSelect('#polySym', polyNames, state.polySym);

  const stellNames = subgroupsOf(state.polySym);
  if (!stellNames.includes(state.stellSym)) state.stellSym = state.polySym;
  fillSelect('#stellSym', stellNames, state.stellSym);
}

/*
 * Draggable splitters.
 *
 * The three panes are fixed fractions of the window, which is fine until a
 * deep arrangement makes the Cells table wider than its column — with C3
 * symmetry a row can run to twenty sub-cells. Rather than guess a width that
 * suits every solid, let the panes be resized, and remember where they were put.
 */
function installSplitters() {
  const root = document.documentElement;
  for (const [id, apply] of [
    ['#splitPanel', (e) => {
      const w = Math.min(720, Math.max(240, window.innerWidth - e.clientX));
      root.style.setProperty('--panel-w', w + 'px');
      localStorage.setItem('panelW', w);
    }],
    ['#splitViews', (e) => {
      const box = $('.views').getBoundingClientRect();
      const frac = Math.min(0.85, Math.max(0.15, (e.clientX - box.left) / box.width));
      root.style.setProperty('--views-a', frac + 'fr');
      root.style.setProperty('--views-b', (1 - frac) + 'fr');
      localStorage.setItem('viewsFrac', frac);
    }],
  ]) {
    const el = $(id);
    if (!el) continue;
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      el.classList.add('dragging');
      // capture throws for a pointer the browser is not tracking; it is an
      // optimisation for dragging past the splitter, never a precondition
      try { el.setPointerCapture?.(e.pointerId); } catch { /* nothing to capture */ }
      const move = (ev) => { apply(ev); renderer?.resize(); diagram?.draw(); cells?.draw(); };
      const up = () => {
        el.classList.remove('dragging');
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
    });
  }
  const w = Number(localStorage.getItem('panelW'));
  if (w >= 240) root.style.setProperty('--panel-w', w + 'px');
  const f = Number(localStorage.getItem('viewsFrac'));
  if (f > 0.1 && f < 0.9) {
    root.style.setProperty('--views-a', f + 'fr');
    root.style.setProperty('--views-b', (1 - f) + 'fr');
  }
}

/**
 * The axis of a proper rotation, from its matrix. Null for the identity.
 *
 * The axis is the eigenvector for eigenvalue 1, and the skew part gives it
 * directly as (R32-R23, R13-R31, R21-R12) = 2·sin(θ)·n. A half-turn defeats
 * that, because sin(180°) = 0; there R + I is 2·n·nᵀ, rank one with every column
 * parallel to the axis, so the longest column serves. Recovering the sign from
 * square roots of the diagonal instead loses an axis of Oh, because a zero
 * component leaves its sign undetermined and two distinct axes then collapse
 * onto each other.
 */
function rotationAxis(a, b, c, d, e, f, g, h, i) {
  if (a + e + i > 2.999) return null;              // the identity
  let v = [h - f, c - g, d - b];
  if (Math.hypot(...v) < 1e-6) {
    const cols = [[a + 1, d, g], [b, e + 1, h], [c, f, i + 1]];
    v = cols.reduce((best, col) =>
      Math.hypot(...col) > Math.hypot(...best) ? col : best, cols[0]);
  }
  const L = Math.hypot(...v);
  return L < 1e-6 ? null : v.map(x => x / L);
}

/*
 * Every symmetry element of a group, sorted into the three kinds that can be
 * drawn — asked for at 13:54: «add checkbox to show rotating planes (translucent
 * disks) separate from axes, and a third one for зеркально-винтовой плоскость».
 *
 *   axes      proper rotations (det +1)
 *   mirrors   reflections (det -1, trace +1) — reported as the plane's normal
 *   improper  rotoreflections S_n, the "glide reflection in 3D" (det -1, other)
 *
 * The trick for the improper ones is that if M is improper then -M is a proper
 * rotation (in 3D, det(-M) = -det(M)), so the same axis extraction works on it.
 * For a plain mirror -M is the half-turn about the plane's normal, which is
 * exactly the number needed to orient the disc. The inversion centre is neither
 * a line nor a plane and is left out.
 */
function symmetryElements(name) {
  const G = state.symmetry[name];
  const out = { axes: [], mirrors: [], improper: [] };
  if (!G?.matrices?.length) return out;
  const seen = { axes: [], mirrors: [], improper: [] };

  const add = (bucket, v) => {
    if (!v) return;
    // ±v are the same line, and the same plane; pick one lexicographically
    if (v[0] < -1e-9 || (Math.abs(v[0]) <= 1e-9 && (v[1] < -1e-9 ||
        (Math.abs(v[1]) <= 1e-9 && v[2] < 0)))) v = v.map(x => -x);
    if (seen[bucket].some(u => Math.abs(u[0] - v[0]) + Math.abs(u[1] - v[1]) +
                               Math.abs(u[2] - v[2]) < 1e-4)) return;
    seen[bucket].push(v);
    out[bucket].push({ dir: v });
  };

  for (const m of G.matrices) {
    const [a, b, c, d, e, f, g, h, i] = m.length === 9
      ? m
      : [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];   // 4x4 row-major
    const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
    const trace = a + e + i;
    if (det > 0) { add('axes', rotationAxis(a, b, c, d, e, f, g, h, i)); continue; }
    if (trace < -2.999) continue;                  // the inversion centre: a point
    const n = rotationAxis(-a, -b, -c, -d, -e, -f, -g, -h, -i);
    add(Math.abs(trace - 1) < 1e-6 ? 'mirrors' : 'improper', n);
  }
  return out;
}

/** what the three "show" checkboxes currently want to see */
function shownElements() {
  const el = symmetryElements(state.stellSym);
  return {
    axes: $('#showAxes')?.checked ? el.axes : [],
    mirrors: $('#showMirrors')?.checked ? el.mirrors : [],
    improper: $('#showImproper')?.checked ? el.improper : [],
  };
}

function refreshElements() {
  if (!renderer) return;
  const any = ['#showAxes', '#showMirrors', '#showImproper'].some(id => $(id)?.checked);
  renderer.setElements(any ? shownElements() : null);
}

// ------------------------------------------------------------------ build

let buildGeneration = 0;

async function build(cellsString, preset = null) {
  const generation = ++buildGeneration;
  // Catalog/symmetry choices are allowed while a long reciprocal diagram is
  // building. Cancel that worker and make the newest request authoritative;
  // otherwise its late reply would paint the old mesh under the new header.
  if (state.building) startWorker('build superseded by a newer selection');
  state.building = true;
  setBuildControlsDisabled(true);
  setStatus('enumerating fixed-vertex facet circuits…', true);

  const sourceDual = state.geometry[state.dualFile];
  // Some chiral library duals use the opposite handedness, but the diagram
  // must share the selected base's frame. Central inversion commutes with I/O.
  const g = state.current.dualInverted && sourceDual
    ? { v: sourceDual.v.map(x => -x), f: sourceDual.f } : sourceDual;
  renderer?.resetScale();      // a new arrangement re-frames; edits within one do not
  clearHistory();              // a different arrangement: nothing earlier applies
  const polyM = state.symmetry[state.polySym]?.matrices || state.symmetry.E.matrices;
  const subM = state.symmetry[state.stellSym]?.matrices || null;

  try {
    if (!g && state.dualFile !== null)
      throw new Error(`the catalog has no dual geometry for ${state.current.file}`);
    const baseGeometry = state.geometry[state.current.file];
    if (!baseGeometry) throw new Error(`the catalog has no base geometry for ${state.current.file}`);
    const info = await call('build', {
      geometry: g, baseGeometry, matrices: polyM, subMatrices: subM,
      skipReciprocal: state.dualFile === null,
      maxIntersection: state.depth >= NO_LIMIT ? -1 : state.depth, maxLayer: 1000,
    }, ({ done, total }) => {
      if (generation === buildGeneration)
        setStatus(`building reciprocal diagram ${done} of ${total}…`, true, done / total);
    });
    if (generation !== buildGeneration) return false;

    state.outline = info.outline;
    state.orbits = info.orbits || [];
    state.presets = info.presets || [];
    state.basePreset = info.basePreset || null;
    state.facetingDiagnostics = info.diagnostics || null;
    cells.setOutline(info.outline);
    fillFaceSelect(info.faces);
    refreshElements();
    renderLegend();

    if (preset) {
      const { selected } = await call('applyPreset', { preset });
      state.selected = new Set(selected);
    } else if (cellsString) {
      const { selected } = await call('parseCells', { cells: cellsString });
      state.selected = new Set(selected);
    } else {
      const { keys } = await call('layerKeys', { n: 1 });
      state.selected = new Set(keys);
    }

    await refresh();
    const slow = info.ms > 5000 && !state.depthAuto;
    const orbitReport = info.diagnostics.partialCandidates
      ? `${info.diagnostics.orbitCount} native face orbits (exact base; broader circuit search limited)`
      : `${info.diagnostics.orbitCount} facet orbits from ${info.facetCandidates.toLocaleString()} circuits`;
    const diagramReport = info.diagnostics.diagramAvailable
      ? `${planeReport(info)} in the reciprocal diagram` : 'reciprocal diagram unavailable (fissary dual)';
    setStatus(`${orbitReport} · ` +
              `${diagramReport} · ${(info.ms / 1000).toFixed(info.ms > 5000 ? 1 : 3)} s` +
              (slow ? ' — lower the depth for a quicker rebuild' : ''), false);
    const dropped = (info.planesCentral || 0) + (info.planesDegenerate || 0);
    const dropNote = dropped
      ? `${dropped} of this solid's ${info.planesTotal} faces have no usable reciprocal plane here` +
        (info.planesCentral ? ` — ${info.planesCentral} pass exactly through the centre, ` +
          'which this representation cannot hold (see notes/design/plane-representation.md)' : '')
      : '';
    const fallbackNote = info.diagnostics.partialCandidates
      ? `Facet candidates are limited to the catalog's exact native face circuits: ${info.diagnostics.fallbackReason || 'exhaustive search unavailable'}.`
      : '';
    $('#status').title = [fallbackNote, dropNote, state.current.reciprocalNote].filter(Boolean).join(' ');
    return true;
  } catch (err) {
    if (generation !== buildGeneration) return false;
    state.outline = null;
    state.orbits = [];
    state.presets = [];
    state.basePreset = null;
    state.selected = new Set();
    state.mesh = null;
    cells?.setOutline([]);
    diagram?.setData(null);
    if (renderer) {
      renderer.resetScale();
      renderer.setMesh({ vertices: [], faces: [], faceLayers: [] }, []);
    }
    $('#stats').textContent = 'unavailable';
    setStatus('failed: ' + err.message, false);
    startWorker();
    return false;
  } finally {
    if (generation === buildGeneration) {
      state.building = false;
      setBuildControlsDisabled(false);
      syncUndo();
    }
  }
}

async function refresh() {
  if (!state.outline) return;
  const selected = [...state.selected];
  const { mesh, diagram: dia } = await call('both', { selected, planeIndex: state.planeIndex });

  state.mesh = mesh;
  renderer?.setMesh(mesh, mesh.faceLayers);
  diagram.setData(dia);
  cells.setSelected(state.selected);

  $('#stats').innerHTML =
    `<b>${mesh.stats.V}</b> V · <b>${mesh.stats.E}</b> E · <b>${mesh.stats.F}</b> F · ` +
    `<span class="${mesh.validation.manifold ? 'valid' : 'warn'}">${mesh.validation.manifold ? 'tidy' : 'non-tidy'}</span>`;

  const { cells: str } = await call('formatCells', { selected });
  state.cellsString = str;
  $('#cellsString').value = str;
  syncHash();
}

/*
 * "N planes", or "N of M planes" when some of the solid's faces did not make it.
 *
 * Silently building an arrangement out of fewer planes than the solid has is the
 * worst failure this program can have, because the answer looks perfectly
 * healthy: you get a stellation, it is just a stellation of a *different* solid.
 * The hemipolyhedra lose their central planes here and there was nothing on
 * screen to say so. Now the count says it, and the tooltip says why.
 */
function planeReport(info) {
  const total = info.planesTotal ?? info.planes;
  const dropped = (info.planesCentral || 0) + (info.planesDegenerate || 0);
  if (!dropped) return `${info.planes} reciprocal planes`;
  return `⚠ ${info.planes} of ${total} reciprocal planes`;
}

/*
 * The diagram can be drawn on any face plane, but planes the symmetry carries
 * onto one another give the same picture — so offer one of each kind rather
 * than a number to type with no upper bound («здесь должно быть только два
 * выбора… но нету ограничителя»). Each entry is named after the polygon at the
 * centre of that diagram, which is the solid's own face there.
 */
const POLYGON = { 3: 'triangle', 4: 'square', 5: 'pentagon', 6: 'hexagon',
                  7: 'heptagon', 8: 'octagon', 9: 'nonagon', 10: 'decagon', 12: 'dodecagon' };

function fillFaceSelect(faces) {
  state.faces = Array.isArray(faces) ? faces : [];
  const sel = $('#planeIndex');
  if (!sel) return;
  sel.disabled = !state.faces.length;
  if (!state.faces.length) {
    sel.innerHTML = '<option value="0">diagram unavailable</option>';
    state.planeIndex = 0;
    return;
  }
  if (!state.faces.some(f => f.index === state.planeIndex)) state.planeIndex = state.faces[0].index;
  sel.innerHTML = state.faces.map(f => {
    const shape = POLYGON[f.sides] || (f.sides ? `${f.sides}-gon` : 'face');
    return `<option value="${f.index}"${f.index === state.planeIndex ? ' selected' : ''}>` +
           `${shape} vertex figure · ${f.count} equivalent</option>`;
  }).join('');
}

/** the key to the orbit colours: one swatch per distinct face count */
function renderLegend() {
  const host = $('#cellsLegend');
  if (!host) return;
  const entries = cells.legend();
  host.innerHTML = '<span class="legend-label">faces per orbit</span>' + entries.map(e =>
    `<span class="legend-item"><i style="background:${e.color}"></i>${e.count}</span>`).join('');
}

// ------------------------------------------------------------------ controls

function wireControls() {
  $('#pickPoly').onclick = () => {
    ensureCatalog();
    $('#catalogDialog').showModal();
    showFoot(state.current, state.current?.category);
    $('#search').focus();
    document.querySelector('.poly.active')?.scrollIntoView({ block: 'center' });
  };
  $('#catalogClose').onclick = () => $('#catalogDialog').close();

  $('#polySym').onchange = (e) => {
    state.polySym = e.target.value;
    const allowed = subgroupsOf(state.polySym);
    if (!allowed.includes(state.stellSym)) state.stellSym = state.polySym;
    syncSymmetrySelects();
    build();
  };
  $('#stellSym').onchange = (e) => { state.stellSym = e.target.value; build(); };
  $('#depth').oninput = (e) => setDepth(Number(e.target.value), false);
  $('#depth').onchange = () => build();
  $('#planeIndex').onchange = (e) => { state.planeIndex = Number(e.target.value) || 0; refresh(); };

  $('#selectCore').onclick = async () => {
    const { selected } = await call('applyPreset', { preset: 'base' });
    mark(); state.selected = new Set(selected); refresh();
  };
  $('#presetBase').onclick = async () => {
    const { selected } = await call('applyPreset', { preset: 'base' });
    mark(); state.selected = new Set(selected); refresh();
  };
  $('#presetGreatStella').onclick = async () => {
    // The named preset is one orbit under I. Under a small subgroup the same
    // twelve faces split into several orbits and no longer have that preset id,
    // so this shortcut deliberately restores the verified reference symmetry.
    await select(findItem('u28'), {
      polySym: 'Ih', stellSym: 'I', preset: 'great-stellated-dodecahedron',
    });
  };
  $('#selectNone').onclick = () => { mark(); state.selected = new Set(); refresh(); };
  $('#selectAll').onclick = async () => {
    const { selected } = await call('applyPreset', { preset: 'all' });
    mark(); state.selected = new Set(selected); refresh();
  };
  $('#growLayer').onclick = () => {
    if (!state.orbits.length) return;
    const current = state.mesh?.selectedOrbitIds?.[0] ?? -1;
    const next = (current + 1) % state.orbits.length;
    mark(); state.selected = new Set([`0.${next}.0`]); refresh();
  };
  $('#undoBtn').onclick = undo;
  $('#redoBtn').onclick = redo;

  /*
   * ctrl+Z everywhere, cmd+Z as well on macOS — both, rather than one per
   * platform, because a Mac keyboard has ctrl too and nobody is surprised when
   * it works. Ignored while typing in the cell string or the search box.
   */
  addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); redo(); }
  });

  $('#autoRotate').onchange = (e) => { if (renderer) renderer.autoRotate = e.target.checked; };
  $('#showEdges').onchange = (e) => { if (renderer) { renderer.showEdges = e.target.checked; renderer.draw(); } };
  $('#fitView').onclick = () => { renderer?.fit(); setStatus('rescaled to fit', false); };
  $('#homeView').onclick = () => { renderer?.home(); setStatus('canonical orientation', false); };

  for (const id of ['#showAxes', '#showMirrors', '#showImproper']) {
    const el = $(id);
    if (el) el.onchange = refreshElements;
  }

  installSplitters();

  $('#edgeWidth').oninput = (e) => {
    const w = Number(e.target.value);
    $('#edgeWidthLabel').textContent = w.toFixed(1);
    localStorage.setItem('edgeWidth', w);
    if (renderer) { renderer.edgeWidth = w; renderer.draw(); }
  };
  $('#showAllFacets').onchange = (e) => { diagram.showAll = e.target.checked; diagram.draw(); };

  $('#cellsString').onchange = async (e) => {
    try {
      const { selected } = await call('parseCells', { cells: e.target.value });
          state.selected = new Set(selected);
      refresh();
    } catch (err) { setStatus('could not read that facet-orbit selection: ' + err.message, false); }
  };

  $('#exportOff').onclick = () => download(`${name()}.off`, toOFF(state.mesh));
  $('#exportObj').onclick = () => download(`${name()}.obj`, toOBJ(state.mesh));
  $('#exportStl').onclick = () => download(`${name()}.stl`, toSTL(state.mesh, name()));
  $('#saveJson').onclick = () => {
    const docName = newDocumentName();
    download(`${docName}.json`, writePreset({
      name: docName,
      polyhedron: state.current.name, file: state.current.file,
      polySymmetry: state.polySym, stellSymmetry: state.stellSym,
      planeDepth: state.depth, facetOrbits: state.cellsString, dualFile: state.dualFile,
      diagramFace: state.planeIndex,
      showEdges: $('#showEdges').checked,
      showAllFacets: $('#showAllFacets').checked,
      spin: $('#autoRotate').checked,
      view: renderer?.getView() || null,
    }), 'application/json');
  };
  $('#exportStel').onclick = () => {
    const reciprocal = reciprocalStelSpec();
    if (!reciprocal) {
      setStatus('this facet-orbit selection has no exact reciprocal .stel description; save native JSON instead', false);
      return;
    }
    download(`${name()}-dual.stel`, writeStel(reciprocal));
  };
  $('#exportSvg').onclick = () => download(`${name()}-diagram.svg`, diagram.toSVG(), 'image/svg+xml');
  $('#exportPng').onclick = () => {
    const a = document.createElement('a');
    a.download = `${name()}.png`;
    a.href = renderer.snapshot();
    a.click();
  };

  $('#loadDoc').onchange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await openDocument(await file.text(), file.name);
    e.target.value = '';
  };

  $$('.sample').forEach(b => {
    b.onclick = async () => openDocument(await fetch(`samples/${b.dataset.file}`).then(r => r.text()), b.dataset.file);
  });

  $('#help').onclick = () => {
    const b = $('#buildStamp');
    if (b) b.textContent = BUILD;
    $('#helpDialog').showModal();
  };
  $('#helpClose').onclick = () => $('#helpDialog').close();

  $('#themeBtn').onclick = cycleTheme;

  const runSearch = () => {
    const q = $('#search').value.trim().toLowerCase();
    $$('.poly').forEach(b => {
      const hay = `${b.dataset.name} ${b.dataset.file} ${b.dataset.sym} ${b.dataset.cat}`.toLowerCase();
      b.style.display = (!q || hay.includes(q)) ? '' : 'none';
    });
    $$('.cat').forEach(sec => {
      const any = [...sec.querySelectorAll('.poly')].some(b => b.style.display !== 'none');
      sec.style.display = any ? '' : 'none';
    });
    updateCatCount();
    const first = $$('.poly').find(b => b.style.display !== 'none');
    if (q && first) {
      showFoot(findItem(first.dataset.file), first.dataset.cat);
    } else if (q && !first) {
      $('#footThumb').removeAttribute('src');
      $('#footName').textContent = 'nothing matches';
      $('#footMeta').textContent = `no solid named, filed or symmetric as “${$('#search').value.trim()}”`;
    }
  };
  $('#search').oninput = runSearch;
  $('#search').onkeydown = (e) => {
    if (e.key !== 'Enter') return;
    const first = $$('.poly').find(b => b.style.display !== 'none');
    first?.click();
  };

  $('#catalogDialog').addEventListener('close', () => { $('#search').value = ''; runSearch(); });
  $('#catalogDialog').addEventListener('cancel', () => { $('#search').value = ''; });
}

// ------------------------------------------------------------------ theme

function cycleTheme() {
  const order = ['auto', 'light', 'dark'];
  const cur = document.documentElement.dataset.themePref || 'auto';
  const next = order[(order.indexOf(cur) + 1) % order.length];
  localStorage.setItem('theme', next);
  applyTheme(next);
}

function applyTheme(pref) {
  const dark = pref === 'dark' || (pref === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.dataset.themePref = pref;
  $('#themeBtn').textContent = pref === 'auto' ? '◐' : pref === 'dark' ? '●' : '○';
  $('#themeBtn').title = `Theme: ${pref}`;
  if (renderer) {
    renderer.background = dark ? [0.055, 0.06, 0.078] : [0.965, 0.97, 0.977];
    renderer.draw();
  }
  cells?.draw();
  diagram?.draw();
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if ((document.documentElement.dataset.themePref || 'auto') === 'auto') applyTheme('auto');
});

// ------------------------------------------------------------------ misc

const name = () => `${state.current.file}-${state.polySym}-${state.stellSym}`;

function selectedPresetId() {
  const ids = state.mesh?.selectedOrbitIds || [];
  const same = p => p && p.orbitIds?.length === ids.length &&
    p.orbitIds.every(id => ids.includes(id));
  return [state.basePreset, ...state.presets].find(same)?.id || null;
}

/**
 * Native facet-orbit numbers are not reciprocal cell numbers. Only export a
 * legacy `.stel` when a known Kepler–Poinsot preset has an exact, verified dual
 * cell description; otherwise inventing a cell string would silently change
 * the solid on reopen.
 */
function reciprocalStelSpec() {
  const preset = selectedPresetId();
  const known = {
    'u28:dodecahedron': ['u27', '{0}'],
    'u28:great-stellated-dodecahedron': ['u27', '{0,1,2,3,4,5,6}'],
    'u27:icosahedron': ['u28', '{0}'],
    'u27:great-dodecahedron': ['u28', '{0,1}'],
    'u27:small-stellated-dodecahedron': ['u28', '{0,1,2}'],
    'u27:great-icosahedron': ['u28', '{0,1,2,3}'],
  };
  const pair = known[`${state.current?.file}:${preset}`];
  if (!pair) return null;
  const [helperFile, selection] = pair;
  return {
    polyhedron: findItem(helperFile)?.name || helperFile,
    polySymmetry: 'Ih',
    stellSymmetry: 'I',
    cells: selection,
  };
}

function presetForReciprocalStel(helperFile, cellsString) {
  const cells = String(cellsString || '').replace(/\s+/g, '');
  // A subcell expression such as 1(2[3]) is not a cumulative full-layer
  // selection and must never be flattened into a known regular preset.
  if (!/^\{\d+(?:,\d+)*\}$/.test(cells)) return null;
  const known = {
    'u27:{0}': 'dodecahedron',
    'u27:{0,1,2,3,4,5,6}': 'great-stellated-dodecahedron',
    'u28:{0}': 'icosahedron',
    'u28:{0,1}': 'great-dodecahedron',
    'u28:{0,1,2}': 'small-stellated-dodecahedron',
    'u28:{0,1,2,3}': 'great-icosahedron',
  };
  return known[`${helperFile}:${cells}`] || null;
}

/** open either our JSON preset or an original .stel file */
async function openDocument(text, filename = '') {
  let doc;
  try {
    doc = readDocument(text);
  } catch (err) {
    setStatus(`could not read ${filename || 'that file'}: ${err.message}`, false);
    return;
  }

  // Native JSON names the fixed-vertex base. Legacy JSON and .stel name the
  // stellation helper, so their honest faceting base is its polar dual.
  let item = doc.file ? findItem(doc.file) : null;
  if (!item && doc.polyhedron) {
    for (const cat of state.catalog)
      for (const it of cat.items)
        if (it.name.toLowerCase() === doc.polyhedron.toLowerCase()) item = { ...it, category: cat.category };
  }
  const legacyReciprocal = doc.source === 'stel' || (doc.source === 'json' && !doc.nativeFaceting);
  const reciprocalPreset = legacyReciprocal && item
    ? presetForReciprocalStel(item.file, doc.cells)
    : null;
  if (legacyReciprocal && item) {
    const baseFile = dualFile(item.file);
    item = findItem(baseFile) || (state.geometry[baseFile] ? {
      file: baseFile,
      name: `dual of ${item.name}`,
      symmetry: item.symmetry || doc.polySymmetry || 'Ih',
      category: 'reciprocal import',
    } : null);
  }
  if (!item) {
    setStatus(`${filename || 'that file'} names "${doc.polyhedron}", which is not in the catalog`, false);
    return;
  }

  state.planeIndex = doc.diagramFace || 0;
  $('#planeIndex').value = state.planeIndex;

  if (doc.source === 'json') {
    for (const [id, val] of [['#showEdges', doc.showEdges], ['#showAllFacets', doc.showAllFacets], ['#autoRotate', doc.spin]]) {
      $(id).checked = !!val;
      $(id).dispatchEvent(new Event('change'));
    }
  }

  await select(item, { polySym: doc.polySymmetry, stellSym: doc.stellSymmetry,
                       cells: legacyReciprocal ? null : doc.cells,
                       preset: legacyReciprocal ? (reciprocalPreset || 'base') : null,
                       depth: doc.planeDepth ?? undefined, view: doc.view });
  setStatus(legacyReciprocal
    ? reciprocalPreset
      ? `opened ${doc.name || filename} as the exact reciprocal ${reciprocalPreset.replaceAll('-', ' ')}`
      : `opened ${doc.name || filename} on its dual base; these legacy cells have no automatic facet-circuit map`
    : `opened ${doc.name || filename} (faceting JSON)`, false);
}

function download(filename, text, mime = 'text/plain') {
  const blob = new Blob([text], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function setStatus(text, busy, frac) {
  $('#status').textContent = text;
  $('#status').classList.toggle('busy', !!busy);
  const bar = $('#progress');
  bar.style.display = busy ? '' : 'none';
  bar.style.setProperty('--frac', frac == null ? 0 : frac);
}

function setBuildControlsDisabled(disabled) {
  for (const id of [
    '#presetBase', '#selectCore', '#growLayer', '#selectAll', '#selectNone',
    '#undoBtn', '#redoBtn', '#cellsString', '#saveJson', '#exportOff',
    '#exportObj', '#exportStl', '#exportStel', '#exportSvg', '#exportPng',
  ]) {
    const el = $(id);
    if (el) el.disabled = disabled ||
      (state.dualFile === null && ['#exportSvg', '#exportStel'].includes(id));
  }
  if ($('#cells')) $('#cells').style.pointerEvents = disabled ? 'none' : '';
}

applyTheme(localStorage.getItem('theme') || 'auto');
boot();
