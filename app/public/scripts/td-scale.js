// ══════════════════════════ STEP 2: SCALE ══════════════════════════
let scC, scCtx, scImg;
let scZoom = { s: 1 };

// ── Ruler auto-detection (autocorrelation on Sobel edges) ────
function _autocorrelPeriod(signal, minLag, maxLag) {
  const n = signal.length;
  let bestLag = 0, bestScore = -Infinity;
  let mean = 0;
  for (let i=0; i<n; i++) mean += signal[i];
  mean /= n;
  const c = signal.map(v => v - mean);
  for (let lag=minLag; lag<=maxLag; lag++) {
    let ac=0, cnt=0;
    for (let i=0; i<n-lag; i++) { ac += c[i]*c[i+lag]; cnt++; }
    if (cnt) ac /= cnt;
    if (ac > bestScore) { bestScore=ac; bestLag=lag; }
  }
  return { period: bestLag, score: bestScore };
}
function _rulerSobelX(gray, W, H) {
  const out = new Float32Array(W*H);
  for (let y=1; y<H-1; y++) for (let x=1; x<W-1; x++) {
    const gx = -gray[(y-1)*W+(x-1)] + gray[(y-1)*W+(x+1)]
               -2*gray[y*W+(x-1)]   + 2*gray[y*W+(x+1)]
               -gray[(y+1)*W+(x-1)] + gray[(y+1)*W+(x+1)];
    out[y*W+x] = Math.abs(gx);
  }
  return out;
}
function _rulerSobelY(gray, W, H) {
  const out = new Float32Array(W*H);
  for (let y=1; y<H-1; y++) for (let x=1; x<W-1; x++) {
    const gy = -gray[(y-1)*W+(x-1)] - 2*gray[(y-1)*W+x] - gray[(y-1)*W+(x+1)]
               +gray[(y+1)*W+(x-1)] + 2*gray[(y+1)*W+x] + gray[(y+1)*W+(x+1)];
    out[y*W+x] = Math.abs(gy);
  }
  return out;
}
function _findBestBandH(edgeX, W, H) {
  const bH = Math.max(6, Math.floor(H*.07)), step = Math.max(1, Math.floor(bH/2));
  let bestY=0, bestScore=-Infinity;
  for (let y=0; y<=H-bH; y+=step) {
    const sig = new Float32Array(W);
    for (let x=0; x<W; x++) for (let dy=0; dy<bH; dy++) sig[x] += edgeX[(y+dy)*W+x];
    const energy = sig.reduce((s,v)=>s+v,0)/W;
    if (energy < 1) continue;
    const { score } = _autocorrelPeriod(Array.from(sig), 2, Math.floor(W/4));
    if (score > bestScore) { bestScore=score; bestY=y; }
  }
  return { y: bestY, h: bH };
}
function _findBestBandV(edgeY, W, H) {
  const bW = Math.max(6, Math.floor(W*.07)), step = Math.max(1, Math.floor(bW/2));
  let bestX=0, bestScore=-Infinity;
  for (let x=0; x<=W-bW; x+=step) {
    const sig = new Float32Array(H);
    for (let y=0; y<H; y++) for (let dx=0; dx<bW; dx++) sig[y] += edgeY[y*W+(x+dx)];
    const energy = sig.reduce((s,v)=>s+v,0)/H;
    if (energy < 1) continue;
    const { score } = _autocorrelPeriod(Array.from(sig), 2, Math.floor(H/4));
    if (score > bestScore) { bestScore=score; bestX=x; }
  }
  return { x: bestX, w: bW };
}
function detectRulerScale(gray, W, H) {
  // Horizontal ruler
  const eX = _rulerSobelX(gray, W, H);
  const bH = _findBestBandH(eX, W, H);
  const sigH = new Float32Array(W);
  for (let x=0; x<W; x++) for (let dy=0; dy<bH.h; dy++) sigH[x] += eX[(bH.y+dy)*W+x];
  const { period: pH, score: sH } = _autocorrelPeriod(Array.from(sigH), 2, Math.floor(W/3));
  const thH = sigH.reduce((s,v)=>s+v,0)/W*1.5;
  let peaksH=0; for (let x=1; x<W-1; x++) if (sigH[x]>thH && sigH[x]>=sigH[x-1] && sigH[x]>=sigH[x+1]) peaksH++;
  const confH = (peaksH>3 && pH>2) ? sH * Math.min(peaksH/5, 3) : 0;

  // Vertical ruler
  const eY = _rulerSobelY(gray, W, H);
  const bV = _findBestBandV(eY, W, H);
  const sigV = new Float32Array(H);
  for (let y=0; y<H; y++) for (let dx=0; dx<bV.w; dx++) sigV[y] += eY[y*W+(bV.x+dx)];
  const { period: pV, score: sV } = _autocorrelPeriod(Array.from(sigV), 2, Math.floor(H/3));
  const thV = sigV.reduce((s,v)=>s+v,0)/H*1.5;
  let peaksV=0; for (let y=1; y<H-1; y++) if (sigV[y]>thV && sigV[y]>=sigV[y-1] && sigV[y]>=sigV[y+1]) peaksV++;
  const confV = (peaksV>3 && pV>2) ? sV * Math.min(peaksV/5, 3) : 0;

  const useH = confH >= confV;
  const period = useH ? pH : pV;
  const peakCount = useH ? peaksH : peaksV;
  const confidence = useH ? confH : confV;
  const orientation = useH ? 'horizontal' : 'vertical';

  const p = period;
  const suggestedMm = p >= 30 ? 10 : p >= 10 ? 5 : p >= 3 ? 1 : 0.5;
  return { period, confidence, orientation, peakCount, suggestedMm };
}

function autoDetectScale() {
  const url = S.imgs[S.scaleView];
  if (!url) return alert('Please upload an image first');
  const infoEl = document.getElementById('ruler-detect-info');
  if (infoEl) infoEl.textContent = '⏳ Detecting...';
  setTimeout(() => {
    const tmpC = document.createElement('canvas');
    const img = new Image();
    img.onload = () => {
      const SZ = 800, sc = Math.min(1, SZ/Math.max(img.width, img.height));
      tmpC.width = Math.round(img.width*sc); tmpC.height = Math.round(img.height*sc);
      const ctx = tmpC.getContext('2d');
      ctx.drawImage(img, 0, 0, tmpC.width, tmpC.height);
      const W=tmpC.width, H=tmpC.height;
      const src = ctx.getImageData(0,0,W,H).data;
      const gray = new Uint8ClampedArray(W*H);
      for (let i=0; i<W*H; i++) gray[i] = src[i*4]*.299+src[i*4+1]*.587+src[i*4+2]*.114;
      const result = detectRulerScale(gray, W, H);
      const periodOrig = result.period / sc;

      if (result.confidence <= 0 || result.period < 2) {
        if (infoEl) infoEl.textContent = '❌ Ruler not detected — make sure the ruler is visible in the image';
        return;
      }
      const dir = result.orientation === 'horizontal' ? 'horizontal' : 'vertical';
      if (infoEl) infoEl.textContent = `✓ ${dir} ruler · ${result.peakCount} marks · ${Math.round(periodOrig)}px between marks`;
      showRulerDialog(periodOrig, result);
    };
    img.src = url;
  }, 0);
}

function showRulerDialog(periodPx, result) {
  const old = document.getElementById('ruler-dlg');
  if (old) old.remove();
  const dlg = document.createElement('div');
  dlg.id = 'ruler-dlg';
  dlg.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:24px 28px;z-index:2000;min-width:340px;direction:ltr;box-shadow:0 20px 60px rgba(0,0,0,.6);';
  const mm = result.suggestedMm;
  const px = Math.round(periodPx);
  dlg.innerHTML = `
    <div style="font-size:26px;text-align:center;margin-bottom:10px;">📏</div>
    <h3 style="color:var(--teal-light);margin:0 0 6px;font-size:16px;text-align:center;">Ruler Detected</h3>
    <p style="color:var(--muted);font-size:13px;text-align:center;margin:0 0 18px;">${result.orientation==='horizontal'?'horizontal':'vertical'} · ${result.peakCount} marks · ${px}px between marks</p>
    <div style="font-size:13px;color:var(--text);margin-bottom:10px;font-weight:600;">This distance equals:</div>
    <div style="display:flex;gap:8px;margin-bottom:18px;flex-wrap:wrap;">
      ${[0.5,1,2,5,10].map(v=>`
        <button onclick="applyRulerScale(${periodPx},${v})"
          style="flex:1;padding:10px 6px;background:${v===mm?'rgba(13,148,136,.2)':'var(--bg)'};border:1px solid ${v===mm?'var(--teal)':'var(--border)'};border-radius:8px;color:${v===mm?'var(--teal-light)':'var(--subtle)'};cursor:pointer;font-size:13px;font-weight:600;">
          ${v} mm${v===mm?'<br><span style="font-size:10px;color:var(--teal-light)">recommended</span>':''}
        </button>`).join('')}
    </div>
    <div style="font-size:12px;color:var(--muted);margin-bottom:12px;">Or enter manually: <input id="ruler-manual-mm" type="number" value="${mm}" step="0.5" min="0.1" style="width:70px;padding:5px 8px;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:13px;margin:0 6px;"> mm
      <button onclick="applyRulerScale(${periodPx},parseFloat(document.getElementById('ruler-manual-mm').value))" style="padding:5px 14px;background:var(--teal);color:white;border:none;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;">Apply</button>
    </div>
    <button onclick="document.getElementById('ruler-dlg').remove()" style="width:100%;padding:8px;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--muted);cursor:pointer;font-size:13px;">Cancel</button>
  `;
  document.body.appendChild(dlg);
}

function applyRulerScale(periodPx, mm) {
  if (!mm || mm <= 0) return;
  const pxPerMM = periodPx / mm;
  // Add as a measurement for the current view
  const view = S.scaleView;
  // Find approximate canvas points at center of image
  const cx = scC ? scC.width / 2 : 100, cy = scC ? scC.height / 2 : 100;
  const pts = [{x: cx - periodPx/2, y: cy}, {x: cx + periodPx/2, y: cy}];
  measurements[view].push({ px: Math.round(periodPx), mm, ppm: pxPerMM, pts, auto: true });
  updateScaleAvg();
  renderMeasurements();
  drawScale();
  const infoEl = document.getElementById('ruler-detect-info');
  if (infoEl) infoEl.textContent = `✓ ${pxPerMM.toFixed(2)} px/mm set (${Math.round(periodPx)}px = ${mm}mm)`;
  const dlg = document.getElementById('ruler-dlg');
  if (dlg) dlg.remove();
}
// measurements[view] = [{px, mm, ppm}, ...]
const measurements = { front: [], side: [], top: [] };

function setScaleView(v) {
  S.scaleView = v; S.scalePts = [];
  document.querySelectorAll('.scale-tab').forEach(t => t.classList.toggle('active', t.dataset.v === v));
  const lbl = document.getElementById('meas-view-label');
  if (lbl) lbl.textContent = v === 'front' ? 'Front View' : v === 'side' ? 'Side View' : 'Top View';
  renderMeasurements();
  initScale();
}

function initScale() {
  scC = document.getElementById('scale-canvas');
  if (!scC) return;
  scCtx = scC.getContext('2d');
  const url = S.imgs[S.scaleView];
  if (!url) { scCtx.clearRect(0,0,scC.width,scC.height); return; }
  const img = new Image();
  scImg = img;
  img.onload = () => {
    if (img !== scImg) return;   // stale — a newer load is in progress
    const par = scC.parentElement;
    // Use rAF so the float window (or newly visible panel) is fully laid out
    requestAnimationFrame(() => {
      if (img !== scImg) return;
      const maxW = Math.max(par.offsetWidth  - 2, 200);
      const maxH = Math.max(par.offsetHeight - 2, 200);
      // Fit image to fill the available area — allow upscaling small photos
      // so they aren't shown tiny inside a large (or floating) window.
      const r = Math.min(maxW / img.width, maxH / img.height);
      scC.width  = Math.round(img.width  * r);
      scC.height = Math.round(img.height * r);
      drawScale();
    });
  };
  img.src = url;
  scC.onclick = (e) => {
    if (S.scalePts.length >= 2) S.scalePts = [];
    const rc = scC.getBoundingClientRect();
    const mx = (e.clientX - rc.left) * (scC.width / rc.width);
    const my = (e.clientY - rc.top)  * (scC.height / rc.height);
    // Inverse zoom transform: canvas center is anchor
    const s = scZoom.s, cx = scC.width / 2, cy = scC.height / 2;
    S.scalePts.push({ x: (mx - cx) / s + cx, y: (my - cy) / s + cy });
    drawScale(); updatePtsInfo();
  };
  scC.onwheel = (e) => { e.preventDefault(); scaleZoomBy(e.deltaY < 0 ? 1.15 : 1/1.15); };
}

function drawScale() {
  if (!scCtx || !scImg) return;
  const s = scZoom.s, cx = scC.width / 2, cy = scC.height / 2;
  scCtx.clearRect(0, 0, scC.width, scC.height);
  scCtx.save();
  scCtx.translate(cx, cy);
  scCtx.scale(s, s);
  scCtx.translate(-cx, -cy);

  // 1. Background — clean neutral surface (no image)
  const poly = S.polys?.[S.scaleView];
  const pcs  = S.polyCanvasSize?.[S.scaleView];
  const hasContour = poly?.closed && poly.pts.length >= 3 && pcs;
  scCtx.fillStyle = '#0F172A';   // dark background matching app theme
  scCtx.fillRect(0, 0, scC.width, scC.height);
  if (!hasContour && scImg) {
    // No contour yet — show the image so the user can still use the ruler
    scCtx.drawImage(scImg, 0, 0, scC.width, scC.height);
  }

  // 2. Polygon contour + dimension annotations
  if (hasContour) {
    const sx = scC.width  / pcs.w;
    const sy = scC.height / pcs.h;
    const scaled = poly.pts.map(p => ({ x: p.x * sx, y: p.y * sy }));

    // Contour outline
    scCtx.beginPath();
    scaled.forEach((p, i) => i === 0 ? scCtx.moveTo(p.x, p.y) : scCtx.lineTo(p.x, p.y));
    scCtx.closePath();
    scCtx.strokeStyle = '#0D9488';
    scCtx.lineWidth = 1.5 / s;
    scCtx.stroke();

    // Dimension arrows
    _drawScaleDims(scaled, s);

    // Holes (thin dashed)
    const holes = S.holes?.[S.scaleView];
    if (holes?.length) {
      scCtx.strokeStyle = 'rgba(148,163,184,0.6)';
      scCtx.lineWidth = 1 / s;
      scCtx.setLineDash([4/s, 3/s]);
      for (const hole of holes) {
        if (hole.length < 3) continue;
        scCtx.beginPath();
        hole.forEach((p, i) => {
          const x = p.x * sx, y = p.y * sy;
          i === 0 ? scCtx.moveTo(x, y) : scCtx.lineTo(x, y);
        });
        scCtx.closePath(); scCtx.stroke();
      }
      scCtx.setLineDash([]);
    }
  }

  // 3. Previous measurements (grey dashed)
  measurements[S.scaleView].forEach(m => {
    if (!m.pts) return;
    scCtx.beginPath(); scCtx.moveTo(m.pts[0].x, m.pts[0].y); scCtx.lineTo(m.pts[1].x, m.pts[1].y);
    scCtx.strokeStyle = 'rgba(148,163,184,.5)'; scCtx.lineWidth = 1.5 / s;
    scCtx.setLineDash([4/s, 3/s]); scCtx.stroke(); scCtx.setLineDash([]);
    [m.pts[0], m.pts[1]].forEach(p => {
      scCtx.beginPath(); scCtx.arc(p.x, p.y, 4/s, 0, Math.PI*2);
      scCtx.fillStyle = 'rgba(148,163,184,.6)'; scCtx.fill();
    });
  });

  // 4. Current measurement points
  S.scalePts.forEach((p, i) => {
    scCtx.beginPath(); scCtx.arc(p.x, p.y, 6/s, 0, Math.PI*2);
    scCtx.fillStyle = i === 0 ? '#0D9488' : '#F97316'; scCtx.fill();
    scCtx.strokeStyle = 'white'; scCtx.lineWidth = 2/s; scCtx.stroke();
  });
  if (S.scalePts.length === 2) {
    const [a, b] = S.scalePts;
    scCtx.beginPath(); scCtx.moveTo(a.x, a.y); scCtx.lineTo(b.x, b.y);
    scCtx.strokeStyle = '#14B8A6'; scCtx.lineWidth = 2/s;
    scCtx.setLineDash([6/s, 4/s]); scCtx.stroke(); scCtx.setLineDash([]);
  }
  scCtx.restore();
}

// ── Dimension annotation helpers ──────────────────────────────────────────────

function _drawScaleDims(pts, zs) {
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const W_px = maxX - minX, H_px = maxY - minY;
  if (W_px < 4 || H_px < 4) return;

  // S.scale[v] is original-image px/mm; convert to scale-canvas px/mm for annotation
  const ppmOrig = S.scale?.[S.scaleView];
  const imgNatW = scImg ? scImg.naturalWidth : scC?.width ?? 1;
  const ppm = (ppmOrig && scC && scC.width > 0) ? ppmOrig * scC.width / imgNatW : null;
  const gap  = 28 / zs;
  const ext  = 6  / zs;
  const arr  = 7  / zs;
  const fs   = 11 / zs;

  scCtx.save();
  scCtx.strokeStyle = '#64748B';
  scCtx.fillStyle   = '#475569';
  scCtx.lineWidth   = 0.8 / zs;
  scCtx.font        = `bold ${fs}px 'Fira Code', monospace`;

  // ── Width (horizontal, below polygon) ──────────────────────────────────
  const dimY = maxY + gap;
  // Extension lines
  scCtx.beginPath();
  scCtx.moveTo(minX, maxY + ext / 2); scCtx.lineTo(minX, dimY + ext);
  scCtx.moveTo(maxX, maxY + ext / 2); scCtx.lineTo(maxX, dimY + ext);
  scCtx.stroke();
  // Arrow line
  _scArrow(minX, dimY, maxX, dimY, arr);
  // Label
  const wLabel = ppm ? `${(W_px / ppm).toFixed(1)} mm` : `${Math.round(W_px)} px`;
  scCtx.textAlign    = 'center';
  scCtx.textBaseline = 'bottom';
  scCtx.fillStyle = '#0D9488';
  scCtx.fillText(wLabel, (minX + maxX) / 2, dimY - 3 / zs);

  // ── Height (vertical, right of polygon) ────────────────────────────────
  scCtx.fillStyle   = '#475569';
  const dimX = maxX + gap;
  // Extension lines
  scCtx.beginPath();
  scCtx.moveTo(maxX + ext / 2, minY); scCtx.lineTo(dimX + ext, minY);
  scCtx.moveTo(maxX + ext / 2, maxY); scCtx.lineTo(dimX + ext, maxY);
  scCtx.stroke();
  // Arrow line
  _scArrow(dimX, minY, dimX, maxY, arr);
  // Label (rotated 90°)
  const hLabel = ppm ? `${(H_px / ppm).toFixed(1)} mm` : `${Math.round(H_px)} px`;
  scCtx.save();
  scCtx.translate(dimX + 3 / zs, (minY + maxY) / 2);
  scCtx.rotate(-Math.PI / 2);
  scCtx.textAlign    = 'center';
  scCtx.textBaseline = 'bottom';
  scCtx.fillStyle = '#0D9488';
  scCtx.fillText(hLabel, 0, -3 / zs);
  scCtx.restore();

  // ── 3 extra cross-section dims (front view only) ─────────────────────────
  if ((S.scaleView === 'front' || S.scaleView === 'top') && ppm) {
    // _polyCrossSections is defined in td-dimensions.js (same global scope)
    const rows = typeof _polyCrossSections === 'function'
      ? _polyCrossSections(pts, minY, maxY)
      : [];

    if (rows.length > 10) {
      const maxRow = rows.reduce((m, r) => r.width > m.width ? r : m, rows[0]);
      const bH = maxY - minY;
      const lo = minY + bH * 0.15, hi = maxY - bH * 0.15;
      const midRows = rows.filter(r => r.y >= lo && r.y <= hi);
      const minRow = midRows.length > 0
        ? midRows.reduce((m, r) => r.width < m.width ? r : m, midRows[0])
        : null;

      const TK  = 9  / zs;
      const lw2 = 0.8 / zs;
      const fs2 = 10 / zs;
      scCtx.font = `bold ${fs2}px 'Fira Code', monospace`;

      // 1. Max cross-section — amber, inline horizontal at maxRow.y
      if (maxRow.width > 8 && (W_px - maxRow.width) > 3) {
        scCtx.strokeStyle = '#b45309'; scCtx.fillStyle = '#b45309';
        scCtx.lineWidth = lw2;
        scCtx.setLineDash([4/zs, 3/zs]);
        scCtx.beginPath();
        scCtx.moveTo(minX, maxRow.y); scCtx.lineTo(maxRow.x1, maxRow.y);
        scCtx.moveTo(maxRow.x2, maxRow.y); scCtx.lineTo(maxX, maxRow.y);
        scCtx.stroke();
        scCtx.setLineDash([]);
        scCtx.beginPath();
        scCtx.moveTo(maxRow.x1, maxRow.y - TK); scCtx.lineTo(maxRow.x1, maxRow.y + TK);
        scCtx.moveTo(maxRow.x2, maxRow.y - TK); scCtx.lineTo(maxRow.x2, maxRow.y + TK);
        scCtx.stroke();
        _scArrow(maxRow.x1, maxRow.y, maxRow.x2, maxRow.y, arr);
        scCtx.textAlign = 'center'; scCtx.textBaseline = 'bottom';
        scCtx.fillText(`${(maxRow.width / ppm).toFixed(1)} mm`,
          (maxRow.x1 + maxRow.x2) / 2, maxRow.y - TK - 2/zs);
      }

      // 2. Narrowest width — rose, inline horizontal at minRow.y
      if (minRow && minRow.width > 8 && (W_px - minRow.width) > 8) {
        scCtx.strokeStyle = '#9f1239'; scCtx.fillStyle = '#9f1239';
        scCtx.lineWidth = lw2;
        scCtx.setLineDash([4/zs, 3/zs]);
        scCtx.beginPath();
        scCtx.moveTo(minX, minRow.y); scCtx.lineTo(minRow.x1, minRow.y);
        scCtx.moveTo(minRow.x2, minRow.y); scCtx.lineTo(maxX, minRow.y);
        scCtx.stroke();
        scCtx.setLineDash([]);
        scCtx.beginPath();
        scCtx.moveTo(minRow.x1, minRow.y - TK); scCtx.lineTo(minRow.x1, minRow.y + TK);
        scCtx.moveTo(minRow.x2, minRow.y - TK); scCtx.lineTo(minRow.x2, minRow.y + TK);
        scCtx.stroke();
        _scArrow(minRow.x1, minRow.y, minRow.x2, minRow.y, arr);
        scCtx.textAlign = 'center'; scCtx.textBaseline = 'bottom';
        scCtx.fillText(`${(minRow.width / ppm).toFixed(1)} mm`,
          (minRow.x1 + minRow.x2) / 2, minRow.y - TK - 2/zs);
      }

    }
  }

  scCtx.restore();
}

// Draws a line with closed arrowheads at both ends (inward-facing)
function _scArrow(x1, y1, x2, y2, arr) {
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.sqrt(dx * dx + dy * dy); if (len < 1) return;
  const ux = dx / len, uy = dy / len;
  // Line
  scCtx.beginPath(); scCtx.moveTo(x1, y1); scCtx.lineTo(x2, y2); scCtx.stroke();
  // Arrow at start (pointing right toward center)
  scCtx.beginPath();
  scCtx.moveTo(x1, y1);
  scCtx.lineTo(x1 + ux * arr - uy * arr * 0.3, y1 + uy * arr + ux * arr * 0.3);
  scCtx.lineTo(x1 + ux * arr + uy * arr * 0.3, y1 + uy * arr - ux * arr * 0.3);
  scCtx.closePath(); scCtx.fill();
  // Arrow at end (pointing left toward center)
  scCtx.beginPath();
  scCtx.moveTo(x2, y2);
  scCtx.lineTo(x2 - ux * arr - uy * arr * 0.3, y2 - uy * arr + ux * arr * 0.3);
  scCtx.lineTo(x2 - ux * arr + uy * arr * 0.3, y2 - uy * arr - ux * arr * 0.3);
  scCtx.closePath(); scCtx.fill();
}

function scaleZoomBy(factor) {
  scZoom.s = Math.max(0.25, Math.min(8, scZoom.s * factor));
  const el = document.getElementById('scale-zoom-pct');
  if (el) el.textContent = `${Math.round(scZoom.s * 100)}%`;
  drawScale();
}

function resetScaleZoom() {
  scZoom.s = 1;
  const el = document.getElementById('scale-zoom-pct');
  if (el) el.textContent = '100%';
  drawScale();
}

function updatePtsInfo() {
  const el = document.getElementById('scale-pts-info');
  const n = S.scalePts.length;
  if (n === 0) el.textContent = 'Click point 1 on the ruler';
  else if (n === 1) el.textContent = 'Click point 2 on the ruler';
  else {
    const dx = S.scalePts[1].x - S.scalePts[0].x, dy = S.scalePts[1].y - S.scalePts[0].y;
    el.textContent = `${Math.round(Math.sqrt(dx*dx+dy*dy))} px — enter mm and add`;
  }
}

function addMeasurement() {
  if (S.scalePts.length < 2) return alert('Click 2 points on the ruler first');
  const mm = parseFloat(document.getElementById('mm-input').value);
  if (!mm || mm <= 0) return alert('Enter a distance in mm');
  const [a, b] = S.scalePts;
  const pxCanvas = Math.sqrt((b.x-a.x)**2 + (b.y-a.y)**2);
  // Convert canvas px → original-image px so S.scale[v] is always original-image px/mm
  const toOrig = (scImg && scC && scC.width > 0) ? scImg.naturalWidth / scC.width : 1;
  const ppm = (pxCanvas * toOrig) / mm;
  measurements[S.scaleView].push({ px: Math.round(pxCanvas), mm, ppm, pts: [{ ...a }, { ...b }] });
  S.scalePts = [];
  document.getElementById('mm-input').value = '';
  updatePtsInfo();
  drawScale();
  renderMeasurements();
  updateScaleAvg();
  persistState();
}

function deleteMeasurement(v, idx) {
  measurements[v].splice(idx, 1);
  renderMeasurements();
  updateScaleAvg();
  drawScale();
  persistState();
}

function renderMeasurements() {
  const list = document.getElementById('meas-list');
  if (!list) return;
  const items = measurements[S.scaleView];
  if (!items.length) {
    list.innerHTML = '<div style="font-size:12px;color:var(--border);text-align:center;padding:16px 0;">No measurements yet</div>';
    return;
  }
  list.innerHTML = `
    <table style="width:100%;border-collapse:collapse;font-size:12px;">
      <thead>
        <tr style="color:var(--muted);">
          <th style="text-align:left;padding:3px 4px;font-weight:600;">#</th>
          <th style="text-align:left;padding:3px 4px;font-weight:600;">px</th>
          <th style="text-align:left;padding:3px 4px;font-weight:600;">mm</th>
          <th style="text-align:left;padding:3px 4px;font-weight:600;">px/mm</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${items.map((m, i) => `
          <tr style="border-top:1px solid var(--border);">
            <td style="padding:4px;color:var(--muted);">${i+1}</td>
            <td style="padding:4px;font-family:'Fira Code',monospace;">${m.px}</td>
            <td style="padding:4px;font-family:'Fira Code',monospace;">${m.mm}</td>
            <td style="padding:4px;font-family:'Fira Code',monospace;color:var(--teal-light);font-weight:600;">${m.ppm.toFixed(2)}</td>
            <td style="padding:4px;">
              <button onclick="deleteMeasurement('${S.scaleView}',${i})"
                style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:14px;padding:0 4px;line-height:1;">×</button>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>`;
}

function updateScaleAvg() {
  const v = S.scaleView;
  const items = measurements[v];
  const avg = items.length ? items.reduce((s, m) => s + m.ppm, 0) / items.length : null;
  S.scale[v] = avg;

  // Update avg display
  const avgEl = document.getElementById('scale-avg');
  if (avgEl) { avgEl.textContent = avg ? avg.toFixed(3) : '—'; avgEl.style.color = avg ? '#14B8A6' : 'var(--subtle)'; }

  // Update 3-view summary
  ['front','side','top'].forEach(vv => {
    const el = document.getElementById(`scale-${vv}`);
    if (!el) return;
    const ms = measurements[vv];
    if (!ms.length) { el.textContent = '—'; el.style.color = 'var(--subtle)'; return; }
    const a = ms.reduce((s, m) => s + m.ppm, 0) / ms.length;
    el.textContent = a.toFixed(2); el.style.color = '#14B8A6';
  });

  // Rebuild cross-view model with updated scale
  buildObjectModel();
  _renderModelBar(document.getElementById('scale-model-bar'));

  // Update tab badges
  ['front','side','top'].forEach(vv => {
    const b = document.getElementById(`sctab-badge-${vv}`);
    if (b) b.textContent = measurements[vv].length > 0 ? ' ✓' : '';
  });

  // Enable Next only if all 3 views have at least 1 measurement
  const allDone = ['front','side','top'].every(vv => measurements[vv].length > 0);
  const btn = document.getElementById('step4-next');
  if (btn) {
    btn.disabled = !allDone;
    btn.style.background = allDone ? 'var(--orange)' : 'var(--border)';
    btn.style.color = allDone ? 'white' : 'var(--muted)';
    btn.style.cursor = allDone ? 'pointer' : 'not-allowed';
  }
}
