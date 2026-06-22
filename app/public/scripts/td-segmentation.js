// ══════════════════════════ STEP 3: SEGMENTATION ══════════════════════════
let segSrc, segOut, segComp, segCtxS, segCtxO, segCtxC, segImgEl;
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
  segComp = document.getElementById('seg-computed');
  if (!segSrc || !segOut) return;
  segCtxS = segSrc.getContext('2d');
  segCtxO = segOut.getContext('2d');
  segCtxC = segComp ? segComp.getContext('2d') : null;

  // Capture view now — the onload callback is async and S.segView may change before it fires.
  const myView = S.segView;
  const url = S.imgs[myView];
  if (!url) return;
  segImgEl = new Image();
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
    if (segComp) { segComp.width = w; segComp.height = h; segComp.style.width = w+'px'; segComp.style.height = h+'px'; }
    segCtxS.drawImage(segImgEl, 0, 0, w, h);
    S.segImgData = segCtxS.getImageData(0, 0, w, h);
    // Sync slider from saved threshold BEFORE applyThreshold reads it.
    const savedT = segThresholds[myView] ?? 120;
    const sliderEl = document.getElementById('seg-slider');
    const valEl = document.getElementById('seg-val');
    if (sliderEl) sliderEl.value = savedT;
    if (valEl) valEl.textContent = savedT;
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
  _updateSegMeta(S.segView, mask, W, H);
  _updateContourSegBadges();
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
  _updateSegMeta(S.segView, mask, W, H);
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
  // Erode then dilate the binary output to remove noise
  if (!S.segImgData || !segCtxO) return;
  const W=segOut.width, H=segOut.height;
  const imgd = segCtxO.getImageData(0,0,W,H);
  const bin = new Uint8ClampedArray(W*H);
  for (let i=0;i<W*H;i++) bin[i]=imgd.data[i*4]>127?255:0;
  const eroded = erodeMask(bin,W,H,2);
  const cleaned = dilateEdges(eroded,W,H,2);
  const out = segCtxO.createImageData(W,H);
  for (let i=0;i<W*H;i++) { out.data[i*4]=out.data[i*4+1]=out.data[i*4+2]=cleaned[i]; out.data[i*4+3]=255; }
  segCtxO.putImageData(out,0,0);
}

function applyThreshold() {
  const t = parseInt(document.getElementById('seg-slider').value);
  document.getElementById('seg-val').textContent = t;
  segThresholds[S.segView] = t;
  if (!S.segImgData || !segCtxO) return;
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
  _updateSegMeta(S.segView, mask, W, H);
  // Layer 2: segmentation intelligence
  const _segArea = mask.reduce((s, v) => s + (v ? 1 : 0), 0);
  ctxWrite(S.segView, 'seg', { area: _segArea, coverage: _segArea / (W*H), W, H, method: 'threshold' });
  _updateContourSegBadges();
  // Compute per-view reliability score from boundary gradient sharpness
  _computeSegScore(S.segView, mask, W, H);
  // Rebuild cross-view model (now also uses S.isoData if available)
  buildObjectModel();
  // Re-run ISO pipeline in background — new ortho scale/mask may change ISO dims,
  // then compute improved silhouette for 3rd panel
  runIsoFullPipeline(() => {
    _renderModelBar(document.getElementById('seg-model-bar'));
    _renderSegScoreBar(document.getElementById('seg-score-bar'));
    // Compute improved silhouette for EVERY view that has a raw mask,
    // not just the currently visible one — so Contour Drawing gets Computed data for all 3 views.
    for (const v of ['front', 'side', 'top']) {
      if (S.segMasks?.[v]) _improveSegFromISO(v);
    }
  });
}

// ── Computed silhouette (3rd panel) ───────────────────────────────────────────
// STEP 1 (always): seal open border concavities + fill enclosed holes.
//   This is purely self-consistent — same ortho image, just filling interior gaps
//   (e.g. arch openings that were touching the border and thus not filled).
// STEP 2 (only when score < 4): union with ISO face mask inside the ortho bbox.
//   Adds pixels that the ortho segmentation missed, restricted to the object area.
//   NEVER applied for high-quality views (score ≥ 4) — avoids wrong-perspective bleed.
function _improveSegFromISO(view) {
  const ortho = S.segMasks?.[view];
  if (!ortho) { if (view === S.segView) _clearComputed(); return; }
  const { mask: orthoMask, W: oW, H: oH } = ortho;

  // ── Step 1: seal + fill on the ortho mask itself ──────────────────────────
  const score = S.segScore?.[view] ?? 5;
  const blob = findLargestBlob(orthoMask, oW, oH);
  if (!blob || blob.length < 20) { if (view === S.segView) _clearComputed(); return; }
  const blobMask = new Uint8ClampedArray(oW * oH);
  blob.forEach(i => { blobMask[i] = 255; });

  // High-quality views: only fill enclosed holes — don't alter the boundary.
  // Low-quality views: also seal border concavities (arch openings on the border).
  const sealed = score >= 6 ? blobMask : _sealBorderConcavities(blobMask, oW, oH);
  let improved = morphFillHoles(sealed, oW, oH);

  // ── Step 2: multi-source voting for low-quality views (score < 4) ──────────
  if (score < 4) {
    // votes[i] accumulates evidence that pixel i belongs to the object.
    const votes = new Uint8ClampedArray(oW * oH);

    // Source A — raw blob (weight 1): noisy but real signal from this view's image
    blob.forEach(i => { votes[i] += 1; });

    // Source B — seal+fill mask (weight 2): cleaned version of the ortho mask
    for (let i = 0; i < oW*oH; i++) if (improved[i]) votes[i] += 2;

    // Source C — ISO face mask (weight 1): clean silhouette, different perspective
    const isoFace = S.isoFaceMasks?.[view];
    if (isoFace) {
      // Find bboxes for alignment
      let oX0=oW,oX1=0,oY0=oH,oY1=0;
      for (let y=0;y<oH;y++) for (let x=0;x<oW;x++) {
        if (!improved[y*oW+x]) continue;
        if(x<oX0)oX0=x; if(x>oX1)oX1=x; if(y<oY0)oY0=y; if(y>oY1)oY1=y;
      }
      let fX0=isoFace.W,fX1=0,fY0=isoFace.H,fY1=0;
      for (let y=0;y<isoFace.H;y++) for (let x=0;x<isoFace.W;x++) {
        if (!isoFace.mask[y*isoFace.W+x]) continue;
        if(x<fX0)fX0=x; if(x>fX1)fX1=x; if(y<fY0)fY0=y; if(y>fY1)fY1=y;
      }
      if (oX1>oX0 && oY1>oY0 && fX1>fX0 && fY1>fY0) {
        const scX=(oX1-oX0)/(fX1-fX0), scY=(oY1-oY0)/(fY1-fY0);
        for (let fy=fY0;fy<=fY1;fy++) for (let fx=fX0;fx<=fX1;fx++) {
          if (!isoFace.mask[fy*isoFace.W+fx]) continue;
          const ox=Math.round(oX0+(fx-fX0)*scX), oy=Math.round(oY0+(fy-fY0)*scY);
          if (ox>=0&&ox<oW&&oy>=0&&oy<oH) votes[oy*oW+ox] += 1;
        }
      }
    }

    // Source D — best other orthographic view(s) projected as bbox prior (weight 1 each)
    // If we know the object's height from the best other view, we can constrain this view.
    const otherViews = ['front','side','top'].filter(v => v !== view);
    for (const ov of otherViews) {
      const otherScore = S.segScore?.[ov] ?? 0;
      if (otherScore < 6) continue;                         // only trust high-quality views
      const otherMask = S.segMaskImproved?.[ov] ?? S.segMasks?.[ov];
      if (!otherMask) continue;
      const { mask: om, W: omW, H: omH } = otherMask;
      // Get the other view's object bbox
      let bX0=omW,bX1=0,bY0=omH,bY1=0;
      for (let y=0;y<omH;y++) for (let x=0;x<omW;x++) {
        if (!om[y*omW+x]) continue;
        if(x<bX0)bX0=x; if(x>bX1)bX1=x; if(y<bY0)bY0=y; if(y>bY1)bY1=y;
      }
      if (bX1<=bX0 || bY1<=bY0) continue;
      // Project: the object should occupy a similar fraction of the canvas in this view.
      // Map other-view's bbox proportions → this view's canvas as a rectangular prior.
      const oX0p = Math.round((bX0/omW)*oW), oX1p = Math.round((bX1/omW)*oW);
      const oY0p = Math.round((bY0/omH)*oH), oY1p = Math.round((bY1/omH)*oH);
      const pad  = Math.round(Math.min(oW,oH)*0.04);
      for (let y=Math.max(0,oY0p-pad);y<=Math.min(oH-1,oY1p+pad);y++)
        for (let x=Math.max(0,oX0p-pad);x<=Math.min(oW-1,oX1p+pad);x++)
          votes[y*oW+x] += 1;
    }

    // Threshold: a pixel is object if it gets ≥ 3 weighted votes.
    // (max possible = 1+2+1+1+2 = 7; 3 = clear majority)
    const fused = new Uint8ClampedArray(oW * oH);
    for (let i=0;i<oW*oH;i++) if (votes[i] >= 3) fused[i] = 255;
    // Smooth result — voting can leave salt-and-pepper; close small gaps
    improved = morphCloseDisk(fused, oW, oH, 4);
  }

  // ── Depth: hard-remove sure-background pixels (all views, all quality levels) ─
  // Runs AFTER voting/improvement so depth cannot accidentally remove object pixels
  // that other sources confirmed as foreground before depth was available.
  // Threshold 0.15 = only very far pixels (conservative to avoid false removals).
  if (typeof depthSureBackground === 'function') {
    const sureBg = depthSureBackground(view, oW, oH, 0.15);
    if (sureBg) {
      for (let i = 0; i < oW * oH; i++) {
        if (sureBg[i]) improved[i] = 0; // hard veto — depth overrides all other sources
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

  // ── Display: only for the view currently shown on screen ──────────────────
  if (view !== S.segView) return;

  if (segCtxC && segComp && segComp.width === oW) {
    const out = segCtxC.createImageData(oW, oH);
    for (let i=0; i<oW*oH; i++) {
      out.data[i*4]=out.data[i*4+1]=out.data[i*4+2]=improved[i]; out.data[i*4+3]=255;
    }
    segCtxC.putImageData(out, 0, 0);
  }

  // Score label — uses S.segImgData which belongs to S.segView (same as view here)
  const lbl = document.getElementById('seg-computed-label');
  if (lbl) {
    const src = S.segImgData?.data;
    let newScore = score;
    if (src && src.length === oW * oH * 4) {
      const gray = new Uint8ClampedArray(oW*oH);
      for (let i=0; i<oW*oH; i++) gray[i]=src[i*4]*.299+src[i*4+1]*.587+src[i*4+2]*.114;
      let tot=0, cnt=0;
      for (let y=1; y<oH-1; y++) for (let x=1; x<oW-1; x++) {
        const idx=y*oW+x; if (!improved[idx]) continue;
        if (!improved[idx-1]||!improved[idx+1]||!improved[idx-oW]||!improved[idx+oW]) {
          const gx=-gray[(y-1)*oW+(x-1)]+gray[(y-1)*oW+(x+1)]-2*gray[y*oW+(x-1)]+2*gray[y*oW+(x+1)]-gray[(y+1)*oW+(x-1)]+gray[(y+1)*oW+(x+1)];
          const gy=-gray[(y-1)*oW+(x-1)]-2*gray[(y-1)*oW+x]-gray[(y-1)*oW+(x+1)]+gray[(y+1)*oW+(x-1)]+2*gray[(y+1)*oW+x]+gray[(y+1)*oW+(x+1)];
          tot+=Math.sqrt(gx*gx+gy*gy); cnt++;
        }
      }
      if (cnt) newScore=Math.min(10,Math.max(1,Math.round(tot/cnt/18)));
    }
    const arrow = newScore > score ? `<span style="color:#4ade80">${score}→${newScore}</span>`
                : newScore < score ? `<span style="color:#f87171">${score}→${newScore}</span>`
                : `<span style="color:var(--muted)">${score}</span>`;
    lbl.innerHTML = `Computed &nbsp;${arrow}`;
  }
}

function _clearComputed() {
  if (segCtxC && segComp) segCtxC.clearRect(0, 0, segComp.width, segComp.height);
  const lbl = document.getElementById('seg-computed-label');
  if (lbl) lbl.textContent = 'Computed';
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