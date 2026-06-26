// ══════════════════════════ STEP 5: REVIEW ══════════════════════════
function initReview() {
  ['front','side','top'].forEach(v => {
    const c = document.getElementById(`rev-canvas-${v}`);
    if (!c) return;
    const ctx = c.getContext('2d');
    const url = S.imgs[v];
    if (!url) return;
    const img = new Image();
    img.onerror = () => { ctx.clearRect(0, 0, c.width, c.height); };
    img.onload = () => {
      const parent = c.parentElement;
      const r = Math.min(parent.clientWidth / img.width, parent.clientHeight / img.height, 1);
      c.width = Math.round(img.width * r);
      c.height = Math.round(img.height * r);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      // Draw contour scaled to this canvas
      const poly = S.polys[v];
      // cC was sized from same image, so scale ratio = c.width / cC_w stored per view
      const srcW = S.polyCanvasSize?.[v]?.w ?? c.width;
      const srcH = S.polyCanvasSize?.[v]?.h ?? c.height;
      const sx = c.width / srcW, sy = c.height / srcH;
      if (poly.pts.length >= 2) {
        ctx.beginPath();
        ctx.moveTo(poly.pts[0].x * sx, poly.pts[0].y * sy);
        poly.pts.slice(1).forEach(p => ctx.lineTo(p.x * sx, p.y * sy));
        if (poly.closed) ctx.closePath();
        ctx.strokeStyle = '#0D9488'; ctx.lineWidth = 2; ctx.stroke();
        if (poly.closed) { ctx.fillStyle = 'rgba(13,148,136,.15)'; ctx.fill(); }
      }
    };
    img.src = url;
  });
  calcDimensions();
}

function calcDimensions() {
  const bbox = (v) => {
    const p = S.polys[v];
    if (!p.pts.length) return null;
    return {
      minX: Math.min(...p.pts.map(pt => pt.x)), maxX: Math.max(...p.pts.map(pt => pt.x)),
      minY: Math.min(...p.pts.map(pt => pt.y)), maxY: Math.max(...p.pts.map(pt => pt.y)),
    };
  };
  const fmt = (px, view, axis) => {
    const ppm = S.scale[view] ?? measurements[view]?.reduce((a,m)=>a+m.ppm,0) / (measurements[view]?.length||1);
    if (!ppm || !px) return '—';
    // poly.pts are in canvas pixels; ppm is in original-image px/mm.
    // Convert: canvas_px / ppmCanvas, where ppmCanvas = ppm * canvasW / origW
    const srcW = S.polyCanvasSize?.[view]?.w ?? 1;
    const srcH = S.polyCanvasSize?.[view]?.h ?? 1;
    const origW = S.segMeta?.[view]?.origW ?? srcW;
    const origH = S.segMeta?.[view]?.origH ?? srcH;
    const ppmCanvas = axis === 'y' ? ppm * srcH / origH : ppm * srcW / origW;
    return (px / ppmCanvas).toFixed(1);
  };
  const fb = bbox('front'), sb = bbox('side'), tb = bbox('top');
  const W = fb ? fmt(fb.maxX - fb.minX, 'front', 'x') : '—';
  const H = fb ? fmt(fb.maxY - fb.minY, 'front', 'y') : '—';
  const D = sb ? fmt(sb.maxX - sb.minX, 'side', 'x') : '—';
  ['W','H','D'].forEach((k,i) => {
    const el = document.getElementById(`dim-${k}`);
    const val = [W,H,D][i];
    if (el) { el.textContent = val; el.style.color = val === '—' ? 'var(--subtle)' : 'var(--teal-light)'; }
  });
  // Store for drawing layout
  S.dims = { W, H, D };
  // Run cross-validation after dims are computed
  scaleXValidation();
  // Refresh reference comparison if the user already has values filled in
  if (document.getElementById('ref-W')?.value || document.getElementById('ref-H')?.value || document.getElementById('ref-D')?.value) {
    compareWithReference();
  }
}

// ── Hole auto-detection ───────────────────────────────────────────────
// Finds enclosed background regions inside the object mask → hole polygons
function detectHoles(objMask, W, H, minHoleArea=30) {
  const visited = new Uint8ClampedArray(W*H);
  const holes = [];
  for (let y=1; y<H-1; y++) for (let x=1; x<W-1; x++) {
    const i = y*W+x;
    if (objMask[i] || visited[i]) continue;
    // BFS
    const q=[i], region=[i]; visited[i]=1;
    let isBorder=false, qi=0;
    while (qi<q.length) {
      const idx=q[qi++], cx=idx%W, cy=(idx/W)|0;
      if (cx<=0||cx>=W-1||cy<=0||cy>=H-1) isBorder=true;
      for (const [dx,dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
        const nx=cx+dx,ny=cy+dy,ni=ny*W+nx;
        if (nx<0||nx>=W||ny<0||ny>=H||visited[ni]||objMask[ni]) continue;
        visited[ni]=1; q.push(ni); region.push(ni);
      }
    }
    if (!isBorder && region.length >= minHoleArea) holes.push(region);
  }
  return holes;
}

function autoDetectHoles() {
  const url = S.imgs[S.contourView];
  if (!url || !S.polys[S.contourView].pts.length) return alert('Detect the contour first');
  const tmpC=document.createElement('canvas'), tmpCtx=tmpC.getContext('2d');
  const img=new Image();
  img.onerror=()=>{ alert('Could not load image for hole detection'); };
  img.onload=()=>{
    const maxW=900, maxH=700;
    const r=Math.min(maxW/img.width,maxH/img.height,1);
    tmpC.width=Math.round(img.width*r); tmpC.height=Math.round(img.height*r);
    tmpCtx.drawImage(img,0,0,tmpC.width,tmpC.height);
    const W=tmpC.width, H=tmpC.height;
    const src=tmpCtx.getImageData(0,0,W,H).data;
    const gray=new Uint8ClampedArray(W*H);
    for (let i=0;i<W*H;i++) gray[i]=src[i*4]*.299+src[i*4+1]*.587+src[i*4+2]*.114;
    const enhMode2=document.getElementById('enhance-mode')?.value??'clahe';
    const enhanced=enhMode2==='clahe'?claheEnhance(gray,W,H):enhMode2==='zdce'?zeroDCEEnhance(gray,W,H):gray;
    const denoised=bilateralFilter(enhanced,W,H,2,1.5,30);
    const edges=cannyEdges(denoised,W,H,20,60);
    const dilated=dilateEdges(edges,W,H,2);
    const bg=floodFillBackground(dilated,W,H);
    let obj=new Uint8ClampedArray(W*H);
    for (let i=0;i<W*H;i++) if (!bg[i]&&!dilated[i]) obj[i]=255;
    obj=morphClose(obj,W,H,3);
    const holes=detectHoles(obj,W,H,50);
    if (!holes.length) { alert('No holes found'); return; }
    if (!S.holes) S.holes={};
    const scaleX=cC?cC.width/W:1, scaleY=cC?cC.height/H:1;
    S.holes[S.contourView]=holes.map(region=>{
      const hMask=new Uint8ClampedArray(W*H);
      region.forEach(i=>hMask[i]=255);
      const traced=mooreBoundaryTraceMask(hMask,W,H);
      const simp=douglasPeucker(traced,3/r);
      return simp.map(p=>({x:p.x*scaleX,y:p.y*scaleY}));
    });
    alert(`Found ${holes.length} hole(s)`);
    drawContour(); persistState();
  };
  img.src=url;
}

// ── Scale Cross-Validation (simplified Bundle Adjustment) ──────────────
// Orthographic shared-dimension constraints:
//   H_front ≈ H_side  (both measure object height)
//   W_front ≈ W_top   (both measure object width)
//   W_side  ≈ H_top   (both measure object depth)
function scaleXValidation() {
  const panel = document.getElementById('scale-xval');
  const rowsEl = document.getElementById('xval-rows');
  const badgeEl = document.getElementById('xval-badge');
  const suggEl = document.getElementById('xval-suggestion');
  if (!panel || !rowsEl) return;

  const bboxMM = (v) => {
    const p = S.polys[v]; const ppm = S.scale[v];
    if (!p.pts.length || !ppm) return null;
    // Convert canvas px to mm using canvas-space ppm
    const srcW = S.polyCanvasSize?.[v]?.w ?? 1;
    const srcH = S.polyCanvasSize?.[v]?.h ?? 1;
    const origW = S.segMeta?.[v]?.origW ?? srcW;
    const origH = S.segMeta?.[v]?.origH ?? srcH;
    const ppmX = ppm * srcW / origW;
    const ppmY = ppm * srcH / origH;
    const xs = p.pts.map(pt=>pt.x/ppmX), ys = p.pts.map(pt=>pt.y/ppmY);
    return { w: Math.max(...xs)-Math.min(...xs), h: Math.max(...ys)-Math.min(...ys) };
  };
  const f = bboxMM('front'), s = bboxMM('side'), t = bboxMM('top');

  // Need at least 2 views to compare
  const pairs = [];
  if (f && s) pairs.push({ label:'Height H', a: f.h, bLabel:'Front', aLabel:'Side', b: s.h, pair:'H:front-side' });
  if (f && t) pairs.push({ label:'Width W', a: f.w, aLabel:'Front', b: t.w, bLabel:'Top', pair:'W:front-top' });
  if (s && t) pairs.push({ label:'Depth D', a: s.w, aLabel:'Side',  b: t.h, bLabel:'Top', pair:'D:side-top' });

  if (!pairs.length) { panel.style.display='none'; return; }
  panel.style.display='block';

  let maxDisc = 0;
  const suggestions = [];
  rowsEl.innerHTML = pairs.map(p => {
    if (!p.a || !p.b) return '';
    const disc = Math.abs(p.a - p.b) / ((p.a + p.b) / 2) * 100;
    maxDisc = Math.max(maxDisc, disc);
    const color = disc < 3 ? '#22c55e' : disc < 8 ? '#f59e0b' : '#ef4444';
    const icon = disc < 3 ? '✓' : disc < 8 ? '⚠' : '✗';
    if (disc >= 8) suggestions.push(`${p.label}: ${p.aLabel} shows ${p.a.toFixed(1)}mm, ${p.bLabel} shows ${p.b.toFixed(1)}mm — check scale of ${p.a > p.b ? p.aLabel : p.bLabel}`);
    return `<div style="display:flex;align-items:center;gap:10px;padding:5px 8px;border-radius:6px;background:var(--bg);">
      <span style="color:${color};font-size:13px;width:16px;">${icon}</span>
      <span style="color:var(--subtle);width:56px;">${p.label}</span>
      <span style="color:var(--text);">${p.aLabel}: <b>${p.a.toFixed(1)}</b></span>
      <span style="color:var(--muted);">vs</span>
      <span style="color:var(--text);">${p.bLabel}: <b>${p.b.toFixed(1)}</b></span>
      <span style="margin-right:auto;color:${color};font-size:11px;">${disc.toFixed(1)}% deviation</span>
    </div>`;
  }).join('');

  const ok = maxDisc < 3, warn = maxDisc < 8;
  badgeEl.textContent = ok ? 'OK' : warn ? 'Minor deviation' : 'Check required';
  badgeEl.style.background = ok ? 'rgba(34,197,94,.15)' : warn ? 'rgba(245,158,11,.15)' : 'rgba(239,68,68,.15)';
  badgeEl.style.color = ok ? '#22c55e' : warn ? '#f59e0b' : '#ef4444';
  suggEl.innerHTML = suggestions.length ? '💡 ' + suggestions.join('<br>💡 ') : '';
}

// ══════════════════════════ REFERENCE COMPARISON ══════════════════════════

function _polyAreaMM(view) {
  const p = S.polys[view];
  const ppm = S.scale[view];
  if (!p || p.pts.length < 3 || !ppm) return null;
  // Convert canvas px to mm using canvas-space ppm
  const srcW = S.polyCanvasSize?.[view]?.w ?? 1;
  const srcH = S.polyCanvasSize?.[view]?.h ?? 1;
  const origW = S.segMeta?.[view]?.origW ?? srcW;
  const origH = S.segMeta?.[view]?.origH ?? srcH;
  const ppmX = ppm * srcW / origW;
  const ppmY = ppm * srcH / origH;
  // Shoelace formula directly in mm space
  let area = 0;
  const n = p.pts.length;
  for (let i = 0; i < n; i++) {
    const a = p.pts[i], b = p.pts[(i + 1) % n];
    area += (a.x / ppmX) * (b.y / ppmY) - (b.x / ppmX) * (a.y / ppmY);
  }
  return Math.abs(area) / 2; // mm²
}

function _detectedDimsMM() {
  const bboxMM = (v) => {
    const p = S.polys[v];
    const ppm = S.scale[v];
    if (!p.pts.length || !ppm) return null;
    // Convert canvas px to mm using canvas-space ppm
    const srcW = S.polyCanvasSize?.[v]?.w ?? 1;
    const srcH = S.polyCanvasSize?.[v]?.h ?? 1;
    const origW = S.segMeta?.[v]?.origW ?? srcW;
    const origH = S.segMeta?.[v]?.origH ?? srcH;
    const ppmX = ppm * srcW / origW;
    const ppmY = ppm * srcH / origH;
    const xs = p.pts.map(pt => pt.x / ppmX), ys = p.pts.map(pt => pt.y / ppmY);
    return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  };
  const f = bboxMM('front'), s = bboxMM('side');
  return {
    W: f ? f.w : null,
    H: f ? f.h : null,
    D: s ? s.w : null,
  };
}

function compareWithReference() {
  const tol = Math.abs(parseFloat(document.getElementById('ref-tol').value) || 10) / 100;
  const refs = {
    W: parseFloat(document.getElementById('ref-W').value) || null,
    H: parseFloat(document.getElementById('ref-H').value) || null,
    D: parseFloat(document.getElementById('ref-D').value) || null,
  };
  const det = _detectedDimsMM();

  const labels = { W: 'Width W', H: 'Height H', D: 'Depth D' };
  const rowsEl = document.getElementById('ref-rows');
  const badgeEl = document.getElementById('ref-badge');
  const areaEl = document.getElementById('ref-area');

  if (!refs.W && !refs.H && !refs.D) {
    rowsEl.innerHTML = '<div style="font-size:12px;color:var(--muted);">Enter at least one reference dimension</div>';
    return;
  }

  let allMatch = true, anyProvided = false;
  const rows = Object.entries(refs).map(([k, ref]) => {
    if (!ref) return '';
    anyProvided = true;
    const detected = det[k];
    if (!detected) {
      return `<div style="display:flex;align-items:center;gap:10px;padding:5px 8px;border-radius:6px;background:var(--bg);font-size:12px;font-family:'Fira Code',monospace;">
        <span style="color:#94a3b8;width:16px;">?</span>
        <span style="color:var(--subtle);width:60px;">${labels[k]}</span>
        <span style="color:var(--muted);">Dimension not computed (missing contour / scale)</span>
      </div>`;
    }
    const diff = (detected - ref) / ref;
    const absDiff = Math.abs(diff);
    const pct = (diff * 100).toFixed(1);
    let icon, color, statusText;
    if (absDiff <= tol) {
      icon = '✓'; color = '#22c55e'; statusText = 'Match';
    } else if (diff > tol) {
      icon = '↑'; color = '#ef4444'; statusText = 'Too large';
      allMatch = false;
    } else {
      icon = '↓'; color = '#f59e0b'; statusText = 'Too small';
      allMatch = false;
    }
    return `<div style="display:flex;align-items:center;gap:10px;padding:5px 8px;border-radius:6px;background:var(--bg);font-size:12px;font-family:'Fira Code',monospace;">
      <span style="color:${color};font-size:13px;width:16px;">${icon}</span>
      <span style="color:var(--subtle);width:60px;">${labels[k]}</span>
      <span style="color:var(--text);">Detected: <b>${detected.toFixed(1)}</b> mm</span>
      <span style="color:var(--muted);">Reference: ${ref.toFixed(1)} mm</span>
      <span style="margin-right:auto;color:${color};">${statusText} (${pct > 0 ? '+' : ''}${pct}%)</span>
    </div>`;
  }).join('');

  rowsEl.innerHTML = rows || '<div style="font-size:12px;color:var(--muted);">No dimensions to check</div>';

  // Show area for front view
  const frontArea = _polyAreaMM('front');
  areaEl.textContent = frontArea != null ? `Front contour area: ${frontArea.toFixed(1)} mm²` : '';

  if (anyProvided) {
    badgeEl.style.display = 'inline-block';
    badgeEl.textContent = allMatch ? 'Match' : 'Mismatch';
    badgeEl.style.background = allMatch ? 'rgba(34,197,94,.15)' : 'rgba(239,68,68,.15)';
    badgeEl.style.color = allMatch ? '#22c55e' : '#ef4444';
  } else {
    badgeEl.style.display = 'none';
  }

}