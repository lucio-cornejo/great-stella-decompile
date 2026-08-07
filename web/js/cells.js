/*
 * The orbit panel. Its drawing and interaction started as a close port of the
 * Java "Cells" window (pvs.polyhedra.stellation.ui.Selection); in the faceting
 * port the same compact boxes primarily represent explicit facet orbits.
 *
 * An outline can still describe reciprocal construction layers, but the direct
 * engine supplies one labelled row whose boxes are symmetry orbits of closed
 * vertex circuits. Optional sub-boxes can represent split orbits.
 *
 * The coloured bars are the original's cleverest touch: every bar colour stands
 * for one particular number of congruent pieces, so cells that are the "same
 * kind of thing" read alike at a glance across the whole table.
 *
 * Mouse, as in the original:
 *   click              toggle this cell (a header toggles all its sub-cells)
 *   shift-click        add it AND everything holding it up
 *   ctrl / cmd-click   remove it and its supporting set
 *   click layer number act on the whole layer
 */

/* Geometry. The colour bar sits in its own lane at the foot of each box, with the
   digit centred in the space above it — in the original they shared the same few
   pixels and collided. */
const BOX_W    = 27;   // a cell box
const BOX_H    = 28;
const BAR_H    = 3;    // the colour bar
const BAR_INSET = 4;   // its margin from the box's left and right edges
const BAR_LIFT = 4;    // how far its top sits above the box's bottom edge
const GAP_X    = 3;    // between boxes
const GAP_Y    = 5;    // between rows
const LAYER_W  = 30;   // the layer-number column
const PAD      = 8;    // around the whole table
const GROUP_PAD = 4;   // inside a sub-cell group's container
const SUB_W    = 19;   // a sub-cell box: visibly smaller than its parent
const SUB_H    = 20;
/* The arrow and its part-count were too faint to find: «поярче сделать надписи
   и стрелочки … их просто почти не видно, этих стрелочек», with the note that
   more horizontal space was available for them. Widened, and drawn heavier. */
const TWISTY_W = 19;   // the expand/collapse arrow beside a group
const FONT = (px, weight = 600) =>
  `${weight} ${px}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;

import { ACTION } from './render3d.js';

export class CellsPanel {
  constructor(canvas, { onChange, onHover, onBeforeChange } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onChange = onChange;
    this.onHover = onHover;
    this.onBeforeChange = onBeforeChange;
    this.hoverAction = null;   // 'add' | 'remove' | null — see draw()

    this.outline = null;      // [layer][cell] = {index, subCells:[...], ...}
    this.selected = new Set();
    this.hit = [];            // hit rectangles in CSS pixels
    this.hover = null;
    this.scroll = 0;     // vertical
    this.scrollX = 0;    // horizontal — deep layers run wide
    /*
     * Sub-cell groups start collapsed.
     *
     * Under a low symmetry a single orbit can split into a hundred and twenty
     * sub-cells; expanded by default that is a row far wider than any sensible
     * panel, and it buries the layer structure the table exists to show. The
     * arrow beside a group opens it when you actually want the parts.
     */
    this.expanded = new Set();   // "layer.cell" for each opened group

    canvas.addEventListener('pointermove', (e) => {
      if (this._onDragMove && this._onDragMove(e)) return;
      this._lastMove = e;
      const h = this.hitTest(e);
      const m = modifiersOf(e);
      const act = m.shift ? 'add' : m.ctrl ? 'remove' : null;
      const same = (a, b) => a === b || (a && b && a.key === b.key && a.kind === b.kind);
      if (!same(h, this.hover) || act !== this.hoverAction) {
        this.hover = h;
        this.hoverAction = act;
        canvas.style.cursor = h ? 'pointer' : 'default';
        // a real hover tooltip, as the Java window has: hold still and the
        // details appear, so the boxes themselves can stay bare numbers
        canvas.title = h ? this.describe(h) : '';
        this.draw();
        this.onHover?.(h);
      }
    });
    canvas.addEventListener('pointerleave', () => {
      this._lastMove = null;
      if (this.hover) { this.hover = null; this.hoverAction = null; this.draw(); this.onHover?.(null); }
    });
    // Deep tables are wider and taller than the panel, so the canvas pans. A drag
    // must not toggle whatever it started on, so a click counts only if the
    // pointer barely moved.
    let down = null, moved = 0;
    const capture = (e, on) => {
      try { on ? canvas.setPointerCapture?.(e.pointerId) : canvas.releasePointerCapture?.(e.pointerId); }
      catch { /* nothing to capture */ }
    };
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button === 2) return;
      down = { x: e.clientX, y: e.clientY, sx: this.scrollX, sy: this.scroll };
      moved = 0;
      capture(e, true);
    });
    canvas.addEventListener('pointerup', (e) => {
      if (!down) return;
      const wasDrag = moved > 3;
      down = null;
      capture(e, false);
      if (wasDrag) return;
      const h = this.hitTest(e);
      if (h) this.apply(h, modifiersOf(e));
    });
    canvas.addEventListener('pointercancel', () => { down = null; });
    this._dragState = () => down;
    this._onDragMove = (e) => {
      if (!down) return false;
      const dx = e.clientX - down.x, dy = e.clientY - down.y;
      moved = Math.max(moved, Math.hypot(dx, dy));
      if (moved <= 3) return true;
      this.scrollX = down.sx - dx;
      this.scroll = down.sy - dy;
      this._clampScroll();
      canvas.style.cursor = 'grabbing';
      this.draw();
      return true;
    };
    // macOS turns ctrl-click into the secondary click, so the page is handed a
    // contextmenu event and never a ctrl-click. Take that event as "carve", the
    // same as a right-click, which is what a user reaching for ctrl meant.
    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const h = this.hitTest(e);
      if (h) this.apply(h, { shift: e.shiftKey, ctrl: !e.shiftKey });
    });
    canvas.addEventListener('wheel', (e) => {
      const overY = this.contentHeight - canvas.clientHeight;
      const overX = this.contentWidth - canvas.clientWidth;
      if (overY <= 0 && overX <= 0) return;
      e.preventDefault();
      if (e.shiftKey) this.scrollX += e.deltaY;
      else { this.scroll += e.deltaY; this.scrollX += e.deltaX; }
      this._clampScroll();
      this.draw();
    }, { passive: false });

    // holding or releasing a modifier changes what a click would do, and the
    // pointer has not moved to tell us — replay the last position with the new
    // keys, so the green never outlives the shift that produced it
    const replay = (e) => {
      if (!this._lastMove) return;
      const act = e.shiftKey ? 'add'
                : (e.ctrlKey || e.metaKey || e.altKey) ? 'remove' : null;
      if (act === this.hoverAction) return;
      this.hoverAction = act;
      this.draw();
    };
    addEventListener('keydown', replay);
    addEventListener('keyup', replay);
    addEventListener('blur', () => {
      if (this.hoverAction) { this.hoverAction = null; this.draw(); }
    });

    new ResizeObserver(() => this.draw()).observe(canvas);
  }

  /**
   * outline: [{layer, cells:[{index, primitives, facets, vertices, volume,
   *                           subCells:[{index, primitives, volume, bottom:[key]}]}]}]
   */
  setOutline(outline) {
    this.outline = outline;
    this.scroll = 0;
    this.palette = buildPalette(outline);
    this.byKey = new Map();
    for (const layer of outline)
      for (const cell of layer.cells)
        for (const sub of cell.subCells)
          this.byKey.set(`${layer.layer}.${cell.index}.${sub.index}`, { layer, cell, sub });
    this.draw();
    this.fit();
  }

  _clampScroll() {
    const c = this.canvas;
    this.scroll  = Math.min(Math.max(0, (this.contentHeight || 0) - c.clientHeight), Math.max(0, this.scroll));
    this.scrollX = Math.min(Math.max(0, (this.contentWidth  || 0) - c.clientWidth),  Math.max(0, this.scrollX));
  }

  /** shrink the frame to the table, up to a sensible ceiling, then scroll */
  fit() {
    const wrap = this.canvas.parentElement;
    if (!wrap || !this.contentHeight) return;
    wrap.style.height = Math.min(this.contentHeight + 6, 460) + 'px';
    this.draw();
  }

  setSelected(selected) { this.selected = selected; this.draw(); }

  /** what each bar colour means: one entry per distinct piece-count */
  legend() { return this.palette?.entries ?? []; }

  // ---------------------------------------------------------------- selection

  /** every sub-cell key holding `key` up, transitively (the graph came from the worker) */
  supportKeys(key) {
    return this._closure(key, 'bottom');
  }

  /** everything resting on `key`, transitively */
  dependentKeys(key) {
    return this._closure(key, 'top');
  }

  _closure(key, dir) {
    const out = new Set([key]);
    const stack = [key];
    while (stack.length) {
      const k = stack.pop();
      for (const n of (this.byKey.get(k)?.sub[dir] || [])) {
        if (!out.has(n)) { out.add(n); stack.push(n); }
      }
    }
    return out;
  }

  apply(hit, mod) {
    // the arrow beside a group opens and closes it; it selects nothing
    if (hit.kind === 'twisty') {
      const id = `${hit.layer.layer}.${hit.cell.index}`;
      this.expanded.has(id) ? this.expanded.delete(id) : this.expanded.add(id);
      this._clampScroll();
      this.draw();
      return;
    }

    this.onBeforeChange?.();                     // bank the selection for undo

    const sel = this.selected;
    const keys = hit.keys;                       // the sub-cells this hit covers

    if (mod.shift || mod.ctrl) {
      /*
       * Both gestures walk the same way — inward, to the cells holding this one
       * up — so that ctrl undoes a shift exactly. Reaching outward for the
       * carve reads as the natural opposite, but then the pair does not cancel:
       * what disappears depends on what was already standing above.
       */
      const all = new Set();
      for (const k of keys) for (const s of this.supportKeys(k)) all.add(s);
      for (const k of all) mod.shift ? sel.add(k) : sel.delete(k);
    } else {
      const anyOff = keys.some(k => !sel.has(k));
      for (const k of keys) anyOff ? sel.add(k) : sel.delete(k);
    }
    this.onChange?.(sel);
  }

  // ---------------------------------------------------------------- layout

  /** walk the table, calling back with the rect for every drawable box */
  _walk(cb) {
    if (!this.outline) return;
    const rowH = BOX_H + GAP_Y;
    let widest = 0;
    let y = PAD - this.scroll;
    const x0 = PAD - this.scrollX;

    // Bottom-up: the core is the ground floor and each shell is built on top of
    // the one below, which is how the solid actually grows and how the support
    // relation reads. Row numbers are unchanged — only the order is reversed.
    for (const layer of [...this.outline].reverse()) {
      let x = x0;
      cb({ kind: 'layer', layer, x, y, w: LAYER_W, h: BOX_H });
      x += LAYER_W + GAP_X * 2;

      for (const cell of layer.cells) {
        const n = cell.subCells.length;
        if (n > 1) {
          const open = this.expanded.has(`${layer.layer}.${cell.index}`);
          const inner = open
            ? BOX_W + TWISTY_W + n * (SUB_W + GAP_X)
            : BOX_W + TWISTY_W;
          cb({ kind: 'group', layer, cell, x: x - GROUP_PAD, y: y - GROUP_PAD,
               w: inner + 2 * GROUP_PAD, h: BOX_H + 2 * GROUP_PAD });
          cb({ kind: 'header', layer, cell, x, y, w: BOX_W, h: BOX_H });
          cb({ kind: 'twisty', layer, cell, open, n,
               x: x + BOX_W, y, w: TWISTY_W, h: BOX_H });
          if (open) {
            let sx = x + BOX_W + TWISTY_W;
            for (const sub of cell.subCells) {
              cb({ kind: 'sub', layer, cell, sub,
                   x: sx, y: y + (BOX_H - SUB_H) / 2, w: SUB_W, h: SUB_H });
              sx += SUB_W + GAP_X;
            }
          }
          x += inner + GAP_X + 2 * GROUP_PAD;
        } else {
          cb({ kind: 'cell', layer, cell, sub: cell.subCells[0], x, y, w: BOX_W, h: BOX_H });
          x += BOX_W + GAP_X;
        }
      }
      y += rowH;
      widest = Math.max(widest, x + this.scrollX);
    }
    this.contentHeight = y + this.scroll - GAP_Y + PAD;
    this.contentWidth = widest;
  }

  hitTest(e) {
    const r = this.canvas.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    let found = null;
    this._walk((b) => {
      if (b.kind === 'group') return;
      if (px < b.x || px > b.x + b.w || py < b.y || py > b.y + b.h) return;
      found = this._toHit(b);
    });
    return found;
  }

  _toHit(b) {
    const L = b.layer.layer;
    if (b.kind === 'twisty') {
      // the open state is part of the key so the tooltip refreshes on toggle
      return { kind: 'twisty', key: `T${L}.${b.cell.index}.${b.open ? 1 : 0}`, keys: [],
               layer: b.layer, cell: b.cell, open: b.open, n: b.n };
    }
    if (b.kind === 'layer') {
      const keys = [];
      for (const c of b.layer.cells) for (const s of c.subCells) keys.push(`${L}.${c.index}.${s.index}`);
      return { kind: 'layer', key: `L${L}`, keys, layer: b.layer };
    }
    if (b.kind === 'header') {
      const keys = b.cell.subCells.map(s => `${L}.${b.cell.index}.${s.index}`);
      return { kind: 'header', key: `${L}.${b.cell.index}`, keys, layer: b.layer, cell: b.cell };
    }
    const key = `${L}.${b.cell.index}.${b.sub.index}`;
    return { kind: b.kind, key, keys: [key], layer: b.layer, cell: b.cell, sub: b.sub };
  }

  // ---------------------------------------------------------------- painting

  draw() {
    const ctx = this.ctx;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w; this.canvas.height = h;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const S = themeColors();
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = S.bg;
    ctx.fillRect(0, 0, w / dpr, h / dpr);
    if (!this.outline) return;

    const sel = this.selected;
    const hoverKey = this.hover?.key;

    this._walk((b) => {
      const L = b.layer.layer;

      // ---- the layer number: a plain figure with an accent rule when the row is in play
      if (b.kind === 'layer') {
        // an empty layer (the depth limit cut it off) must not read as "all on":
        // `every` over nothing is true, which would light the whole row up
        const any = b.layer.cells.length > 0;
        const on = any && b.layer.cells.every(c => c.subCells.every(s => sel.has(`${L}.${c.index}.${s.index}`)));
        const some = any && b.layer.cells.some(c => c.subCells.some(s => sel.has(`${L}.${c.index}.${s.index}`)));

        if (hoverKey === `L${L}`) {
          const act = ACTION[this.hoverAction];
          roundRect(ctx, b.x, b.y, b.w, b.h, 7);
          ctx.fillStyle = act
            ? `rgba(${act.rgb.map(v => Math.round(v * 255)).join(',')},0.26)`
            : S.rowHover;
          ctx.fill();
        }
        ctx.fillStyle = on ? S.accent : some ? S.accentSoft : S.line;
        roundRect(ctx, b.x, b.y + 4, 2.5, b.h - 8, 1.5);
        ctx.fill();

        ctx.fillStyle = !any ? S.faint : on ? S.accent : S.text;
        ctx.font = FONT(14, on ? 700 : 550);
        ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText(String(b.layer.label ?? L), b.x + b.w - 6, b.y + b.h / 2);
        if (!any) {
          ctx.fillStyle = S.faint;
          ctx.font = FONT(10.5, 400);
          ctx.textAlign = 'left';
          ctx.fillText('beyond the build depth', b.x + b.w + GAP_X * 2, b.y + b.h / 2);
        }
        return;
      }

      // ---- the container behind a header and its sub-cells
      if (b.kind === 'group') {
        roundRect(ctx, b.x, b.y, b.w, b.h, 9);
        ctx.fillStyle = S.groupFill; ctx.fill();
        ctx.strokeStyle = S.groupLine; ctx.lineWidth = 1; ctx.stroke();
        return;
      }

      /*
       * ---- the expand/collapse arrow for a group of sub-cells
       *
       * The two states are opposite directions along one axis, not two
       * different axes: ▸ opens the group to the right, ◂ closes it back up
       * again. A downward arrow for "close" made the pair read as unrelated —
       * «она здесь расширить, она туда делает, а сузить это какой-то вниз. По
       * идее нужна просто обратно стрелочка».
       */
      if (b.kind === 'twisty') {
        const hov = hoverKey === `T${L}.${b.cell.index}.${b.open ? 1 : 0}`;
        ctx.strokeStyle = hov ? S.accent : S.arrow;
        ctx.lineWidth = 2.3;
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        const cx = b.x + b.w / 2, r = 4.2;
        const cy = b.y + b.h / 2 - (b.open ? 0 : 4);   // room for the count below
        const d = b.open ? -1 : 1;                     // ◂ closes, ▸ opens
        ctx.beginPath();
        ctx.moveTo(cx - r * 0.6 * d, cy - r);
        ctx.lineTo(cx + r * 0.7 * d, cy);
        ctx.lineTo(cx - r * 0.6 * d, cy + r);
        ctx.stroke();
        if (!b.open) {                    // how many parts are hidden in there
          ctx.fillStyle = hov ? S.accent : S.arrow;
          ctx.font = FONT(11, 700);
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText(String(b.n), cx, cy + r + 7);
        }
        return;
      }

      const isHeader = b.kind === 'header';
      const key = isHeader ? null : `${L}.${b.cell.index}.${b.sub.index}`;
      const hovered = hoverKey === (isHeader ? `${L}.${b.cell.index}` : key);
      // a header reads as "on" when all of its sub-cells are
      const on = isHeader
        ? b.cell.subCells.every(s => sel.has(`${L}.${b.cell.index}.${s.index}`))
        : sel.has(key);
      const part = isHeader && !on && b.cell.subCells.some(s => sel.has(`${L}.${b.cell.index}.${s.index}`));

      // box. A hovered box is outlined in the colour of what a click would do:
      // green to add, red to carve, the accent when a bare click just toggles.
      const act = hovered ? ACTION[this.hoverAction] : null;
      roundRect(ctx, b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1, 7);
      ctx.fillStyle = on ? S.accent : part ? S.accentFaint : S.boxFill;
      ctx.fill();
      if (act) {
        const rgb = act.rgb.map(v => Math.round(v * 255)).join(',');
        ctx.fillStyle = `rgba(${rgb},0.30)`;
        ctx.fill();
        ctx.strokeStyle = `rgb(${rgb})`;
      } else {
        ctx.strokeStyle = hovered || on ? S.accent : S.boxLine;
      }
      ctx.lineWidth = hovered ? 2 : 1;
      ctx.stroke();

      // the colour bar, in its own lane at the foot of the box — never under the digit
      const count = isHeader ? b.cell.primitives : b.sub.primitives;
      roundRect(ctx, b.x + BAR_INSET, b.y + b.h - BAR_LIFT - BAR_H,
                b.w - 2 * BAR_INSET, BAR_H, BAR_H / 2);
      ctx.fillStyle = this.palette(count);
      ctx.globalAlpha = on ? 1 : 0.9;
      ctx.fill();
      ctx.globalAlpha = 1;

      // the digit, centred in the space above the bar
      // A one-part orbit is the cell itself, so show its orbit number. Only an
      // expanded multi-part group labels the smaller boxes by sub-orbit index.
      const label = String(isHeader || b.kind === 'cell' ? b.cell.index : b.sub.index);
      ctx.fillStyle = on ? S.onText : S.text;
      ctx.font = FONT(isHeader || b.kind === 'cell' ? 14 : 12, isHeader || b.kind === 'cell' ? 640 : 480);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(label, b.x + b.w / 2, b.y + (b.h - BAR_LIFT - BAR_H) / 2 + 1);
    });
  }

  /** the info line the original shows while hovering */
  describe(hit) {
    if (!hit) return '';
    if (hit.kind === 'layer') {
      if (hit.layer.kind === 'facet-orbits') {
        return `${hit.layer.cells.length} facet orbit${hit.layer.cells.length === 1 ? '' : 's'} · click the row to toggle all`;
      }
      const n = hit.layer.cells.reduce((a, c) => a + c.subCells.length, 0);
      const v = hit.layer.cells.reduce((a, c) => a + c.volume, 0);
      return `layer ${hit.layer.layer} · ${hit.layer.cells.length} cells, ${n} selectable · volume ${v.toFixed(5)}`;
    }
    const L = hit.layer.layer, c = hit.cell;
    if (hit.layer.kind === 'facet-orbits') {
      const shape = c.step > 1 ? `{${c.sides}/${c.step}} star circuit` : `${c.sides}-vertex circuit`;
      const status = c.manifold ? 'tidy manifold' : c.closed ? 'closed, non-manifold' : 'open / non-tidy';
      return `${c.label || `orbit ${c.index}`} · ${c.faceCount ?? c.primitives} faces · ${shape} · ${status}`;
    }
    if (hit.kind === 'twisty') {
      return hit.open
        ? `${L}(${c.index}) · click to collapse its ${hit.n} sub-cells`
        : `${L}(${c.index}) · ${hit.n} sub-cells hidden — click to expand`;
    }
    if (hit.kind === 'header') {
      return `${L}(${c.index}) · ${c.subCells.length} sub-cells · ${c.primitives} elem. cells ` +
             `[${c.facets}, ${c.vertices}, ${c.volume.toFixed(5)}]`;
    }
    const s = hit.sub;
    const name = c.subCells.length > 1 ? `${L}(${c.index}[${s.index}])` : `${L}(${c.index})`;
    return `${name} · ${s.primitives} elem. cells [${c.facets}, ${c.vertices}, ${s.volume.toFixed(5)}]`;
  }
}

/**
 * "Carve" has to be reachable on every platform. ctrl is the obvious key but on
 * macOS it is the secondary-click gesture and never arrives, so alt/option and
 * cmd both mean the same thing, and a right-click does too (see the contextmenu
 * handlers). shift always wins, so shift-alt is still "add".
 */
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h);
}

function modifiersOf(e) {
  const shift = e.shiftKey;
  return { shift, ctrl: !shift && (e.ctrlKey || e.metaKey || e.altKey), alt: e.altKey };
}

/**
 * One hue per distinct "number of congruent pieces", spread around the wheel in
 * increasing order — Selection.makeColors, which used HSB(hue, 0.8, 0.9).
 */
function buildPalette(outline) {
  const counts = new Set();
  for (const layer of outline)
    for (const cell of layer.cells) {
      counts.add(cell.primitives);
      for (const s of cell.subCells) counts.add(s.primitives);
    }
  const sorted = [...counts].sort((a, b) => a - b);
  const map = new Map();
  // spread the hues but keep them all at a readable weight, and skip the muddy
  // yellow-green band that the original's raw HSB sweep lands in
  sorted.forEach((c, i) => {
    const t = sorted.length > 1 ? i / (sorted.length - 1) : 0;
    map.set(c, hsb((0.02 + 0.86 * t) % 1, 0.72, 0.86));
  });
  const fn = (n) => map.get(n) || '#8b93a7';
  fn.entries = sorted.map(c => ({ count: c, color: map.get(c) }));
  return fn;
}

function hsb(h, s, v) {
  const i = Math.floor(h * 6), f = h * 6 - i;
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  let r, g, b;
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    default: r = v; g = p; b = q;
  }
  return `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
}

function themeColors() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n, fallback) => (cs.getPropertyValue(n).trim() || fallback);
  const dark = document.documentElement.dataset.theme !== 'light';
  const accent = v('--accent', dark ? '#f5b942' : '#c8860a');
  return {
    bg: v('--panel', dark ? '#12151c' : '#fff'),
    text: v('--text', dark ? '#e6e9f0' : '#14181f'),
    faint: dark ? 'rgba(230,233,240,0.34)' : 'rgba(20,24,31,0.34)',
    line: v('--line', dark ? '#242a36' : '#d9dee7'),
    accent,
    accentSoft: dark ? 'rgba(245,185,66,0.45)' : 'rgba(200,134,10,0.45)',
    accentFaint: dark ? 'rgba(245,185,66,0.17)' : 'rgba(200,134,10,0.15)',
    onText: dark ? '#14100a' : '#fffaf0',
    boxFill: dark ? 'rgba(255,255,255,0.035)' : 'rgba(20,30,60,0.028)',
    boxLine: dark ? 'rgba(200,212,235,0.20)' : 'rgba(40,55,85,0.20)',
    groupFill: dark ? 'rgba(111,168,255,0.09)' : 'rgba(37,99,201,0.06)',
    groupLine: dark ? 'rgba(111,168,255,0.28)' : 'rgba(37,99,201,0.22)',
    // the arrow and its count carry the same weight as the box numbers now;
    // at the old group-line opacity they simply were not findable
    arrow: dark ? 'rgba(150,192,255,0.85)' : 'rgba(30,80,170,0.80)',
    rowHover: dark ? 'rgba(255,255,255,0.05)' : 'rgba(20,30,60,0.045)',
  };
}
