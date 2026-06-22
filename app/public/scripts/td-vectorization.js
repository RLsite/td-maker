// ══════════════════════════ STEP 7: VECTORIZATION (Potrace-style JS) ══════════════════════════
let vecView = 'front';

function initVectorize() { setVecView('front'); }

function setVecView(v) {
  vecView = v;
  document.querySelectorAll('.vec-tab').forEach(t => t.classList.toggle('active', t.dataset.v === v));
  renderVectorize();
}

// ─── Geometry helpers ────────────────────────────────────────────────────────

function _norm(v) {
  const l = Math.hypot(v.x, v.y) || 1;
  return { x: v.x / l, y: v.y / l };
}

function _angleDeg(a, b) {
  return Math.acos(Math.max(-1, Math.min(1, a.x*b.x + a.y*b.y))) * 180 / Math.PI;
}

// ─── Corner detection ────────────────────────────────────────────────────────
// Returns boolean[] — true where the contour has a sharp turn > threshDeg

function _detectCorners(pts, closed, threshDeg) {
  const n = pts.length;
  return pts.map((p, i) => {
    if (!closed && (i === 0 || i === n - 1)) return true;
    const prev = pts[(i - 1 + n) % n];
    const next = pts[(i + 1) % n];
    const inV  = _norm({ x: p.x - prev.x, y: p.y - prev.y });
    const outV = _norm({ x: next.x - p.x, y: next.y - p.y });
    return _angleDeg(inV, outV) > threshDeg;
  });
}

// ─── Straight-line test ───────────────────────────────────────────────────────
// Returns true when all points deviate < maxDevPx from the chord a→b

function _isStraight(span, maxDevPx) {
  if (span.length <= 2) return true;
  const a = span[0], b = span[span.length - 1];
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx*dx + dy*dy || 1;
  return span.every(p => {
    const t = ((p.x - a.x)*dx + (p.y - a.y)*dy) / len2;
    const cx = a.x + t*dx, cy = a.y + t*dy;
    return Math.hypot(p.x - cx, p.y - cy) < maxDevPx;
  });
}

// ─── Catmull-Rom → cubic Bezier ──────────────────────────────────────────────
// Converts a smooth span of pts into one cubic Bezier per segment pair.
// Standard formula: CP1 = P1 + (P2-P0)/6,  CP2 = P2 - (P3-P1)/6

function _catmullRomBeziers(span) {
  const n = span.length;
  const out = [];
  for (let i = 0; i < n - 1; i++) {
    const p0 = span[Math.max(0, i - 1)];
    const p1 = span[i];
    const p2 = span[i + 1];
    const p3 = span[Math.min(n - 1, i + 2)];
    // At run endpoints use simple 1/3 tangent so the curve doesn't overshoot
    const cp1 = i === 0
      ? { x: p1.x + (p2.x - p1.x) / 3, y: p1.y + (p2.y - p1.y) / 3 }
      : { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
    const cp2 = i === n - 2
      ? { x: p2.x - (p2.x - p1.x) / 3, y: p2.y - (p2.y - p1.y) / 3 }
      : { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
    out.push({ p0: p1, cp1, cp2, p3: p2 });
  }
  return out;
}

// ─── Main vectorize ───────────────────────────────────────────────────────────
// Returns { svgD, segments, lineCount, curveCount, cornerCount }

function _vectorize(pts, closed, cornerThreshDeg, lineDevPx) {
  const n = pts.length;
  if (n < 3) return { svgD: '', segments: [], lineCount: 0, curveCount: 0, cornerCount: 0 };

  const cornerFlags = _detectCorners(pts, closed, cornerThreshDeg);

  // Collect corner indices
  let cornerIdxs = pts.reduce((acc, _, i) => { if (cornerFlags[i]) acc.push(i); return acc; }, []);
  if (cornerIdxs.length === 0) cornerIdxs = [0]; // treat everything as one smooth span

  // Build spans between consecutive corners
  const spans = [];
  for (let ci = 0; ci < cornerIdxs.length; ci++) {
    const from = cornerIdxs[ci];
    const to   = cornerIdxs[(ci + 1) % cornerIdxs.length];
    const span = [];
    let k = from;
    while (true) {
      span.push(pts[k]);
      if (k === to) break;
      k = (k + 1) % n;
      if (!closed && k >= n) break;
    }
    if (span.length >= 2) spans.push(span);
  }

  // Classify each span: L (straight) or C (bezier)
  const segments = spans.map(span => {
    if (_isStraight(span, lineDevPx))
      return { type: 'L', span };
    return { type: 'C', span, beziers: _catmullRomBeziers(span) };
  });

  // Build SVG path string
  let svgD = '';
  if (segments.length > 0) {
    const p0 = segments[0].span[0];
    svgD = `M ${p0.x.toFixed(1)},${p0.y.toFixed(1)}`;
    for (const seg of segments) {
      if (seg.type === 'L') {
        const pe = seg.span[seg.span.length - 1];
        svgD += ` L ${pe.x.toFixed(1)},${pe.y.toFixed(1)}`;
      } else {
        for (const b of seg.beziers) {
          svgD += ` C ${b.cp1.x.toFixed(1)},${b.cp1.y.toFixed(1)}`
               +  ` ${b.cp2.x.toFixed(1)},${b.cp2.y.toFixed(1)}`
               +  ` ${b.p3.x.toFixed(1)},${b.p3.y.toFixed(1)}`;
        }
      }
    }
    if (closed) svgD += ' Z';
  }

  return {
    svgD,
    segments,
    lineCount:   segments.filter(s => s.type === 'L').length,
    curveCount:  segments.filter(s => s.type === 'C').length,
    cornerCount: cornerIdxs.length,
  };
}

// ─── Draw bezier result on canvas ─────────────────────────────────────────────

function _drawVecResult(ctx, result) {
  if (!result || !result.segments.length) return;

  // Fill (very subtle)
  _applyVecPath(ctx, result.segments);
  ctx.fillStyle = 'rgba(13,148,136,.08)';
  ctx.fill('evenodd');

  // Curve segments — orange
  result.segments.filter(s => s.type === 'C').forEach(seg => {
    ctx.beginPath();
    ctx.moveTo(seg.beziers[0].p0.x, seg.beziers[0].p0.y);
    seg.beziers.forEach(b => ctx.bezierCurveTo(b.cp1.x, b.cp1.y, b.cp2.x, b.cp2.y, b.p3.x, b.p3.y));
    ctx.strokeStyle = '#F97316'; ctx.lineWidth = 2; ctx.stroke();
  });

  // Line segments — teal
  result.segments.filter(s => s.type === 'L').forEach(seg => {
    const a = seg.span[0], b = seg.span[seg.span.length - 1];
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = '#14B8A6'; ctx.lineWidth = 2.2; ctx.stroke();
    // Endpoint dots
    [a, b].forEach(p => {
      ctx.beginPath(); ctx.arc(p.x, p.y, 3.5, 0, Math.PI*2);
      ctx.fillStyle = '#14B8A6'; ctx.fill();
      ctx.strokeStyle = '#0F172A'; ctx.lineWidth = 1; ctx.stroke();
    });
  });

  // Control-point handles (subtle, teal-dim)
  result.segments.filter(s => s.type === 'C').forEach(seg => {
    seg.beziers.forEach(b => {
      ctx.strokeStyle = 'rgba(20,184,166,.3)'; ctx.lineWidth = 0.8;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(b.p0.x, b.p0.y);  ctx.lineTo(b.cp1.x, b.cp1.y); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(b.p3.x, b.p3.y);  ctx.lineTo(b.cp2.x, b.cp2.y); ctx.stroke();
      ctx.setLineDash([]);
      [b.cp1, b.cp2].forEach(cp => {
        ctx.beginPath(); ctx.arc(cp.x, cp.y, 2.5, 0, Math.PI*2);
        ctx.fillStyle = 'rgba(20,184,166,.5)'; ctx.fill();
      });
    });
  });
}

function _applyVecPath(ctx, segments) {
  if (!segments.length) return;
  ctx.beginPath();
  const p0 = segments[0].span[0];
  ctx.moveTo(p0.x, p0.y);
  for (const seg of segments) {
    if (seg.type === 'L') {
      const pe = seg.span[seg.span.length - 1];
      ctx.lineTo(pe.x, pe.y);
    } else {
      seg.beziers.forEach(b => ctx.bezierCurveTo(b.cp1.x, b.cp1.y, b.cp2.x, b.cp2.y, b.p3.x, b.p3.y));
    }
  }
  ctx.closePath();
}

// ─── Render ───────────────────────────────────────────────────────────────────

function renderVectorize() {
  const c = document.getElementById('vec-canvas');
  if (!c) return;
  const ctx = c.getContext('2d');

  // Re-use the epsilon slider as corner-angle threshold (5→85°, default 50°)
  const sliderVal = parseInt(document.getElementById('vec-eps')?.value ?? 50);
  const cornerThresh = sliderVal;   // degrees
  const lineDevPx    = 2.5;         // max deviation for "straight" classification
  const epsEl = document.getElementById('vec-eps-val');
  if (epsEl) epsEl.textContent = `${cornerThresh}°`;

  const url = S.imgs[vecView];
  if (!url) {
    c.width = 400; c.height = 280;
    ctx.fillStyle = '#1E293B'; ctx.fillRect(0,0,400,280);
    ctx.fillStyle = '#475569'; ctx.font = '14px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('No image', 200, 140);
    _updateVecStats(null);
    return;
  }

  const img = new Image();
  img.onload = () => {
    const maxW = (c.parentElement?.offsetWidth ?? 600) - 2;
    const r    = Math.min(maxW / img.width, 420 / img.height, 1);
    c.width  = Math.round(img.width  * r);
    c.height = Math.round(img.height * r);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    ctx.fillStyle = 'rgba(15,23,42,.42)';
    ctx.fillRect(0, 0, c.width, c.height);

    const poly = S.polys[vecView];
    if (!poly || poly.pts.length < 3) { _updateVecStats(null); return; }

    // Scale polygon points from their original canvas space to current display
    const srcW = S.polyCanvasSize?.[vecView]?.w ?? c.width;
    const srcH = S.polyCanvasSize?.[vecView]?.h ?? c.height;
    const sx = c.width / srcW, sy = c.height / srcH;
    const pts = poly.pts.map(p => ({ x: p.x * sx, y: p.y * sy }));

    const result = _vectorize(pts, poly.closed, cornerThresh, lineDevPx);

    // Cache SVG path for export (in original polygon coordinate space)
    const ptsOrig = poly.pts;
    const origResult = _vectorize(ptsOrig, poly.closed, cornerThresh, lineDevPx);
    if (!S.vecCache) S.vecCache = {};
    S.vecCache[vecView] = origResult;

    _drawVecResult(ctx, result);
    _updateVecStats(result, pts, poly.closed);
  };
  img.src = url;
}

// ─── Stats panel ──────────────────────────────────────────────────────────────

function _updateVecStats(result, pts, closed) {
  const el = document.getElementById('vec-stats');
  if (!el) return;

  if (!result || result.lineCount + result.curveCount === 0) {
    el.innerHTML = '<div style="font-size:11px;color:var(--border);padding:16px;text-align:center;">No contour data</div>';
    return;
  }

  const ppm = S.scale[vecView];
  const srcW = S.polyCanvasSize?.[vecView]?.w ?? 1;
  const cEl  = document.getElementById('vec-canvas');
  const dispScale = cEl ? cEl.width / srcW : 1;
  const pxToMm = px => ppm ? (px / dispScale / ppm) : null;

  // Perimeter of full path
  let perimPx = 0;
  if (pts) {
    for (let i = 0; i < pts.length - 1; i++) {
      const dx = pts[i+1].x - pts[i].x, dy = pts[i+1].y - pts[i].y;
      perimPx += Math.hypot(dx, dy);
    }
    if (closed && pts.length > 1) {
      perimPx += Math.hypot(pts[0].x - pts[pts.length-1].x, pts[0].y - pts[pts.length-1].y);
    }
  }
  const perimMm  = pxToMm(perimPx);
  const perimStr = perimMm != null ? `${perimMm.toFixed(1)} mm` : `${Math.round(perimPx / dispScale)} px`;

  // Line lengths
  const linesHTML = result.segments.filter(s => s.type === 'L').map((s, i) => {
    const a = s.span[0], b = s.span[s.span.length - 1];
    const lenPx = Math.hypot(b.x - a.x, b.y - a.y);
    const mm    = pxToMm(lenPx);
    const ang   = ((Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI) + 360) % 180;
    return `<div style="padding:4px 8px;margin-bottom:3px;background:rgba(20,184,166,.07);border-radius:6px;font-family:'Fira Code',monospace;font-size:11px;display:flex;gap:8px;align-items:center;">
      <span style="color:#14B8A6;font-size:13px;">━</span>
      <span style="color:var(--subtle);">L${i+1}</span>
      <span style="color:var(--text);font-weight:600;">${mm != null ? mm.toFixed(1)+' mm' : Math.round(lenPx/dispScale)+' px'}</span>
      <span style="color:var(--muted);margin-left:auto;">${ang.toFixed(1)}°</span>
    </div>`;
  }).join('');

  const curvesHTML = result.segments.filter(s => s.type === 'C').map((s, i) =>
    `<div style="padding:4px 8px;margin-bottom:3px;background:rgba(249,115,22,.07);border-radius:6px;font-size:11px;display:flex;gap:8px;align-items:center;">
      <span style="color:#F97316;font-size:13px;">⌒</span>
      <span style="color:var(--subtle);">C${i+1}</span>
      <span style="color:var(--muted);font-size:10px;">${s.beziers.length} Bézier</span>
    </div>`
  ).join('');

  el.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:4px;margin-bottom:10px;">
      <div style="background:var(--bg);border-radius:8px;padding:6px;text-align:center;">
        <div style="font-size:18px;font-weight:700;color:#14B8A6;font-family:'Fira Code',monospace;">${result.lineCount}</div>
        <div style="font-size:9px;color:var(--muted);">Lines</div>
      </div>
      <div style="background:var(--bg);border-radius:8px;padding:6px;text-align:center;">
        <div style="font-size:18px;font-weight:700;color:#F97316;font-family:'Fira Code',monospace;">${result.curveCount}</div>
        <div style="font-size:9px;color:var(--muted);">Curves</div>
      </div>
      <div style="background:var(--bg);border-radius:8px;padding:6px;text-align:center;">
        <div style="font-size:18px;font-weight:700;color:var(--subtle);font-family:'Fira Code',monospace;">${result.cornerCount}</div>
        <div style="font-size:9px;color:var(--muted);">Corners</div>
      </div>
      <div style="background:var(--bg);border-radius:8px;padding:6px;text-align:center;">
        <div style="font-size:12px;font-weight:700;color:var(--teal-light);font-family:'Fira Code',monospace;">${perimStr}</div>
        <div style="font-size:9px;color:var(--muted);">Perimeter</div>
      </div>
    </div>
    <div style="max-height:220px;overflow-y:auto;">${linesHTML}${curvesHTML}</div>`;
}

// ─── SVG path accessor used by td-export.js ───────────────────────────────────
// Returns the SVG path string for a view, in polygon coordinate space,
// scaled to mm using the view's ppm.  Called from exportSVG().

function getVecSvgPath(v) {
  const poly = S.polys[v];
  if (!poly || poly.pts.length < 3) return null;
  const sliderVal   = parseInt(document.getElementById('vec-eps')?.value ?? 50);
  const origResult  = _vectorize(poly.pts, poly.closed, sliderVal, 2.5);
  const ppm         = S.scale[v] ?? 1;
  // Convert px → mm for SVG coordinates
  const toMm = n => (n / ppm).toFixed(3);
  let d = '';
  if (origResult.segments.length) {
    const p0 = origResult.segments[0].span[0];
    d = `M ${toMm(p0.x)},${toMm(p0.y)}`;
    for (const seg of origResult.segments) {
      if (seg.type === 'L') {
        const pe = seg.span[seg.span.length - 1];
        d += ` L ${toMm(pe.x)},${toMm(pe.y)}`;
      } else {
        for (const b of seg.beziers) {
          d += ` C ${toMm(b.cp1.x)},${toMm(b.cp1.y)}`
            +  ` ${toMm(b.cp2.x)},${toMm(b.cp2.y)}`
            +  ` ${toMm(b.p3.x)},${toMm(b.p3.y)}`;
        }
      }
    }
    d += ' Z';
  }
  return d || null;
}

// ══════════════════════════ SAVE / NEW ══════════════════════════
async function newProject() {
  if (!confirm('Delete the current project and start fresh?')) return;
  for (const v of ['front','side','top','iso']) await IDB.del(`img-${v}`);
  await IDB.del('state');
  await IDB.del('measurements');
  try { localStorage.removeItem('td-state'); localStorage.removeItem('td-measurements'); } catch(e) {}
  location.reload();
}

function saveProject() {
  persistState();
  const data = {
    version: 1,
    savedAt: new Date().toISOString(),
    step: S.step,
    scale: S.scale,
    polys: S.polys,
    holes: S.holes,
    dims: S.dims,
    imgMeta: S.imgMeta,
    polyCanvasSize: S.polyCanvasSize,
    measurements,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `td-project-${new Date().toISOString().slice(0,10)}.json`;
  a.click();

  const btn = document.querySelector('[onclick="saveProject()"]');
  if (btn) {
    const orig = btn.textContent;
    btn.textContent = 'Saved ✓';
    btn.style.color = '#14B8A6';
    setTimeout(() => { btn.textContent = orig; btn.style.color = ''; }, 2000);
  }
}
