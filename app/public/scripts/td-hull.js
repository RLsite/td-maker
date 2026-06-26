// ══════════════════════════ STEP 6: VISUAL HULL ══════════════════════════
const hull = { az: 225, el: 22, zoom: 1, drag: null, grid: true };

// Compare row-width profiles of the ISO top-face mask (back→front) with the
// standalone top-view segmentation mask (top→bottom) to decide whether the
// top-view image was photographed with the object's front at the top (needs flip)
// or at the bottom (normal). Returns true if v-axis should be flipped.
function _detectTopViewFlip() {
  const isoTop = S.isoFaceMasks?.top;
  const topMask = S.segMaskImproved?.top ?? S.segMasks?.top;
  if (!isoTop || !topMask) return false;

  const BINS = 24;
  const rowProf = ({ mask, W, H }) => {
    const p = new Float32Array(BINS);
    for (let b = 0; b < BINS; b++) {
      const row = Math.round(b / (BINS - 1) * (H - 1));
      let cnt = 0;
      for (let x = 0; x < W; x++) if (mask[row * W + x]) cnt++;
      p[b] = W ? cnt / W : 0;
    }
    return p;
  };

  const isoProf = rowProf(isoTop);  // row 0 = BACK, last = FRONT
  const topProf = rowProf(topMask); // row 0 = TOP of image, last = BOTTOM

  let cNorm = 0, cFlip = 0;
  for (let i = 0; i < BINS; i++) {
    cNorm += isoProf[i] * topProf[i];
    cFlip += isoProf[i] * topProf[BINS - 1 - i];
  }
  // Require 5% margin before declaring flip to avoid flipping on near-symmetric shapes
  return cFlip > cNorm * 1.05;
}

// ── Cross-view Orientation Solver ────────────────────────────────────────────
// The 4 views are orthographic projections of the same object from 4 known
// directions (front=−Z, side=±X, top=−Y).  They share axes:
//   Front ↔ Side  : Y (height)
//   Front ↔ Top   : X (width)
//   Side  ↔ Top   : Z (depth)  ← the 90° relationship
//
// We solve two binary unknowns:
//   topFlip  — is the top-view image top the FRONT or BACK of the object?
//   sideFlip — is the side-view image left the FRONT or BACK of the object?
//
// Algorithm (inspired by multi-view geometry bundle adjustment):
//   For each of the 4 orientation combinations (topFlip×sideFlip ∈ {T,F}²)
//   compute a consistency score across all shared axes, then pick the best.
//
// Consistency measures:
//   1. Front–Top   width agreement  : at the candidate HEAD end of the top view,
//      the silhouette width should match the front view's width at the top
//      (where the ears are).
//   2. Front–Side  height agreement : the height profiles of front and side
//      (both share Y) should correlate strongly.  This validates scale but
//      not orientation, so it is used as a sanity check only.
//   3. Side–Top    depth axis check : the WIDTH of the top view at each depth
//      position (row) should correlate with the FILL of the side view at the
//      corresponding column.  Testing both sideFlip values gives us two
//      correlation scores; the higher one wins.
// ── Cross-view Landmark Detection ─────────────────────────────────────────────
// The EARS are the key cross-view landmark:
//   • In the FRONT VIEW  : widest row (max X extent) = ear level = head height
//   • In the TOP VIEW    : widest row (max X extent) = ear D-position = HEAD = FRONT
//   • In the SIDE VIEW   : ears are not visible from the side; use trunk CoM instead
//
// The widest row in the TOP VIEW is the absolute D anchor:
//   it corresponds to D≈0 (the front/head end), so it must map to v=1 (FRONT of face).
//   This gives us BOTH the flip direction AND the absolute D position.
function _detectOrientations() {
  const get  = v => S.segMaskImproved?.[v] ?? S.segMasks?.[v];
  const fMsk = get('front');
  const sMsk = get('side');
  const tMsk = get('top');

  // widestRow: row with max filled pixels → normalized Y position [0,1]
  const widestRow = ({ mask, W, H }) => {
    let maxW = 0, row = 0;
    for (let y = 0; y < H; y++) {
      let w = 0; for (let x = 0; x < W; x++) if (mask[y*W+x]) w++;
      if (w > maxW) { maxW = w; row = y; }
    }
    return { row, norm: H > 0 ? row / H : 0.5 };
  };
  // widestCol: column with max filled pixels → normalized X position [0,1]
  const widestCol = ({ mask, W, H }) => {
    let maxH = 0, col = 0;
    for (let x = 0; x < W; x++) {
      let h = 0; for (let y = 0; y < H; y++) if (mask[y*W+x]) h++;
      if (h > maxH) { maxH = h; col = x; }
    }
    return { col, norm: W > 0 ? col / W : 0.5 };
  };

  S._landmarks = S._landmarks ?? {};

  // ── TOP VIEW: ear landmark finds the HEAD end (D=0 = FRONT) ──────────────
  // The top view image may be rotated 90°:
  //   Normal   (topRotated90=false): body top-to-bottom, ears left-right → widestRow gives ear Y
  //   Rotated  (topRotated90=true ): body left-to-right, ears top-bottom → widestCol gives ear X
  // S.topRotated90 is set by buildObjectModel using cross-view consistency.
  const rotated90 = !!S.topRotated90;
  let topFlip = false;

  // earSpanCenter: given a mask and row index, find the centre of the filled span in X.
  // Returns normalised X centre [0,1].
  const earSpanCenterX = ({ mask, W, H }, row) => {
    let lo = W, hi = -1;
    for (let x = 0; x < W; x++) if (mask[row * W + x]) { if (x < lo) lo = x; if (x > hi) hi = x; }
    return (lo <= hi) ? (lo + hi) / 2 / W : 0.5;
  };
  // Same but for a column — finds centre of filled span in Y.
  const earSpanCenterY = ({ mask, W, H }, col) => {
    let lo = H, hi = -1;
    for (let y = 0; y < H; y++) if (mask[y * W + col]) { if (y < lo) lo = y; if (y > hi) hi = y; }
    return (lo <= hi) ? (lo + hi) / 2 / H : 0.5;
  };

  if (tMsk) {
    if (rotated90) {
      // Rotated90: body goes L-R (D = image X), ears go T-B (W = image Y).
      // widestCol → the X column where the ear span (in Y) is largest = D position of head.
      // earSpanCenterY of that column → W centre of ears → should map to u=0.5.
      const earCol  = widestCol(tMsk);
      topFlip = earCol.norm > 0.5;
      if (S.isoFaceMasks?.top) topFlip = _detectTopViewFlip();
      S._landmarks.topEarNorm       = null;
      S._landmarks.topEarColNorm    = earCol.norm;
      S._landmarks.topEarWCenterNorm = earSpanCenterY(tMsk, earCol.col);  // Y centre → W
      console.log(`[hull] top ROTATED90 → earCol=${earCol.norm.toFixed(3)}  wCenter=${S._landmarks.topEarWCenterNorm.toFixed(3)}  topFlip=${topFlip}`);
    } else {
      // Normal: body goes T-B (D = image Y), ears go L-R (W = image X).
      // widestRow → the Y row where the ear span (in X) is largest = D position of head.
      // earSpanCenterX of that row → W centre of ears → should map to u=0.5.
      const earRow  = widestRow(tMsk);
      topFlip = earRow.norm < 0.5;
      if (S.isoFaceMasks?.top) topFlip = _detectTopViewFlip();
      S._landmarks.topEarNorm       = earRow.norm;
      S._landmarks.topEarColNorm    = null;
      S._landmarks.topEarWCenterNorm = earSpanCenterX(tMsk, earRow.row);  // X centre → W
      console.log(`[hull] top NORMAL → earRow=${earRow.norm.toFixed(3)}  wCenter=${S._landmarks.topEarWCenterNorm.toFixed(3)}  topFlip=${topFlip}`);
    }
  }

  // ── FRONT VIEW: verify ear height ────────────────────────────────────────
  // The widest row of the front-view mask = ear level.
  // Stored for cross-validation (not yet used for positioning).
  if (fMsk) {
    const frontLandmark = widestRow(fMsk);
    S._landmarks.frontEarRow  = frontLandmark.row;
    S._landmarks.frontMaskH   = fMsk.H;
    S._landmarks.frontEarNorm = frontLandmark.norm;
  }

  // ── SIDE VIEW: trunk bottom-profile asymmetry ────────────────────────────
  // Asymmetry principle: find the MOST ASYMMETRIC POINT and use it as anchor.
  //
  // The TRUNK is the key asymmetric feature of the side view:
  //   • It hangs BELOW the body at the HEAD/FRONT end only.
  //   • In the bottom-edge profile (for each column x: the lowest filled pixel),
  //     the trunk creates a distinct DOWNWARD SPIKE at one end only.
  //   • The column with the deepest bottom-edge = trunk tip = D≈0 = FRONT.
  //   • The half of the mask whose bottom-edge is on average LOWER = FRONT half.
  //
  // This is superior to a CoM comparison because the trunk spike is highly
  // localised — an asymmetric point that cannot be confused with its mirror.
  let sideFlip = false;
  if (sMsk) {
    const { mask, W, H } = sMsk;

    // Build bottom-edge profile: for each column, the Y of the lowest filled pixel.
    const botEdge = new Float32Array(W).fill(0);
    for (let x = 0; x < W; x++) {
      for (let y = H - 1; y >= 0; y--) {
        if (mask[y * W + x]) { botEdge[x] = y / H; break; }  // normalised [0,1]
      }
    }

    // Compare mean bottom-edge depth of left vs right halves.
    // Higher mean = lower (more downward) = trunk side = FRONT.
    let lSum = 0, rSum = 0;
    const half = Math.floor(W / 2);
    for (let x = 0; x < half; x++)   lSum += botEdge[x];
    for (let x = half; x < W; x++) rSum += botEdge[x];
    const lMean = lSum / half, rMean = rSum / (W - half);

    // Also find the single column with the deepest bottom point = trunk tip.
    let maxBot = -1, trunkCol = Math.floor(W / 2);
    for (let x = 0; x < W; x++) if (botEdge[x] > maxBot) { maxBot = botEdge[x]; trunkCol = x; }
    const trunkColNorm = trunkCol / W;  // normalised [0,1]: 0=image-left, 1=image-right

    // Primary: trunk-tip column → which half it's in.
    // Tie-break: half mean comparison.
    sideFlip = trunkColNorm > 0.5 || (Math.abs(trunkColNorm - 0.5) < 0.1 && rMean > lMean + 0.02);

    // Store trunk column landmark for absolute D anchoring in the renderer.
    S._landmarks.sideTrunkColNorm = trunkColNorm;
    S._landmarks.sideTrunkFlip    = sideFlip;

    console.log(`[hull] side  → trunkCol=${trunkColNorm.toFixed(3)}  lMean=${lMean.toFixed(3)}  rMean=${rMean.toFixed(3)}  sideFlip=${sideFlip}`);
  }

  // ── Consistency check: no contradictions between the two anchors ──────────
  // Ears  anchor → Front ↔ Top  (shared W axis): topFlip tells us which end is HEAD
  // Trunk anchor → Top  ↔ Side  (shared D axis): sideFlip tells us which end is FRONT
  // The HEAD of the animal is always at the FRONT of the D axis.
  // So: topFlip (which Y/X end is HEAD in top view) must agree with sideFlip
  //     (which X end is FRONT in side view) via the top view's D orientation.
  // If they contradict, trust the higher-confidence detection (sideFlip, trunk-based).
  if (tMsk && sMsk) {
    const topFrontIsLeft  = !topFlip;   // topFlip=false → bottom=FRONT (for normal); rotated: left=FRONT
    const sideFrontIsLeft = !sideFlip;  // sideFlip=false → left=FRONT
    // In a consistent model, the trunk is FRONT in BOTH side and top views.
    // (Deep check would require cross-view D correlation — skipped for now.)
    // Just log the agreement state for debugging.
    console.log(`[hull] anchor check → topFrontIsLeft=${topFrontIsLeft}  sideFrontIsLeft=${sideFrontIsLeft}  agree=${topFrontIsLeft === sideFrontIsLeft}`);
  }

  console.log(`[hull] top   → earNorm=${S._landmarks?.topEarNorm?.toFixed(3) ?? '—'}  topFlip=${topFlip}`);
  return { topFlip, sideFlip };
}

function initVisualHull() {
  buildObjectModel();   // refresh consensus model from all 4 sources
  updateHullDims();
  // Detect cross-view orientations BEFORE rendering the knowledge panel
  // so _renderKnowledgePanel can include the orientation decisions.
  const orient = _detectOrientations();
  hull._topFlip  = orient.topFlip;
  hull._sideFlip = orient.sideFlip;
  _renderKnowledgePanel();
  renderHullOrtho();
  const c = document.getElementById('hull-canvas');
  if (!c) return;
  c.onmousedown = (e) => { hull.drag = { x: e.clientX, y: e.clientY, az: hull.az, el: hull.el }; c.style.cursor = 'grabbing'; };
  c.onmousemove = (e) => {
    if (!hull.drag) return;
    hull.az = hull.drag.az + (e.clientX - hull.drag.x) * 0.6;
    hull.el = Math.max(-89, Math.min(89, hull.drag.el - (e.clientY - hull.drag.y) * 0.4));
    const elSlider = document.getElementById('hull-el');
    if (elSlider) elSlider.value = Math.round(hull.el);
    renderVisualHull();
  };
  c.onmouseup = c.onmouseleave = () => { hull.drag = null; c.style.cursor = 'grab'; };
  c.onwheel = (e) => { e.preventDefault(); hull.zoom = Math.max(0.3, Math.min(4, hull.zoom * (e.deltaY < 0 ? 1.1 : 0.91))); renderVisualHull(); };
  renderVisualHull();
  _initNavCube();
}

// ══════════════════════════ NAV CUBE (2D canvas) ══════════════════════════════
// Orientation gizmo — pure 2D canvas, no external dependencies.
// Reuses the same az/el projection as the main hull renderer.
// Click a face → smooth snap to that orthographic view.

let _ncCanvas = null;
let _ncFacePolys = [];   // projected quads for hit-testing: [{ pts, snap }]
let _ncHover = -1;

function _initNavCube() {
  const canvas = document.getElementById('nav-cube');
  if (!canvas) return;
  _ncCanvas = canvas;
  canvas.addEventListener('click',     _navCubePick);
  canvas.addEventListener('mousemove', _navCubeHover);
  canvas.addEventListener('mouseleave',() => { _ncHover = -1; _renderNavCube(); });
  _renderNavCube();
}

// Face definitions: corners (indices into c3), outward normal, label, snap target
const _ncFaces = [
  { idx:[3,2,1,0], norm:[0,0,-1], label:'FRONT',  snap:{ az:270, el:0  } },
  { idx:[4,5,6,7], norm:[0,0, 1], label:'BACK',   snap:{ az:90,  el:0  } },
  { idx:[1,2,6,5], norm:[1,0, 0], label:'RIGHT',  snap:{ az:0,   el:0  } },
  { idx:[0,3,7,4], norm:[-1,0,0], label:'LEFT',   snap:{ az:180, el:0  } },
  { idx:[2,3,7,6], norm:[0,1, 0], label:'TOP',    snap:{ az:270, el:89 } },
  { idx:[0,1,5,4], norm:[0,-1,0], label:'BOTTOM', snap:{ az:270, el:-89} },
];

const _ncColors = {
  FRONT:'#6D28D9', BACK:'#4C1D95',
  RIGHT:'#1D4ED8', LEFT:'#1E40AF',
  TOP:'#065F46',   BOTTOM:'#064E3B',
};
const _ncTextColors = {
  FRONT:'#C4B5FD', BACK:'#DDD6FE',
  RIGHT:'#93C5FD', LEFT:'#BFDBFE',
  TOP:'#6EE7B7',   BOTTOM:'#A7F3D0',
};

function _renderNavCube() {
  const canvas = _ncCanvas;
  if (!canvas) return;
  const W = canvas.width, H = canvas.height;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);

  const azR = hull.az * Math.PI / 180;
  const elR = hull.el * Math.PI / 180;
  const s = W * 0.34;
  const cx = W / 2, cy = H / 2;

  // Same rotation as hull renderer
  const proj = (x, y, z) => {
    const rx =  x * Math.cos(azR) + z * Math.sin(azR);
    const rz = -x * Math.sin(azR) + z * Math.cos(azR);
    const ry =  y * Math.cos(elR) - rz * Math.sin(elR);
    return { x: cx + rx * s, y: cy - ry * s };
  };

  // Unit cube corners
  const c3 = [
    [-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1],
    [-1,-1, 1],[1,-1, 1],[1,1, 1],[-1,1, 1],
  ];
  const p2 = c3.map(([x,y,z]) => proj(x,y,z));

  const viewDir = [
    Math.cos(azR)*Math.cos(elR),
    Math.sin(elR),
    Math.sin(azR)*Math.cos(elR),
  ];
  const dot3 = n => n[0]*viewDir[0]+n[1]*viewDir[1]+n[2]*viewDir[2];

  // Sort visible faces back-to-front by depth
  const visible = _ncFaces
    .map((f, i) => ({
      f, i,
      vis: dot3(f.norm),
      depth: f.idx.reduce((s,j) => s + c3[j][0]*Math.sin(azR) - c3[j][2]*Math.cos(azR), 0),
    }))
    .filter(d => d.vis > 0.01)
    .sort((a, b) => b.depth - a.depth);

  _ncFacePolys = [];

  for (const { f, i } of visible) {
    const pts = f.idx.map(j => p2[j]);
    const hover = (_ncHover === i);

    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let k = 1; k < pts.length; k++) ctx.lineTo(pts[k].x, pts[k].y);
    ctx.closePath();

    ctx.fillStyle = hover
      ? _ncTextColors[f.label] + '33'
      : _ncColors[f.label] + 'CC';
    ctx.fill();

    ctx.strokeStyle = _ncTextColors[f.label];
    ctx.lineWidth = hover ? 2 : 1.2;
    ctx.stroke();

    // Label
    const mx = pts.reduce((s,p)=>s+p.x,0)/4;
    const my = pts.reduce((s,p)=>s+p.y,0)/4;
    ctx.fillStyle = _ncTextColors[f.label];
    ctx.font = `bold ${Math.round(W*0.115)}px Arial,sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(f.label, mx, my);

    _ncFacePolys.push({ pts, snap: f.snap, idx: i });
  }
}

function _ptInQuad(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length-1; i < pts.length; j = i++) {
    const xi=pts[i].x, yi=pts[i].y, xj=pts[j].x, yj=pts[j].y;
    if (((yi>y)!==(yj>y)) && (x < (xj-xi)*(y-yi)/(yj-yi)+xi)) inside = !inside;
  }
  return inside;
}

function _ncHitFace(e) {
  const r = _ncCanvas.getBoundingClientRect();
  const x = (e.clientX - r.left) * (_ncCanvas.width  / r.width);
  const y = (e.clientY - r.top)  * (_ncCanvas.height / r.height);
  for (let i = _ncFacePolys.length-1; i >= 0; i--) {
    if (_ptInQuad(x, y, _ncFacePolys[i].pts)) return i;
  }
  return -1;
}

function _navCubePick(e) {
  const hit = _ncHitFace(e);
  if (hit < 0) return;
  _animateHullTo(_ncFacePolys[hit].snap.az, _ncFacePolys[hit].snap.el);
}

function _navCubeHover(e) {
  const hit = _ncHitFace(e);
  if (hit === _ncHover) return;
  _ncHover = hit;
  _renderNavCube();
}

function _animateHullTo(targetAz, targetEl) {
  const startAz = hull.az, startEl = hull.el;
  // Normalize azimuth delta to [-180, 180] to take the shortest arc
  let dAz = ((targetAz - startAz) % 360 + 540) % 360 - 180;
  const startTime = performance.now();
  const DURATION = 380;

  function step(now) {
    const t = Math.min(1, (now - startTime) / DURATION);
    const ease = t < 0.5 ? 2*t*t : -1 + (4 - 2*t)*t;
    hull.az = startAz + dAz * ease;
    hull.el = startEl + (targetEl - startEl) * ease;
    const elSlider = document.getElementById('hull-el');
    if (elSlider) elSlider.value = Math.round(hull.el);
    renderVisualHull();
    if (t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

function updateHullDims() {
  const om = S.objectModel;
  ['W','H','D'].forEach(k => {
    const el = document.getElementById(`hull-dim-${k}`);
    if (!el) return;
    const val = om?.dims?.[k];
    if (val != null) {
      el.textContent = Math.round(val);
      el.style.color = 'var(--teal-light)';
    } else if (S.dims?.[k] && S.dims[k] !== '—') {
      el.textContent = S.dims[k];
      el.style.color = 'var(--subtle)';
    } else {
      el.textContent = '—';
      el.style.color = 'var(--border)';
    }
  });
  _renderHullConsistency();
}

function _renderHullConsistency() {
  const om = S.objectModel;

  // Per-dim consistency badges (inside each card)
  const dimViews = { W: ['front','top'], H: ['front','side'], D: ['side','top'] };
  const dimMeas  = { W: ['wMm','wMm'],  H: ['hMm','hMm'],    D: ['wMm','hMm'] };
  ['W','H','D'].forEach((k, ki) => {
    const badge = document.getElementById(`hull-cons-${k}`);
    if (!badge) return;
    const c = om?.consistency?.[k];
    const src = om?.dimSource?.[k];
    const pv  = om?.perView;
    const [vA, vB]  = dimViews[k];
    const [mA, mB]  = dimMeas[k];
    const valA = pv?.[vA]?.[mA], valB = pv?.[vB]?.[mB];

    if (c === null || c === undefined) {
      badge.textContent = src ? `src: ${src[0].toUpperCase()}` : '—';
      badge.style.color = 'var(--muted)';
      return;
    }
    const color = c >= 0.90 ? '#10B981' : c >= 0.82 ? '#F59E0B' : '#EF4444';
    const icon  = c >= 0.90 ? '✓' : c >= 0.82 ? '~' : '⚠';
    const aStr  = valA != null ? Math.round(valA) : '?';
    const bStr  = valB != null ? Math.round(valB) : '?';
    badge.innerHTML = `<span style="color:${color}">${icon} ${Math.round(c*100)}%</span> <span style="color:var(--muted)">${aStr}↔${bStr}</span>`;
  });

  // Issues banner
  const issueEl = document.getElementById('hull-issues');
  if (issueEl) {
    const issues = om?.issues ?? [];
    if (issues.length) {
      issueEl.style.display = 'block';
      issueEl.innerHTML = '⚠ ' + issues.map(i =>
        `<strong>${i.dim}</strong>: ${i.a} mm (${i.views.split('↔')[0]}) vs ${i.b} mm (${i.views.split('↔')[1]})`
      ).join(' &nbsp;·&nbsp; ');
    } else {
      issueEl.style.display = 'none';
    }
  }
}

// ── Knowledge Panel — all information gathered across all steps ───────────────
function _renderKnowledgePanel() {
  const el = document.getElementById('hull-knowledge');
  if (!el) return;

  const om = S.objectModel;
  const fmt = v => v != null ? Math.round(v) + ' mm' : '—';
  const fmtF = v => v != null ? v.toFixed(1) : '—';
  const scoreColor = s => s >= 7 ? '#10B981' : s >= 4 ? '#F59E0B' : '#EF4444';
  const scoreIcon  = s => s >= 7 ? '✓' : s >= 4 ? '~' : '⚠';
  const conIcon    = c => c == null ? '' : c >= 0.90 ? '<span style="color:#10B981">✓</span>' : c >= 0.82 ? '<span style="color:#F59E0B">~</span>' : '<span style="color:#EF4444">⚠</span>';

  // Per-view rows
  const views = ['front', 'side', 'top'];
  const viewLabels = { front: 'Front', side: 'Side', top: 'Top' };
  let rows = '';
  for (const v of views) {
    const ppm = S.scale?.[v];
    const sm  = S.segMeta?.[v];
    const sc  = S.segScore?.[v];
    const poly = S.polys?.[v];
    const ci  = S.contourInfo?.[v];
    const sym = S.symmetry?.[v];
    const holes = S.holes?.[v] ?? [];
    const pv  = om?.perView?.[v];

    // Compute bbox dims in mm from segMeta
    let bboxStr = '—';
    if (sm?.bbox && ppm) {
      const sX = (sm.origW ?? sm.W) / sm.W;
      const sY = (sm.origH ?? sm.H) / sm.H;
      const bW = (sm.bbox.maxX - sm.bbox.minX) * sX / ppm;
      const bH = (sm.bbox.maxY - sm.bbox.minY) * sY / ppm;
      bboxStr = `${Math.round(bW)} × ${Math.round(bH)}`;
    }

    const scStr = sc != null
      ? `<span style="color:${scoreColor(sc)}">${scoreIcon(sc)} ${sc.toFixed(1)}</span>`
      : '<span style="color:var(--muted)">—</span>';
    const ppmStr = ppm ? `${ppm.toFixed(1)} px/mm` : '—';
    const ptsStr = poly?.pts?.length ? `${poly.pts.length} pts${poly.closed ? '' : ' (open)'}` : '—';
    const ratioStr = ci?.areaRatio != null
      ? `<span style="color:${Math.abs(ci.areaRatio - 1) < 0.2 ? '#10B981' : '#F59E0B'}">${Math.round(ci.areaRatio * 100)}%</span>`
      : '—';
    const symStr = sym
      ? `<span style="color:#2dd4bf">${sym.dir === 'v' ? '⟺' : '⇳'} ${Math.round(sym.score * 100)}%</span>`
      : '<span style="color:var(--border)">none</span>';
    const holeStr = sm?.holeCount === 0
      ? '<span style="color:var(--muted)">0</span>'
      : holes.length
        ? `<span style="color:#6366f1">${holes.length}</span>`
        : '<span style="color:var(--muted)">—</span>';
    const dimsStr = pv ? `${fmt(pv.wMm)} × ${fmt(pv.hMm)}` : '—';

    rows += `<tr>
      <td style="font-weight:600;color:var(--text);padding:5px 8px;">${viewLabels[v]}</td>
      <td style="color:var(--muted);padding:5px 8px;">${ppmStr}</td>
      <td style="padding:5px 8px;">${scStr}</td>
      <td style="color:var(--subtle);padding:5px 8px;">${bboxStr}</td>
      <td style="color:var(--subtle);padding:5px 8px;">${ptsStr}</td>
      <td style="padding:5px 8px;">${ratioStr}</td>
      <td style="padding:5px 8px;">${symStr}</td>
      <td style="padding:5px 8px;">${holeStr}</td>
      <td style="color:var(--subtle);padding:5px 8px;">${dimsStr}</td>
    </tr>`;
  }

  // ISO row
  const iso = S.isoData;
  let isoRow = '';
  if (iso?.dims_mm) {
    const d = iso.dims_mm;
    isoRow = `<tr style="border-top:1px solid var(--border)">
      <td style="font-weight:600;color:#6366f1;padding:5px 8px;">ISO</td>
      <td colspan="3" style="color:var(--muted);padding:5px 8px;">Isometric view</td>
      <td colspan="2" style="padding:5px 8px;"></td>
      <td style="padding:5px 8px;"></td>
      <td style="padding:5px 8px;"></td>
      <td style="color:#6366f1;font-family:'Fira Code',monospace;padding:5px 8px;">${fmt(d.W)} W · ${fmt(d.H)} H · ${fmt(d.D ?? d.Dt)} D</td>
    </tr>`;
  }

  // Consensus row
  const cons = om?.dims;
  const conC = om?.consistency ?? {};
  const consRow = cons ? `<tr style="background:rgba(13,148,136,.06);border-top:1px solid rgba(13,148,136,.3)">
    <td style="font-weight:700;color:var(--teal-light);padding:5px 8px;">Consensus</td>
    <td colspan="3" style="padding:5px 8px;font-size:10px;color:var(--muted);">Weighted merge of all sources</td>
    <td style="padding:5px 8px;"></td>
    <td style="padding:5px 8px;"></td>
    <td style="padding:5px 8px;"></td>
    <td style="padding:5px 8px;"></td>
    <td style="font-family:'Fira Code',monospace;font-weight:700;color:var(--teal-light);padding:5px 8px;">
      W ${fmt(cons.W)} ${conIcon(conC.W)} &nbsp;
      H ${fmt(cons.H)} ${conIcon(conC.H)} &nbsp;
      D ${fmt(cons.D)} ${conIcon(conC.D)}
    </td>
  </tr>` : '';

  // Orientation row — summarise cross-view orientation decisions
  const orientRow = (() => {
    const tf = hull._topFlip, sf = hull._sideFlip;
    if (tf == null && sf == null) return '';
    const lm = S._landmarks ?? {};
    const earPct  = lm.topEarNorm   != null ? `ear@${(lm.topEarNorm*100).toFixed(0)}%`     : '';
    const trunkPct = lm.sideTrunkColNorm != null ? `trunk@${(lm.sideTrunkColNorm*100).toFixed(0)}%` : '';
    const tfStr = tf == null ? '—'
      : tf ? `<span style="color:#6366f1">↑top=FRONT ${earPct}</span>`
           : `<span style="color:#6366f1">↓bot=FRONT ${earPct}</span>`;
    const sfStr = sf == null ? '—'
      : sf ? `<span style="color:#f97316">→right=FRONT ${trunkPct}</span>`
           : `<span style="color:#f97316">←left=FRONT ${trunkPct}</span>`;
    return `<tr style="background:rgba(99,102,241,.05);border-top:1px solid rgba(99,102,241,.2)">
      <td style="font-weight:600;color:#6366f1;padding:5px 8px;">Orient</td>
      <td colspan="3" style="color:var(--muted);padding:5px 8px;font-size:10px;">asymmetry landmarks</td>
      <td colspan="2" style="padding:5px 8px;">${tfStr}</td>
      <td colspan="3" style="padding:5px 8px;">${sfStr}</td>
    </tr>`;
  })();

  el.innerHTML = `
    <table style="width:100%;border-collapse:collapse;font-size:11px;">
      <thead>
        <tr style="border-bottom:1px solid var(--border)">
          <th style="text-align:left;padding:4px 8px;color:var(--muted);font-weight:600;">View</th>
          <th style="text-align:left;padding:4px 8px;color:var(--muted);font-weight:600;">Scale</th>
          <th style="text-align:left;padding:4px 8px;color:var(--muted);font-weight:600;">Seg</th>
          <th style="text-align:left;padding:4px 8px;color:var(--muted);font-weight:600;">Bbox (mm)</th>
          <th style="text-align:left;padding:4px 8px;color:var(--muted);font-weight:600;">Contour</th>
          <th style="text-align:left;padding:4px 8px;color:var(--muted);font-weight:600;">Area fit</th>
          <th style="text-align:left;padding:4px 8px;color:var(--muted);font-weight:600;">Symmetry</th>
          <th style="text-align:left;padding:4px 8px;color:var(--muted);font-weight:600;">Holes</th>
          <th style="text-align:left;padding:4px 8px;color:var(--muted);font-weight:600;">Dims W×H</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
        ${isoRow}
        ${consRow}
        ${orientRow}
      </tbody>
    </table>`;

  // Log contour dimension table to console for copy-paste into chat
  const pv = om?.perView;
  const lm = S._landmarks ?? {};
  console.table([
    { View:'Front', 'Contour W (mm)': pv?.front?.wMm?.toFixed(1) ?? '—', 'Contour H (mm)': pv?.front?.hMm?.toFixed(1) ?? '—', 'W→axis':'W', 'H→axis':'H', 'ppm': pv?.front?.ppm?.toFixed(1) ?? '—' },
    { View:'Side',  'Contour W (mm)': pv?.side?.wMm?.toFixed(1)  ?? '—', 'Contour H (mm)': pv?.side?.hMm?.toFixed(1)  ?? '—', 'W→axis':'D', 'H→axis':'H', 'ppm': pv?.side?.ppm?.toFixed(1)  ?? '—',  'trunkCol%': lm.sideTrunkColNorm != null ? (lm.sideTrunkColNorm*100).toFixed(0)+'%' : '—' },
    { View:'Top',   'Contour W (mm)': pv?.top?.wMm?.toFixed(1)   ?? '—', 'Contour H (mm)': pv?.top?.hMm?.toFixed(1)   ?? '—', 'W→axis':'W', 'H→axis':'D', 'ppm': pv?.top?.ppm?.toFixed(1)   ?? '—',  'earRow%':   lm.topEarNorm != null    ? (lm.topEarNorm*100).toFixed(0)+'%'    : '—' },
    { View:'Consensus', 'Contour W (mm)': om?.dims?.W?.toFixed(1) ?? '—', 'Contour H (mm)': om?.dims?.H?.toFixed(1) ?? '—', 'W→axis':'W+D', 'H→axis':'H', 'D (mm)': om?.dims?.D?.toFixed(1) ?? '—' },
  ]);
}

function resetHullView() { hull.az = 225; hull.el = 22; hull.zoom = 1; renderVisualHull(); }

function toggleTopRotate90() {
  S.topRotated90 = !S.topRotated90;
  const btn = document.getElementById('hull-top-rot-btn');
  if (btn) {
    btn.style.background   = S.topRotated90 ? 'rgba(99,102,241,.2)' : 'var(--surface)';
    btn.style.color        = S.topRotated90 ? '#a5b4fc' : 'var(--subtle)';
    btn.style.borderColor  = S.topRotated90 ? '#6366f1' : 'var(--border)';
  }
  S._landmarks = {};   // clear landmarks so _detectOrientations recomputes
  initVisualHull();
}

function toggleHullGrid() {
  hull.grid = !hull.grid;
  const btn = document.getElementById('hull-grid-btn');
  if (btn) {
    btn.style.background = hull.grid ? 'rgba(13,148,136,.15)' : 'var(--surface)';
    btn.style.color = hull.grid ? 'var(--teal-light)' : 'var(--subtle)';
    btn.style.borderColor = hull.grid ? 'var(--teal)' : 'var(--border)';
    btn.textContent = hull.grid ? 'Grid ✓' : 'Grid';
  }
  renderVisualHull();
}

// ── Orthographic 3-view contour panel ─────────────────────────────────────────
// 3-column layout: [Front] [Side] [Top]
// Each view is independent — always all 3 visible regardless of missing dims.
function renderHullOrtho() {
  const c = document.getElementById('hull-ortho-canvas');
  if (!c) return;
  const ctx = c.getContext('2d');
  const CW = c.parentElement.clientWidth - 2;
  if (CW < 10) return;

  const PAD = 8, GAP = 10, LABEL_H = 18;
  const cols = ['front', 'side', 'top'];

  const om = S.objectModel;
  const consW = om?.dims?.W, consH = om?.dims?.H, consD = om?.dims?.D;

  // Pre-pass: get contour bounding-box in mm for each view.
  // The box is sized to the CONTOUR, not the consensus — so it fits exactly.
  const contourMm = {};
  cols.forEach(view => {
    const poly = S.polys[view];
    const ppm  = S.scale?.[view];
    if (!poly?.pts?.length || !ppm) return;
    const srcW = S.polyCanvasSize?.[view]?.w ?? 1;
    const srcH = S.polyCanvasSize?.[view]?.h ?? 1;
    const origW = S.segMeta?.[view]?.origW ?? srcW;
    const origH = S.segMeta?.[view]?.origH ?? srcH;
    const ppmX  = ppm * srcW / origW, ppmY = ppm * srcH / origH;
    const xs = poly.pts.map(p => p.x / ppmX);
    const ys = poly.pts.map(p => p.y / ppmY);
    const minX = xs.reduce((a, b) => Math.min(a, b));
    const maxX = xs.reduce((a, b) => Math.max(a, b));
    const minY = ys.reduce((a, b) => Math.min(a, b));
    const maxY = ys.reduce((a, b) => Math.max(a, b));
    contourMm[view] = { w: (maxX - minX) || 1, h: (maxY - minY) || 1, minX, maxX, minY, maxY, ppmX, ppmY };
  });

  // ── 3D Symmetry inference ─────────────────────────────────────────────────
  // Symmetry is a property of the OBJECT, not of each photo.
  // Each view's detected axis maps to one 3D axis (W, H, or D).
  // If ANY view detects an axis, ALL views that can see it get the line.
  // Position is normalised to [0..1] within that view's contour bounding box.

  // Helper: normalised axis position within the contour box for a given view.
  // dir='v' → axis in X (image px) → normalised to contour W span
  // dir='h' → axis in Y (image px) → normalised to contour H span
  const normAxis = (view, dir) => {
    const sym = S.symmetry?.[view];
    const cm  = contourMm[view];
    if (!sym || !cm || sym.dir !== dir) return null;
    const srcW2 = S.polyCanvasSize?.[view]?.w ?? 1;
    const srcH2 = S.polyCanvasSize?.[view]?.h ?? 1;
    if (dir === 'v' && sym.mW) {
      const axMm = sym.axis * srcW2 / sym.mW / cm.ppmX;
      return (axMm - cm.minX) / cm.w;
    }
    if (dir === 'h' && sym.mH) {
      const axMm = sym.axis * srcH2 / sym.mH / cm.ppmY;
      return (axMm - cm.minY) / cm.h;
    }
    return null;
  };
  const avg = arr => { const f = arr.filter(v => v != null); return f.length ? f.reduce((a,b)=>a+b)/f.length : null; };
  const topRot = !!S.topRotated90;

  // W axis (left-right symmetry) — visible in Front (v) and Top (v normal / h rotated)
  const wNorm = avg([
    normAxis('front', 'v'),
    topRot ? normAxis('top', 'h') : normAxis('top', 'v'),
  ]);

  // H axis (top-bottom symmetry) — visible in Front (h) and Side (h)
  const hNorm = avg([normAxis('front', 'h'), normAxis('side', 'h')]);

  // D axis (front-back symmetry) — visible in Side (v) and Top (h normal / v rotated)
  const dNorm = avg([
    normAxis('side', 'v'),
    topRot ? normAxis('top', 'v') : normAxis('top', 'h'),
  ]);

  // Store on S so contour editor and 3D hull can also use it
  S._sym3D = { W: wNorm, H: hNorm, D: dNorm };

  // Unified mm→px scale: contour boxes side-by-side, all sharing the same ruler.
  // Total width = sum of each contour's W; max height = tallest contour.
  const totalCW = cols.reduce((s, v) => s + (contourMm[v]?.w ?? 0), 0);
  const maxCH   = cols.reduce((s, v) => Math.max(s, contourMm[v]?.h ?? 0), 0);
  const hasData = totalCW > 5 && maxCH > 5;

  const mmPx = hasData
    ? Math.min(
        (CW - PAD * 2 - GAP * 2) / totalCW,
        200 / maxCH            // cap: never taller than 200px
      )
    : null;
  const contentH = hasData ? Math.ceil(maxCH * mmPx) : 154;
  const CH = contentH + PAD * 2 + LABEL_H;
  c.width = CW; c.height = CH;
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, CW, CH);

  // Left-edge X for each box: boxes are packed from the left, no overlap.
  let curX = PAD;
  const faceX = cols.map(view => {
    const x = curX;
    curX += Math.ceil((contourMm[view]?.w ?? 0) * (mmPx ?? 1)) + GAP;
    return x;
  });

  cols.forEach((view, ci) => {
    const cm  = contourMm[view];
    const bw  = cm ? Math.ceil(cm.w * (mmPx ?? 1)) : Math.floor((CW - PAD*2 - GAP*2) / 3);
    const bh  = cm ? Math.ceil(cm.h * (mmPx ?? 1)) : contentH;
    const bx  = faceX[ci];
    const by  = PAD + contentH - bh;   // bottom-align: all views share the same floor

    const poly = S.polys[view];
    const ppm  = S.scale?.[view];
    const hasPts = poly?.pts?.length >= 3 && ppm;

    // Background + border
    ctx.fillStyle = '#1e293b';
    ctx.fillRect(bx, by, bw, bh);
    ctx.strokeStyle = hasPts ? '#334155' : '#1e293b';
    ctx.lineWidth = 1;
    ctx.strokeRect(bx, by, bw, bh);

    // Label
    ctx.fillStyle = '#94a3b8';
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(view[0].toUpperCase() + view.slice(1), bx + bw / 2, by + bh + LABEL_H - 4);

    if (!hasPts) {
      ctx.fillStyle = '#334155';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('no contour', bx + bw / 2, by + bh / 2 + 4);
      return;
    }

    // Use pre-computed contour bounds from the pre-pass (no duplicate work).
    if (!cm) return;
    const { minX, maxX, minY, maxY, ppmX, ppmY } = cm;
    const cW_mm = cm.w, cH_mm = cm.h;
    const xs_mm = poly.pts.map(p => p.x / ppmX);
    const ys_mm = poly.pts.map(p => p.y / ppmY);

    // Drawing scale: box is exactly the contour size → scale fills box edge-to-edge.
    const sc = mmPx ?? Math.min((bw - 2) / cW_mm, (bh - 2) / cH_mm);

    // X: left-align contour to box left (box = contour, no centering offset needed).
    // Symmetry axis draws at its position, but no offset needed for W alignment here.
    const drawOffX = bx - minX * sc;
    // Y: bottom-align — maxY (floor of contour) → bottom of box.
    const drawOffY = by + bh - maxY * sc;

    const px = x => drawOffX + x * sc;
    const py = y => drawOffY + y * sc;

    // Clip strictly to this view's box — contours CANNOT cross into adjacent boxes.
    ctx.save();
    ctx.beginPath(); ctx.rect(bx, by, bw, bh); ctx.clip();

    // Symmetry lines — derived from S._sym3D (object property, not per-photo).
    // Each view shows the axes it can see:
    //   front: W (vertical),  H (horizontal)
    //   side:  D (vertical),  H (horizontal)
    //   top:   W (vertical),  D (horizontal)  — axes swap if topRotated90
    const isTopRotV = (view === 'top' && topRot);
    // Which 3D axis is "vertical" (U direction) in this view?
    const vertNorm = view === 'front' ? S._sym3D?.W
                   : view === 'side'  ? S._sym3D?.D
                   : isTopRotV        ? S._sym3D?.D   // rotated: D becomes vertical
                   :                    S._sym3D?.W;   // normal:  W is vertical
    // Which 3D axis is "horizontal" (V direction) in this view?
    const horizNorm = view === 'front' ? S._sym3D?.H
                    : view === 'side'  ? S._sym3D?.H
                    : isTopRotV        ? S._sym3D?.W   // rotated: W becomes horizontal
                    :                    S._sym3D?.D;  // normal:  D is horizontal

    ctx.strokeStyle = '#FACC15'; ctx.lineWidth = 1.5; ctx.setLineDash([]);
    if (vertNorm != null) {
      const ax = bx + vertNorm * bw;
      ctx.beginPath(); ctx.moveTo(ax, by + 2); ctx.lineTo(ax, by + bh - 2); ctx.stroke();
    }
    if (horizNorm != null) {
      const ay = by + horizNorm * bh;
      ctx.beginPath(); ctx.moveTo(bx + 2, ay); ctx.lineTo(bx + bw - 2, ay); ctx.stroke();
    }

    // Contour
    ctx.beginPath();
    ctx.moveTo(px(xs_mm[0]), py(ys_mm[0]));
    for (let i = 1; i < xs_mm.length; i++) ctx.lineTo(px(xs_mm[i]), py(ys_mm[i]));
    ctx.closePath();
    ctx.fillStyle = 'rgba(13,148,136,.15)'; ctx.fill();
    ctx.strokeStyle = '#2dd4bf'; ctx.lineWidth = 1.5; ctx.stroke();

    ctx.restore();

    // Dimension labels
    const expW = (view === 'front' || view === 'top') ? consW : consD;
    const expH = (view === 'front' || view === 'side') ? consH : consD;
    const wOk = !expW || Math.abs(cW_mm - expW) / expW < 0.15;
    const hOk = !expH || Math.abs(cH_mm - expH) / expH < 0.15;

    ctx.font = 'bold 10px monospace'; ctx.textAlign = 'left';
    ctx.fillStyle = wOk ? '#34d399' : '#f87171';
    ctx.fillText(`W ${Math.round(cW_mm)}`, bx + 4, by + 13);
    ctx.fillStyle = hOk ? '#34d399' : '#f87171';
    ctx.fillText(`H ${Math.round(cH_mm)}`, bx + 4, by + 25);
    if (expW) {
      ctx.fillStyle = '#475569'; ctx.textAlign = 'right';
      ctx.fillText(`/${Math.round(expW)}`, bx + bw - 4, by + 13);
      ctx.fillText(`/${Math.round(expH || 0)}`, bx + bw - 4, by + 25);
    }
    ctx.fillStyle = '#475569'; ctx.textAlign = 'center'; ctx.font = '9px monospace';
    ctx.fillText(`${ppm.toFixed(1)} px/mm`, bx + bw / 2, by + bh - 3);
  });

  // Status
  const status = document.getElementById('hull-ortho-status');
  if (status) {
    const issues = om?.issues ?? [];
    status.textContent = issues.length
      ? `⚠ ${issues.map(i => `${i.dim}: ${i.a}↔${i.b}mm`).join(' · ')}`
      : (cols.some(v => S.polys[v]?.pts?.length >= 3) ? '✓ views consistent' : '');
    status.style.color = issues.length ? '#f59e0b' : '#10b981';
  }

  // Contour dimensions table
  const dimsEl = document.getElementById('hull-ortho-dims');
  if (dimsEl && om?.perView) {
    const pv = om.perView;
    const r  = v => v != null ? Math.round(v) : '—';
    const viewDefs = [
      { label: 'Front', data: pv.front, axes: ['W', 'H'] },
      { label: 'Side',  data: pv.side,  axes: ['D', 'H'] },
      { label: 'Top',   data: pv.top,   axes: ['W', 'D'] },
    ];
    const cons = om.dims;
    // Face dimensions (mm²) for fill ratio: contour_area / face_area
    const faceArea = {
      front: cons?.W && cons?.H ? cons.W * cons.H : null,
      side:  cons?.D && cons?.H ? cons.D * cons.H : null,
      top:   cons?.W && cons?.D ? cons.W * cons.D : null,
    };
    const fillColor = f => f == null ? 'var(--muted)' : f >= 0.7 ? '#10b981' : f >= 0.4 ? '#f59e0b' : '#ef4444';

    const rowsHtml = viewDefs.map(({ label, data, axes }) => {
      const [ax0, ax1] = axes;
      const w = r(data?.wMm), h = r(data?.hMm);
      const key = label.toLowerCase();
      const fa = faceArea[key];
      const contourArea = (data?.wMm != null && data?.hMm != null) ? data.wMm * data.hMm : null;
      const fill = (contourArea != null && fa != null && fa > 0) ? contourArea / fa : null;
      const fillStr = fill != null
        ? `<span style="color:${fillColor(fill)};font-weight:600;">${Math.round(fill * 100)}%</span>`
        : '—';
      return `<td style="padding:2px 10px;font-weight:600;color:var(--subtle);">${label}</td>
              <td style="padding:2px 8px;color:var(--muted);">${ax0}</td>
              <td style="padding:2px 8px;font-family:'Fira Code',monospace;">${w} mm</td>
              <td style="padding:2px 8px;color:var(--muted);">${ax1}</td>
              <td style="padding:2px 8px;font-family:'Fira Code',monospace;">${h} mm</td>
              <td style="padding:2px 8px;text-align:right;">${fillStr}</td>`;
    }).map(cells => `<tr>${cells}</tr>`).join('');
    const consHtml = cons ? `<tr style="border-top:1px solid var(--border)">
      <td style="padding:3px 10px;font-weight:700;color:var(--teal-light);">Consensus</td>
      <td style="padding:3px 8px;color:var(--muted);">W</td>
      <td style="padding:3px 8px;font-family:'Fira Code',monospace;color:var(--teal-light);">${r(cons.W)} mm</td>
      <td style="padding:3px 8px;color:var(--muted);">H</td>
      <td style="padding:3px 8px;font-family:'Fira Code',monospace;color:var(--teal-light);">${r(cons.H)} mm</td>
      <td style="padding:3px 8px;color:var(--muted);">D</td>
      <td style="padding:3px 8px;font-family:'Fira Code',monospace;color:var(--teal-light);">${r(cons.D)} mm</td>
    </tr>` : '';
    dimsEl.style.display = 'block';
    dimsEl.innerHTML = `<table style="border-collapse:collapse;width:100%;font-size:11px;">
      <tr style="border-bottom:1px solid var(--border)">
        <th style="padding:2px 10px;text-align:left;color:var(--muted);">View</th>
        <th colspan="2" style="padding:2px 8px;text-align:left;color:var(--muted);">Horiz axis</th>
        <th colspan="2" style="padding:2px 8px;text-align:left;color:var(--muted);">Vert axis</th>
        <th style="padding:2px 8px;text-align:right;color:var(--muted);">Fill</th>
      </tr>
      ${rowsHtml}${consHtml}
    </table>`;
  }
}

function renderVisualHull() {
  const c = document.getElementById('hull-canvas');
  if (!c) return;
  const ctx = c.getContext('2d');
  const CW = c.parentElement.clientWidth - 2;
  const CH = Math.round(CW * 0.55);
  c.width = CW; c.height = CH;

  const om = S.objectModel;
  const pv = om?.perView;

  // Box dimensions come from the contours themselves, not the blended consensus.
  // Each axis uses the view that directly measures it:
  //   W → front contour width  (front view is orthogonal to W)
  //   H → max(front H, side H) so neither contour clips at the top
  //   D → side contour width   (side view is orthogonal to D)
  // Fall back to consensus, then to review-step dims if no contour data yet.
  const dW = pv?.front?.wMm ?? om?.dims?.W ?? parseFloat(S.dims?.W) ?? 100;
  const dH = Math.max(pv?.front?.hMm ?? 0, pv?.side?.hMm ?? 0)
          || om?.dims?.H || parseFloat(S.dims?.H) || 80;
  const dD = pv?.side?.wMm  ?? om?.dims?.D ?? parseFloat(S.dims?.D) ?? 60;
  const maxDim = Math.max(dW, dH, dD, 1);
  const sc = Math.min(CW, CH) * 0.28 / maxDim * hull.zoom;

  const cx = CW / 2, cy = CH / 2 + dH * sc * 0.05;
  const azR = hull.az * Math.PI / 180;
  const elR = hull.el * Math.PI / 180;

  const proj = (x, y, z) => {
    const rx = x * Math.cos(azR) + z * Math.sin(azR);
    const rz = -x * Math.sin(azR) + z * Math.cos(azR);
    const ry = y * Math.cos(elR) - rz * Math.sin(elR);
    return { x: cx + rx * sc, y: cy - ry * sc };
  };

  ctx.fillStyle = '#F8FAFC';
  ctx.fillRect(0, 0, CW, CH);

  // Ground grid
  if (hull.grid) {
    const gs = maxDim * 1.3, step = maxDim / 4;
    ctx.strokeStyle = 'rgba(148,163,184,.22)'; ctx.lineWidth = 0.7;
    for (let i = -4; i <= 4; i++) {
      const g1 = proj(i*step, -dH/2, -gs/2), g2 = proj(i*step, -dH/2, gs/2);
      ctx.beginPath(); ctx.moveTo(g1.x,g1.y); ctx.lineTo(g2.x,g2.y); ctx.stroke();
      const g3 = proj(-gs/2, -dH/2, i*step), g4 = proj(gs/2, -dH/2, i*step);
      ctx.beginPath(); ctx.moveTo(g3.x,g3.y); ctx.lineTo(g4.x,g4.y); ctx.stroke();
    }
  }

  const hw = dW/2, hh = dH/2, hd = dD/2;
  const c3 = [
    [-hw,-hh,-hd],[hw,-hh,-hd],[hw,hh,-hd],[-hw,hh,-hd],
    [-hw,-hh, hd],[hw,-hh, hd],[hw,hh, hd],[-hw,hh, hd]
  ];
  const p2 = c3.map(([x,y,z]) => proj(x,y,z));

  const viewDir = [
    Math.cos(azR)*Math.cos(elR),
    Math.sin(elR),
    Math.sin(azR)*Math.cos(elR)
  ];
  const dot3 = (n) => n[0]*viewDir[0]+n[1]*viewDir[1]+n[2]*viewDir[2];

  const faces = [
    { idx:[3,2,1,0], norm:[0,0,-1], poly:'front', color:'rgba(13,148,136,.14)' },
    // Back face — no photo data, not shown
    { idx:[4,5,6,7], norm:[0,0,1],  poly:null,    color:'rgba(0,0,0,0)' },
    { idx:[7,6,2,3], norm:[0,1,0],  poly:'top',   color:'rgba(99,102,241,.14)' },
    // Bottom face — no photo data, not shown
    { idx:[0,1,5,4], norm:[0,-1,0], poly:null,    color:'rgba(0,0,0,0)' },
    // Right side — no data (we photographed from the LEFT only), never show contour
    { idx:[2,6,5,1], norm:[1,0,0],  poly:null,    color:'rgba(0,0,0,0)' },
    // Left side — has side-view data.
    // fu = vertex[1]-vertex[0] = [0,0,-dD] → U runs BACK→FRONT (u=0=back, u=1=front).
    // Contour U (edge-anchored) runs FRONT→BACK (u=0=front), so we must invert:
    // faceFlipU:true XORs with sideFlip so the front of the animal → u=1 = front of face.
    { idx:[7,3,0,4], norm:[-1,0,0], poly:'side',  color:'rgba(249,115,22,.14)', faceFlipU:true },
  ].map(f => {
    const cDepth = f.idx.reduce((s,i) => s + c3[i][0]*Math.sin(azR) - c3[i][2]*Math.cos(azR), 0)/4;
    return { ...f, dot: dot3(f.norm), cDepth };
  }).sort((a,b) => a.cDepth - b.cDepth);

  // Draw faces + silhouettes
  faces.forEach(f => {
    const fp = f.idx.map(i => p2[i]);
    ctx.beginPath(); ctx.moveTo(fp[0].x,fp[0].y); fp.slice(1).forEach(p=>ctx.lineTo(p.x,p.y)); ctx.closePath();
    ctx.fillStyle = f.dot > 0 ? f.color : 'rgba(15,23,42,.04)'; ctx.fill();
    ctx.strokeStyle = '#CBD5E1'; ctx.lineWidth = 0.8; ctx.stroke();

    // Silhouette projection on visible faces
    if (f.dot > 0.05 && f.poly) {
      const poly = S.polys[f.poly];
      if (!poly || poly.pts.length < 3) return;
      const srcW = S.polyCanvasSize?.[f.poly]?.w ?? 1;
      const srcH = S.polyCanvasSize?.[f.poly]?.h ?? 1;

      // Physical face dimensions from per-view contour measurements so the
      // contour fills its face exactly (no empty margins, no overflow).
      const topRotFace = f.poly === 'top' && !!S.topRotated90;
      const face_u_mm = f.poly === 'side'
        ? (pv?.side?.wMm  ?? dD)
        : f.poly === 'top'
          ? (topRotFace ? (pv?.top?.hMm ?? dW) : (pv?.top?.wMm ?? dW))
          : (pv?.front?.wMm ?? dW);
      const face_v_mm = f.poly === 'top'
        ? (topRotFace ? (pv?.top?.wMm ?? dD) : (pv?.top?.hMm ?? dD))
        : f.poly === 'side'
          ? (pv?.side?.hMm ?? dH)
          : (pv?.front?.hMm ?? dH);

      // Build a ptToUV function: normalises contour point to [0,1] on the face.
      // poly.pts are canvas pixels; ppm is in original-image px/mm — must scale.
      const ppm = S.scale?.[f.poly];
      const flipV = f.poly === 'top'  && !!hull._topFlip;
      // faceFlipU: left face's U runs back→front, which is opposite to the contour
      // edge anchor (front→back). XOR with sideFlip so front of animal → front of face.
      const flipU = (f.poly === 'side' && !!hull._sideFlip) !== !!f.faceFlipU;
      const applyFlip  = v => flipV ? 1 - v : v;
      const applyUFlip = u => flipU ? 1 - u : u;
      const symFace = S.symmetry?.[f.poly] ?? null;
      let ptToUV;
      if (ppm && face_u_mm > 0 && face_v_mm > 0) {
        const sm = S.segMeta?.[f.poly];
        const origW_px = sm?.origW ?? srcW;
        const origH_px = sm?.origH ?? srcH;
        const ppmX = ppm * srcW / origW_px;   // canvas px/mm
        const ppmY = ppm * srcH / origH_px;
        const xs_mm = poly.pts.map(p => p.x / ppmX);
        const ys_mm = poly.pts.map(p => p.y / ppmY);
        const minXmm = Math.min(...xs_mm), maxXmm = Math.max(...xs_mm);
        const minYmm = Math.min(...ys_mm), maxYmm = Math.max(...ys_mm);
        const contourW_mm = maxXmm - minXmm;
        const contourH_mm = maxYmm - minYmm;

        const topRot = topRotFace;  // already computed above

        // ── U offset (horizontal axis) ────────────────────────────────────────
        // Side face  → U = D axis → anchor FRONT edge to u=0 (no centering).
        // Front/Top  → U = W axis → center via symmetry axis or segMeta bbox.
        let offU;
        if (f.poly === 'side') {
          // Edge anchoring: FRONT edge of contour → u=0.
          // Asymmetry (trunk) is used only to determine sideFlip (which end is FRONT).
          // flipU=false → left=FRONT → leftmost contour pt → u=0  → offU=0
          // flipU=true  → right=FRONT → after applyUFlip, rightmost → u=0
          //   applyUFlip(contourW/face_u + offU)=0 → 1-(contourW/face_u+offU)=0 → offU=1-contourW/face_u
          offU = flipU ? (1 - contourW_mm / face_u_mm) : 0;
        } else if (f.poly === 'top') {
          // Ear-centre W anchor: the centre of the ear span → u=0.5 (W centre of box).
          // Rotated90: ear W centre is in image Y;  Normal: ear W centre is in image X.
          const wCenterNorm = S._landmarks?.topEarWCenterNorm;
          if (wCenterNorm != null) {
            const wCenterMm = topRot
              ? wCenterNorm * srcH / ppmY - minYmm   // image Y → W
              : wCenterNorm * srcW / ppmX - minXmm;  // image X → W
            offU = 0.5 - wCenterMm / face_u_mm;
          } else {
            // Fallback: centre the contour span
            offU = topRot
              ? (face_u_mm - contourH_mm) / (2 * face_u_mm)
              : (face_u_mm - contourW_mm) / (2 * face_u_mm);
          }
        } else if (symFace?.dir === 'v' && symFace.mW) {
          // W axis via symmetry axis of the contour
          const axisCanvasPx = symFace.axis * srcW / symFace.mW;
          const axisMm = axisCanvasPx / ppmX;
          offU = 0.5 - (axisMm - minXmm) / face_u_mm;
        } else if (sm?.bbox) {
          // W axis via segMeta bbox center
          const smScaleX = origW_px / sm.W;
          const smCenterMm = (sm.bbox.minX + sm.bbox.maxX) / 2 * smScaleX / ppm;
          const smHalfW = ((sm.bbox.maxX - sm.bbox.minX) * smScaleX / ppm) / 2;
          offU = 0.5 - (smCenterMm - smHalfW - minXmm) / face_u_mm - contourW_mm / (2 * face_u_mm);
        } else {
          offU = (face_u_mm - contourW_mm) / (2 * face_u_mm);
        }

        // ── V offset (vertical axis) ──────────────────────────────────────────
        // Top face   → V = D axis → anchor EAR to v=1 (ear = HEAD = FRONT = D≈0).
        //   Normal   (topRotated90=false): ear row (Y) is the D anchor
        //   Rotated  (topRotated90=true ): ear col (X) is the D anchor
        // Front/Side → V = H axis → ruler-at-bottom gives absolute height.
        let offV;
        if (f.poly === 'top') {
          // Edge anchoring: FRONT edge of contour → v=1.
          // Asymmetry (ears) is used only to determine topFlip (which end is FRONT).
          // The D span in the image is: contourH_mm (normal) or contourW_mm (rotated90).
          const dSpan = topRot ? contourW_mm : contourH_mm;
          // flipV=false → bottom=FRONT → bottom raw_v = dSpan/face_v → +offV = 1 → offV = 1-dSpan/face_v
          // flipV=true  → top=FRONT   → top raw_v = 0 → applyFlip(0+offV)=1-offV=1 → offV=0
          offV = flipV ? 0 : (1 - dSpan / face_v_mm);
        } else {
          // H axis: ruler is at image bottom = floor = physical H=0.
          const imgH_mm = srcH / ppmY;
          offV = 1 - (imgH_mm - minYmm) / face_v_mm;
          if (offV < -0.3) offV = 0;
        }

        // When top view is rotated 90°: swap image X↔Y so that:
        //   u (W axis) ← image Y,  v (D axis) ← image X
        ptToUV = topRot
          ? pt => ({
              u: applyUFlip((pt.y / ppmY - minYmm) / face_u_mm + offU),
              v: applyFlip ((pt.x / ppmX - minXmm) / face_v_mm + offV),
            })
          : pt => ({
              u: applyUFlip((pt.x / ppmX - minXmm) / face_u_mm + offU),
              v: applyFlip ((pt.y / ppmY - minYmm) / face_v_mm + offV),
            });
      } else {
        ptToUV = pt => ({ u: applyUFlip(pt.x / srcW), v: applyFlip(pt.y / srcH) });
      }

      // Face axes in 3D (u = along first edge, v = along last edge)
      const [fc0,fc1,,fc3] = f.idx.map(i => c3[i]);
      const fu = [fc1[0]-fc0[0], fc1[1]-fc0[1], fc1[2]-fc0[2]];
      const fv = [fc3[0]-fc0[0], fc3[1]-fc0[1], fc3[2]-fc0[2]];
      const mapFace = (u,v) => proj(fc0[0]+fu[0]*u+fv[0]*v, fc0[1]+fu[1]*u+fv[1]*v, fc0[2]+fu[2]*u+fv[2]*v);

      ctx.save();
      ctx.beginPath(); ctx.moveTo(fp[0].x,fp[0].y); fp.slice(1).forEach(p=>ctx.lineTo(p.x,p.y)); ctx.closePath(); ctx.clip();

      // Outer contour + holes as sub-paths (even-odd rule creates cutouts)
      ctx.beginPath();
      const uv0 = ptToUV(poly.pts[0]);
      const p0 = mapFace(uv0.u, uv0.v);
      ctx.moveTo(p0.x, p0.y);
      poly.pts.slice(1).forEach(pt => { const uv = ptToUV(pt); ctx.lineTo(mapFace(uv.u, uv.v).x, mapFace(uv.u, uv.v).y); });
      if (poly.closed) ctx.closePath();

      // Each hole is an inner sub-path — even-odd fill punches it through
      const viewHoles = S.holes?.[f.poly] ?? [];
      for (const hole of viewHoles) {
        if (hole.length < 3) continue;
        const huv0 = ptToUV(hole[0]);
        const hp0 = mapFace(huv0.u, huv0.v);
        ctx.moveTo(hp0.x, hp0.y);
        hole.slice(1).forEach(pt => { const uv = ptToUV(pt); ctx.lineTo(mapFace(uv.u, uv.v).x, mapFace(uv.u, uv.v).y); });
        ctx.closePath();
      }

      ctx.strokeStyle = '#0D9488'; ctx.lineWidth = 1.5; ctx.stroke();
      if (poly.closed) { ctx.fillStyle = 'rgba(13,148,136,.12)'; ctx.fill('evenodd'); }

      // Symmetry axis — yellow line, consistent with ortho view and contour editor
      if (symFace?.dir === 'v') {
        const axTop = mapFace(0.5, 0), axBot = mapFace(0.5, 1);
        ctx.setLineDash([4, 3]); ctx.strokeStyle = '#FACC15'; ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.moveTo(axTop.x, axTop.y); ctx.lineTo(axBot.x, axBot.y); ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.restore();
    }
  });

  // Edges
  [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]].forEach(([a,b]) => {
    ctx.beginPath(); ctx.moveTo(p2[a].x,p2[a].y); ctx.lineTo(p2[b].x,p2[b].y);
    ctx.strokeStyle = '#475569'; ctx.lineWidth = 1.2; ctx.stroke();
  });

  // Dim labels
  ctx.font = 'bold 11px Fira Code, monospace'; ctx.fillStyle = '#64748B';
  const wM = { x:(p2[0].x+p2[1].x)/2, y:(p2[0].y+p2[1].y)/2+14 };
  ctx.textAlign='center'; ctx.fillText(`W=${dW}mm`, wM.x, wM.y);
  const hM = { x:(p2[1].x+p2[2].x)/2+14, y:(p2[1].y+p2[2].y)/2 };
  ctx.textAlign='left'; ctx.fillText(`H=${dH}mm`, hM.x, hM.y);
  const dM = { x:(p2[1].x+p2[5].x)/2+10, y:(p2[1].y+p2[5].y)/2+10 };
  ctx.textAlign='left'; ctx.fillText(`D=${dD}mm`, dM.x, dM.y);

  // Axes indicator (bottom-left)
  const ax = 48, ay = CH - 38, axLen = 22;
  [[[1,0,0],'#EF4444','X'],[[0,1,0],'#22C55E','Y'],[[0,0,1],'#3B82F6','Z']].forEach(([dir,color,lbl]) => {
    const tip = proj(dir[0]*axLen/sc, dir[1]*axLen/sc, dir[2]*axLen/sc);
    ctx.beginPath(); ctx.moveTo(ax,ay); ctx.lineTo(ax+(tip.x-cx), ay+(tip.y-cy));
    ctx.strokeStyle=color; ctx.lineWidth=2; ctx.stroke();
    ctx.fillStyle=color; ctx.font='bold 9px sans-serif'; ctx.textAlign='center';
    ctx.fillText(lbl, ax+(tip.x-cx)*1.35, ay+(tip.y-cy)*1.35+3);
  });

  _renderNavCube();
}

// ══════════════════════════ STL EXPORT ═══════════════════════════════════════
// Converts canvas-space poly.pts to world-space mm for a given view.

function _contourToMmFront(view) {
  const poly = S.polys[view];
  if (!poly?.pts?.length) return null;
  const ppm = S.scale?.[view];
  if (!ppm) return null;
  const srcW = S.polyCanvasSize?.[view]?.w ?? 1;
  const srcH = S.polyCanvasSize?.[view]?.h ?? 1;
  const origW = S.segMeta?.[view]?.origW ?? srcW;
  const origH = S.segMeta?.[view]?.origH ?? srcH;
  const ppmX = ppm * srcW / origW;
  const ppmY = ppm * srcH / origH;
  const H_mm = srcH / ppmY;
  return poly.pts.map(p => ({ x: p.x / ppmX, y: H_mm - p.y / ppmY }));
}

function _contourToMmSide(view) {
  const poly = S.polys[view];
  if (!poly?.pts?.length) return null;
  const ppm = S.scale?.[view];
  if (!ppm) return null;
  const srcW = S.polyCanvasSize?.[view]?.w ?? 1;
  const srcH = S.polyCanvasSize?.[view]?.h ?? 1;
  const origW = S.segMeta?.[view]?.origW ?? srcW;
  const origH = S.segMeta?.[view]?.origH ?? srcH;
  const ppmX = ppm * srcW / origW;
  const ppmY = ppm * srcH / origH;
  const H_mm = srcH / ppmY;
  // canvas-x → z (depth, 0=front), canvas-y → y (height, 0=bottom)
  return poly.pts.map(p => ({ z: p.x / ppmX, y: H_mm - p.y / ppmY }));
}

function _contourToMmTop(view) {
  const poly = S.polys[view];
  if (!poly?.pts?.length) return null;
  const ppm = S.scale?.[view];
  if (!ppm) return null;
  const srcW = S.polyCanvasSize?.[view]?.w ?? 1;
  const srcH = S.polyCanvasSize?.[view]?.h ?? 1;
  const origW = S.segMeta?.[view]?.origW ?? srcW;
  const origH = S.segMeta?.[view]?.origH ?? srcH;
  const ppmX = ppm * srcW / origW;
  const ppmY = ppm * srcH / origH;
  const D_mm = srcH / ppmY;
  // _topFlip=false: back at top of image → z = D - canvas_y/ppm
  // _topFlip=true:  front at top          → z = canvas_y/ppm
  const flipZ = !!hull._topFlip;
  return poly.pts.map(p => ({
    x: p.x / ppmX,
    z: flipZ ? p.y / ppmY : D_mm - p.y / ppmY,
  }));
}

async function exportSTL() {
  const btn = document.getElementById('hull-export-stl-btn');
  const setBtn = (txt, disabled) => { if (btn) { btn.textContent = txt; btn.disabled = disabled; } };

  if (!window.tdCompute?.isElectron) {
    alert('STL export requires the Electron desktop app.');
    return;
  }

  const front = _contourToMmFront('front');
  const side  = _contourToMmSide('side');
  const top   = _contourToMmTop('top');
  if (!front && !side && !top) {
    alert('No contours available — run Contour Drawing first.');
    return;
  }

  setBtn('⏳ Building 3D mesh…', true);
  try {
    const om = S.objectModel;
    const dims = {
      W: om?.dims?.W || parseFloat(S.dims?.W) || 100,
      H: om?.dims?.H || parseFloat(S.dims?.H) || 80,
      D: om?.dims?.D || parseFloat(S.dims?.D) || 60,
    };
    const meshData = { front, side, top, dims, iso_az: hull.az, iso_el: hull.el, resolution: 2.0 };

    const result = await window.tdCompute.runMesh(meshData);
    if (result?.error) throw new Error(result.error);

    // Decode base64 STL and trigger download
    const raw   = atob(result.stl_b64);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    const blob  = new Blob([bytes], { type: 'application/octet-stream' });
    const url   = URL.createObjectURL(blob);
    const a     = document.createElement('a');
    a.href = url; a.download = 'td_maker_mesh.stl'; a.click();
    URL.revokeObjectURL(url);

    setBtn(`✓ STL (${(result.voxel_count || 0).toLocaleString()} voxels)`, false);
  } catch (err) {
    alert('STL export failed: ' + err.message);
    setBtn('Export STL', false);
  }
}