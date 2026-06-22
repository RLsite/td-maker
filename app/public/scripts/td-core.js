// ══════════════════════════ INDEXEDDB PERSISTENCE ══════════════════════════
const IDB = (() => {
  const DB = 'td-maker-v1', ST = 'kv';
  let db = null;
  const open = () => new Promise((res, rej) => {
    if (db) return res(db);
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = e => e.target.result.createObjectStore(ST);
    r.onsuccess = e => { db = e.target.result; res(db); };
    r.onerror = rej;
  });
  const tx = (mode) => db.transaction(ST, mode).objectStore(ST);
  const req = (r) => new Promise((res, rej) => { r.onsuccess = e => res(e.target.result); r.onerror = rej; });
  return {
    put: async (k, v) => { await open(); await req(tx('readwrite').put(v, k)); },
    get: async (k) => { await open(); return req(tx('readonly').get(k)); },
    del: async (k) => { await open(); await req(tx('readwrite').delete(k)); },
  };
})();

async function persistImg(view, url) {
  if (!url) return IDB.del(`img-${view}`).catch(() => {});
  try {
    const blob = await fetch(url).then(r => r.blob());
    await IDB.put(`img-${view}`, blob);
  } catch(e) { console.error('[TD] persistImg failed for', view, e); }
}

function persistState() {
  // ── Build state object (defensive: cross-script vars may theoretically be undefined) ──
  let st;
  try {
    st = {
      step: S.step,
      scale: S.scale,
      polys: S.polys,
      polyCanvasSize: S.polyCanvasSize,
      dims: S.dims,
      segThresholds: (typeof segThresholds !== 'undefined') ? segThresholds : {},
      segModes:      (typeof segModes      !== 'undefined') ? segModes      : {},
      floatWin: S.floatWin,
      contourTargetPts: S.contourTargetPts,
      holes: S.holes,
      imgMeta: S.imgMeta,
      segMeta: S.segMeta,
      contourBbox: S.contourBbox,
      contourInfo: S.contourInfo,
      symmetry: S.symmetry,
    };
  } catch(e) {
    console.error('[TD] persistState: failed to build state object', e);
    return;
  }

  const ms = (typeof measurements !== 'undefined') ? measurements : { front: [], side: [], top: [] };

  // ── localStorage (synchronous — survives beforeunload) ──
  try {
    localStorage.setItem('td-state', JSON.stringify(st));
  } catch(e) {
    console.error('[TD] persistState: localStorage state write failed', e);
  }
  try {
    localStorage.setItem('td-measurements', JSON.stringify(ms));
  } catch(e) {
    console.error('[TD] persistState: localStorage measurements write failed', e);
  }

  // ── IDB (async backup — larger capacity, survives tab close) ──
  IDB.put('state', st).catch(e => console.warn('[TD] IDB state write failed:', e));
  IDB.put('measurements', ms).catch(e => console.warn('[TD] IDB measurements write failed:', e));
}

async function restoreSession() {
  console.log('[TD] restoreSession: starting…');

  // ── Restore images ───────────────────────────────────────────────────────
  for (const v of ['front','side','top','iso']) {
    try {
      const blob = await IDB.get(`img-${v}`);
      if (blob) {
        const url = URL.createObjectURL(blob);
        setImg(v, url, true);
        console.log('[TD] restored img:', v, Math.round(blob.size/1024) + 'KB');
      }
    } catch(e) { console.warn('[TD] restoreSession img failed for', v, e); }
  }

  // ── Restore state ────────────────────────────────────────────────────────
  let st = null;
  try { st = await IDB.get('state'); } catch(e) { console.warn('[TD] IDB state read failed:', e); }
  if (!st) {
    try {
      const raw = localStorage.getItem('td-state');
      if (raw) { st = JSON.parse(raw); console.log('[TD] state from localStorage, step=', st?.step); }
    } catch(e) { console.error('[TD] localStorage state parse failed:', e); }
  } else {
    console.log('[TD] state from IDB, step=', st?.step);
  }
  if (!st) console.warn('[TD] No saved state — starting fresh');

  if (st) {
    if (st.scale)            S.scale            = st.scale;
    if (st.polys)            S.polys            = st.polys;
    if (st.polyCanvasSize)   S.polyCanvasSize   = st.polyCanvasSize;
    if (st.dims)             S.dims             = st.dims;
    if (st.segThresholds && typeof segThresholds !== 'undefined') Object.assign(segThresholds, st.segThresholds);
    if (st.segModes      && typeof segModes      !== 'undefined') Object.assign(segModes,      st.segModes);
    if (st.floatWin)         S.floatWin         = st.floatWin;
    if (st.contourTargetPts) S.contourTargetPts = st.contourTargetPts;
    if (st.holes)            S.holes            = st.holes;
    if (st.symmetry)         S.symmetry         = st.symmetry;
  }

  // ── Restore measurements ─────────────────────────────────────────────────
  // Defer until AFTER _quickAnalysis has had a chance to run (it fires from
  // checkUploads which is called by the setImg loop above). We wait a tick so
  // that any auto-detected measurements don't race with the restored ones.
  await new Promise(r => setTimeout(r, 0));

  let ms = null;
  try { ms = await IDB.get('measurements'); } catch(e) { console.warn('[TD] IDB measurements read failed:', e); }
  if (!ms) {
    try {
      const raw = localStorage.getItem('td-measurements');
      if (raw) ms = JSON.parse(raw);
    } catch(e) { console.warn('[TD] localStorage measurements parse failed:', e); }
  }
  if (ms && typeof measurements !== 'undefined') {
    ['front','side','top'].forEach(v => { if (ms[v]?.length) measurements[v] = ms[v]; });
    console.log('[TD] measurements restored');
    if (typeof updateScaleAvg      === 'function') updateScaleAvg();
    if (typeof renderMeasurements  === 'function') renderMeasurements();
  }

  goTo(st?.step ?? 1);
  _rebuildSegMasks();
  console.log('[TD] restoreSession: done');
}

// Re-run applyThreshold silently for every loaded view → populates S.segMasks
function _rebuildSegMasks() {
  const views = ['front','side','top'];
  let idx = 0;
  function next() {
    if (idx >= views.length) return;
    const v = views[idx++];
    const url = S.imgs[v];
    if (!url) { next(); return; }
    const img = new Image();
    img.onload = () => {
      const maxW=900, maxH=700;
      const r=Math.min(maxW/img.width, maxH/img.height, 1);
      const W=Math.round(img.width*r), H=Math.round(img.height*r);
      const tmp=document.createElement('canvas'); tmp.width=W; tmp.height=H;
      const ctx=tmp.getContext('2d'); ctx.drawImage(img,0,0,W,H);
      const src=ctx.getImageData(0,0,W,H).data;
      const t=segThresholds[v]??120, mode=segModes[v]??'dark';
      const mask=new Uint8ClampedArray(W*H);
      for (let i=0;i<W*H;i++) {
        const g=src[i*4]*.299+src[i*4+1]*.587+src[i*4+2]*.114;
        mask[i]=(mode==='dark'?g<t:g>t)?255:0;
      }
      if (!S.segMasks) S.segMasks={};
      S.segMasks[v]={mask,W,H};
      _updateSegMeta(v, mask, W, H);
      _updateContourSegBadges();
      // If the user is already on the contour step, refresh the background composite
      // so the teal silhouette overlay appears immediately without manual action.
      if (S.step === 3 && S.contourView === v) initContour();
      next();
    };
    img.src=url;
  }
  next();
}

// ══════════════════════════ STATE ══════════════════════════
const S = {
  step: 1,
  imgs: { front: null, side: null, top: null, iso: null },
  imgMeta: {},     // naturalW/H, aspect, suggestedThreshold — set at upload
  segMeta: {},     // bbox, area, W, H of silhouette — set after segmentation
  contourBbox: {}, // canvas-space bbox of closed polygon — set in updateContourInfo
  contourInfo: {}, // areaPx, areaRatio (vs silhouette), perimPx — set in updateContourInfo
  scale: { front: null, side: null, top: null },
  polys: { front: { pts: [], closed: false }, side: { pts: [], closed: false }, top: { pts: [], closed: false } },
  scaleView: 'front',
  scalePts: [],
  segView: 'top',
  segImgData: null,
  contourView: 'front',
  mouse: null,
  floatWin: null,      // saved position/size of floating canvas window {x,y,w,h}
  contourTargetPts: 50, // target point count for auto-detect resampling

  // ── ImageContext — accumulated intelligence per view ─────────────────────
  // Each processing step enriches ctx[view] with its layer.
  // Downstream steps read ALL prior layers — the system knows the full history.
  // Layers: raw | seg | shape | scale | dims | lines | circles
  ctx: { front: {}, side: {}, top: {} },
};

// Write data into a named layer of the per-view context.
// Merges (does not replace) so each call enriches the layer.
function ctxWrite(view, layer, data) {
  if (!S.ctx[view]) S.ctx[view] = {};
  S.ctx[view][layer] = Object.assign(S.ctx[view][layer] ?? {}, data);
}

// Read the full accumulated context for a view.
function ctxRead(view) { return S.ctx[view] ?? {}; }

// ══════════════════════════ CROSS-VIEW OBJECT MODEL ══════════════════════════
// Builds a 3D object model from all view segmentations + scale data.
// Called after each segmentation update and after quick analysis.
// Reorder all .view-tabs-row containers so the highest-quality view appears first.
// Uses S.segScore as the quality signal (set after every segmentation / ISO pipeline run).
// Upload step (Step 1) has no .view-tabs-row so it is automatically excluded.
// Non-tab siblings (e.g. Auto Detect button) are left at the end, after all tabs.
function _sortAllViewTabs() {
  const views = ['front', 'side', 'top'];
  const scored = views
    .map(v => ({ v, score: S.segScore?.[v] ?? -1 }))
    .filter(x => x.score >= 0)          // only views with a computed score
    .sort((a, b) => b.score - a.score);  // descending — best first
  if (scored.length < 2) return;         // need at least 2 views scored to sort
  const order = scored.map(x => x.v);

  document.querySelectorAll('.view-tabs-row').forEach(row => {
    const tabs = order.map(v => row.querySelector(`[data-v="${v}"]`)).filter(Boolean);
    // Non-tab elements (e.g. Auto Detect button) — placed after tabs
    const others = [...row.children].filter(el => !views.includes(el.dataset?.v));
    // Reinsert: tabs in sorted order first, then non-tab elements
    tabs.forEach(t => row.appendChild(t));
    others.forEach(el => row.appendChild(el));
  });
}

// Stores result in S.objectModel and enriches S.ctx[v].dims per view.
function buildObjectModel() {
  function pxDims(v) {
    const m = S.segMeta?.[v];
    if (!m?.bbox) return null;
    return { w: m.bbox.maxX - m.bbox.minX, h: m.bbox.maxY - m.bbox.minY };
  }
  function ppm(v)   { return S.scale?.[v]    ?? null; }
  function score(v) { return S.segScore?.[v]  ?? 5;   } // default mid-score if not yet computed
  function toMm(px, p) { return (px != null && p) ? px / p : null; }
  function agree(a, b) { return (a && b) ? Math.min(a,b)/Math.max(a,b) : null; }

  // Reliability-weighted merge: favour the measurement from the higher-scored view.
  // If only one is available, use it.  Weights are normalised segScore values.
  function wMerge(valA, scA, valB, scB) {
    if (valA == null && valB == null) return { val: null, src: null };
    if (valA == null) return { val: valB, src: 'B' };
    if (valB == null) return { val: valA, src: 'A' };
    const wA = scA, wB = scB;
    return { val: (valA*wA + valB*wB) / (wA+wB), src: scA >= scB ? 'A' : 'B' };
  }

  const fD = pxDims('front'), sD = pxDims('side'), tD = pxDims('top');
  const pF = ppm('front'),   pS = ppm('side'),   pT = ppm('top');
  const sF = score('front'), sS = score('side'), sT = score('top');

  const fW = toMm(fD?.w, pF), fH = toMm(fD?.h, pF);
  const sW = toMm(sD?.w, pS), sH = toMm(sD?.h, pS);
  const tW = toMm(tD?.w, pT), tH = toMm(tD?.h, pT);

  // Orthographic 3-view relationships:
  //   Height H: front.h ≈ side.h   (use regional score: front.left+right, side.left+right)
  //   Width  W: front.w ≈ top.w    (use regional score: front.top+bottom, top.top+bottom)
  //   Depth  D: side.w ≈ top.h
  //
  // Regional scores for the relevant edges of each dimension:
  const rF = S.segRegions?.front, rS = S.segRegions?.side, rT = S.segRegions?.top;
  const scFH = rF ? ((rF.left??sF) + (rF.right??sF)) / 2 : sF; // front height edges
  const scSH = rS ? ((rS.left??sS) + (rS.right??sS)) / 2 : sS; // side height edges
  const scFW = rF ? ((rF.top??sF)  + (rF.bottom??sF)) / 2 : sF; // front width edges
  const scTW = rT ? ((rT.top??sT)  + (rT.bottom??sT)) / 2 : sT; // top width edges
  const scSW = rS ? ((rS.top??sS)  + (rS.bottom??sS)) / 2 : sS; // side depth edges
  const scTH = rT ? ((rT.left??sT) + (rT.right??sT))  / 2 : sT; // top depth edges

  // ISO contributes as a 4th source — weight by its face score
  const iso   = S.isoData;
  const isoD  = iso?.dims_mm ?? {};
  const isoSc = iso?.scores  ?? {};
  // For H: ISO front-face height (most reliable ISO measurement — vertical edges preserved)
  const isoH  = isoD.H  ?? null;
  const isoSH = isoSc.front ?? 0;
  // For W: ISO front-face width (slight foreshortening but still useful)
  const isoW  = isoD.W  ?? null;
  const isoSW = isoSc.front ?? 0;
  // For D: ISO side-face width OR top-face depth
  const isoDD = isoD.D != null ? isoD.D : isoD.Dt ?? null;
  const isoSD = isoD.D != null ? (isoSc.side ?? 0) : (isoSc.top ?? 0);

  // Three-way merge: ortho-A, ortho-B, ISO
  function wMerge3(vA, sA, vB, sB, vC, sC) {
    const entries = [[vA,sA],[vB,sB],[vC,sC]].filter(([v]) => v != null);
    if (!entries.length) return { val: null, src: null };
    const tot = entries.reduce((s,[,w]) => s+w, 0) || 1;
    const val = entries.reduce((s,[v,w]) => s + v*w, 0) / tot;
    const best = entries.reduce((a,b) => b[1] > a[1] ? b : a);
    return { val, src: best === entries[0] ? 'A' : best === entries[1] ? 'B' : 'ISO' };
  }

  const mH = wMerge3(fH, scFH, sH, scSH, isoH, isoSH);
  const mW = wMerge3(fW, scFW, tW, scTW, isoW, isoSW);
  const mD = wMerge3(sW, scSW, tH, scTH, isoDD, isoSD);

  const cH = agree(fH, sH), cW = agree(fW, tW), cD = agree(sW, tH);
  const THRESH = 0.82;
  const issues = [];
  if (cH !== null && cH < THRESH) issues.push({ dim:'H', views:'Front↔Side', a:Math.round(fH), b:Math.round(sH) });
  if (cW !== null && cW < THRESH) issues.push({ dim:'W', views:'Front↔Top',  a:Math.round(fW), b:Math.round(tW) });
  if (cD !== null && cD < THRESH) issues.push({ dim:'D', views:'Side↔Top',   a:Math.round(sW), b:Math.round(tH) });

  S.objectModel = {
    dims: { H: mH.val, W: mW.val, D: mD.val },
    // Which view is the primary source for each dimension (higher reliability)
    dimSource: { H: mH.src === 'A' ? 'front' : 'side',
                 W: mW.src === 'A' ? 'front' : 'top',
                 D: mD.src === 'A' ? 'side'  : 'top' },
    consistency: { H: cH, W: cW, D: cD },
    perView: {
      front: { wMm: fW, hMm: fH, ppm: pF, score: sF },
      side:  { wMm: sW, hMm: sH, ppm: pS, score: sS },
      top:   { wMm: tW, hMm: tH, ppm: pT, score: sT },
    },
    issues,
  };

  // Enrich ctx[v].dims so ctxSummary() shows live mm values
  for (const [v,wm,hm] of [['front',fW,fH],['side',sW,sH],['top',tW,tH]])
    if (wm || hm) ctxWrite(v, 'dims', { W_mm: wm, H_mm: hm });

  return S.objectModel;
}

// Render cross-view model into a DOM element.
function _renderModelBar(el) {
  if (!el) return;
  const m = S.objectModel;
  if (!m) { el.style.display = 'none'; return; }
  const { dims, consistency, issues } = m;
  const fmt = v => v != null ? Math.round(v) + ' mm' : '—';
  function icon(c) {
    if (c === null) return '';
    if (c >= 0.90) return '<span style="color:#10B981"> ✓</span>';
    if (c >= 0.82) return '<span style="color:#F59E0B"> ~</span>';
    return '<span style="color:#EF4444"> ⚠</span>';
  }
  const hasAny = dims.H || dims.W || dims.D;
  if (!hasAny) { el.style.display = 'none'; return; }
  const src = m.dimSource ?? {};
  const srcLabel = v => v ? `<span style="font-size:9px;color:var(--muted);margin-left:2px;">${v[0].toUpperCase()}</span>` : '';
  el.style.display = 'flex';
  el.innerHTML =
    `<span style="font-size:10px;font-weight:700;letter-spacing:.07em;color:var(--subtle);text-transform:uppercase;margin-right:8px;white-space:nowrap;align-self:center;">3-View Model</span>` +
    [['H','H',dims.H,consistency.H,src.H],['W','W',dims.W,consistency.W,src.W],['D','D',dims.D,consistency.D,src.D]].map(([,lbl,val,c,s]) =>
      `<span style="font-size:11px;color:var(--muted);margin-right:2px;">${lbl}:</span>` +
      `<span style="font-size:13px;font-weight:700;font-family:'Fira Code',monospace;color:${val?'var(--teal-light)':'var(--border)'};margin-right:2px;">${fmt(val)}</span>` +
      srcLabel(s) + icon(c) +
      `<span style="margin-right:10px;"></span>`
    ).join('') +
    (issues.length
      ? `<span style="font-size:11px;color:#F59E0B;align-self:center;">${issues.map(i=>`⚠ ${i.dim}: ${i.a} vs ${i.b} mm (${i.views})`).join(' · ')}</span>`
      : '');
}

// ══════════════════════════ ISO FULL PIPELINE ══════════════════════════
// Runs the ISO image through the complete processing pipeline automatically,
// without any user interaction.  Results are stored in S.isoData and
// feed directly into buildObjectModel() and _adaptiveQualitySmooth().
//
// Pipeline: load → grayscale → segment (Otsu + border-remove) →
//           boundary quality score per face → face pixel dims →
//           derive mm dims (once any ortho scale is known) →
//           S.isoData = { faces, scores, dims_mm, ppm }
function runIsoFullPipeline(callback) {
  const url = S.imgs?.iso;
  if (!url) { if (callback) callback(null); return; }

  const img = new Image();
  img.onload = () => {
    const SZ = 900;
    const sc = Math.min(SZ / img.width, SZ / img.height, 1);
    const W = Math.round(img.width * sc), H = Math.round(img.height * sc);
    const tmp = document.createElement('canvas');
    tmp.width = W; tmp.height = H;
    const ctx = tmp.getContext('2d');
    ctx.drawImage(img, 0, 0, W, H);
    const px = ctx.getImageData(0, 0, W, H).data;

    // ── 1. Grayscale ──────────────────────────────────────────────────────
    const gray = new Uint8ClampedArray(W * H);
    for (let i = 0; i < W * H; i++)
      gray[i] = px[i*4]*.299 + px[i*4+1]*.587 + px[i*4+2]*.114;

    // ── 2. Segment — Otsu + remove border-connected noise ─────────────────
    const hist = new Int32Array(256);
    for (let i = 0; i < W*H; i++) hist[gray[i]]++;
    let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, maxV = 0, thr = 128;
    for (let i = 0; i < 256; i++) {
      wB += hist[i]; if (!wB) continue;
      const wF = W*H - wB; if (!wF) break;
      sumB += i * hist[i];
      const v = wB * wF * ((sumB/wB) - (sum-sumB)/wF) ** 2;
      if (v > maxV) { maxV = v; thr = i; }
    }
    let mask = new Uint8ClampedArray(W * H);
    for (let i = 0; i < W*H; i++) mask[i] = gray[i] < thr ? 255 : 0;
    mask = _removeBorderConnected(mask, W, H);

    // ── 3. Bounding box ───────────────────────────────────────────────────
    let minX = W, maxX = 0, minY = H, maxY = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (!mask[y*W+x]) continue;
      if (x < minX) minX=x; if (x > maxX) maxX=x;
      if (y < minY) minY=y; if (y > maxY) maxY=y;
    }
    if (maxX <= minX || maxY <= minY) { if (callback) callback(null); return; }

    // ── 4. Find splitY (widest horizontal span = isometric equator) ───────
    const midX = Math.round((minX + maxX) / 2);
    let splitY = minY + Math.round((maxY - minY) * 0.4), maxSpan = 0;
    for (let y = minY; y < maxY; y++) {
      let l = maxX, r = minX;
      for (let x = minX; x <= maxX; x++) if (mask[y*W+x]) { if(x<l)l=x; if(x>r)r=x; }
      if (r > l && r - l > maxSpan) { maxSpan = r - l; splitY = y; }
    }

    // ── 5. Face pixel measurements ────────────────────────────────────────
    function faceBBox(yMin, yMax, xMin, xMax) {
      let l=xMax, r=xMin, t=yMax, b=yMin, n=0;
      for (let y=yMin; y<yMax; y++) for (let x=xMin; x<xMax; x++) {
        if (!mask[y*W+x]) continue;
        if(x<l)l=x; if(x>r)r=x; if(y<t)t=y; if(y>b)b=y; n++;
      }
      return n > 10 ? { l, r, t, b, wPx: r-l, hPx: b-t, n } : null;
    }
    const topBB   = faceBBox(minY, splitY, minX, maxX);
    const frontBB = faceBBox(splitY, maxY, minX, midX);
    const sideBB  = faceBBox(splitY, maxY, midX, maxX);

    // ── 6. Boundary quality score for each face (Sobel at mask edge) ──────
    function faceScore(yMin, yMax, xMin, xMax) {
      let total = 0, cnt = 0;
      for (let y = Math.max(1,yMin); y < Math.min(H-1,yMax); y++) {
        for (let x = Math.max(1,xMin); x < Math.min(W-1,xMax); x++) {
          const i = y*W+x;
          if (!mask[i]) continue;
          if (!mask[i-1]||!mask[i+1]||!mask[i-W]||!mask[i+W]) {
            const gx = -gray[(y-1)*W+(x-1)] + gray[(y-1)*W+(x+1)]
                       -2*gray[y*W+(x-1)]   + 2*gray[y*W+(x+1)]
                       -gray[(y+1)*W+(x-1)] + gray[(y+1)*W+(x+1)];
            const gy = -gray[(y-1)*W+(x-1)] - 2*gray[(y-1)*W+x] - gray[(y-1)*W+(x+1)]
                       +gray[(y+1)*W+(x-1)] + 2*gray[(y+1)*W+x] + gray[(y+1)*W+(x+1)];
            total += Math.sqrt(gx*gx + gy*gy); cnt++;
          }
        }
      }
      return cnt ? Math.min(10, Math.max(1, Math.round(total / cnt / 18))) : null;
    }
    const scores = {
      top:   faceScore(minY, splitY, minX, maxX),
      front: faceScore(splitY, maxY, minX, midX),
      side:  faceScore(splitY, maxY, midX, maxX),
    };

    // ── 7. Derive mm dimensions from ISO pixel measurements ───────────────
    // In a fixed-orientation isometric view the vertical face height in px is
    // proportional to the true H.  We use any known ortho px/mm as anchor.
    // Once H_mm is known → ppmISO = frontBB.hPx / H_mm
    // Then: W_mm ≈ frontBB.wPx / ppmISO  (slight foreshortening, ~0.87)
    //        D_mm ≈ sideBB.wPx  / ppmISO
    const knownH = S.objectModel?.dims?.H;
    let ppmISO = null, isoDims = {};
    if (knownH && frontBB) {
      ppmISO = frontBB.hPx / knownH;
      isoDims = {
        H:  knownH,
        W:  frontBB.wPx / ppmISO,
        D:  sideBB  ? sideBB.wPx  / ppmISO : null,
        Wt: topBB   ? topBB.wPx   / ppmISO : null, // W from top face
        Dt: topBB   ? topBB.hPx   / ppmISO : null, // D from top face
      };
    }

    S.isoData = {
      faces: { top: topBB, front: frontBB, side: sideBB },
      scores,
      dims_mm: isoDims,
      ppmISO,
      splitY, midX, W, H,
      mask,
    };

    // ── 8. Extract per-face contours for orthographic fallback ────────────────
    // When an orthographic view (front/side) has open arch openings at the image
    // border, its contour algorithm fails.  The equivalent ISO face has the arches
    // INSIDE the cropped region → morphFillHoles works → clean silhouette.
    // Stored in S.isoContours keyed by 'front'|'side'|'top'.
    S.isoContours  = {};
    S.isoFaceMasks = {};
    const _faceRegions = {
      top:   [minY, splitY, minX, maxX],
      front: [splitY, maxY, minX, midX],
      side:  [splitY, maxY, midX, maxX],
    };
    for (const [faceName, [fy0, fy1, fx0, fx1]] of Object.entries(_faceRegions)) {
      const fW = fx1 - fx0, fH = fy1 - fy0;
      if (fW <= 10 || fH <= 10) continue;
      const faceMask = new Uint8ClampedArray(fW * fH);
      const faceGray = new Uint8ClampedArray(fW * fH);
      for (let y = fy0; y < fy1; y++) for (let x = fx0; x < fx1; x++) {
        const fi = (y - fy0) * fW + (x - fx0);
        faceMask[fi] = mask[y * W + x];
        faceGray[fi] = gray[y * W + x];
      }
      // Store clean filled silhouette for each face (used to repair low-quality ortho masks)
      const fblob = findLargestBlob(faceMask, fW, fH);
      if (fblob && fblob.length > 50) {
        const fblobMask = new Uint8ClampedArray(fW * fH);
        fblob.forEach(i => { fblobMask[i] = 255; });
        const fsealed = _sealBorderConcavities(fblobMask, fW, fH);
        S.isoFaceMasks[faceName] = { mask: morphFillHoles(fsealed, fW, fH), W: fW, H: fH };
      }
      // Store contour polygon for degenerate-poly fallback
      const fc = _extractContourFromMask(faceMask, fW, fH, faceGray);
      if (fc) S.isoContours[faceName] = fc;
    }

    // Merge into objectModel
    buildObjectModel();
    if (callback) callback(S.isoData);
  };
  img.src = url;
}

// ══════════════════════════ ISO VIEW ANALYSIS (legacy banner) ══════════════════════════
// Fixed isometric orientation: left-bottom = Front, right-bottom = Side, top = Top.
// Segments the three visible faces by position, measures pixel aspect ratios,
// then cross-validates against objectModel.dims.
// Calls callback(result) when done; result is also stored in S.isoAnalysis.
function analyzeIsoView(callback) {
  const url = S.imgs?.iso;
  if (!url) { if (callback) callback(null); return; }

  const img = new Image();
  img.onload = () => {
    const maxW = 900, maxH = 700;
    const sc = Math.min(maxW / img.width, maxH / img.height, 1);
    const W = Math.round(img.width * sc), H = Math.round(img.height * sc);
    const tmp = document.createElement('canvas'); tmp.width = W; tmp.height = H;
    tmp.getContext('2d').drawImage(img, 0, 0, W, H);
    const px = tmp.getContext('2d').getImageData(0, 0, W, H).data;

    const gray = new Uint8ClampedArray(W * H);
    for (let i = 0; i < W * H; i++)
      gray[i] = px[i*4]*0.299 + px[i*4+1]*0.587 + px[i*4+2]*0.114;

    // ── Segment object: reuse ISO seg mask if available, else Otsu ──
    const segM = S.segMasks?.iso;
    const mask = new Uint8ClampedArray(W * H);
    if (segM) {
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const sx = Math.round(x * segM.W / W), sy = Math.round(y * segM.H / H);
        if (sx < segM.W && sy < segM.H) mask[y*W+x] = segM.mask[sy*segM.W+sx];
      }
    } else {
      const hist = new Int32Array(256);
      for (let i = 0; i < W*H; i++) hist[gray[i]]++;
      let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
      let sumB = 0, wB = 0, maxV = 0, t = 128;
      for (let i = 0; i < 256; i++) {
        wB += hist[i]; if (!wB) continue;
        const wF = W*H - wB; if (!wF) break;
        sumB += i * hist[i];
        const v = wB * wF * ((sumB/wB) - (sum-sumB)/wF) ** 2;
        if (v > maxV) { maxV = v; t = i; }
      }
      for (let i = 0; i < W*H; i++) mask[i] = gray[i] < t ? 255 : 0;
    }

    // ── Bounding box of object silhouette ──
    let minX = W, maxX = 0, minY = H, maxY = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (!mask[y*W+x]) continue;
      if (x < minX) minX=x; if (x > maxX) maxX=x;
      if (y < minY) minY=y; if (y > maxY) maxY=y;
    }
    if (maxX <= minX || maxY <= minY) { if (callback) callback(null); return; }

    const midX = Math.round((minX + maxX) / 2);

    // ── Find splitY: y where horizontal span is widest ──
    // Above splitY = Top face; below = Front (left) + Side (right)
    let splitY = minY + Math.round((maxY - minY) * 0.4);
    let maxSpan = 0;
    for (let y = minY; y < maxY; y++) {
      let l = maxX, r = minX;
      for (let x = minX; x <= maxX; x++) if (mask[y*W+x]) { if(x<l)l=x; if(x>r)r=x; }
      if (r > l && r - l > maxSpan) { maxSpan = r - l; splitY = y; }
    }

    // ── Measure each face region ──
    function regionStats(yMin, yMax, xMin, xMax) {
      let l=xMax, r=xMin, t=yMax, b=yMin, sum=0, n=0;
      for (let y=yMin; y<yMax; y++) for (let x=xMin; x<xMax; x++) {
        if (!mask[y*W+x]) continue;
        if(x<l)l=x; if(x>r)r=x; if(y<t)t=y; if(y>b)b=y;
        sum+=gray[y*W+x]; n++;
      }
      return n ? { widthPx:r-l, heightPx:b-t, brightness:sum/n, pixelCount:n } : null;
    }

    const topFace   = regionStats(minY, splitY, minX, maxX);
    const frontFace = regionStats(splitY, maxY, minX, midX);
    const sideFace  = regionStats(splitY, maxY, midX, maxX);

    // ── Cross-validate aspect ratios against objectModel ──
    const model = S.objectModel;
    let validation = null;
    if (model && frontFace && sideFace) {
      const { W: mW, H: mH, D: mD } = model.dims;
      if (mW && mH && mD) {
        const measFR = frontFace.heightPx ? frontFace.widthPx / frontFace.heightPx : null;
        const measSR = sideFace.heightPx  ? sideFace.widthPx  / sideFace.heightPx  : null;
        const expFR = mW / mH;  // front = W×H
        const expSR = mD / mH;  // side  = D×H

        function pctDiff(a, b) { return a && b ? Math.abs(a - b) / b : null; }
        const frontOk    = pctDiff(measFR, expFR);
        const sideOk     = pctDiff(measSR, expSR);
        const frontSwap  = pctDiff(measFR, expSR);
        const sideSwap   = pctDiff(measSR, expFR);

        const correct = (frontOk < 0.18) && (sideOk < 0.18);
        const swapped = !correct && (frontSwap < 0.18) && (sideSwap < 0.18);

        validation = { correct, swapped, measFR, measSR, expFR, expSR };
      }
    }

    const result = {
      faces: { top: topFace, front: frontFace, side: sideFace },
      splitY, midX, validation,
    };
    S.isoAnalysis = result;
    if (callback) callback(result);
  };
  img.src = url;
}

// Render ISO analysis result as a banner (used in Step 1 quick-analysis panel).
function _isoAnalysisBanner(result) {
  if (!result) return '';
  const { faces, validation } = result;
  const fmtR = r => r != null ? r.toFixed(2) : '—';

  let status = '', advice = '';
  if (validation) {
    if (validation.correct) {
      status = '<span style="color:#10B981;font-weight:600;">✓ View assignment confirmed by ISO</span>';
    } else if (validation.swapped) {
      status = '<span style="color:#EF4444;font-weight:600;">⚠ Front and Side appear SWAPPED</span>';
      advice = '<div style="margin-top:5px;font-size:11px;color:#F59E0B;">ISO shows: left face W/H=' + fmtR(validation.measFR) + ' but expects ' + fmtR(validation.expSR) + ' (Side). Re-assign Front↔Side slots.</div>';
    } else {
      status = '<span style="color:#F59E0B;font-weight:600;">~ Could not confirm view assignment from ISO</span>';
    }
  }

  const brightness = faces.top && faces.front && faces.side
    ? `<span style="font-size:11px;color:var(--muted);">Brightness — Top:${Math.round(faces.top.brightness)} Front:${Math.round(faces.front.brightness)} Side:${Math.round(faces.side.brightness)}</span>`
    : '';

  return `<div style="margin-top:10px;padding:8px 12px;background:rgba(13,148,136,.07);border:1px solid rgba(13,148,136,.25);border-radius:8px;">
    <div style="font-size:11px;font-weight:700;letter-spacing:.06em;color:var(--subtle);text-transform:uppercase;margin-bottom:5px;">ISO Analysis</div>
    <div style="font-size:12px;">${status}</div>
    ${advice}
    <div style="margin-top:4px;">${brightness}</div>
  </div>`;
}

// One-line human-readable summary — shows what the pipeline has learned so far.
function ctxSummary(view) {
  const c = S.ctx[view] ?? {};
  const p = [];
  if (c.raw)            p.push(`${c.raw.W}×${c.raw.H}px`);
  if (c.seg?.coverage)  p.push(`seg ${Math.round(c.seg.coverage*100)}%`);
  if (c.shape?.eccentricity != null) p.push(`ecc ${c.shape.eccentricity.toFixed(2)}`);
  if (c.scale?.ppm)     p.push(`${c.scale.ppm.toFixed(1)}px/mm`);
  if (c.dims?.W_mm)     p.push(`${Math.round(c.dims.W_mm)}×${Math.round(c.dims.H_mm)}mm`);
  if (c.lines?.length)   p.push(`${c.lines.length} line${c.lines.length!==1?'s':''}`);
  if (c.circles?.length) p.push(`${c.circles.length} circle${c.circles.length!==1?'s':''}`);
  return p.length ? p.join(' · ') : '—';
}

const STEPS = [
  [1,'Upload Images','3 photos + ruler'],
  [2,'Background Separation','auto silhouette'],
  [3,'Contour Drawing','vector polygon'],
  [4,'Scale','px/mm from ruler'],
  [5,'Contour Review','initial dimensions'],
  [6,'3D Reconstruction','Visual Hull'],
  [7,'Vectorization','clean lines'],
  [8,'Dimension Lines','dimensions in mm'],
  [9,'Drawing Layout','ISO standard'],
  [10,'Export','DXF / SVG / PDF'],
];

// ══════════════════════════ SIDEBAR TOGGLE ══════════════════════════
function toggleSidebar() {
  const sb = document.getElementById('sidebar');
  const btn = document.getElementById('sidebar-toggle');
  if (!sb) return;
  const collapsed = sb.dataset.collapsed === '1';
  if (collapsed) {
    sb.dataset.collapsed = '0';
    sb.style.setProperty('width',   '220px', 'important');
    sb.style.setProperty('padding', '10px',  'important');
    if (btn) btn.style.color = 'var(--subtle)';
  } else {
    sb.dataset.collapsed = '1';
    sb.style.setProperty('width',   '0', 'important');
    sb.style.setProperty('padding', '0', 'important');
    if (btn) btn.style.color = 'var(--teal-light)';
  }
  // Rebuild canvas when available width changes
  if (S.step === 3) setTimeout(initContour, 250);
  if (S.step === 4) setTimeout(initScale,   250);
}

// ══════════════════════════ SIDEBAR ══════════════════════════
function buildSidebar() {
  document.getElementById('sidebar').innerHTML = STEPS.map(([id, name, desc]) => `
    <button onclick="goTo(${id})" id="sb${id}"
      style="width:100%;display:flex;align-items:flex-start;gap:10px;padding:10px 10px;border-radius:8px;border:none;cursor:pointer;margin-bottom:2px;text-align:left;background:transparent;transition:background .15s;">
      <span id="sbn${id}" style="width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-family:'Fira Code',monospace;font-weight:700;flex-shrink:0;margin-top:1px;background:#334155;color:#64748B;">${id}</span>
      <div>
        <div id="sbname${id}" style="font-size:13px;font-weight:500;color:#94A3B8;">${name}</div>
        <div style="font-size:11px;color:#475569;margin-top:1px;">${desc}</div>
      </div>
    </button>
  `).join('');
}

function refreshSidebar() {
  STEPS.forEach(([id]) => {
    const done = id < S.step, active = id === S.step;
    const btn = document.getElementById(`sb${id}`);
    const num = document.getElementById(`sbn${id}`);
    const name = document.getElementById(`sbname${id}`);
    if (!btn) return;
    btn.style.background = active ? 'rgba(13,148,136,.15)' : 'transparent';
    num.style.background = (done || active) ? 'var(--teal)' : '#334155';
    num.style.color = (done || active) ? 'white' : '#64748B';
    num.innerHTML = done
      ? `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3.5"><polyline points="20 6 9 17 4 12"/></svg>`
      : id;
    name.style.color = active ? 'var(--teal-light)' : done ? '#475569' : '#94A3B8';
  });
}

// ══════════════════════════ NAVIGATION ══════════════════════════
function goTo(n) {
  S.step = n;
  const main = document.getElementById('main');
  const flexPanel = n === 3 || n === 4;
  document.querySelectorAll('.panel').forEach(p => {
    if (p.dataset.panel == n) {
      if (flexPanel) {
        p.style.display = 'flex';
        p.style.flexDirection = 'column';
      } else {
        p.style.display = 'block';
        p.style.flexDirection = '';
      }
    } else {
      p.style.display = 'none';
    }
  });
  // Steps 3–4 fill the main area — no scroll; all other steps scroll normally
  if (main) main.style.overflow = flexPanel ? 'hidden' : 'auto';
  document.getElementById('step-label').textContent = `Step ${n} of 10`;
  document.getElementById('progress-bar').style.width = `${n * 10}%`;
  const prev = document.getElementById('hdr-prev'), next = document.getElementById('hdr-next');
  if (prev) { prev.disabled = n <= 1;  prev.style.opacity = n <= 1  ? '.3' : '1'; prev.style.cursor = n <= 1  ? 'default' : 'pointer'; }
  if (next) { next.disabled = n >= 10; next.style.opacity = n >= 10 ? '.3' : '1'; next.style.cursor = n >= 10 ? 'default' : 'pointer'; }
  refreshSidebar();
  onActivate(n);
  persistState();
}

function nextStep() { if (S.step < 10) goTo(S.step + 1); }
function prevStep() { if (S.step > 1) goTo(S.step - 1); }

function onActivate(n) {
  // Always reorder view tabs to match the quality-sorted order before showing any step
  _sortAllViewTabs();
  if (n === 2) {
    initSeg();
    if (typeof _updateContourSegBadges === 'function') _updateContourSegBadges();
    if (typeof computeDepthMap === 'function') {
      ['front','side','top'].forEach(v => { if (S.imgs[v]) computeDepthMap(v); });
    }
  }
  if (n === 3) {
    // Ensure all 3 views have segmentation masks before building the canvas
    const views = ['front','side','top'];
    let pending = views.filter(v => S.imgs[v] && !S.segMasks?.[v]).length || 0;
    const onReady = () => {
      if (--pending > 0) return;
      initContour();
      setTimeout(() => {
        if (!S.polys[S.contourView]?.pts?.length) autoDetectContour();
      }, 150);
    };
    if (pending === 0) { initContour(); setTimeout(() => { if (!S.polys[S.contourView]?.pts?.length) autoDetectContour(); }, 150); }
    else views.forEach(v => { if (S.imgs[v] && !S.segMasks?.[v]) _ensureSegMask(v, onReady); });
  }
  if (n === 4) { initScale(); document.getElementById('meas-view-label').textContent = 'Front View'; renderMeasurements(); }
  if (n === 5) {
    initReview();
    // Scale has been measured — ruler is no longer needed. Auto-crop all views to remove it.
    // autoCropPreserveData skips views where no significant crop is detected (already clean).
    if (typeof autoCropPreserveData === 'function') {
      ['front','side','top'].forEach(v => { if (S.imgs[v] && S.scale?.[v]) autoCropPreserveData(v); });
    }
  }
  if (n === 6) initVisualHull();
  if (n === 7) initVectorize();
  if (n === 8) { setDimView('front'); }
  if (n === 9) initLayout();
  if (n === 10) copyToExport();
}

