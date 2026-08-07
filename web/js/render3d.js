/*
 * A small self-contained WebGL renderer for faceted polyhedra.
 *
 * Deliberately dependency-free: the shapes are flat-shaded polygon soups, which
 * needs far less than a general 3D engine, and a static page with no build step
 * loads instantly.
 *
 * Faces are given per-face flat normals and a per-face colour keyed to the
 * facet orbit, so you can read the construction by eye.
 */

const VERT = `#version 300 es
precision highp float;
in vec3 aPos;
in vec3 aNormal;
in vec3 aColor;
uniform mat4 uProj;
uniform mat4 uView;
out vec3 vNormal;
out vec3 vColor;
out vec3 vEye;
void main() {
  vec4 p = uView * vec4(aPos, 1.0);
  vEye = p.xyz;
  vNormal = mat3(uView) * aNormal;
  vColor = aColor;
  gl_Position = uProj * p;
}`;

const FRAG = `#version 300 es
precision highp float;
in vec3 vNormal;
in vec3 vColor;
in vec3 vEye;
uniform float uEdgeDark;
uniform float uAlpha;      // 1 for solids; mirror-plane discs draw translucent
out vec4 fragColor;
void main() {
  vec3 n = normalize(vNormal);
  // two-sided: faceting shells can be open and must read from both sides
  if (!gl_FrontFacing) n = -n;
  vec3 L1 = normalize(vec3(-0.35, 0.55, 0.9));
  vec3 L2 = normalize(vec3(0.6, -0.3, 0.4));
  float d = max(dot(n, L1), 0.0) * 0.85 + max(dot(n, L2), 0.0) * 0.25;
  vec3 V = normalize(-vEye);
  vec3 H = normalize(L1 + V);
  float spec = pow(max(dot(n, H), 0.0), 48.0) * 0.35;
  vec3 c = vColor * (0.34 + d) + spec;   // keep shadowed faces light enough that black edges still read
  // slight rim to separate touching facets
  float rim = pow(1.0 - max(dot(n, V), 0.0), 3.0) * 0.12;
  fragColor = vec4(c + rim, uAlpha);
}`;

/*
 * Edges are drawn as screen-space quads, not GL_LINES.
 *
 * gl.lineWidth() is a lie on essentially every desktop GL implementation: the
 * core profile only has to support a width of 1.0, and ANGLE clamps it there,
 * so asking for thicker lines silently changes nothing. The fix is to expand
 * each edge into a quad in clip space, offsetting the corners along the screen
 * normal of the segment, which gives real, controllable thickness everywhere.
 */
const LINE_VERT = `#version 300 es
precision highp float;
in vec3 aA;          // segment start, model space
in vec3 aB;          // segment end
in float aSide;      // -1 / +1, which side of the segment this corner sits on
in float aEnd;       // 0 at A, 1 at B
uniform mat4 uProj;
uniform mat4 uView;
uniform vec2 uViewport;
uniform float uWidth;   // half-width, device pixels
void main() {
  vec4 ca = uProj * uView * vec4(aA, 1.0);
  vec4 cb = uProj * uView * vec4(aB, 1.0);
  vec2 sa = ca.xy / max(ca.w, 1e-6) * uViewport;
  vec2 sb = cb.xy / max(cb.w, 1e-6) * uViewport;
  vec2 dir = sb - sa;
  dir = length(dir) < 1e-6 ? vec2(1.0, 0.0) : normalize(dir);
  vec2 nrm = vec2(-dir.y, dir.x) * aSide * uWidth / uViewport;
  vec4 c = mix(ca, cb, aEnd);
  c.xy += nrm * c.w;
  gl_Position = c;
}`;

const LINE_FRAG = `#version 300 es
precision highp float;
uniform vec4 uColor;
out vec4 fragColor;
void main() { fragColor = uColor; }`;

// layer palette — warm at the core, cool further out
export const LAYER_COLORS = [
  [0.98, 0.76, 0.32], [0.95, 0.55, 0.30], [0.88, 0.38, 0.38],
  [0.78, 0.35, 0.55], [0.58, 0.40, 0.72], [0.38, 0.50, 0.80],
  [0.30, 0.65, 0.78], [0.32, 0.72, 0.62], [0.45, 0.75, 0.45],
  [0.68, 0.75, 0.35], [0.85, 0.70, 0.35], [0.70, 0.55, 0.45],
];
export const layerColor = i => LAYER_COLORS[i % LAYER_COLORS.length];

/*
 * One palette for the two gestures, shared by all three views.
 *
 * "Shift и Control … может быть, нужно тогда Control сделать разного цвета —
 * зеленое и красное, наверное, как бы более натуральное." Adding is green,
 * carving is red, and the same two colours mean the same two things whether you
 * are pointing at the solid, the diagram or a box in the Cells table.
 *
 * `off` is what a modifier gets when the gesture cannot do anything from here —
 * nothing left to add, or nothing behind the face to remove. Dimming rather
 * than hiding still tells you where you are pointing, but says the click is
 * going to be a no-op before you spend it.
 */
export const ACTION = {
  add:    { rgb: [0.29, 0.80, 0.44], css: '#4acb70', off: 'rgba(74,203,112,0.30)' },
  remove: { rgb: [0.94, 0.33, 0.33], css: '#f05454', off: 'rgba(240,84,84,0.30)' },
  none:   { rgb: [1.00, 0.93, 0.30], css: '#ffee4d', off: 'rgba(255,238,77,0.30)' },
};

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    throw new Error('shader: ' + gl.getShaderInfoLog(s));
  }
  return s;
}

function program(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error('link: ' + gl.getProgramInfoLog(p));
  }
  return p;
}

export class Renderer3D {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = this.gl = canvas.getContext('webgl2', { antialias: true, alpha: false });
    if (!gl) throw new Error('WebGL2 is not available in this browser');

    this.prog = program(gl, VERT, FRAG);
    this.lineProg = program(gl, LINE_VERT, LINE_FRAG);

    this.vao = gl.createVertexArray();
    this.posBuf = gl.createBuffer();
    this.normBuf = gl.createBuffer();
    this.colBuf = gl.createBuffer();
    this.count = 0;

    this.lineVao = gl.createVertexArray();
    this.lineBufs = { a: gl.createBuffer(), b: gl.createBuffer(), side: gl.createBuffer(), end: gl.createBuffer() };
    this.lineCount = 0;
    this.edgeWidth = 1.0;   // CSS pixels of total line width, scaled by dpr at draw

    this.modelScale = 0;   // sticky; see setMesh() and fit()
    this.rotation = quatFromEuler(-0.42, 0.6, 0);
    this.distance = 1.0;   // relative zoom; the fit distance is computed per frame
    this.autoRotate = true;
    this.showEdges = true;
    this.elements = null;      // symmetry axes / mirrors / Sn axes, see setElements
    this.elemCount = 0;
    this.discCount = 0;
    this.background = [0.055, 0.06, 0.078];
    this.edgeColor = [0.0, 0.0, 0.0, 1.0];

    this._installControls();
    this._raf = null;
    this.resize();
    new ResizeObserver(() => this.resize()).observe(canvas);
  }

  /**
   * The symmetry elements of the current group, as solid geometry.
   *
   *   elements.axes    [{dir}]  proper rotation axes      → teal tubes
   *   elements.improper[{dir}]  rotoreflection (Sn) axes  → violet tubes
   *   elements.mirrors [{dir}]  mirror-plane normals      → translucent discs
   *
   * Everything is depth-tested against the solid, so an element behind a cell is
   * hidden by it and you can read which way it actually runs.
   */
  setElements(elements) {
    this.elements = elements || null;
    this._buildElements();
    this.draw();
  }

  _buildElements() {
    const gl = this.gl;
    const el = this.elements;
    const tubes = { pos: [], norm: [], col: [] };
    const discs = { pos: [], norm: [], col: [] };
    if (el) {
      // reach a little past whatever is currently on screen
      const R = Math.max(1e-3, (this.lastMaxR || 1) * (this.modelScale || 1));
      const ext = R * 1.18;
      const rad = R * 0.014;
      for (const a of (el.axes || [])) tube(tubes, a.dir, ext, rad, [0.25, 0.72, 0.95]);
      for (const a of (el.improper || [])) tube(tubes, a.dir, ext * 0.94, rad * 0.9, [0.72, 0.45, 0.95]);
      /*
       * A mirror plane is a *disc*, which is what Vladimir asked for — but I_h
       * has fifteen of them, and fifteen translucent discs compound into an
       * opaque ball that hides the solid they are supposed to explain. So each
       * plane gets a solid rim, which is what actually tells you where it lies,
       * and only the faintest wash inside it. The rims go in the opaque buffer
       * so the solid occludes them like everything else; edge-on a flat annulus
       * collapses to a line, which is exactly right.
       */
      for (const m of (el.mirrors || [])) {
        ring(tubes, m.dir, ext * 0.92, ext * 0.016, [0.42, 0.90, 0.80]);
        disc(discs, m.dir, ext * 0.92, [0.42, 0.88, 0.80]);
      }
    }
    const put = (which, data, count) => {
      if (!this[which + 'Vao']) {
        this[which + 'Vao'] = gl.createVertexArray();
        this[which + 'Bufs'] = { p: gl.createBuffer(), n: gl.createBuffer(), c: gl.createBuffer() };
      }
      const b = this[which + 'Bufs'];
      gl.bindVertexArray(this[which + 'Vao']);
      for (const [buf, arr, name] of [[b.p, data.pos, 'aPos'], [b.n, data.norm, 'aNormal'], [b.c, data.col, 'aColor']]) {
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(arr), gl.STATIC_DRAW);
        const l = gl.getAttribLocation(this.prog, name);
        if (l >= 0) { gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, 3, gl.FLOAT, false, 0, 0); }
      }
      this[count] = data.pos.length / 3;
    };
    put('elem', tubes, 'elemCount');
    put('disc', discs, 'discCount');
    gl.bindVertexArray(null);
  }

  /**
   * Canonical orientation: x to the right, y up, z toward the viewer — the
   * frame the symmetry groups' matrices are written in, so a subgroup's axes
   * point where the group says they do.
   */
  home() {
    this._ease({ rotation: [0, 0, 0, 1], distance: 1.0 });
  }

  /*
   * Ease `distance` (and optionally the orientation) to a target.
   *
   * Snapping is disorienting: the solid you were looking at is replaced by a
   * differently-sized one and you have to find your place again. Vladimir asked
   * for this from the start — "кнопочка fit, которая медленно уменьшает".
   * Any drag, wheel or second press cancels it, so the animation never fights
   * the pointer.
   */
  _ease(target, ms = 420) {
    if (this._anim) cancelAnimationFrame(this._anim);
    if (this._pending) { this._pending.x = 0; this._pending.y = 0; }   // don't fight a glide
    const d0 = this.distance;
    const q0 = this.rotation.slice();
    const q1 = target.rotation;
    const d1 = target.distance ?? d0;
    const t0 = performance.now();
    const step = (now) => {
      const u = Math.min(1, (now - t0) / ms);
      const k = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;   // easeInOutCubic
      this.distance = d0 + (d1 - d0) * k;
      if (q1) this.rotation = slerp(q0, q1, k);
      this.draw();
      if (u < 1) this._anim = requestAnimationFrame(step);
      else this._anim = null;
    };
    this._anim = requestAnimationFrame(step);
  }

  /** stop any easing — called when the pointer takes over */
  cancelEase() { if (this._anim) { cancelAnimationFrame(this._anim); this._anim = null; } }

  /** ease the zoom until the whole selection is framed */
  fit() {
    if (!this.mesh) return;
    // screen size goes as R / (distance * fit), so distance = R frames it
    const R = Math.max(1e-6, (this.lastMaxR || 1) * (this.modelScale || 1));
    this._ease({ distance: Math.min(40, Math.max(0.05, R)) });
  }

  /** forget the scale so the next mesh sets it — used when the solid changes */
  resetScale() { this.modelScale = 0; }

  /*
   * The view as five numbers, so it can be put in a URL and in a saved document
   * — «хорошо, чтобы можно было человеку послать … тогда это просто должна быть
   * частью JSON файла: ориентация, zoom и еще что там». Four decimals is well
   * inside what the eye can tell apart and keeps the hash short.
   */
  getView() {
    return [...this.rotation, this.distance].map(v => Math.round(v * 1e4) / 1e4);
  }

  setView(v) {
    if (!Array.isArray(v) || v.length < 5 || v.some(x => !Number.isFinite(x))) return false;
    const n = Math.hypot(v[0], v[1], v[2], v[3]);
    if (!(n > 1e-6)) return false;
    this.rotation = [v[0] / n, v[1] / n, v[2] / n, v[3] / n];
    this.distance = Math.min(40, Math.max(0.05, v[4]));
    if (this._pending) { this._pending.x = 0; this._pending.y = 0; }
    this.draw();
    return true;
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w; this.canvas.height = h;
    }
    this.draw();
  }

  /** upload a mesh: {vertices:[{x,y,z}], faces:[[i,...]]} plus an orbit per face */
  setMesh(mesh, faceLayers) {
    const gl = this.gl;
    const pos = [], norm = [], col = [], lines = [];
    this.pickTris = [];      // {a,b,c, face} in model space, for ray picking
    this.mesh = mesh;
    this.lastFaceLayers = faceLayers;
    const seenEdges = new Set();

    /*
     * The model scale is sticky.
     *
     * Renormalising to the current mesh on every change means adding one shell
     * shrinks everything already on screen, so the solid you are working on
     * jumps about while you build it and the core never stays put. Instead the
     * scale is fixed when the arrangement is built and left alone; `fit()`
     * rescales on demand.
     */
    let maxR = 1e-9;
    for (const v of mesh.vertices) maxR = Math.max(maxR, Math.hypot(v.x, v.y, v.z));
    this.lastMaxR = maxR;
    if (!this.modelScale) this.modelScale = 1 / maxR;
    const s = this.modelScale;

    mesh.faces.forEach((face, fi) => {
      const c = layerColor(faceLayers ? faceLayers[fi] : 0);
      const p = face.map(i => mesh.vertices[i]);
      // flat normal from the first non-degenerate corner
      let nx = 0, ny = 0, nz = 0;
      for (let i = 0; i < p.length; i++) {
        const a = p[i], b = p[(i + 1) % p.length];
        nx += (a.y - b.y) * (a.z + b.z);
        ny += (a.z - b.z) * (a.x + b.x);
        nz += (a.x - b.x) * (a.y + b.y);
      }
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;

      /*
       * A fan from p[0] is valid for an ordinary convex polygon, but it is not
       * a triangulation of a self-intersecting {n/k} circuit.  Direct faceting
       * marks those faces with either a numeric step (> 1) or a star flag.  In
       * that case a render-only centre lets every triangle follow one abstract
       * circuit edge.  The source vertex table remains untouched, outlines
       * still use the actual star edges, and the same triangles carry the
       * original face id into CPU picking.
       */
      const step = Number(mesh.faceSteps?.[fi] ?? 1);
      const starMark = mesh.faceStars instanceof Set
        ? mesh.faceStars.has(fi)
        : Array.isArray(mesh.faceStars)
          ? (mesh.faceStars.length === mesh.faces.length
              ? Boolean(mesh.faceStars[fi])
              : mesh.faceStars.includes(fi))
          : Boolean(mesh.faceStars?.[fi]);
      const isStar = step > 1 || starMark;
      const triangles = [];
      if (isStar && p.length >= 3) {
        const centre = p.reduce((q, v) => ({
          x: q.x + v.x,
          y: q.y + v.y,
          z: q.z + v.z,
        }), { x: 0, y: 0, z: 0 });
        centre.x /= p.length;
        centre.y /= p.length;
        centre.z /= p.length;
        for (let i = 0; i < p.length; i++)
          triangles.push([centre, p[i], p[(i + 1) % p.length]]);
      } else {
        for (let i = 1; i < p.length - 1; i++)
          triangles.push([p[0], p[i], p[i + 1]]);
      }

      for (const tri of triangles) {
        for (const v of tri) {
          pos.push(v.x * s, v.y * s, v.z * s);
          norm.push(nx, ny, nz);
          col.push(c[0], c[1], c[2]);
        }
        this.pickTris.push({
          a: [tri[0].x * s, tri[0].y * s, tri[0].z * s],
          b: [tri[1].x * s, tri[1].y * s, tri[1].z * s],
          c: [tri[2].x * s, tri[2].y * s, tri[2].z * s],
          face: fi,
        });
      }
      for (let i = 0; i < p.length; i++) {
        const ia = face[i], ib = face[(i + 1) % face.length];
        const key = ia < ib ? `${ia}_${ib}` : `${ib}_${ia}`;
        if (seenEdges.has(key)) continue;      // interior edges are shared by two faces
        seenEdges.add(key);
        const a = p[i], b = p[(i + 1) % p.length];
        lines.push([a.x * s, a.y * s, a.z * s], [b.x * s, b.y * s, b.z * s]);
      }
    });

    const upload = (vao, buf, loc, data, size, prog) => {
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
      const l = gl.getAttribLocation(prog, loc);
      if (l >= 0) { gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, size, gl.FLOAT, false, 0, 0); }
    };

    upload(this.vao, this.posBuf, 'aPos', pos, 3, this.prog);
    upload(this.vao, this.normBuf, 'aNormal', norm, 3, this.prog);
    upload(this.vao, this.colBuf, 'aColor', col, 3, this.prog);
    this.count = pos.length / 3;

    this.lineCount = this._uploadSegments(this.lineVao, this.lineBufs, lines);

    gl.bindVertexArray(null);
    // the elements are sized to the arrangement, so they follow it as it grows
    if (this.elements) this._buildElements();
    this.draw();
  }

  /** expand [[x,y,z],[x,y,z], …] segment pairs into two triangles each */
  _uploadSegments(vao, bufs, segs) {
    const gl = this.gl;
    const n = segs.length / 2;
    const A = new Float32Array(n * 6 * 3);
    const B = new Float32Array(n * 6 * 3);
    const S = new Float32Array(n * 6);
    const E = new Float32Array(n * 6);
    //  corners:  (A,-1) (A,+1) (B,-1)   (B,-1) (A,+1) (B,+1)
    const SIDE = [-1, 1, -1, -1, 1, 1];
    const END  = [0, 0, 1, 1, 0, 1];
    for (let i = 0; i < n; i++) {
      const a = segs[i * 2], b = segs[i * 2 + 1];
      for (let k = 0; k < 6; k++) {
        const o = (i * 6 + k) * 3;
        A[o] = a[0]; A[o + 1] = a[1]; A[o + 2] = a[2];
        B[o] = b[0]; B[o + 1] = b[1]; B[o + 2] = b[2];
        S[i * 6 + k] = SIDE[k];
        E[i * 6 + k] = END[k];
      }
    }
    gl.bindVertexArray(vao);
    const bind = (buf, data, name, size) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      const l = gl.getAttribLocation(this.lineProg, name);
      if (l >= 0) { gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, size, gl.FLOAT, false, 0, 0); }
    };
    bind(bufs.a, A, 'aA', 3);
    bind(bufs.b, B, 'aB', 3);
    bind(bufs.side, S, 'aSide', 1);
    bind(bufs.end, E, 'aEnd', 1);
    gl.bindVertexArray(null);
    return n * 6;
  }

  draw() {
    const gl = this.gl;
    const W = this.canvas.width, H = this.canvas.height;
    gl.viewport(0, 0, W, H);
    gl.clearColor(...this.background, 1);
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);          // shells are visible from both sides
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!this.count) return;

    const cam = this._camera(W, H);
    const far = cam.dist + cam.R * 3 + 10;      // never clip a big arrangement
    const proj = perspective(cam.fovy, cam.aspect, Math.max(0.02, cam.dist * 0.01), far, cam.zoom);
    const view = mat4mul(translation(0, 0, -cam.dist), quatToMat4(this.rotation));

    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.prog, 'uProj'), false, proj);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.prog, 'uView'), false, view);
    gl.uniform1f(gl.getUniformLocation(this.prog, 'uAlpha'), 1.0);
    gl.bindVertexArray(this.vao);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(1.2, 1.2);      // sink the faces so edges sit cleanly on top
    gl.drawArrays(gl.TRIANGLES, 0, this.count);
    gl.disable(gl.POLYGON_OFFSET_FILL);

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const drawLines = (vao, count, rgba, cssWidth) => {
      gl.useProgram(this.lineProg);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.lineProg, 'uProj'), false, proj);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.lineProg, 'uView'), false, view);
      gl.uniform4f(gl.getUniformLocation(this.lineProg, 'uColor'), ...rgba);
      gl.uniform2f(gl.getUniformLocation(this.lineProg, 'uViewport'), W, H);
      gl.uniform1f(gl.getUniformLocation(this.lineProg, 'uWidth'), cssWidth * dpr);
      gl.bindVertexArray(vao);
      gl.drawArrays(gl.TRIANGLES, 0, count);
    };

    if (this.showEdges && this.lineCount) {
      drawLines(this.lineVao, this.lineCount, this.edgeColor, this.edgeWidth);
    }
    /*
     * Symmetry elements are real geometry, drawn into the same depth buffer as
     * the solid, so an axis that runs behind a cell is hidden by it. Drawn as
     * overlaid lines they were «kind of useless, because of occlusions»: you
     * could not tell which side of the solid an axis came out of. Vladimir's own
     * suggestion was to make them cylinders — «представить цилиндры как набор
     * выпуклых сегментов, тогда можно было бы тем же вьюером пользоваться».
     */
    if (this.elemCount) {
      gl.useProgram(this.prog);
      gl.uniform1f(gl.getUniformLocation(this.prog, 'uAlpha'), 1.0);
      gl.bindVertexArray(this.elemVao);
      gl.drawArrays(gl.TRIANGLES, 0, this.elemCount);
    }
    // mirror planes last: translucent, so they must read over what is behind
    // them without writing depth, or the discs would hide each other
    if (this.discCount) {
      gl.useProgram(this.prog);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      // faint, because they stack: fifteen planes at 0.06 still reach ~0.6
      gl.uniform1f(gl.getUniformLocation(this.prog, 'uAlpha'), 0.06);
      gl.bindVertexArray(this.discVao);
      gl.drawArrays(gl.TRIANGLES, 0, this.discCount);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
      gl.uniform1f(gl.getUniformLocation(this.prog, 'uAlpha'), 1.0);
    }

    if (this.hlCount) {
      gl.disable(gl.DEPTH_TEST);
      drawLines(this.hlVao, this.hlCount, this.hlColor || [1.0, 0.93, 0.3, 1.0], 3.2);
      gl.enable(gl.DEPTH_TEST);
    }
    gl.bindVertexArray(null);
  }

  /**
   * The camera.
   *
   * One rule governs this whole function: **the amount of perspective must not
   * depend on anything except the solid.** Foreshortening is set by the ratio of
   * the object's radius to the camera's distance, so that ratio is pinned to the
   * constant `fit` and everything else — zoom, and framing a canvas of any shape
   * — is done by scaling the projection, which is a flat 2-D magnification and
   * cannot bend a straight line.
   *
   * Two ways this was previously broken, both reported on 6 August:
   *
   *  - `fit` was computed from `min(fovy, fovx)` so that a *narrow* canvas would
   *    not clip the solid left and right. But fovx depends on the aspect ratio,
   *    so dragging the splitter moved the camera, and you could watch vertical
   *    lines bend as you dragged — «размер канвы меняет перспективу, что вообще
   *    является неприемлемым». Narrow canvases are now framed by shrinking the
   *    projection instead, which leaves the camera where it was.
   *  - `R` was floored at 1, so a selection smaller than the initial one left the
   *    camera too far back and the picture went flat. Toggling the core on and
   *    off could therefore change the perspective — the Windows report at 13:33,
   *    where a scrollbar appearing in the Cells panel resized the canvas as well.
   *
   * The camera does still retreat as the selection grows, in exact proportion to
   * its radius: a fixed distance would eventually be swallowed, since the core
   * has radius 1 and a full stellation reaches past 6. Retreating and magnifying
   * by the same factor holds both the size and the perspective constant.
   */
  _camera(W, H) {
    const fovy = Math.PI / 4.5;
    const aspect = W / H;
    const fit = 1.13 / Math.sin(fovy / 2);          // constant: no aspect, no zoom
    const R = Math.max(1e-3, (this.lastMaxR || 1) * (this.modelScale || 1));
    // A canvas narrower than it is tall sees less sideways than fovy allows;
    // scale the projection down to compensate rather than moving the camera.
    const narrow = Math.min(1, aspect / Math.cos(fovy / 2));
    return { fovy, aspect, fit, R, dist: fit * R, zoom: (R / this.distance) * narrow };
  }

  // ---------------------------------------------------------------- picking

  /**
   * Which face of the solid is under the pointer.
   *
   * The camera sits at the origin of view space looking down -Z, so the ray
   * through a pixel is trivial there; we push it back into model space with the
   * inverse of the view transform (a rotation, so its transpose) and hit-test
   * the triangles directly. A few thousand triangles is nothing per click, and
   * this keeps picking exact rather than reading back pixel ids.
   */
  pick(e) {
    if (!this.pickTris?.length) return null;
    const r = this.canvas.getBoundingClientRect();
    const nx = ((e.clientX - r.left) / r.width) * 2 - 1;
    const ny = 1 - ((e.clientY - r.top) / r.height) * 2;

    const cam = this._camera(this.canvas.width, this.canvas.height);
    // the projection is scaled by cam.zoom, so the effective half-angle is
    // tan(fovy/2)/zoom — pick with the same frustum that was drawn, or clicks
    // land on the wrong face as soon as you zoom
    const t = Math.tan(cam.fovy / 2) / cam.zoom;
    const dirView = [nx * cam.aspect * t, ny * t, -1];

    const R = quatToMat4(this.rotation);
    const origin = rotT(R, [0, 0, cam.dist]);
    const dir = rotT(R, dirView);

    let best = null;
    for (const tri of this.pickTris) {
      const hit = rayTriangle(origin, dir, tri.a, tri.b, tri.c);
      if (hit !== null && (best === null || hit < best.t)) best = { t: hit, face: tri.face };
    }
    return best;
  }

  /**
   * Outline one face, or clear with -1.
   *
   * `action` is 'add' | 'remove' | null and picks the colour; `enabled` false
   * dims it, meaning "you are pointing at this, but the click would do nothing".
   */
  setHighlight(faceIndex, action = null, enabled = true) {
    const want = `${faceIndex}|${action}|${enabled ? 1 : 0}`;
    const a = ACTION[action] || ACTION.none;
    this.hlColor = enabled ? [...a.rgb, 1.0] : [...a.rgb, 0.34];
    if (this._hl === want) { this.draw(); return; }
    this._hl = want;
    const gl = this.gl;
    const pts = [];
    if (faceIndex >= 0 && this.mesh) {
      // must be the same scale the mesh was uploaded at, or the outline floats
      // away from the face it is meant to mark
      const s = this.modelScale || 1;
      const face = this.mesh.faces[faceIndex];
      if (face) {
        for (let i = 0; i < face.length; i++) {
          const a = this.mesh.vertices[face[i]], b = this.mesh.vertices[face[(i + 1) % face.length]];
          pts.push([a.x * s, a.y * s, a.z * s], [b.x * s, b.y * s, b.z * s]);
        }
      }
    }
    if (!this.hlVao) {
      this.hlVao = gl.createVertexArray();
      this.hlBufs = { a: gl.createBuffer(), b: gl.createBuffer(), side: gl.createBuffer(), end: gl.createBuffer() };
    }
    this.hlCount = this._uploadSegments(this.hlVao, this.hlBufs, pts);
    gl.bindVertexArray(null);
    this.draw();
  }

  /*
   * Pointer smoothing and momentum.
   *
   * A mouse reports in uneven jumps — «то есть у мышки маленький шаг, три
   * пиксела там, а потом другой шаг пять» — and applying each jump directly
   * makes the solid stutter. Vladimir's own navigator models the pointer as the
   * far end of a spring dragging a damped mass, tuned to the ratio that settles
   * fastest without ringing.
   *
   * This is that idea with a first-order filter rather than a second-order one:
   * the motion you have asked for accumulates in `_pending`, and each frame a
   * fixed fraction of what is left gets applied. It smooths exactly the same way
   * and, unlike a spring, it *cannot* overshoot — the remainder only ever shrinks
   * — so there is no ringing to tune away. Nothing is lost either: the whole of
   * `_pending` is eventually spent, so a drag turns the solid by exactly as much
   * as the pointer asked for.
   *
   * Momentum comes from the release: the recent pointer speed is pushed into the
   * same buffer, so a flick coasts on and settles — «я ее толкнул, и она
   * тихонечко в ту сторону продолжает двигаться».
   */
  _spinStep(dt) {
    const p = this._pending;
    if (!p || (Math.abs(p.x) < 1e-6 && Math.abs(p.y) < 1e-6)) return false;
    const k = 1 - Math.exp(-dt / 0.055);       // ~55 ms to settle most of the way
    const dx = p.x * k, dy = p.y * k;
    p.x -= dx; p.y -= dy;
    this.rotation = quatMul(
      quatMul(quatFromAxis([0, 1, 0], dx), quatFromAxis([1, 0, 0], dy)),
      this.rotation);
    return true;
  }

  start() {
    if (this._raf) return;
    let last = performance.now();
    const tick = (t) => {
      const dt = Math.min((t - last) / 1000, 0.05); last = t;
      if (this.autoRotate && !this.dragging) {
        this.rotation = quatMul(quatFromAxis([0, 1, 0], dt * 0.35), this.rotation);
      }
      this._spinStep(dt);
      this.draw();
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
  }

  stop() { if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; } }

  _installControls() {
    const c = this.canvas;
    let px = 0, py = 0;

    // A modifier means "I am pointing at a cell", not "turn the model" — that is
    // what keeps picking and orbiting out of each other's way. The same two
    // gestures mean the same two things in all three views: shift adds a cell
    // with everything holding it up, the carve modifier removes it with
    // everything resting on it. On Windows and Linux that modifier is ctrl; on
    // macOS ctrl-click is the OS secondary click and never arrives as a click,
    // so option and cmd stand in for it there (and see the contextmenu handler).
    const picking = (e) => e.shiftKey || e.ctrlKey || e.metaKey || e.altKey;
    const mods = (e) => {
      const shift = e.shiftKey;
      return { shift, ctrl: !shift && (e.ctrlKey || e.metaKey || e.altKey), alt: e.altKey };
    };

    let lastT = 0;
    this._pending = { x: 0, y: 0 };
    this._vel = { x: 0, y: 0 };

    const down = (e) => {
      if (picking(e) || e.button === 2) return;
      this.cancelEase();
      this.dragging = true;
      this._vel = { x: 0, y: 0 };
      const p = point(e, c); px = p.x; py = p.y;
      lastT = performance.now();
      c.setPointerCapture?.(e.pointerId);
    };
    const move = (e) => {
      if (!this.dragging) {
        this._lastMove = e;
        const hit = picking(e) ? this.pick(e) : null;
        c.style.cursor = hit ? 'crosshair' : 'grab';
        // the app knows whether the gesture can actually do anything here, so it
        // owns the highlight colour; without it, fall back to a plain outline
        if (this.onPickHover) this.onPickHover(hit, mods(e));
        else this.setHighlight(hit ? hit.face : -1);
        return;
      }
      const p = point(e, c);
      const dx = (p.x - px) * 0.008, dy = (p.y - py) * 0.008;
      px = p.x; py = p.y;
      // trackball: drag direction maps to rotation about the perpendicular axis.
      // The motion is banked rather than applied — see _spinStep.
      this._pending.x += dx; this._pending.y += dy;
      const now = performance.now();
      const dt = Math.max(1 / 240, Math.min(0.1, (now - lastT) / 1000));
      lastT = now;
      const a = 0.35;                          // EMA of the pointer's rate, rad/s
      this._vel.x += (dx / dt - this._vel.x) * a;
      this._vel.y += (dy / dt - this._vel.y) * a;
      if (!this._raf) { this._spinStep(1 / 60); this.draw(); }
    };
    const up = (e) => {
      if (this.dragging) {
        // a flick coasts: hand the buffer a slice of the speed it ended at
        const GLIDE = 0.11;                    // seconds of travel to carry on with
        this._pending.x += this._vel.x * GLIDE;
        this._pending.y += this._vel.y * GLIDE;
      }
      this.dragging = false;
      c.releasePointerCapture?.(e.pointerId);
    };

    c.addEventListener('pointerdown', down);
    c.addEventListener('pointermove', move);
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('pointerleave', () => {
      this._lastMove = null;
      this.setHighlight(-1); this.onPickHover?.(null);
    });

    /*
     * Pressing or releasing a modifier changes what a click would do, so it has
     * to change the highlight too — without it the green stays on the face after
     * you let go of shift and the picture lies about what a click will do
     * («я отпустил Shift, но highlighting не исчез»). The pointer has not moved,
     * so replay the last move event with the new modifier state.
     */
    const replay = (e) => {
      if (!this._lastMove || this.dragging) return;
      const m = this._lastMove;
      move({ clientX: m.clientX, clientY: m.clientY, shiftKey: e.shiftKey,
             ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey });
    };
    addEventListener('keydown', replay);
    addEventListener('keyup', replay);
    addEventListener('blur', () => { this.setHighlight(-1); this.onPickHover?.(null); });

    c.addEventListener('click', (e) => {
      if (!picking(e) || !this.onPick) return;
      const hit = this.pick(e);
      if (hit) this.onPick(hit, mods(e));
    });

    /*
     * A plain right-click is meant to do nothing at all here. But on macOS a
     * ctrl-click IS the secondary click: the OS swallows it and the page only
     * ever sees `contextmenu`. Both requirements are satisfiable at once,
     * because the two cases are distinguishable — a ctrl-click carries
     * ctrlKey, a real right-click does not. So: swallow the menu either way,
     * and only carve when the modifier was actually held.
     */
    c.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!this.onPick || !e.ctrlKey) return;
      const hit = this.pick(e);
      if (hit) this.onPick(hit, { shift: false, ctrl: true });
    });

    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.cancelEase();
      // wide range: a deep arrangement can be a hundred times the core's radius
      this.distance = Math.min(40, Math.max(0.05, this.distance * Math.exp(e.deltaY * 0.0012)));
      this.draw();
    }, { passive: false });
  }

  /** a PNG data URL of the current view */
  snapshot() {
    this.draw();
    return this.canvas.toDataURL('image/png');
  }
}

function point(e, el) {
  const r = el.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

// ------------------------------------------------- symmetry-element geometry

/** two unit vectors perpendicular to `d` and to each other */
function basis(d) {
  const n = Math.hypot(...d) || 1;
  const w = [d[0] / n, d[1] / n, d[2] / n];
  // pick the world axis least aligned with w, so the cross product is stable
  const a = Math.abs(w[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  let u = [w[1] * a[2] - w[2] * a[1], w[2] * a[0] - w[0] * a[2], w[0] * a[1] - w[1] * a[0]];
  const ul = Math.hypot(...u) || 1;
  u = u.map(x => x / ul);
  const v = [w[1] * u[2] - w[2] * u[1], w[2] * u[0] - w[0] * u[2], w[0] * u[1] - w[1] * u[0]];
  return { w, u, v };
}

function push(o, p, n, c) {
  o.pos.push(p[0], p[1], p[2]);
  o.norm.push(n[0], n[1], n[2]);
  o.col.push(c[0], c[1], c[2]);
}

/** a capped n-gonal prism along `dir`, from -ext to +ext, as flat triangles */
function tube(o, dir, ext, rad, col, sides = 10) {
  const { w, u, v } = basis(dir);
  const ring = [];
  for (let i = 0; i < sides; i++) {
    const t = (i / sides) * Math.PI * 2;
    const c = Math.cos(t), s = Math.sin(t);
    ring.push({ n: [u[0] * c + v[0] * s, u[1] * c + v[1] * s, u[2] * c + v[2] * s] });
  }
  const at = (r, k) => [r.n[0] * rad + w[0] * k * ext, r.n[1] * rad + w[1] * k * ext, r.n[2] * rad + w[2] * k * ext];
  for (let i = 0; i < sides; i++) {
    const a = ring[i], b = ring[(i + 1) % sides];
    const A = at(a, -1), B = at(b, -1), C = at(b, 1), D = at(a, 1);
    push(o, A, a.n, col); push(o, B, b.n, col); push(o, C, b.n, col);
    push(o, A, a.n, col); push(o, C, b.n, col); push(o, D, a.n, col);
  }
  // flat caps, so an axis pointing at the viewer is a disc rather than a hole
  for (const k of [-1, 1]) {
    const nrm = [w[0] * k, w[1] * k, w[2] * k];
    const hub = [w[0] * k * ext, w[1] * k * ext, w[2] * k * ext];
    for (let i = 0; i < sides; i++) {
      const a = ring[i], b = ring[(i + 1) % sides];
      push(o, hub, nrm, col);
      push(o, at(k > 0 ? a : b, k), nrm, col);
      push(o, at(k > 0 ? b : a, k), nrm, col);
    }
  }
}

/** a flat annulus through the origin with normal `dir` — the rim of a mirror plane */
function ring(o, dir, rad, w, col, sides = 64) {
  const { w: nrm, u, v } = basis(dir);
  const at = (t, r) => {
    const c = Math.cos(t) * r, s = Math.sin(t) * r;
    return [u[0] * c + v[0] * s, u[1] * c + v[1] * s, u[2] * c + v[2] * s];
  };
  const ri = rad - w, ro = rad;
  for (let i = 0; i < sides; i++) {
    const t0 = (i / sides) * Math.PI * 2, t1 = ((i + 1) / sides) * Math.PI * 2;
    const A = at(t0, ri), B = at(t1, ri), C = at(t1, ro), D = at(t0, ro);
    push(o, A, nrm, col); push(o, B, nrm, col); push(o, C, nrm, col);
    push(o, A, nrm, col); push(o, C, nrm, col); push(o, D, nrm, col);
  }
}

/** a flat disc through the origin with normal `dir` — one mirror plane */
function disc(o, dir, rad, col, sides = 48) {
  const { w, u, v } = basis(dir);
  const at = (t) => {
    const c = Math.cos(t) * rad, s = Math.sin(t) * rad;
    return [u[0] * c + v[0] * s, u[1] * c + v[1] * s, u[2] * c + v[2] * s];
  };
  for (let i = 0; i < sides; i++) {
    const t0 = (i / sides) * Math.PI * 2, t1 = ((i + 1) / sides) * Math.PI * 2;
    push(o, [0, 0, 0], w, col); push(o, at(t0), w, col); push(o, at(t1), w, col);
  }
}

// ---------------------------------------------------------------- tiny math

/** shortest-arc interpolation between two orientations */
function slerp(a, b, t) {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  let bb = b;
  if (d < 0) { bb = [-b[0], -b[1], -b[2], -b[3]]; d = -d; }   // take the short way round
  if (d > 0.9995) {                                          // nearly aligned: lerp
    const o = [a[0] + (bb[0] - a[0]) * t, a[1] + (bb[1] - a[1]) * t,
               a[2] + (bb[2] - a[2]) * t, a[3] + (bb[3] - a[3]) * t];
    const n = Math.hypot(...o) || 1;
    return o.map(v => v / n);
  }
  const th = Math.acos(d), s = Math.sin(th);
  const wa = Math.sin((1 - t) * th) / s, wb = Math.sin(t * th) / s;
  return [a[0] * wa + bb[0] * wb, a[1] * wa + bb[1] * wb,
          a[2] * wa + bb[2] * wb, a[3] * wa + bb[3] * wb];
}

function perspective(fovy, aspect, near, far, zoom = 1) {
  const f = (1 / Math.tan(fovy / 2)) * zoom, nf = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ]);
}

function translation(x, y, z) {
  return new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, x,y,z,1]);
}

function mat4mul(a, b) {
  const o = new Float32Array(16);
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 4; j++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + j] * b[i * 4 + k];
      o[i * 4 + j] = s;
    }
  return o;
}

function quatFromAxis(axis, angle) {
  const l = Math.hypot(...axis) || 1;
  const s = Math.sin(angle / 2);
  return [axis[0] / l * s, axis[1] / l * s, axis[2] / l * s, Math.cos(angle / 2)];
}

function quatFromEuler(x, y, z) {
  let q = quatFromAxis([1, 0, 0], x);
  q = quatMul(quatFromAxis([0, 1, 0], y), q);
  return quatMul(quatFromAxis([0, 0, 1], z), q);
}

function quatMul(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

/** apply the transpose (= inverse, for a rotation) of a column-major mat4's 3x3 part */
function rotT(m, v) {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[4] * v[0] + m[5] * v[1] + m[6] * v[2],
    m[8] * v[0] + m[9] * v[1] + m[10] * v[2],
  ];
}

/** Möller–Trumbore; returns the ray parameter of the hit, or null. Two-sided. */
function rayTriangle(o, d, a, b, c) {
  const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const p = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
  const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
  if (Math.abs(det) < 1e-12) return null;
  const inv = 1 / det;
  const t0 = [o[0] - a[0], o[1] - a[1], o[2] - a[2]];
  const u = (t0[0] * p[0] + t0[1] * p[1] + t0[2] * p[2]) * inv;
  if (u < -1e-6 || u > 1 + 1e-6) return null;
  const q = [t0[1] * e1[2] - t0[2] * e1[1], t0[2] * e1[0] - t0[0] * e1[2], t0[0] * e1[1] - t0[1] * e1[0]];
  const v = (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]) * inv;
  if (v < -1e-6 || u + v > 1 + 1e-6) return null;
  const t = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) * inv;
  return t > 1e-6 ? t : null;
}

function quatToMat4(q) {
  const [x, y, z, w] = q;
  return new Float32Array([
    1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0,
    2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0,
    2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0,
    0, 0, 0, 1,
  ]);
}
