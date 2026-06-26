// ══════════════════════════ STEP 3: SEGMENTATION ══════════════════════════
let segSrc, segOut, segCtxS, segCtxO, segImgEl;
const segThresholds = { front: 120, side: 120, top: 120 };

function setSegView(v) {
  S.segView = v;
  document.querySelectorAll('.seg-tab').forEach(t => t.classList.toggle('active', t.dataset.v === v));
  // Restore this view's threshold before re-init
  const slider = document.getElementById('seg-slider');
  const valEl  = document.getElementById('seg-val');
  if (slider) slider.value = segThresholds[v] ?? 120;
  if (valEl)  valEl.textContent = segThresholds[v] ?? 120;
  initSeg();
}

function initSeg() {
  segSrc  = document.getElementById('seg-src');
  segOut  = document.getElementById('seg-out');
  if (!segSrc || !segOut) return;
  segCtxS = segSrc.getContext('2d');
  segCtxO = segOut.getContext('2d');

  // Capture view now — the onload callback is async and S.segView may change before it fires.
  const myView = S.segView;
  const url = S.imgs[myView];
  if (!url) return;
  segImgEl = new Image();
  segImgEl.onerror = () => {
    if (myView !== S.segView) return;
    segCtxS.clearRect(0, 0, segSrc.width, segSrc.height);
    segCtxO.clearRect(0, 0, segOut.width, segOut.height);
  };
  segImgEl.onload = () => {
    // Stale: user switched to a different view before this image finished loading
    if (myView !== S.segView) return;
    const maxW = segSrc.parentElement.offsetWidth - 4;
    const r = Math.min(maxW / segImgEl.width, 320 / segImgEl.height, 1);
    const w = Math.round(segImgEl.width * r), h = Math.round(segImgEl.height * r);
    segSrc.width = w; segSrc.height = h;
    segOut.width = w; segOut.height = h;
    segSrc.style.width = w + 'px'; segSrc.style.height = h + 'px';
    segOut.style.width = w + 'px'; segOut.style.height = h + 'px';
    segCtxS.drawImage(segImgEl, 0, 0, w, h);
    S.segImgData = segCtxS.getImageData(0, 0, w, h);
    // Sync slider from saved threshold BEFORE applyThreshold reads it.
    const savedT = segThresholds[myView] ?? 120;
    const sliderEl = document.getElementById('seg-slider');
    const valEl = document.getElementById('seg-val');
    if (sliderEl) sliderEl.value = savedT;
    if (valEl) valEl.textContent = savedT;
    _drawSegHistogram(S.segImgData, w, h, savedT);
    applyThreshold();
  };
  segImgEl.src = url;
}

const segModes = { front:'dark', side:'dark', top:'dark' };

function setSegMode(mode) {
  segModes[S.segView] = mode;
  document.getElementById('seg-mode-dark').style.background  = mode==='dark'  ? 'rgba(13,148,136,.2)' : 'var(--surface)';
  document.getElementById('seg-mode-dark').style.borderColor = mode==='dark'  ? 'var(--teal)' : 'var(--border)';
  document.getElementById('seg-mode-dark').style.color       = mode==='dark'  ? 'var(--teal-light)' : 'var(--subtle)';
  document.getElementById('seg-mode-light').style.background  = mode==='light' ? 'rgba(13,148,136,.2)' : 'var(--surface)';
  document.getElementById('seg-mode-light').style.borderColor = mode==='light' ? 'var(--teal)' : 'var(--border)';
  document.getElementById('seg-mode-light').style.color       = mode==='light' ? 'var(--teal-light)' : 'var(--subtle)';
  applyThreshold();
}

function segAutoOtsu() {
  if (!S.segImgData) return;
  const src = S.segImgData.data, n = src.length/4;
  const hist = new Int32Array(256);
  for (let i=0; i<n; i++) hist[Math.round(src[i*4]*.299+src[i*4+1]*.587+src[i*4+2]*.114)]++;
  let sum=0; for (let i=0;i<256;i++) sum+=i*hist[i];
  let sumB=0,wB=0,maxV=0,t=128;
  for (let i=0;i<256;i++) {
    wB+=hist[i]; if (!wB) continue;
    const wF=n-wB; if (!wF) break;
    sumB+=i*hist[i];
    const v=wB*wF*((sumB/wB)-(sum-sumB)/wF)**2;
    if (v>maxV) { maxV=v; t=i; }
  }
  const sl=document.getElementById('seg-slider');
  const valEl=document.getElementById('seg-val');
  if (sl) sl.value=t; if (valEl) valEl.textContent=t;
  segThresholds[S.segView]=t; applyThreshold();
}

// ─── Sauvola adaptive threshold (skimage.filters.threshold_sauvola) ──────────
// Spatially-varying binarisation — outperforms global Otsu on images with
// shadows or uneven lighting. Window size auto-selected from image dimensions.
function segAutoSauvola() {
  if (!S.segImgData || !segCtxO) return;
  const src  = S.segImgData.data;
  const W    = segOut.width, H = segOut.height;
  const mode = segModes[S.segView] ?? 'dark';

  const gray = new Uint8ClampedArray(W * H);
  for (let i = 0; i < W * H; i++)
    gray[i] = src[i*4]*0.299 + src[i*4+1]*0.587 + src[i*4+2]*0.114;

  // For light-object mode, invert so Sauvola still detects "dark vs local mean"
  const work = mode === 'light'
    ? Uint8ClampedArray.from(gray, v => 255 - v)
    : gray;

  let mask = thresholdSauvola(work, W, H);
  mask = _safeRemoveBorderConnected(mask, W, H);

  const out = segCtxO.createImageData(W, H);
  for (let i = 0; i < W * H; i++) {
    out.data[i*4] = out.data[i*4+1] = out.data[i*4+2] = mask[i];
    out.data[i*4+3] = 255;
  }
  segCtxO.putImageData(out, 0, 0);
  if (!S.segMasks) S.segMasks = {};
  S.segMasks[S.segView] = { mask, W, H };
  _updateSegMeta(S.segView, mask, W, H, segImgEl?.naturalWidth, segImgEl?.naturalHeight);
  _updateContourSegBadges();
  const _area = mask.reduce((s,v)=>s+(v?1:0),0);
  ctxWrite(S.segView, 'seg', { area: _area, coverage: _area/(W*H), W, H, method: 'sauvola' });
  _computeSegScore(S.segView, mask, W, H);
  buildObjectModel();
  runIsoFullPipeline(() => {
    _renderSegScoreBar(document.getElementById('seg-score-bar'));
    for (const v of ['front','side','top']) {
      if (S.segMasks?.[v]) _improveSegFromISO(v);
    }
  });
}

// ─── Fill interior holes (skimage.morphology.remove_small_holes) ─────────────
// Reads current binary output, fills enclosed background regions, re-displays.
function segFillHoles() {
  if (!segCtxO) return;
  const W = segOut.width, H = segOut.height;
  const imgd = segCtxO.getImageData(0, 0, W, H);
  let mask = new Uint8ClampedArray(W * H);
  for (let i = 0; i < W * H; i++) mask[i] = imgd.data[i*4] > 127 ? 255 : 0;
  mask = morphFillHoles(mask, W, H);
  const out = segCtxO.createImageData(W, H);
  for (let i = 0; i < W * H; i++) {
    out.data[i*4] = out.data[i*4+1] = out.data[i*4+2] = mask[i];
    out.data[i*4+3] = 255;
  }
  segCtxO.putImageData(out, 0, 0);
  if (!S.segMasks) S.segMasks = {};
  S.segMasks[S.segView] = { mask, W, H };
  _updateSegMeta(S.segView, mask, W, H, segImgEl?.naturalWidth, segImgEl?.naturalHeight);
  _updateContourSegBadges();
}

function saveSegSettings() {
  persistState();
  const btn = document.getElementById('seg-save-btn');
  if (!btn) return;
  const orig = btn.textContent;
  btn.textContent = '✓ Saved';
  btn.style.background = 'rgba(74,222,128,.15)';
  btn.style.borderColor = '#4ade80';
  btn.style.color = '#4ade80';
  setTimeout(() => {
    btn.textContent = orig;
    btn.style.background = 'var(--surface)';
    btn.style.borderColor = 'var(--border)';
    btn.style.color = 'var(--subtle)';
  }, 1800);
}

function segMorphClean() {
  // Erode then dilate the binary output to remove noise (morphological opening)
  if (!segCtxO) return;
  const W=segOut.width, H=segOut.height;
  const imgd = segCtxO.getImageData(0,0,W,H);
  const bin = new Uint8ClampedArray(W*H);
  for (let i=0;i<W*H;i++) bin[i]=imgd.data[i*4]>127?255:0;
  const eroded = erodeMask(bin,W,H,2);
  const cleaned = dilateEdges(eroded,W,H,2);
  const out = segCtxO.createImageData(W,H);
  for (let i=0;i<W*H;i++) { out.data[i*4]=out.data[i*4+1]=out.data[i*4+2]=cleaned[i]; out.data[i*4+3]=255; }
  segCtxO.putImageData(out,0,0);
  // Save cleaned mask so the contour step uses the noise-free version
  if (!S.segMasks) S.segMasks = {};
  S.segMasks[S.segView] = { mask: cleaned, W, H };
  _updateSegMeta(S.segView, cleaned, W, H, segImgEl?.naturalWidth, segImgEl?.naturalHeight);
  _computeSegScore(S.segView, cleaned, W, H);
  _updateContourSegBadges();
  runIsoFullPipeline(() => {
    for (const v of ['front', 'side', 'top']) {
      if (S.segMasks?.[v]) _improveSegFromISO(v);
    }
  });
}

// Draw a grayscale luminance histogram on the #seg-histogram canvas.
// Overlays a teal vertical line at the current threshold value.
function _drawSegHistogram(imgData, W, H, t) {
  const hCanvas = document.getElementById('seg-histogram');
  if (!hCanvas) return;
  const cW = hCanvas.offsetWidth || hCanvas.width || 300;
  hCanvas.width = cW;
  const cH = hCanvas.height;
  const hCtx = hCanvas.getContext('2d');
  hCtx.clearRect(0, 0, cW, cH);

  // Build histogram
  const hist = new Int32Array(256);
  const d = imgData.data;
  const n = W * H;
  for (let i = 0; i < n; i++)
    hist[Math.round(d[i*4]*0.299 + d[i*4+1]*0.587 + d[i*4+2]*0.114)]++;

  // Find max (skip 0 and 255 which are often clipped extremes)
  let maxH = 0;
  for (let i = 1; i < 255; i++) if (hist[i] > maxH) maxH = hist[i];
  if (!maxH) return;

  // Draw bars
  const barW = cW / 256;
  hCtx.fillStyle = 'rgba(148,163,184,0.55)';
  for (let i = 0; i < 256; i++) {
    const bH = Math.round((hist[i] / maxH) * (cH - 2));
    hCtx.fillRect(i * barW, cH - bH, barW + 0.5, bH);
  }

  // Threshold line
  hCtx.strokeStyle = '#2dd4bf';
  hCtx.lineWidth   = 1.5;
  hCtx.beginPath();
  const tx = (t / 255) * cW;
  hCtx.moveTo(tx, 0); hCtx.lineTo(tx, cH);
  hCtx.stroke();
}

function applyThreshold() {
  const t = parseInt(document.getElementById('seg-slider').value);
  document.getElementById('seg-val').textContent = t;
  segThresholds[S.segView] = t;
  if (!S.segImgData || !segCtxO) return;
  _drawSegHistogram(S.segImgData, segOut.width, segOut.height, t);
  const src = S.segImgData.data;
  const W = segOut.width, H = segOut.height;
  const mode = segModes[S.segView] ?? 'dark';

  // Raw threshold
  let mask = new Uint8ClampedArray(W*H);
  for (let i=0; i<W*H; i++) {
    const g = src[i*4]*.299 + src[i*4+1]*.587 + src[i*4+2]*.114;
    mask[i] = (mode==='dark' ? g < t : g > t) ? 255 : 0;
  }

  // Remove ruler / calibration grid: they are connected to the image border.
  // Safe version: if border removal would wipe >60% of the mask, the object itself
  // touches the border (common in side views) — revert to keep the object.
  mask = _safeRemoveBorderConnected(mask, W, H);

  // Display the cleaned silhouette so what you see = what contour will use
  const out = segCtxO.createImageData(W, H);
  for (let i=0; i<W*H; i++) {
    out.data[i*4] = out.data[i*4+1] = out.data[i*4+2] = mask[i];
    out.data[i*4+3] = 255;
  }
  segCtxO.putImageData(out, 0, 0);

  // Save cleaned mask per-view so contour step can use it directly
  if (!S.segMasks) S.segMasks = {};
  S.segMasks[S.segView] = { mask, W, H };
  _updateSegMeta(S.segView, mask, W, H, segImgEl?.naturalWidth, segImgEl?.naturalHeight);
  // Layer 2: segmentation intelligence
  const _segArea = mask.reduce((s, v) => s + (v ? 1 : 0), 0);
  ctxWrite(S.segView, 'seg', { area: _segArea, coverage: _segArea / (W*H), W, H, method: 'threshold' });
  _updateContourSegBadges();
  // Compute per-view reliability score from boundary gradient sharpness
  _computeSegScore(S.segView, mask, W, H);
  // Rebuild cross-view model (now also uses S.isoData if available)
  buildObjectModel();
  // Debounced ISO pipeline — slider drags fire applyThreshold many times per second.
  // Only run once the user pauses for 400ms; avoids concurrent pipeline race conditions.
  clearTimeout(applyThreshold._isoTimer);
  applyThreshold._isoTimer = setTimeout(() => {
    runIsoFullPipeline(() => {
      _renderModelBar(document.getElementById('seg-model-bar'));
      _renderSegScoreBar(document.getElementById('seg-score-bar'));
      for (const v of ['front', 'side', 'top']) {
        if (S.segMasks?.[v]) _improveSegFromISO(v);
      }
    });
  }, 400);
}

// ── Computed silhouette (3rd panel) ───────────────────────────────────────────
// Pipeline (all quality levels):
//   1. Largest blob extraction  — removes noise blobs
//   2. Morphological close      — closes small gaps inside the object
//      (radius 4 for good views, 8 for low-quality)
//   3. Fill enclosed holes      — removes remaining interior background pockets
//   4. Depth veto               — hard-remove sure-background pixels if depth available
//   5. Symmetry fill            — mirror-fill across detected axis
function _improveSegFromISO(view) {
  const ortho = S.segMasks?.[view];
  if (!ortho) return;
  const { mask: orthoMask, W: oW, H: oH } = ortho;

  const score = S.segScore?.[view] ?? 5;

  // ── Step 1: keep only the largest blob ────────────────────────────────────
  const blob = findLargestBlob(orthoMask, oW, oH);
  if (!blob || blob.length < 20) return;
  const blobMask = new Uint8ClampedArray(oW * oH);
  blob.forEach(i => { blobMask[i] = 255; });

  // ── Step 2: morphological close to bridge small gaps ──────────────────────
  // Radius scales with image size, capped at 4px to avoid destroying thin features
  // (trunk, legs) — a disk close with r=8 kills any feature narrower than 16px.
  const baseR = Math.max(1, Math.round(Math.min(oW, oH) * 0.012));
  const closeR = Math.min(4, score < 4 ? baseR * 2 : baseR);
  let improved = morphCloseDisk(blobMask, oW, oH, closeR);

  // ── Step 3: fill enclosed interior holes ──────────────────────────────────
  improved = morphFillHoles(improved, oW, oH);

  // ── Depth: hard-remove sure-background pixels ────────────────────────────
  if (typeof depthSureBackground === 'function') {
    const sureBg = depthSureBackground(view, oW, oH, 0.15);
    if (sureBg) for (let i = 0; i < oW*oH; i++) if (sureBg[i]) improved[i] = 0;
  }

  // ── Depth: expand mask toward sure-foreground pixels ─────────────────────
  // Pixels that depth says are close but the mask misses → include them,
  // only if within 4px of existing mask (avoids adding noise far from object).
  if (typeof depthSureForeground === 'function' && typeof morphDilateDisk === 'function') {
    const sureFg = depthSureForeground(view, oW, oH);
    if (sureFg) {
      const nearby = morphDilateDisk(improved, oW, oH, 4);
      for (let i = 0; i < oW*oH; i++) if (sureFg[i] && nearby[i]) improved[i] = 255;
    }
  }

  // ── Cross-view bbox constraint ────────────────────────────────────────────
  // Use objectModel consensus dims to clip the mask when cross-view agreement is high.
  // Catches contours that are significantly wider/taller than all other views indicate.
  const _om = S.objectModel;
  const _ppm = S.scale?.[view];
  const _sm  = S.segMeta?.[view];
  if (_om?.dims && _ppm && _sm?.origW) {
    const maskPPM = _ppm * oW / _sm.origW;
    const expW_mm = (view==='front'||view==='top') ? _om.dims.W : _om.dims.D;
    const expH_mm = (view==='front'||view==='side') ? _om.dims.H : _om.dims.D;
    const consW   = (view==='front'||view==='top') ? _om.consistency.W : _om.consistency.D;
    const consH   = (view==='front'||view==='side') ? _om.consistency.H : _om.consistency.D;
    if (expW_mm && expH_mm && maskPPM > 0) {
      let bx1=oW, bx2=0, by1=oH, by2=0;
      for (let y=0;y<oH;y++) for (let x=0;x<oW;x++) if (improved[y*oW+x]) {
        if (x<bx1)bx1=x; if (x>bx2)bx2=x; if (y<by1)by1=y; if (y>by2)by2=y;
      }
      if (bx2>bx1) {
        const cx=(bx1+bx2)/2, cy=(by1+by2)/2;
        const currW=bx2-bx1, currH=by2-by1;
        const expW_px=expW_mm*maskPPM, expH_px=expH_mm*maskPPM;
        if (consW>0.85 && expW_px<currW*0.88) {
          const cx1=Math.round(cx-expW_px/2), cx2=Math.round(cx+expW_px/2);
          for (let y=0;y<oH;y++) {
            for (let x=0;x<cx1;x++) improved[y*oW+x]=0;
            for (let x=Math.max(0,cx2+1);x<oW;x++) improved[y*oW+x]=0;
          }
        }
        if (consH>0.85 && expH_px<currH*0.88) {
          const cy1=Math.round(cy-expH_px/2), cy2=Math.round(cy+expH_px/2);
          for (let y=0;y<cy1;y++) for (let x=0;x<oW;x++) improved[y*oW+x]=0;
          for (let y=Math.max(0,cy2+1);y<oH;y++) for (let x=0;x<oW;x++) improved[y*oW+x]=0;
        }
      }
    }
  }

  // ── Symmetry: detect axis and apply to fill asymmetric noise/gaps ─────────
  const sym = detectMaskSymmetry(improved, oW, oH);
  if (!S.symmetry) S.symmetry = {};
  S.symmetry[view] = sym;   // null means not symmetric — stored for contour + export steps
  if (sym) improved = applyMaskSymmetry(improved, oW, oH, sym);

  // ── Store ─────────────────────────────────────────────────────────────────
  if (!S.segMaskImproved) S.segMaskImproved = {};
  S.segMaskImproved[view] = { mask: improved, W: oW, H: oH };
}

// ── Segmentation reliability scorer ──────────────────────────────────────────
// For every boundary pixel (white pixel with a black neighbour), measure the
// Sobel gradient in the *original* image.  A sharp gradient = confident edge.
// Overall score 1–10 (10 = most reliable).  Also broken into 4 quadrant regions.
function _computeSegScore(v, mask, W, H) {
  const src = S.segImgData?.data;
  if (!src || src.length !== W * H * 4) return;

  const gray = new Uint8ClampedArray(W * H);
  for (let i = 0; i < W * H; i++)
    gray[i] = src[i*4]*.299 + src[i*4+1]*.587 + src[i*4+2]*.114;

  const pts = [];
  for (let y = 1; y < H-1; y++) {
    for (let x = 1; x < W-1; x++) {
      const i = y*W+x;
      if (!mask[i]) continue;
      if (!mask[i-1] || !mask[i+1] || !mask[i-W] || !mask[i+W]) {
        const gx = -gray[(y-1)*W+(x-1)] + gray[(y-1)*W+(x+1)]
                   -2*gray[y*W+(x-1)]   + 2*gray[y*W+(x+1)]
                   -gray[(y+1)*W+(x-1)] + gray[(y+1)*W+(x+1)];
        const gy = -gray[(y-1)*W+(x-1)] - 2*gray[(y-1)*W+x] - gray[(y-1)*W+(x+1)]
                   +gray[(y+1)*W+(x-1)] + 2*gray[(y+1)*W+x] + gray[(y+1)*W+(x+1)];
        pts.push({ x, y, q: Math.sqrt(gx*gx + gy*gy) });
      }
    }
  }
  if (!pts.length) return;

  // Map average gradient to 1–10 (empirical: clean print edge ≈ 80–150 Sobel units)
  const avg = pts.reduce((s, p) => s + p.q, 0) / pts.length;
  const toScore = val => Math.min(10, Math.max(1, Math.round(val / 18)));

  // Quadrant regions: assign each boundary pixel to its dominant quadrant
  const cx = W/2, cy = H/2;
  const reg = { top:[], right:[], bottom:[], left:[] };
  pts.forEach(({ x, y, q }) => {
    const dx = x - cx, dy = y - cy;
    if (Math.abs(dy) >= Math.abs(dx))
      (dy < 0 ? reg.top : reg.bottom).push(q);
    else
      (dx > 0 ? reg.right : reg.left).push(q);
  });
  const avgR = arr => arr.length
    ? toScore(arr.reduce((s,v) => s+v, 0) / arr.length)
    : null;

  if (!S.segScore)   S.segScore   = {};
  if (!S.segRegions) S.segRegions = {};
  S.segScore[v]   = toScore(avg);
  S.segRegions[v] = {
    top:    avgR(reg.top),
    right:  avgR(reg.right),
    bottom: avgR(reg.bottom),
    left:   avgR(reg.left),
  };
}

// ── Score bar renderer ────────────────────────────────────────────────────────
function _renderSegScoreBar(el) {
  if (!el || !S.segScore) return;
  const views = [['front','Front'],['side','Side'],['top','Top']];
  const bar = score => {
    if (score == null) return '<span style="color:var(--border)">—</span>';
    const filled = Math.round(score);
    const color  = score >= 7 ? '#10B981' : score >= 4 ? '#F59E0B' : '#EF4444';
    return `<span style="font-family:'Fira Code',monospace;color:${color};font-weight:700;">${score}/10</span>`;
  };
  const regionRow = v => {
    const r = S.segRegions?.[v]; if (!r) return '';
    return ['top','right','bottom','left'].map(k => {
      if (r[k] == null) return '';
      const c = r[k]>=7?'#10B981':r[k]>=4?'#F59E0B':'#EF4444';
      return `<span style="font-size:9px;color:${c};white-space:nowrap;">${k[0].toUpperCase()}:${r[k]}</span>`;
    }).join(' ');
  };
  const symBadge = v => {
    const sym = S.symmetry?.[v];
    if (!sym) return '';
    const icon = sym.dir === 'v' ? '⟺' : '⇳';
    return `<div style="font-size:9px;color:#2dd4bf;white-space:nowrap;" title="Symmetry axis detected, score ${Math.round(sym.score*100)}%">${icon} Sym ${Math.round(sym.score*100)}%</div>`;
  };

  el.innerHTML = `
    <div style="display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap;padding:8px 12px;background:var(--surface);border:1px solid var(--border);border-radius:10px;">
      <span style="font-size:10px;font-weight:700;color:var(--subtle);text-transform:uppercase;letter-spacing:.07em;align-self:center;">Reliability</span>
      ${views.map(([v,lbl]) => {
        const sc = S.segScore?.[v];
        return `
          <div style="display:flex;flex-direction:column;gap:3px;min-width:80px;">
            <div style="display:flex;align-items:center;gap:6px;">
              <span style="font-size:11px;color:var(--muted);">${lbl}</span>
              ${bar(sc)}
            </div>
            <div style="display:flex;gap:4px;">${regionRow(v)}</div>
            ${symBadge(v)}
          </div>`;
      }).join('')}
      <div style="flex:1;font-size:10px;color:var(--muted);align-self:center;line-height:1.5;">
        ${(() => {
          const scores = Object.entries(S.segScore || {});
          if (!scores.length) return '';
          const best = scores.sort((a,b)=>b[1]-a[1])[0];
          return `Best source: <b style="color:var(--teal-light)">${best[0]}</b> (${best[1]}/10)`;
        })()}
      </div>
    </div>`;
}

function _updateContourSegBadges() {
  for (const v of ['front','side','top']) {
    const el = document.getElementById(`stab-badge-${v}`);
    if (el) el.textContent = S.segMasks?.[v] ? ' ✓' : '';
  }
}