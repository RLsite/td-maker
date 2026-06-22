// ══════════════════════════ STEP 4: CONTOUR ══════════════════════════
let cC, cCtx, cImg;
const cZoom = { s: 1, ox: 0, oy: 0 };
let cRoiMode = false;
let cRoiRect = null;  // {x1,y1,x2,y2} in IMAGE coords (canvas space)
let cRoiDrag = null;  // {x,y} start of current drag
let cBgSampleMode = false;  // when active, next click samples background texture

function screenToImg(sx, sy) {
  return { x: (sx - cZoom.ox) / cZoom.s, y: (sy - cZoom.oy) / cZoom.s };
}

function zoomBy(factor, cx, cy) {
  if (!cC) return;
  const rc = cC.getBoundingClientRect();
  const px = (cx ?? rc.width / 2), py = (cy ?? rc.height / 2);
  const ns = Math.max(0.15, Math.min(12, cZoom.s * factor));
  cZoom.ox = px - (px - cZoom.ox) * (ns / cZoom.s);
  cZoom.oy = py - (py - cZoom.oy) * (ns / cZoom.s);
  cZoom.s = ns;
  const el = document.getElementById('zoom-pct');
  if (el) el.textContent = `${Math.round(cZoom.s * 100)}%`;
  drawContour();
}

function resetZoom() {
  cZoom.s = 1; cZoom.ox = 0; cZoom.oy = 0;
  const el = document.getElementById('zoom-pct');
  if (el) el.textContent = '100%';
  drawContour();
}

/* ── Floating canvas window ── */
let _floatWin = null;
let _floatRO  = null;

function toggleFloatCanvas() {
  if (_floatWin) { _returnContourCanvas(); return; }

  const canvas = document.getElementById('contour-canvas');
  const origWrap = document.getElementById('contour-canvas-wrap');
  const saved = S.floatWin || {};

  // Create floating window
  const win = document.createElement('div');
  win.id = 'contour-float-win';
  const iw = saved.w || Math.min(window.innerWidth  * 0.7, 900);
  const ih = saved.h || Math.min(window.innerHeight * 0.75, 680);
  const il = saved.x ?? Math.max(0, (window.innerWidth  - iw) / 2);
  const it = saved.y ?? Math.max(40, (window.innerHeight - ih) / 2);
  win.style.cssText = `
    position:fixed;left:${il}px;top:${it}px;width:${iw}px;height:${ih}px;
    min-width:280px;min-height:200px;resize:both;overflow:hidden;
    background:var(--surface);border:1px solid var(--teal);border-radius:12px;
    z-index:900;display:flex;flex-direction:column;
    box-shadow:0 24px 64px rgba(0,0,0,.85);`;

  // Title bar (drag handle)
  const bar = document.createElement('div');
  bar.style.cssText = `
    height:36px;background:#1e293b;border-bottom:1px solid var(--border);
    border-radius:12px 12px 0 0;display:flex;align-items:center;padding:0 10px;
    gap:8px;cursor:move;user-select:none;flex-shrink:0;`;
  bar.innerHTML = `
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--teal)" stroke-width="2">
      <rect x="3" y="3" width="18" height="18" rx="2"/>
      <line x1="3" y1="9" x2="21" y2="9"/>
    </svg>
    <span style="font-size:12px;color:var(--subtle);flex:1;pointer-events:none;">Contour Drawing — drag to move · resize from corner</span>
    <button style="background:none;border:none;color:var(--subtle);cursor:pointer;font-size:18px;line-height:1;padding:0 2px;border-radius:4px;" title="Close window">✕</button>`;
  bar.querySelector('button').addEventListener('click', _returnContourCanvas);

  // Canvas container
  const inner = document.createElement('div');
  inner.id = 'float-canvas-inner';
  inner.style.cssText = 'flex:1;min-height:0;display:flex;justify-content:center;align-items:center;background:var(--bg);overflow:hidden;';

  // Placeholder for original wrap (keeps layout stable)
  const ph = document.createElement('div');
  ph.id = 'contour-canvas-placeholder';
  ph.style.cssText = 'width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:13px;';
  ph.textContent = 'Contour window is floating — close it to return';
  origWrap.appendChild(ph);

  inner.appendChild(canvas);
  win.appendChild(bar);
  win.appendChild(inner);
  document.body.appendChild(win);
  _floatWin = win;

  // Resize observer → rebuild canvas
  _floatRO = new ResizeObserver(() => {
    const saved2 = S.floatWin || (S.floatWin = {});
    saved2.w = win.offsetWidth; saved2.h = win.offsetHeight;
    initContour();
  });
  _floatRO.observe(inner);

  initContour();

  // ── Drag logic ──
  let drag = null;
  const onMove = e => {
    if (!drag) return;
    win.style.left = Math.max(0, Math.min(e.clientX - drag.dx, window.innerWidth  - 80)) + 'px';
    win.style.top  = Math.max(0, Math.min(e.clientY - drag.dy, window.innerHeight - 40)) + 'px';
  };
  const onUp = () => {
    if (!drag) return;
    drag = null;
    const f = S.floatWin || (S.floatWin = {});
    f.x = parseInt(win.style.left); f.y = parseInt(win.style.top);
    f.w = win.offsetWidth;          f.h = win.offsetHeight;
    persistState();
  };
  bar.addEventListener('mousedown', e => {
    if (e.target.closest('button')) return;
    drag = { dx: e.clientX - win.offsetLeft, dy: e.clientY - win.offsetTop };
    e.preventDefault();
  });
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
  win._drag = { onMove, onUp };

  // Update float-btn label
  const fb = document.getElementById('float-btn');
  if (fb) { fb.style.borderColor='var(--teal)'; fb.style.color='var(--teal)'; }
}

function _returnContourCanvas() {
  if (!_floatWin) return;
  const canvas = document.getElementById('contour-canvas');
  const origWrap = document.getElementById('contour-canvas-wrap');
  const ph = document.getElementById('contour-canvas-placeholder');

  origWrap.appendChild(canvas);
  if (ph) ph.remove();

  if (_floatRO) { _floatRO.disconnect(); _floatRO = null; }
  if (_floatWin._drag) {
    document.removeEventListener('mousemove', _floatWin._drag.onMove);
    document.removeEventListener('mouseup',   _floatWin._drag.onUp);
  }

  // Save final position/size
  const f = S.floatWin || (S.floatWin = {});
  f.x = parseInt(_floatWin.style.left); f.y = parseInt(_floatWin.style.top);
  f.w = _floatWin.offsetWidth;          f.h = _floatWin.offsetHeight;
  persistState();

  _floatWin.remove(); _floatWin = null;
  initContour();

  const fb = document.getElementById('float-btn');
  if (fb) { fb.style.borderColor=''; fb.style.color=''; }
}

// ── Floating Scale window (same pattern as Contour) ──────────────
let _scaleFloatWin = null;
let _scaleFloatRO  = null;

function toggleFloatScaleCanvas() {
  if (_scaleFloatWin) { _returnScaleCanvas(); return; }

  const canvas  = document.getElementById('scale-canvas');
  const origWrap = document.getElementById('scale-canvas-wrap');
  const saved   = S.scaleFloatWin || {};

  const win = document.createElement('div');
  win.id = 'scale-float-win';
  const iw = saved.w || Math.min(window.innerWidth  * 0.82, 1200);
  const ih = saved.h || Math.min(window.innerHeight * 0.85, 900);
  const il = saved.x ?? Math.max(0, (window.innerWidth  - iw) / 2);
  const it = saved.y ?? Math.max(40, (window.innerHeight - ih) / 2);
  win.style.cssText = `
    position:fixed;left:${il}px;top:${it}px;width:${iw}px;height:${ih}px;
    min-width:280px;min-height:200px;resize:both;overflow:hidden;
    background:var(--surface);border:1px solid var(--teal);border-radius:12px;
    z-index:900;display:flex;flex-direction:column;
    box-shadow:0 24px 64px rgba(0,0,0,.85);`;

  const bar = document.createElement('div');
  bar.style.cssText = `
    height:36px;background:#1e293b;border-bottom:1px solid var(--border);
    border-radius:12px 12px 0 0;display:flex;align-items:center;padding:0 10px;
    gap:8px;cursor:move;user-select:none;flex-shrink:0;`;
  bar.innerHTML = `
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--teal)" stroke-width="2">
      <rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/>
    </svg>
    <span style="font-size:12px;color:var(--subtle);flex:1;pointer-events:none;">Scale — drag to move · resize from corner</span>
    <button style="background:none;border:none;color:var(--subtle);cursor:pointer;font-size:18px;line-height:1;padding:0 2px;border-radius:4px;" title="Close window">✕</button>`;
  bar.querySelector('button').addEventListener('click', _returnScaleCanvas);

  const inner = document.createElement('div');
  inner.id = 'float-scale-inner';
  inner.style.cssText = 'flex:1;min-height:0;display:flex;justify-content:center;align-items:center;background:var(--bg);overflow:hidden;';

  const ph = document.createElement('div');
  ph.id = 'scale-canvas-placeholder';
  ph.style.cssText = 'width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:13px;';
  ph.textContent = 'Scale window is floating — close it to return';
  origWrap.appendChild(ph);

  inner.appendChild(canvas);
  win.appendChild(bar);
  win.appendChild(inner);
  document.body.appendChild(win);
  _scaleFloatWin = win;

  _scaleFloatRO = new ResizeObserver(() => {
    const s2 = S.scaleFloatWin || (S.scaleFloatWin = {});
    s2.w = win.offsetWidth; s2.h = win.offsetHeight;
    initScale();
  });
  _scaleFloatRO.observe(inner);
  // ResizeObserver fires on first observation after layout — no direct initScale() needed

  let drag = null;
  const onMove = e => {
    if (!drag) return;
    win.style.left = Math.max(0, Math.min(e.clientX - drag.dx, window.innerWidth  - 80)) + 'px';
    win.style.top  = Math.max(0, Math.min(e.clientY - drag.dy, window.innerHeight - 40)) + 'px';
  };
  const onUp = () => {
    if (!drag) return;
    drag = null;
    const f = S.scaleFloatWin || (S.scaleFloatWin = {});
    f.x = parseInt(win.style.left); f.y = parseInt(win.style.top);
    f.w = win.offsetWidth;          f.h = win.offsetHeight;
    persistState();
  };
  bar.addEventListener('mousedown', e => {
    if (e.target.closest('button')) return;
    drag = { dx: e.clientX - win.offsetLeft, dy: e.clientY - win.offsetTop };
    e.preventDefault();
  });
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
  win._drag = { onMove, onUp };

  const fb = document.getElementById('scale-float-btn');
  if (fb) { fb.style.borderColor='var(--teal)'; fb.style.color='var(--teal-light)'; }
}

function _returnScaleCanvas() {
  if (!_scaleFloatWin) return;
  const canvas   = document.getElementById('scale-canvas');
  const origWrap = document.getElementById('scale-canvas-wrap');
  const ph       = document.getElementById('scale-canvas-placeholder');

  origWrap.appendChild(canvas);
  if (ph) ph.remove();

  if (_scaleFloatRO) { _scaleFloatRO.disconnect(); _scaleFloatRO = null; }
  if (_scaleFloatWin._drag) {
    document.removeEventListener('mousemove', _scaleFloatWin._drag.onMove);
    document.removeEventListener('mouseup',   _scaleFloatWin._drag.onUp);
  }

  const f = S.scaleFloatWin || (S.scaleFloatWin = {});
  f.x = parseInt(_scaleFloatWin.style.left); f.y = parseInt(_scaleFloatWin.style.top);
  f.w = _scaleFloatWin.offsetWidth;          f.h = _scaleFloatWin.offsetHeight;
  persistState();

  _scaleFloatWin.remove(); _scaleFloatWin = null;
  initScale();

  const fb = document.getElementById('scale-float-btn');
  if (fb) { fb.style.borderColor=''; fb.style.color=''; }
}

function setContourView(v) {
  S.contourView = v; S.mouse = null;
  cActiveContour = 'outer';
  document.querySelectorAll('.contour-tab').forEach(t => t.classList.toggle('active', t.dataset.v === v));
  resetZoom();
  // Ensure this view has a segmentation mask before the canvas builds
  _ensureSegMask(v, () => {
    initContour();
    // Auto-detect if this view has no polygon yet
    setTimeout(() => {
      if (!S.polys[v]?.pts?.length) autoDetectContour();
    }, 150);
  });
}

// Interaction state — module-level so initContour can be called multiple times safely
let cPanStart = null, cPanMoved = false;
let cDragPt = null;
let cHoverPt = -1, cHoverEdge = -1;
let cHoverHolePt   = { hi: -1, pi: -1 };
let cHoverHoleEdge = { hi: -1, ei: -1 };
let cDragHolePt    = null;
let cCtxTarget = {};
// Active contour selector: 'outer' or hole index (0, 1, ...)
let cActiveContour = 'outer';
let _cEventsAttached = false;

function _cCoords(e) {
  const rc = cC.getBoundingClientRect();
  // Canvas CSS size always matches internal size (set explicitly in buildContourImg)
  // so no ratio scaling needed — just subtract the offset
  return { sx: e.clientX - rc.left, sy: e.clientY - rc.top };
}
const DRAG_THRESH = 10;
const PT_HIT = 12;

function _nearestPt(ix, iy) {
  const poly = S.polys[S.contourView];
  let best = -1, bestD = Infinity;
  poly.pts.forEach((p, i) => {
    const dx=(p.x-ix)*cZoom.s, dy=(p.y-iy)*cZoom.s;
    const d=Math.sqrt(dx*dx+dy*dy);
    if (d<bestD){bestD=d;best=i;}
  });
  return bestD < PT_HIT ? best : -1;
}
function _nearestEdge(ix, iy) {
  const poly = S.polys[S.contourView];
  if (!poly.closed||poly.pts.length<2) return -1;
  let best=-1,bestD=Infinity;
  for (let i=0;i<poly.pts.length;i++) {
    const a=poly.pts[i],b=poly.pts[(i+1)%poly.pts.length];
    const mx=(a.x+b.x)/2,my=(a.y+b.y)/2;
    const dx=(mx-ix)*cZoom.s,dy=(my-iy)*cZoom.s;
    const d=Math.sqrt(dx*dx+dy*dy);
    if (d<bestD){bestD=d;best=i;}
  }
  return bestD < PT_HIT*1.5 ? best : -1;
}
function _nearestHolePt(ix, iy, onlyHi=-1) {
  const holes = S.holes?.[S.contourView];
  if (!holes) return { hi:-1, pi:-1 };
  let bestHi=-1,bestPi=-1,bestD=Infinity;
  holes.forEach((hole,hi) => {
    if (onlyHi >= 0 && hi !== onlyHi) return;
    hole.forEach((p,pi) => {
      const dx=(p.x-ix)*cZoom.s, dy=(p.y-iy)*cZoom.s;
      const d=Math.sqrt(dx*dx+dy*dy);
      if (d<bestD){bestD=d;bestHi=hi;bestPi=pi;}
    });
  });
  return bestD < PT_HIT ? {hi:bestHi,pi:bestPi} : {hi:-1,pi:-1};
}
function _nearestHoleEdge(ix, iy, onlyHi=-1) {
  const holes = S.holes?.[S.contourView];
  if (!holes) return { hi:-1, ei:-1 };
  let bestHi=-1,bestEi=-1,bestD=Infinity;
  holes.forEach((hole,hi) => {
    if (onlyHi >= 0 && hi !== onlyHi) return;
    if (hole.length<2) return;
    for (let ei=0;ei<hole.length;ei++) {
      const a=hole[ei],b=hole[(ei+1)%hole.length];
      const mx=(a.x+b.x)/2,my=(a.y+b.y)/2;
      const dx=(mx-ix)*cZoom.s,dy=(my-iy)*cZoom.s;
      const d=Math.sqrt(dx*dx+dy*dy);
      if (d<bestD){bestD=d;bestHi=hi;bestEi=ei;}
    }
  });
  return bestD < PT_HIT*1.5 ? {hi:bestHi,ei:bestEi} : {hi:-1,ei:-1};
}

function _updateContourSelector() {
  const overlay = document.getElementById('contour-select-overlay');
  const badge   = document.getElementById('active-contour-badge');
  if (!overlay) return;
  const holes = S.holes?.[S.contourView] ?? [];
  if (!holes.length) {
    overlay.style.display = 'none';
    cActiveContour = 'outer';
    if (badge) badge.style.display = 'none';
    return;
  }
  overlay.style.display = 'flex';
  overlay.innerHTML = '';
  const items = [['outer','Outer'], ...holes.map((_,i) => [i, `Hole ${i+1}`])];
  items.forEach(([key, label]) => {
    const active = cActiveContour === key;
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.style.cssText = `padding:3px 10px;border-radius:5px;font-size:11px;cursor:pointer;white-space:nowrap;font-family:inherit;` +
      `border:1px solid ${active ? 'rgba(13,148,136,.9)' : 'rgba(100,116,139,.4)'};` +
      `background:${active ? 'rgba(13,148,136,.25)' : 'rgba(15,23,42,.75)'};` +
      `color:${active ? '#14B8A6' : '#94A3B8'};`;
    btn.onclick = () => { cActiveContour = key; _updateContourSelector(); drawContour(); };
    overlay.appendChild(btn);
  });
  // Badge in toolbar: show which contour is active
  if (badge) {
    if (cActiveContour === 'outer') {
      badge.style.display = 'none';
    } else {
      badge.textContent = `Hole ${cActiveContour + 1}`;
      badge.style.display = 'inline-block';
    }
  }
}

function _attachContourEvents() {
  if (_cEventsAttached) return;
  _cEventsAttached = true;

  cC.addEventListener('mousedown', (e) => {
    hideCtxMenu();
    if (e.button !== 0) return;
    const { sx, sy } = _cCoords(e);
    const { x: ix, y: iy } = screenToImg(sx, sy);
    if (cBgSampleMode) {
      _addBgSampleAt(ix, iy);
      return;
    }
    if (cRoiMode) {
      cRoiDrag = { x: ix, y: iy };
      cRoiRect = { x1: ix, y1: iy, x2: ix, y2: iy };
      return;
    }
    if (cC.dataset.guided) {
      cGuidedSeeds.push({ x: ix, y: iy });
      cCtx.save(); cCtx.translate(cZoom.ox,cZoom.oy); cCtx.scale(cZoom.s,cZoom.s);
      cCtx.beginPath(); cCtx.arc(ix,iy,8/cZoom.s,0,Math.PI*2);
      cCtx.fillStyle='rgba(251,191,36,.7)'; cCtx.fill();
      cCtx.restore();
      document.getElementById('contour-info').textContent = `🎯 ${cGuidedSeeds.length} seed points — click "Run Detection"`;
      return;
    }
    const poly = S.polys[S.contourView];
    // Hole point / edge hit — only when active contour is not 'outer'
    if (cActiveContour !== 'outer') {
      const onlyHi = typeof cActiveContour === 'number' ? cActiveContour : -1;
      const {hi:hpi, pi:hpiPi} = _nearestHolePt(ix, iy, onlyHi);
      if (hpi >= 0) { cDragHolePt={hi:hpi,pi:hpiPi}; cC.style.cursor='move'; return; }
      const {hi:hei, ei:heiEi} = _nearestHoleEdge(ix, iy, onlyHi);
      if (hei >= 0) {
        const hole=S.holes[S.contourView][hei];
        const a=hole[heiEi],b=hole[(heiEi+1)%hole.length];
        hole.splice(heiEi+1,0,{x:(a.x+b.x)/2,y:(a.y+b.y)/2});
        cDragHolePt={hi:hei,pi:heiEi+1}; cC.style.cursor='move'; drawContour(); return;
      }
    }
    if (cActiveContour === 'outer' && poly.closed) {
      const pi = _nearestPt(ix, iy);
      if (pi >= 0) { cDragPt={idx:pi}; cC.style.cursor='move'; return; }
      const ei = _nearestEdge(ix, iy);
      if (ei >= 0) {
        const a=poly.pts[ei],b=poly.pts[(ei+1)%poly.pts.length];
        poly.pts.splice(ei+1,0,{x:(a.x+b.x)/2,y:(a.y+b.y)/2});
        cDragPt={idx:ei+1}; cC.style.cursor='move'; drawContour(); return;
      }
    }
    cPanStart={ex:e.clientX,ey:e.clientY,ox:cZoom.ox,oy:cZoom.oy};
    cPanMoved=false; cC.style.cursor='grabbing';
  });

  cC.addEventListener('mousemove', (e) => {
    // Background sample mode: crosshair only
    if (cBgSampleMode) { cC.style.cursor = 'crosshair'; return; }
    // ROI mode: always crosshair; update rect when dragging
    if (cRoiMode) {
      cC.style.cursor = 'crosshair';
      if (cRoiDrag) {
        const { sx, sy } = _cCoords(e);
        const { x: ix, y: iy } = screenToImg(sx, sy);
        cRoiRect = {
          x1: Math.min(cRoiDrag.x,ix), y1: Math.min(cRoiDrag.y,iy),
          x2: Math.max(cRoiDrag.x,ix), y2: Math.max(cRoiDrag.y,iy),
        };
        drawContour();
      }
      return;
    }
    if (cDragHolePt) {
      const { sx, sy } = _cCoords(e);
      const { x, y } = screenToImg(sx, sy);
      S.holes[S.contourView][cDragHolePt.hi][cDragHolePt.pi]={x,y};
      drawContour(); return;
    }
    if (cDragPt) {
      const { sx, sy } = _cCoords(e);
      const { x, y } = screenToImg(sx, sy);
      S.polys[S.contourView].pts[cDragPt.idx]={x,y};
      drawContour(); return;
    }
    if (cPanStart) {
      const dx=e.clientX-cPanStart.ex, dy=e.clientY-cPanStart.ey;
      if (cPanMoved||Math.abs(dx)>DRAG_THRESH/2||Math.abs(dy)>DRAG_THRESH/2) {
        cPanMoved=true;
        // CSS size always matches internal size, so ratio is 1:1
        cZoom.ox=cPanStart.ox+dx;
        cZoom.oy=cPanStart.oy+dy;
        drawContour();
      }
      return;
    }
    const { sx, sy } = _cCoords(e);
    const { x: ix, y: iy } = screenToImg(sx, sy);
    const poly = S.polys[S.contourView];
    // Hole hover
    const {hi:hHi,pi:hPi} = _nearestHolePt(ix,iy);
    const {hi:heHi,ei:heEi} = hHi<0 ? _nearestHoleEdge(ix,iy) : {hi:-1,ei:-1};
    const holeChanged = hHi!==cHoverHolePt.hi||hPi!==cHoverHolePt.pi||heHi!==cHoverHoleEdge.hi||heEi!==cHoverHoleEdge.ei;
    if (holeChanged) { cHoverHolePt={hi:hHi,pi:hPi}; cHoverHoleEdge={hi:heHi,ei:heEi}; drawContour(); }
    if (hHi>=0) { cC.style.cursor='move'; return; }
    if (heHi>=0) { cC.style.cursor='cell'; return; }
    if (poly.closed) {
      const pi=_nearestPt(ix,iy), ei=pi<0?_nearestEdge(ix,iy):-1;
      if (pi!==cHoverPt||ei!==cHoverEdge) { cHoverPt=pi; cHoverEdge=ei; drawContour(); }
      cC.style.cursor=pi>=0?'move':ei>=0?'cell':'grab';
    } else {
      cC.style.cursor='crosshair'; S.mouse=screenToImg(sx,sy);
      if (poly.pts.length) drawContour();
    }
  });

  cC.addEventListener('mouseup', (e) => {
    if (cRoiMode && cRoiDrag) {
      cRoiDrag=null;
      if (cRoiRect&&(cRoiRect.x2-cRoiRect.x1)>8&&(cRoiRect.y2-cRoiRect.y1)>8) {
        _exitRoiMode(); autoDetectContourInROI({...cRoiRect});
      } else { cRoiRect=null; drawContour(); }
      return;
    }
    if (cDragHolePt) { cDragHolePt=null; persistState(); cC.style.cursor='grab'; return; }
    if (cDragPt) { cDragPt=null; updateContourInfo(); persistState(); cC.style.cursor='grab'; return; }
    if (e.button!==0) return;
    const wasPan=cPanMoved;
    cPanStart=null; cPanMoved=false;
    const poly=S.polys[S.contourView];
    cC.style.cursor=poly.closed?'grab':'crosshair';
    if (wasPan) return;
    if (poly.closed) return;
    const { sx, sy } = _cCoords(e);
    const { x, y } = screenToImg(sx, sy);
    if (poly.pts.length>=3) {
      const f=poly.pts[0];
      if (Math.sqrt((x-f.x)**2+(y-f.y)**2)<14/cZoom.s) {
        poly.closed=true; cHoverPt=-1; cHoverEdge=-1;
        drawContour(); updateContourInfo(); persistState(); return;
      }
    }
    poly.pts.push({x,y}); drawContour(); updateContourInfo();
  });

  cC.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const { sx, sy } = _cCoords(e);
    const { x: ix, y: iy } = screenToImg(sx, sy);
    const poly=S.polys[S.contourView];
    const {hi:hpi,pi:hpiPi} = _nearestHolePt(ix,iy);
    const {hi:hei,ei:heiEi} = hpi<0 ? _nearestHoleEdge(ix,iy) : {hi:-1,ei:-1};
    if (hpi>=0 || hei>=0) {
      cCtxTarget={pi:-1,ei:-1,x:ix,y:iy,hpi,hpiPi,hei,heiEi};
      showHoleCtxMenu(e.clientX,e.clientY,hpi,hpiPi,hei,heiEi);
      return;
    }
    const pi=_nearestPt(ix,iy), ei=pi<0?_nearestEdge(ix,iy):-1;
    cCtxTarget={pi,ei,x:ix,y:iy,hpi:-1,hpiPi:-1,hei:-1,heiEi:-1};
    showCtxMenu(e.clientX,e.clientY,pi>=0,poly.pts.length>=3);
  });

  cC.addEventListener('mouseleave', () => {
    cPanStart=null; cPanMoved=false; S.mouse=null;
    cHoverPt=-1; cHoverEdge=-1;
    cHoverHolePt={hi:-1,pi:-1}; cHoverHoleEdge={hi:-1,ei:-1};
    drawContour();
  });

  cC.addEventListener('wheel', (e) => {
    e.preventDefault();
    const { sx, sy } = _cCoords(e);
    zoomBy(e.deltaY<0?1.15:0.87, sx, sy);
  }, { passive: false });
}

function initContour() {
  cC = document.getElementById('contour-canvas');
  if (!cC) return;
  cCtx = cC.getContext('2d');
  _attachContourEvents();   // no-op after first call
  // Sync point-count select with saved preference
  const psel = document.getElementById('pts-count-sel');
  if (psel && S.contourTargetPts) psel.value = String(S.contourTargetPts);

  // Capture the view NOW — async callbacks below must use this, not S.contourView,
  // because the user may switch views before the image loads.
  const myView = S.contourView;
  const url = S.imgs[myView];
  if (!url) return;

  // Build composite: original image + segmentation overlay
  const buildContourImg = (origImg) => {
    // Stale check: user already switched to a different view — discard this load
    if (myView !== S.contourView) return;

    const wrap = cC.parentElement;
    const maxW = Math.max(wrap.clientWidth  - 2, 200);
    const maxH = Math.max(wrap.clientHeight - 2, 300);
    const r = Math.min(maxW/origImg.width, maxH/origImg.height);
    const w = Math.round(origImg.width*r), h = Math.round(origImg.height*r);
    cC.width=w; cC.height=h;
    // Keep CSS display size in sync with internal size to prevent coordinate mismatch
    cC.style.width  = w + 'px';
    cC.style.height = h + 'px';

    // Scale existing polygon points proportionally when canvas size changes
    if (!S.polyCanvasSize) S.polyCanvasSize={};
    const oldSz = S.polyCanvasSize[myView];
    if (oldSz && oldSz.w > 0 && (oldSz.w !== w || oldSz.h !== h)) {
      const sx = w / oldSz.w, sy = h / oldSz.h;
      const poly = S.polys[myView];
      if (poly?.pts?.length) poly.pts = poly.pts.map(p=>({x:p.x*sx,y:p.y*sy}));
      const holes = S.holes?.[myView];
      if (holes) S.holes[myView] = holes.map(h=>h.map(p=>({x:p.x*sx,y:p.y*sy})));
    }
    S.polyCanvasSize[myView]={w,h};

    const tmpC=document.createElement('canvas'); tmpC.width=w; tmpC.height=h;
    const tmpCtx=tmpC.getContext('2d');

    // Prefer Computed (sealed+filled) mask; fall back to raw segmentation mask
    const segMaskData = S.segMaskImproved?.[myView] ?? S.segMasks?.[myView];

    if (segMaskData && !S.showSilhouette) {
      // Default: show clean Computed silhouette as background (white=object, dark=bg)
      const {mask,W:mW,H:mH} = segMaskData;
      const mC=document.createElement('canvas'); mC.width=mW; mC.height=mH;
      const mCtx=mC.getContext('2d');
      const mImg=mCtx.createImageData(mW,mH);
      for (let i=0;i<mW*mH;i++) {
        const obj=mask[i]>128;
        mImg.data[i*4]   = obj ? 240 : 20;
        mImg.data[i*4+1] = obj ? 248 : 28;
        mImg.data[i*4+2] = obj ? 248 : 38;
        mImg.data[i*4+3] = 255;
      }
      mCtx.putImageData(mImg,0,0);
      tmpCtx.fillStyle='#14181E'; tmpCtx.fillRect(0,0,w,h);
      tmpCtx.drawImage(mC,0,0,w,h);
    } else {
      // Silhouette toggle ON (or no mask): show original photo + teal overlay if mask exists
      tmpCtx.drawImage(origImg,0,0,w,h);
      if (segMaskData) {
        const {mask,W:mW,H:mH}=segMaskData;
        const mC=document.createElement('canvas'); mC.width=mW; mC.height=mH;
        const mCtx=mC.getContext('2d');
        const mImg=mCtx.createImageData(mW,mH);
        for (let i=0;i<mW*mH;i++) {
          const isObj=mask[i]>128;
          mImg.data[i*4]=isObj?13:0; mImg.data[i*4+1]=isObj?148:0;
          mImg.data[i*4+2]=isObj?136:0; mImg.data[i*4+3]=isObj?70:0;
        }
        mCtx.putImageData(mImg,0,0); tmpCtx.drawImage(mC,0,0,w,h);
      }
    }

    cImg = new Image();
    cImg.onload = () => {
      // Stale check: user switched views while image was encoding — discard
      if (myView !== S.contourView) return;
      // Auto-zoom to object the first time a view is opened (no polygon, no user pan)
      const sm = S.segMeta?.[myView];
      if (sm?.bbox && cZoom.s === 1 && cZoom.ox === 0 && cZoom.oy === 0 && !S.polys[myView].pts.length) {
        _autoZoomToSegBbox(sm.bbox, sm.W, sm.H, w, h);
      }
      _updateContourSelector();
      drawContour();
    };
    cImg.src = tmpC.toDataURL();
  };

  const orig=new Image(); orig.onload=()=>buildContourImg(orig); orig.src=url;
}

// Zooms the contour canvas so the object region fills it with a small margin.
// bb is in mask pixel space; canvasW/H is the canvas internal size.
function _autoZoomToSegBbox(bb, maskW, maskH, canvasW, canvasH) {
  const scX = canvasW / maskW, scY = canvasH / maskH;
  const x0 = bb.minX * scX, y0 = bb.minY * scY;
  const x1 = bb.maxX * scX, y1 = bb.maxY * scY;
  const pad = 0.12;
  const objW = x1 - x0, objH = y1 - y0;
  const fitS = Math.min(canvasW / (objW * (1 + 2*pad)), canvasH / (objH * (1 + 2*pad)), 4);
  cZoom.s = fitS;
  cZoom.ox = canvasW / 2 - fitS * (x0 + x1) / 2;
  cZoom.oy = canvasH / 2 - fitS * (y0 + y1) / 2;
  const el = document.getElementById('zoom-pct');
  if (el) el.textContent = `${Math.round(fitS * 100)}%`;
}

function drawContour() {
  if (!cCtx || !cImg) return;
  cCtx.clearRect(0, 0, cC.width, cC.height);
  cCtx.save();
  cCtx.translate(cZoom.ox, cZoom.oy);
  cCtx.scale(cZoom.s, cZoom.s);

  cCtx.drawImage(cImg, 0, 0, cC.width, cC.height);

  const poly = S.polys[S.contourView];
  if (poly.pts.length) {
    const pts = poly.pts;
    const lw = 2 / cZoom.s;
    const dr = 5 / cZoom.s, fr = 8 / cZoom.s, hr = 7 / cZoom.s;

    // Build combined fill path (outer + holes) with evenodd rule so holes are transparent
    const holes = S.holes?.[S.contourView];
    if (poly.closed) {
      cCtx.beginPath();
      cCtx.moveTo(pts[0].x, pts[0].y);
      pts.slice(1).forEach(p => cCtx.lineTo(p.x, p.y));
      cCtx.closePath();
      if (holes) holes.forEach(hole => {
        if (hole.length < 3) return;
        cCtx.moveTo(hole[0].x, hole[0].y);
        hole.slice(1).forEach(p => cCtx.lineTo(p.x, p.y));
        cCtx.closePath();
      });
      cCtx.fillStyle = 'rgba(13,148,136,.15)';
      cCtx.fill('evenodd');
    }

    // Outer contour stroke (brighter when active)
    const outerActive = cActiveContour === 'outer';
    cCtx.beginPath(); cCtx.moveTo(pts[0].x, pts[0].y);
    pts.slice(1).forEach(p => cCtx.lineTo(p.x, p.y));
    if (poly.closed) cCtx.closePath();
    else if (S.mouse) cCtx.lineTo(S.mouse.x, S.mouse.y);
    cCtx.strokeStyle = outerActive ? '#14B8A6' : '#0D9488';
    cCtx.lineWidth = outerActive ? lw * 1.6 : lw;
    cCtx.stroke();

    // Hole strokes + interactive points (editable)
    if (holes) holes.forEach((hole, hi) => {
      if (hole.length < 3) return;
      const holeActive = cActiveContour === hi;
      cCtx.beginPath(); cCtx.moveTo(hole[0].x, hole[0].y);
      hole.slice(1).forEach(p => cCtx.lineTo(p.x, p.y));
      cCtx.closePath();
      cCtx.strokeStyle = holeActive ? '#F87171' : '#EF4444';
      cCtx.lineWidth = holeActive ? lw * 1.4 : lw * 0.8;
      cCtx.stroke();
      // Edge midpoint hint
      if (cHoverHoleEdge.hi === hi && cHoverHoleEdge.ei >= 0) {
        const ei = cHoverHoleEdge.ei;
        const a=hole[ei], b=hole[(ei+1)%hole.length];
        cCtx.beginPath(); cCtx.arc((a.x+b.x)/2,(a.y+b.y)/2, hr, 0, Math.PI*2);
        cCtx.fillStyle='rgba(251,191,36,.8)'; cCtx.fill();
        cCtx.strokeStyle='white'; cCtx.lineWidth=lw*.8; cCtx.stroke();
      }
      // Points
      hole.forEach((p, pi) => {
        const isHov = cHoverHolePt.hi===hi && cHoverHolePt.pi===pi;
        cCtx.beginPath(); cCtx.arc(p.x, p.y, isHov ? dr*1.5 : dr, 0, Math.PI*2);
        cCtx.fillStyle = isHov ? '#f59e0b' : '#EF4444'; cCtx.fill();
        cCtx.strokeStyle = 'white'; cCtx.lineWidth = lw*.8; cCtx.stroke();
      });
    });

    // Edge midpoint hint when hovering edge
    if (cHoverEdge >= 0 && poly.closed) {
      const a = pts[cHoverEdge], b = pts[(cHoverEdge+1)%pts.length];
      const mx=(a.x+b.x)/2, my=(a.y+b.y)/2;
      cCtx.beginPath(); cCtx.arc(mx, my, hr, 0, Math.PI*2);
      cCtx.fillStyle = 'rgba(251,191,36,.8)'; cCtx.fill();
      cCtx.strokeStyle = 'white'; cCtx.lineWidth = lw*.8; cCtx.stroke();
    }

    // Points
    pts.forEach((p, i) => {
      const isFirst = i === 0;
      const isHover = i === cHoverPt;
      const r = isFirst ? fr : isHover ? dr*1.5 : dr;
      cCtx.beginPath(); cCtx.arc(p.x, p.y, r, 0, Math.PI*2);
      cCtx.fillStyle = isHover ? '#f59e0b' : isFirst ? '#F97316' : '#14B8A6';
      cCtx.fill();
      cCtx.strokeStyle = 'white'; cCtx.lineWidth = lw*.8; cCtx.stroke();
    });
  }
  // ROI rectangle overlay
  if (cRoiRect) {
    const { x1, y1, x2, y2 } = cRoiRect;
    const lw = 1.5 / cZoom.s;
    cCtx.save();
    cCtx.strokeStyle = '#F59E0B';
    cCtx.lineWidth = lw;
    cCtx.setLineDash([5/cZoom.s, 4/cZoom.s]);
    cCtx.strokeRect(x1, y1, x2-x1, y2-y1);
    cCtx.fillStyle = 'rgba(245,158,11,.08)';
    cCtx.fillRect(x1, y1, x2-x1, y2-y1);
    cCtx.setLineDash([]);
    cCtx.restore();
  }

  cCtx.restore();
}

// ── Context menu ─────────────────────────────────────────────
function showCtxMenu(cx, cy, hasPt, canDel) {
  let m = document.getElementById('c-ctx');
  if (!m) {
    m = document.createElement('div');
    m.id = 'c-ctx';
    m.style.cssText = 'position:fixed;background:#1e293b;border:1px solid #334155;border-radius:10px;padding:4px;z-index:9999;display:none;min-width:140px;box-shadow:0 8px 24px rgba(0,0,0,.5);';
    document.body.appendChild(m);
    document.addEventListener('mousedown', e => { if (!m.contains(e.target)) hideCtxMenu(); });
  }
  const btn = (label, fn, danger=false) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = `display:block;width:100%;text-align:left;padding:7px 12px;background:none;border:none;color:${danger?'#f87171':'#e2e8f0'};font-size:13px;cursor:pointer;border-radius:7px;`;
    b.onmouseenter = () => b.style.background = danger ? 'rgba(248,113,113,.15)' : 'rgba(255,255,255,.08)';
    b.onmouseleave = () => b.style.background = 'none';
    b.onclick = () => { fn(); hideCtxMenu(); };
    return b;
  };
  m.innerHTML = '';
  if (hasPt && canDel) m.appendChild(btn('🗑 Delete Point', ctxDeletePt, true));
  if (!hasPt) m.appendChild(btn('➕ Add Here', ctxInsertEdgePt));
  m.appendChild(btn('✨ Smooth Contour', smoothContour));
  // Add Hole via right-click — only when auto-detect did not confirm zero holes.
  const _holesKnown = S.holes?.[S.contourView];
  const _noHolesConfirmed = Array.isArray(_holesKnown) && _holesKnown.length === 0;
  if (S.polys[S.contourView]?.closed && !_noHolesConfirmed) {
    m.appendChild(btn('🕳 Add Hole Here', () => addHole(cCtxTarget.x, cCtxTarget.y)));
  }
  m.appendChild(btn('🔄 Reopen', () => { S.polys[S.contourView].closed=false; cHoverPt=-1; drawContour(); updateContourInfo(); }));
  m.appendChild(btn('🗑 Clear All', clearContour, true));
  m.style.display = 'block';
  const mw = 160, mh = 200;
  m.style.left = Math.min(cx, window.innerWidth-mw-8) + 'px';
  m.style.top  = Math.min(cy, window.innerHeight-mh-8) + 'px';
}
function hideCtxMenu() { const m=document.getElementById('c-ctx'); if(m) m.style.display='none'; }
function ctxDeletePt() {
  const poly = S.polys[S.contourView];
  const i = cCtxTarget.pi;
  if (i < 0 || poly.pts.length <= 3) return;
  poly.pts.splice(i, 1);
  cHoverPt = -1; drawContour(); updateContourInfo(); persistState();
}
function ctxInsertEdgePt() {
  const poly = S.polys[S.contourView];
  if (cCtxTarget.ei >= 0) {
    const ei = cCtxTarget.ei;
    const a = poly.pts[ei], b = poly.pts[(ei+1)%poly.pts.length];
    poly.pts.splice(ei+1, 0, { x:(a.x+b.x)/2, y:(a.y+b.y)/2 });
  } else {
    poly.pts.push({ x: cCtxTarget.x, y: cCtxTarget.y });
  }
  drawContour(); updateContourInfo(); persistState();
}

// ── Hole context menu ─────────────────────────────────────────
function showHoleCtxMenu(cx, cy, hpi, hpiPi, hei, heiEi) {
  let m = document.getElementById('c-ctx');
  if (!m) {
    m = document.createElement('div');
    m.id = 'c-ctx';
    m.style.cssText = 'position:fixed;background:#1e293b;border:1px solid #334155;border-radius:10px;padding:4px;z-index:9999;display:none;min-width:160px;box-shadow:0 8px 24px rgba(0,0,0,.5);';
    document.body.appendChild(m);
    document.addEventListener('mousedown', e => { if (!m.contains(e.target)) hideCtxMenu(); });
  }
  const btn = (label, fn, danger=false) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = `display:block;width:100%;text-align:left;padding:7px 12px;background:none;border:none;color:${danger?'#f87171':'#e2e8f0'};font-size:13px;cursor:pointer;border-radius:7px;`;
    b.onmouseenter = () => b.style.background = danger ? 'rgba(248,113,113,.15)' : 'rgba(255,255,255,.08)';
    b.onmouseleave = () => b.style.background = 'none';
    b.onclick = () => { fn(); hideCtxMenu(); };
    return b;
  };
  m.innerHTML = '';
  const holes = S.holes?.[S.contourView];
  if (!holes) return;
  if (hpi >= 0 && holes[hpi].length > 3) {
    m.appendChild(btn('🗑 Delete Point', () => {
      holes[hpi].splice(hpiPi, 1);
      cHoverHolePt={hi:-1,pi:-1}; drawContour(); persistState();
    }, true));
  }
  if (hei >= 0) {
    m.appendChild(btn('➕ Add Point Here', () => {
      const hole=holes[hei], a=hole[heiEi], b=hole[(heiEi+1)%hole.length];
      hole.splice(heiEi+1,0,{x:(a.x+b.x)/2,y:(a.y+b.y)/2});
      drawContour(); persistState();
    }));
  }
  const delHi = hpi >= 0 ? hpi : hei;
  m.appendChild(btn('🗑 Delete Hole', () => {
    S.holes[S.contourView].splice(delHi, 1);
    cHoverHolePt={hi:-1,pi:-1}; cHoverHoleEdge={hi:-1,ei:-1};
    if (typeof cActiveContour === 'number' && cActiveContour >= (S.holes[S.contourView]?.length ?? 0)) cActiveContour = 'outer';
    _updateContourSelector(); drawContour(); persistState();
  }, true));
  m.style.display = 'block';
  m.style.left = Math.min(cx, window.innerWidth-180-8) + 'px';
  m.style.top  = Math.min(cy, window.innerHeight-160-8) + 'px';
}

// ── Add a hole contour at the given canvas position (or centroid of outer poly) ──
function addHole(x, y) {
  if (!S.polys?.[S.contourView]?.closed) return;
  if (!S.holes) S.holes = {};
  if (!S.holes[S.contourView]) S.holes[S.contourView] = [];

  // If no position given, place at centroid of outer contour
  if (x === undefined) {
    const pts = S.polys[S.contourView].pts;
    x = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    y = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  }

  const r = 24 / cZoom.s;
  const octagon = Array.from({length: 8}, (_, i) => {
    const a = (i / 8) * Math.PI * 2;
    return { x: x + r * Math.cos(a), y: y + r * Math.sin(a) };
  });
  S.holes[S.contourView].push(octagon);
  cActiveContour = S.holes[S.contourView].length - 1;
  _updateContourSelector();
  drawContour();
  persistState();
}

// ── Sync the Add Hole button enabled state ────────────────────────────────────
function _updateAddHoleBtn() {
  const btn = document.getElementById('add-hole-btn');
  if (!btn) return;
  const closed = !!S.polys?.[S.contourView]?.closed;
  btn.style.opacity = closed ? '1' : '0.4';
  btn.style.pointerEvents = closed ? 'auto' : 'none';
}

// ── Contour smoothing (Gaussian smooth on polygon vertices) ──
function smoothContour() {
  const poly = S.polys[S.contourView];
  if (poly.pts.length < 4) return;
  const n = poly.pts.length;
  const sigma = 1.5, passes = 2;
  // Precompute Gaussian weights [-2..2]
  const ws = [-2,-1,0,1,2].map(k => Math.exp(-(k*k)/(2*sigma*sigma)));
  const wsum = ws.reduce((a,b)=>a+b,0);
  for (let pass=0; pass<passes; pass++) {
    const src = poly.pts.map(p=>({...p}));
    for (let i=0; i<n; i++) {
      let sx=0, sy=0;
      for (let k=-2; k<=2; k++) {
        const j=((i+k)%n+n)%n, w=ws[k+2];
        sx+=src[j].x*w; sy+=src[j].y*w;
      }
      poly.pts[i] = { x:sx/wsum, y:sy/wsum };
    }
  }
  // Re-simplify with fixed epsilon — result should not depend on current zoom level
  const simplified = douglasPeucker(poly.pts, 1.5);
  poly.pts = simplified.length >= 3 ? simplified : poly.pts;
  drawContour(); updateContourInfo(); persistState();
}

// ── Background texture sampling ──────────────────────────────
// User clicks a background region; local (mean, std) is recorded.
// Re-running contour detection excludes pixels with matching texture profiles.

function toggleSilhouette() {
  S.showSilhouette = !S.showSilhouette;
  const btn = document.getElementById('silhouette-btn');
  if (btn) {
    const on = S.showSilhouette;
    btn.style.background  = on ? 'rgba(13,148,136,.2)' : 'transparent';
    btn.style.borderColor = on ? 'var(--teal)' : 'var(--border)';
    btn.style.color       = on ? 'var(--teal-light)' : 'var(--subtle)';
  }
  initContour();
}

function toggleBgSampleMode() {
  if (cRoiMode) toggleRoiMode();
  cBgSampleMode = !cBgSampleMode;
  const btn = document.getElementById('bgsample-btn');
  if (!btn) return;
  if (cBgSampleMode) {
    cC.style.cursor = 'crosshair';
    btn.style.borderColor='#F59E0B'; btn.style.background='rgba(245,158,11,.15)'; btn.style.color='#FCD34D';
    document.getElementById('contour-info').textContent = '🔬 Click on background area — contour will exclude it';
  } else {
    _refreshBgSampleBtn();
    if (cC) cC.style.cursor = S.polys[S.contourView]?.closed ? 'grab' : 'crosshair';
  }
}

function _refreshBgSampleBtn() {
  const btn = document.getElementById('bgsample-btn');
  if (!btn) return;
  const n = S.bgSamples?.[S.contourView]?.length ?? 0;
  btn.textContent = n > 0 ? `🔬 Background ×${n}` : '🔬 Background';
  const active = n > 0;
  btn.style.borderColor = active ? '#F59E0B' : 'var(--border)';
  btn.style.background  = active ? 'rgba(245,158,11,.1)' : 'transparent';
  btn.style.color       = active ? '#FCD34D' : 'var(--subtle)';
}

function _addBgSampleAt(ix, iy) {
  const view = S.contourView;
  const url  = S.imgs[view];
  if (!url) return;
  const img = new Image();
  img.onload = () => {
    const maxW=900, maxH=700;
    const r=Math.min(maxW/img.width, maxH/img.height, 1);
    const W=Math.round(img.width*r), H=Math.round(img.height*r);
    const tmpC=document.createElement('canvas'); tmpC.width=W; tmpC.height=H;
    tmpC.getContext('2d').drawImage(img,0,0,W,H);
    const px=tmpC.getContext('2d').getImageData(0,0,W,H).data;
    const luma=new Uint8ClampedArray(W*H);
    for (let i=0;i<W*H;i++) luma[i]=px[i*4]*.299+px[i*4+1]*.587+px[i*4+2]*.114;

    // ix,iy are in canvas image space → scale to working space
    const cpx=Math.min(W-1, Math.max(0, Math.round(ix*W/cC.width)));
    const cpy=Math.min(H-1, Math.max(0, Math.round(iy*H/cC.height)));

    // Sample brightness in a small circle (~1.2% of image)
    const sR=Math.max(3, Math.round(Math.min(W,H)*0.012));
    let bgSum=0, bgSqSum=0, bgCnt=0;
    for (let dy=-sR;dy<=sR;dy++) for (let dx=-sR;dx<=sR;dx++) {
      const nx=cpx+dx, ny=cpy+dy;
      if (nx<0||nx>=W||ny<0||ny>=H) continue;
      const l=luma[ny*W+nx]; bgSum+=l; bgSqSum+=l*l; bgCnt++;
    }
    if (!bgCnt) return;
    const bgMean=bgSum/bgCnt;
    const bgStd=Math.sqrt(Math.max(0, bgSqSum/bgCnt - bgMean*bgMean));
    // Adaptive tolerance: wider when local texture is noisier
    const bgTol=Math.max(20, bgStd*2.5+15);
    // Correction radius: 15% of image — wide enough to cover adjacent bg area
    const corrR=Math.round(Math.min(W,H)*0.15);

    if (!S.bgSamples) S.bgSamples={};
    if (!S.bgSamples[view]) S.bgSamples[view]=[];
    S.bgSamples[view].push({px:cpx, py:cpy, corrR, bgMean, bgTol});

    // Immediately push polygon vertices that sit in this bg area inward
    const poly=S.polys[view];
    if (poly?.closed && poly.pts.length) {
      // Centroid in working space
      const scaleX=W/cC.width, scaleY=H/cC.height;
      const cx=poly.pts.reduce((s,p)=>s+p.x,0)/poly.pts.length*scaleX;
      const cy=poly.pts.reduce((s,p)=>s+p.y,0)/poly.pts.length*scaleY;
      const isBg=(x,y)=>Math.abs(luma[y*W+x]-bgMean)<=bgTol;
      let changed=false;
      for (let i=0;i<poly.pts.length;i++) {
        const ppx=Math.round(poly.pts[i].x*scaleX), ppy=Math.round(poly.pts[i].y*scaleY);
        if (Math.hypot(ppx-cpx,ppy-cpy)>corrR) continue;
        if (!isBg(ppx,ppy)) continue;
        // Walk inward toward centroid until non-bg pixel found
        const dx=cx-ppx, dy=cy-ppy, d=Math.sqrt(dx*dx+dy*dy)||1;
        const maxK=Math.round(Math.min(W,H)*0.30);
        for (let k=1;k<=maxK;k++) {
          const nx=Math.round(ppx+(dx/d)*k), ny=Math.round(ppy+(dy/d)*k);
          if (nx<0||nx>=W||ny<0||ny>=H) break;
          if (!isBg(nx,ny)) {
            poly.pts[i]={x:nx/scaleX, y:ny/scaleY};
            changed=true; break;
          }
        }
      }
      if (changed) { drawContour(); updateContourInfo(); persistState(); }
    }

    cBgSampleMode=false;
    _refreshBgSampleBtn();
    if (cC) cC.style.cursor = poly?.closed ? 'grab' : 'crosshair';
    // Re-run full pipeline so future auto-detects also respect the sample
    autoDetectContour();
  };
  img.src = url;
}

// ── ROI (Region of Interest) contour detection ───────────────
// User draws a bounding rectangle; auto-detect runs only inside it.
// Coordinates are in canvas image space (cC.width × cC.height).

function toggleRoiMode() {
  if (cRoiMode) { _exitRoiMode(); return; }
  cRoiMode = true; cRoiRect = null; cRoiDrag = null;
  const btn = document.getElementById('roi-btn');
  if (btn) { btn.style.borderColor='#F59E0B'; btn.style.background='rgba(245,158,11,.15)'; btn.style.color='#FCD34D'; }
  document.getElementById('contour-info').textContent = '□ Drag a rectangle over the object — detection will apply only inside';
  if (cC) cC.style.cursor = 'crosshair';
}

function _exitRoiMode() {
  cRoiMode = false;
  const btn = document.getElementById('roi-btn');
  if (btn) { btn.style.borderColor='var(--border)'; btn.style.background='transparent'; btn.style.color='var(--subtle)'; }
  if (cC) cC.style.cursor = S.polys[S.contourView]?.closed ? 'grab' : 'crosshair';
}

// Silhouette-based ROI contour:
// 1. Crop the binary silhouette mask to the drawn rectangle
// 2. From each side of the rectangle, march inward until a white (object) pixel is found
//    — this shrinks the bounding box to the tightest fit around the object
// 3. Trace the silhouette boundary inside that tight box → the polygon
function _roiContourFromSilhouette(rect, mask, maskW, maskH) {
  const view = S.contourView;

  // Convert drawn rectangle from canvas coords to mask coords
  const scX = maskW / (cC?.width || maskW), scY = maskH / (cC?.height || maskH);
  let x1 = Math.max(0,      Math.round(rect.x1 * scX));
  let y1 = Math.max(0,      Math.round(rect.y1 * scY));
  let x2 = Math.min(maskW,  Math.round(rect.x2 * scX));
  let y2 = Math.min(maskH,  Math.round(rect.y2 * scY));
  if (x2 - x1 < 4 || y2 - y1 < 4) { cRoiRect = null; drawContour(); return; }

  // March each edge inward until it touches a white pixel in the silhouette
  outer: for (let y = y1; y < y2; y++) { for (let x = x1; x < x2; x++) if (mask[y*maskW+x]) { y1=y; break outer; } }
  outer: for (let y = y2-1; y >= y1; y--) { for (let x = x1; x < x2; x++) if (mask[y*maskW+x]) { y2=y+1; break outer; } }
  outer: for (let x = x1; x < x2; x++) { for (let y = y1; y < y2; y++) if (mask[y*maskW+x]) { x1=x; break outer; } }
  outer: for (let x = x2-1; x >= x1; x--) { for (let y = y1; y < y2; y++) if (mask[y*maskW+x]) { x2=x+1; break outer; } }

  const rW = x2 - x1, rH = y2 - y1;
  if (rW < 4 || rH < 4) { cRoiRect = null; drawContour(); alert('No object found in selected area'); return; }

  // Crop silhouette to the shrunk box
  const roi = new Uint8ClampedArray(rW * rH);
  for (let y = 0; y < rH; y++) for (let x = 0; x < rW; x++)
    roi[y*rW+x] = mask[(y+y1)*maskW + (x+x1)];

  // Remove isolated noise blobs before tracing
  const cleaned = _removeSmallBlobs(roi, rW, rH, 0.05);

  // Find dominant blob and run Suzuki-Abe (outer + holes)
  const blob = findLargestBlob(cleaned, rW, rH);
  if (!blob || blob.length < 20) { cRoiRect = null; drawContour(); alert('No object found in selected area'); return; }
  const blobMask = new Uint8ClampedArray(rW * rH);
  blob.forEach(i => blobMask[i] = 255);

  // Suzuki-Abe: outer contour + topologically-correct holes
  const allContoursR = _suzukiAbe(blobMask, rW, rH);
  const outersR = allContoursR.filter(c => !c.isHole && c.pts.length >= 4);
  if (!outersR.length) { cRoiRect = null; drawContour(); alert('Could not detect contour'); return; }
  const outerPtsR = outersR.reduce((a, b) => b.pts.length > a.pts.length ? b : a).pts;

  const step = Math.max(1, Math.floor(outerPtsR.length / 2500));
  const sub = outerPtsR.filter((_, i) => i % step === 0);
  const simplified = douglasPeucker(sub, 0.4);

  // Map back from mask-crop space → canvas space
  const toCanvasX = cC ? cC.width  / maskW : 1;
  const toCanvasY = cC ? cC.height / maskH : 1;
  S.polys[view] = {
    pts: simplified.map(p => ({ x: (p.x + x1) * toCanvasX, y: (p.y + y1) * toCanvasY })),
    closed: true,
  };

  // Holes: filter by area — spurious edge-holes have ~0 enclosed area
  if (!S.holes) S.holes = {};
  const minHR = Math.max(30, blob.length * 0.001);
  S.holes[view] = allContoursR
    .filter(c => c.isHole && c.pts.length >= 4 && _polyArea2D(c.pts) >= minHR)
    .map(c => {
      const hs = Math.max(1, Math.floor(c.pts.length / 1000));
      const hsimp = douglasPeucker(c.pts.filter((_, i) => i % hs === 0), 0.4);
      return hsimp.map(p => ({ x: (p.x + x1) * toCanvasX, y: (p.y + y1) * toCanvasY }));
    })
    .filter(h => h.length >= 3);

  _applyContourTargetPts();
  cRoiRect = null;
  cActiveContour = 'outer'; _updateContourSelector();
  drawContour(); updateContourInfo(); persistState();
}

function autoDetectContourInROI(rect) {
  const view = S.contourView;
  const url = S.imgs[view];
  if (!url) return;
  document.getElementById('contour-info').textContent = '⏳ Searching for contour in selected area…';

  // ── PATH A: silhouette mask already computed in step 2 ──
  // Each side of the drawn rectangle marches inward through the mask until it hits
  // a white pixel (object boundary), then the silhouette boundary is traced.
  const savedSeg = S.segMasks?.[view];
  if (savedSeg) {
    _roiContourFromSilhouette(rect, savedSeg.mask, savedSeg.W, savedSeg.H);
    return;
  }
  // ── PATH B: no silhouette yet — fall back to Canny on original image ──

  const img = new Image();
  img.onload = () => {
    const maxW=900, maxH=700;
    const r = Math.min(maxW/img.width, maxH/img.height, 1);
    const W = Math.round(img.width*r), H = Math.round(img.height*r);

    // rect is in canvas image coords (cC.width × cC.height); scale to working resolution.
    const csX = cC ? W/cC.width : 1, csY = cC ? H/cC.height : 1;
    const x1=Math.max(0, Math.round(rect.x1*csX)), y1=Math.max(0, Math.round(rect.y1*csY));
    const x2=Math.min(W, Math.round(rect.x2*csX)), y2=Math.min(H, Math.round(rect.y2*csY));
    const rW=x2-x1, rH=y2-y1;
    if (rW<4||rH<4) return;

    const tmpC=document.createElement('canvas');
    tmpC.width=W; tmpC.height=H;
    const tmpCtx=tmpC.getContext('2d');
    tmpCtx.drawImage(img, 0, 0, W, H);

    const roiPx=tmpCtx.getImageData(x1, y1, rW, rH);
    let gray=new Uint8ClampedArray(rW*rH);
    for (let i=0;i<rW*rH;i++) gray[i]=roiPx.data[i*4]*.299+roiPx.data[i*4+1]*.587+roiPx.data[i*4+2]*.114;

    const enhMode=document.getElementById('enhance-mode')?.value??'clahe';
    if (enhMode==='clahe') gray=claheEnhance(gray,rW,rH);
    else if (enhMode==='zdce') gray=zeroDCEEnhance(gray,rW,rH);

    // Smart mode detection on ROI
    const {sat1,sat2}=_buildSAT(gray,rW,rH);
    const modeInfo=_autoDetectMode(gray,rW,rH,sat1,sat2);
    if (!S.lastMode) S.lastMode={};
    S.lastMode[view]=modeInfo.mode;

    const sens=parseInt(document.getElementById('canny-sens')?.value??5);
    const highT=Math.round(110-(sens-1)*10), lowT=Math.round(highT/3);
    const dilR=Math.max(2, Math.round(3*(S.dilScale?.[view]||1)));

    let obj;
    if (modeInfo.mode==='checkerboard') {
      const sdThresh=modeInfo.borderSdMean*(0.35+sens/10*0.45);
      obj=new Uint8ClampedArray(rW*rH);
      for (let y=0;y<rH;y++) for (let x=0;x<rW;x++) {
        if (_localSd(sat1,sat2,x,y,modeInfo.texR,rW,rH)<sdThresh) obj[y*rW+x]=255;
      }
      obj=morphClose(obj,rW,rH,dilR);
      obj=_removeBorderConnected(obj,rW,rH);
    } else if (modeInfo.mode==='otsu') {
      const t=modeInfo.otsu;
      obj=new Uint8ClampedArray(rW*rH);
      for (let i=0;i<rW*rH;i++) obj[i]=(modeInfo.isLight?gray[i]>=t:gray[i]<=t)?255:0;
      obj=morphClose(obj,rW,rH,dilR);
      obj=_removeBorderConnected(obj,rW,rH);
    } else {
      const sharpened=unsharpMask(gray,rW,rH,1.2);
      const denoised=bilateralFilter(sharpened,rW,rH,2,1.5,30);
      const edges=cannyEdges(denoised,rW,rH,lowT,highT);
      const dilated=dilateEdges(edges,rW,rH,2);
      const closedE=dilateEdges(dilated,rW,rH,1);
      const bg=floodFillBackground(closedE,rW,rH);
      obj=new Uint8ClampedArray(rW*rH);
      for (let i=0;i<rW*rH;i++) if (!bg[i]&&!closedE[i]) obj[i]=255;
      obj=morphClose(obj,rW,rH,dilR);
    }

    const blob=findLargestBlob(obj,rW,rH);
    if (!blob||blob.length<30) { cRoiRect=null; drawContour(); alert('No object found in selected area'); return; }
    const blobMask=new Uint8ClampedArray(rW*rH);
    blob.forEach(i=>blobMask[i]=255);

    // Suzuki-Abe: outer contour + topologically-correct holes
    const allContoursC=_suzukiAbe(blobMask,rW,rH);
    const outersC=allContoursC.filter(c=>!c.isHole&&c.pts.length>=4);
    if (!outersC.length) { cRoiRect=null; drawContour(); alert('Could not detect contour'); return; }
    const outerPtsC=outersC.reduce((a,b)=>b.pts.length>a.pts.length?b:a).pts;

    const step2=Math.max(1,Math.floor(outerPtsC.length/2500));
    const sub2=outerPtsC.filter((_,i)=>i%step2===0);
    const simplified=douglasPeucker(sub2, 0.4);

    // Shift polygon back to full-image canvas coords
    const scaleX=cC?cC.width/W:1, scaleY=cC?cC.height/H:1;
    S.polys[view]={
      pts: simplified.map(p=>({
        x: (Math.max(0,Math.min(rW,p.x))+x1)*scaleX,
        y: (Math.max(0,Math.min(rH,p.y))+y1)*scaleY
      })),
      closed: true
    };

    // Holes: filter by area — spurious edge-holes have ~0 enclosed area
    if (!S.holes) S.holes={};
    const minHA=Math.max(30, blob.length*0.001);
    S.holes[view]=allContoursC
      .filter(c=>c.isHole&&c.pts.length>=4&&_polyArea2D(c.pts)>=minHA)
      .map(c=>{
        const hs=Math.max(1,Math.floor(c.pts.length/1000));
        const hsimp=douglasPeucker(c.pts.filter((_,i)=>i%hs===0),0.4);
        return hsimp.map(p=>({x:(Math.max(0,Math.min(rW,p.x))+x1)*scaleX,y:(Math.max(0,Math.min(rH,p.y))+y1)*scaleY}));
      })
      .filter(h=>h.length>=3);

    _applyContourTargetPts();
    cRoiRect=null;
    cActiveContour = 'outer'; _updateContourSelector();
    drawContour(); updateContourInfo(); persistState();
  };
  img.src=url;
}

// ── Guided contour (click-inside BFS flood fill) ─────────────
let cGuidedSeeds = [];
function toggleGuidedMode() {
  // Exit guided mode if already active
  if (cC.dataset.guided) {
    cGuidedSeeds = [];
    delete cC.dataset.guided;
    const btn = document.getElementById('guided-btn');
    if (btn) { btn.style.background=''; btn.style.borderColor='var(--border)'; }
    drawContour(); updateContourInfo();
    return;
  }
  // Confirm if existing contour would be lost
  const existing = S.polys[S.contourView];
  if (existing.pts.length > 0 && !confirm('Guided mode will clear the current contour. Continue?')) return;
  cGuidedSeeds = [];
  S.polys[S.contourView] = { pts:[], closed:false };
  const btn = document.getElementById('guided-btn');
  if (btn) { btn.style.background='rgba(13,148,136,.25)'; btn.style.borderColor='var(--teal)'; }
  document.getElementById('contour-info').textContent = '🎯 Click on the object center to add a seed point. Click "🎯 Guided" again to cancel.';
  cC.dataset.guided = '1';
}
function runGuidedContour() {
  if (!cGuidedSeeds.length) return alert('Add a seed point first (click on the object)');
  const url = S.imgs[S.contourView];
  if (!url) return;
  const tmpC = document.createElement('canvas'), tmpCtx = tmpC.getContext('2d');
  const img = new Image();
  img.onload = () => {
    tmpC.width = cC.width; tmpC.height = cC.height;
    tmpCtx.drawImage(img, 0, 0, cC.width, cC.height);
    const W=cC.width, H=cC.height;
    const px = tmpCtx.getImageData(0,0,W,H).data;
    const gray = new Uint8ClampedArray(W*H);
    for (let i=0;i<W*H;i++) gray[i]=px[i*4]*.299+px[i*4+1]*.587+px[i*4+2]*.114;

    // Compute seed pixel values → tolerance
    const seedVals = cGuidedSeeds.map(s => {
      const sx=Math.round(s.x), sy=Math.round(s.y);
      return gray[sy*W+sx];
    });
    const seedMean = seedVals.reduce((a,b)=>a+b,0)/seedVals.length;
    const tol = 40;

    // BFS flood fill from seeds
    const visited = new Uint8ClampedArray(W*H);
    const q = [];
    cGuidedSeeds.forEach(s => {
      const sx=Math.max(0,Math.min(W-1,Math.round(s.x)));
      const sy=Math.max(0,Math.min(H-1,Math.round(s.y)));
      if (!visited[sy*W+sx]) { visited[sy*W+sx]=1; q.push(sy*W+sx); }
    });
    let qi=0;
    while (qi<q.length) {
      const idx=q[qi++];
      const x=idx%W, y=(idx/W)|0;
      for (const [dx,dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
        const nx=x+dx, ny=y+dy;
        if (nx<0||nx>=W||ny<0||ny>=H) continue;
        const ni=ny*W+nx;
        if (visited[ni]) continue;
        if (Math.abs(gray[ni]-seedMean) < tol) { visited[ni]=1; q.push(ni); }
      }
    }

    // Trace boundary
    const traced = mooreBoundaryTraceMask(visited, W, H);
    if (!traced || traced.length < 4) { alert('Could not find a contour — try a different seed point'); return; }
    const simplified = douglasPeucker(traced, 2);
    S.polys[S.contourView] = { pts: simplified, closed: true };
    cGuidedSeeds = []; delete cC.dataset.guided;
    const btn = document.getElementById('guided-btn');
    if (btn) { btn.style.background=''; btn.style.borderColor='var(--border)'; }
    cHoverPt=-1; cHoverEdge=-1;
    drawContour(); updateContourInfo(); persistState();
  };
  img.src = url;

}