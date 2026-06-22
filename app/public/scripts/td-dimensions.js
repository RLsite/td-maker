// ══════════════════════════ STEP 8: DIMENSIONS ══════════════════════════
let dimView = 'front';

function setDimView(v) {
  dimView = v;
  document.querySelectorAll('.dim-tab').forEach(t => t.classList.toggle('active', t.dataset.v === v));
  initDimCanvas();
}

function initDimCanvas() {
  const c = document.getElementById('dim-canvas');
  if (!c) return;
  const ctx = c.getContext('2d');
  const url = S.imgs[dimView];
  if (!url) return;
  const img = new Image();
  img.onload = () => {
    const maxW = c.parentElement.offsetWidth - 2;
    const r = Math.min(maxW / img.width, 420 / img.height, 1);
    c.width = Math.round(img.width * r); c.height = Math.round(img.height * r);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    drawDimensions(ctx, c.width, c.height, dimView);
    renderDimList();
  };
  img.src = url;
}

// Scan horizontal cross-sections through a closed polygon (scaled canvas pts).
// Returns [{y, x1, x2, width}] for each integer row between by1 and by2.
function _polyCrossSections(pts, by1, by2) {
  const n = pts.length, rows = [];
  for (let y = Math.ceil(by1) + 1; y < Math.floor(by2) - 1; y++) {
    const xs = [];
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i+1) % n];
      if ((a.y <= y && b.y > y) || (b.y <= y && a.y > y)) {
        const t = (y - a.y) / (b.y - a.y);
        xs.push(a.x + t * (b.x - a.x));
      }
    }
    if (xs.length >= 2) {
      xs.sort((a, b) => a - b);
      rows.push({ y, x1: xs[0], x2: xs[xs.length - 1], width: xs[xs.length - 1] - xs[0] });
    }
  }
  return rows;
}

function drawDimensions(ctx, cw, ch, v) {
  const poly = S.polys[v];
  if (!poly.pts.length) return;
  const srcW = S.polyCanvasSize?.[v]?.w ?? cw;
  const srcH = S.polyCanvasSize?.[v]?.h ?? ch;
  const sx = cw / srcW, sy = ch / srcH;

  // Draw contour in clean black
  ctx.beginPath();
  ctx.moveTo(poly.pts[0].x * sx, poly.pts[0].y * sy);
  poly.pts.slice(1).forEach(p => ctx.lineTo(p.x * sx, p.y * sy));
  if (poly.closed) ctx.closePath();
  ctx.strokeStyle = '#0f172a'; ctx.lineWidth = 1.8; ctx.stroke();
  ctx.fillStyle = 'rgba(13,148,136,.07)'; ctx.fill();

  const ppm = S.scale[v];
  if (!ppm) return;

  const xs = poly.pts.map(p => p.x * sx), ys = poly.pts.map(p => p.y * sy);
  const bx1 = Math.min(...xs), bx2 = Math.max(...xs);
  const by1 = Math.min(...ys), by2 = Math.max(...ys);
  const bW = bx2 - bx1, bH = by2 - by1;

  const DIM_OFF = 30, EXT_GAP = 4, EXT_OVER = 4;
  const C = '#1e40af'; // blue for bbox dims

  // Width dimension (horizontal, below bounding box)
  const wy = by2 + DIM_OFF;
  ctx.strokeStyle = C; ctx.lineWidth = 0.8;
  ctx.beginPath(); ctx.moveTo(bx1, by2 + EXT_GAP); ctx.lineTo(bx1, wy + EXT_OVER); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(bx2, by2 + EXT_GAP); ctx.lineTo(bx2, wy + EXT_OVER); ctx.stroke();
  drawDimLine(ctx, bx1, wy, bx2, wy, `${(bW/ppm).toFixed(1)} mm`, C);

  // Height dimension (vertical, right of bounding box)
  const hx = bx2 + DIM_OFF;
  ctx.beginPath(); ctx.moveTo(bx2 + EXT_GAP, by1); ctx.lineTo(hx + EXT_OVER, by1); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(bx2 + EXT_GAP, by2); ctx.lineTo(hx + EXT_OVER, by2); ctx.stroke();
  ctx.save(); ctx.translate(hx, (by1+by2)/2); ctx.rotate(-Math.PI/2);
  drawDimLine(ctx, -bH/2, 0, bH/2, 0, `${(bH/ppm).toFixed(1)} mm`, C);
  ctx.restore();

  // ── 3 extra front-view cross-section dimensions ───────────────────────────
  if (v === 'front') {
    const scaledPts = poly.pts.map(p => ({ x: p.x * sx, y: p.y * sy }));
    const rows = _polyCrossSections(scaledPts, by1, by2);
    if (rows.length > 10) {
      const maxRow = rows.reduce((m, r) => r.width > m.width ? r : m, rows[0]);

      // Narrowest: only in the middle 70% of height (avoid tiny near-tip cross-sections)
      const lo = by1 + bH * 0.15, hi = by2 - bH * 0.15;
      const midRows = rows.filter(r => r.y >= lo && r.y <= hi);
      const minRow = midRows.length > 0
        ? midRows.reduce((m, r) => r.width < m.width ? r : m, midRows[0])
        : null;

      const TK = 9;   // tick half-height for inline cross-section marks
      const CA = '#b45309'; // amber — max cross-section width
      const CI = '#5b21b6'; // violet — height to max
      const CR = '#9f1239'; // rose   — narrowest width

      // 1. Max cross-section width — inline horizontal dim at maxRow.y
      //    Only draw when meaningfully different from total bbox width (>3px gap)
      if (maxRow.width > 8 && (bW - maxRow.width) > 3) {
        ctx.strokeStyle = CA; ctx.lineWidth = 0.8;
        ctx.setLineDash([4, 3]);
        ctx.beginPath(); ctx.moveTo(bx1, maxRow.y); ctx.lineTo(maxRow.x1, maxRow.y); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(maxRow.x2, maxRow.y); ctx.lineTo(bx2, maxRow.y); ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath(); ctx.moveTo(maxRow.x1, maxRow.y - TK); ctx.lineTo(maxRow.x1, maxRow.y + TK); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(maxRow.x2, maxRow.y - TK); ctx.lineTo(maxRow.x2, maxRow.y + TK); ctx.stroke();
        drawDimLine(ctx, maxRow.x1, maxRow.y, maxRow.x2, maxRow.y,
          `${(maxRow.width / ppm).toFixed(1)} mm`, CA);
      }

      // 2. Narrowest (waist) width — inline horizontal dim at minRow.y
      if (minRow && minRow.width > 8 && (bW - minRow.width) > 8) {
        ctx.strokeStyle = CR; ctx.lineWidth = 0.8;
        ctx.setLineDash([4, 3]);
        ctx.beginPath(); ctx.moveTo(bx1, minRow.y); ctx.lineTo(minRow.x1, minRow.y); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(minRow.x2, minRow.y); ctx.lineTo(bx2, minRow.y); ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath(); ctx.moveTo(minRow.x1, minRow.y - TK); ctx.lineTo(minRow.x1, minRow.y + TK); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(minRow.x2, minRow.y - TK); ctx.lineTo(minRow.x2, minRow.y + TK); ctx.stroke();
        drawDimLine(ctx, minRow.x1, minRow.y, minRow.x2, minRow.y,
          `${(minRow.width / ppm).toFixed(1)} mm`, CR);
      }

      // 3. Height from bottom to max-width level — vertical dim, left of bbox
      const htToMax = by2 - maxRow.y;
      if (htToMax > 10 && htToMax < bH - 10) {
        const hx2 = bx1 - 50;
        ctx.strokeStyle = CI; ctx.lineWidth = 0.8;
        ctx.beginPath(); ctx.moveTo(bx1 - EXT_GAP, maxRow.y); ctx.lineTo(hx2 - EXT_OVER, maxRow.y); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(bx1 - EXT_GAP, by2); ctx.lineTo(hx2 - EXT_OVER, by2); ctx.stroke();
        ctx.save(); ctx.translate(hx2, (maxRow.y + by2) / 2); ctx.rotate(-Math.PI / 2);
        drawDimLine(ctx, -htToMax / 2, 0, htToMax / 2, 0,
          `${(htToMax / ppm).toFixed(1)} mm`, CI);
        ctx.restore();
      }
    }
  }

  // Centroid crosshair
  const cx = (bx1+bx2)/2, cy = (by1+by2)/2;
  ctx.strokeStyle = 'rgba(148,163,184,.6)'; ctx.lineWidth = 0.7;
  ctx.setLineDash([5,3]);
  ctx.beginPath(); ctx.moveTo(cx, by1-8); ctx.lineTo(cx, by2+8); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(bx1-8, cy); ctx.lineTo(bx2+8, cy); ctx.stroke();
  ctx.setLineDash([]);
}

function drawDimLine(ctx, x1, y1, x2, y2, label, color='#1e40af') {
  const ang = Math.atan2(y2-y1, x2-x1);
  const aw = 8;
  ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 1;

  // Main line (leave space for arrowheads)
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();

  // Filled arrowheads
  [[x1,y1,1],[x2,y2,-1]].forEach(([x,y,d]) => {
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + d*aw*Math.cos(ang-0.35), y + d*aw*Math.sin(ang-0.35));
    ctx.lineTo(x + d*aw*Math.cos(ang+0.35), y + d*aw*Math.sin(ang+0.35));
    ctx.closePath(); ctx.fill();
  });

  // Label with white background
  const mx = (x1+x2)/2, my = (y1+y2)/2;
  ctx.font = 'bold 11px Fira Code, monospace';
  const tw = ctx.measureText(label).width;
  const lx = mx - Math.cos(ang+Math.PI/2)*14;
  const ly = my - Math.sin(ang+Math.PI/2)*14;
  ctx.fillStyle = 'rgba(255,255,255,.85)';
  ctx.fillRect(lx - tw/2 - 3, ly - 8, tw + 6, 14);
  ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(label, lx, ly);
  ctx.textBaseline = 'alphabetic';
}

function renderDimList() {
  const el = document.getElementById('dim-list');
  if (!el) return;
  const ppm = S.scale[dimView];
  const poly = S.polys[dimView];
  if (!ppm || !poly.pts.length) { el.innerHTML = '<div style="color:var(--muted);font-size:12px;">No data</div>'; return; }
  const xs = poly.pts.map(p => p.x), ys = poly.pts.map(p => p.y);
  const W = ((Math.max(...xs)-Math.min(...xs))/ppm).toFixed(1);
  const H = ((Math.max(...ys)-Math.min(...ys))/ppm).toFixed(1);

  // Front-view cross-section extras
  let frontExtras = '';
  if (dimView === 'front') {
    const srcW2 = S.polyCanvasSize?.[dimView]?.w ?? 1;
    const srcH2 = S.polyCanvasSize?.[dimView]?.h ?? 1;
    const cEl = document.getElementById('dim-canvas');
    const cw2 = cEl ? cEl.width : srcW2, ch2 = cEl ? cEl.height : srcH2;
    const sx2 = cw2 / srcW2, sy2 = ch2 / srcH2;
    const scaledPts2 = poly.pts.map(p => ({ x: p.x * sx2, y: p.y * sy2 }));
    const ys2 = scaledPts2.map(p => p.y);
    const by1_2 = Math.min(...ys2), by2_2 = Math.max(...ys2), bH2 = by2_2 - by1_2;
    const rows2 = _polyCrossSections(scaledPts2, by1_2, by2_2);
    if (rows2.length > 10) {
      const maxRow2 = rows2.reduce((m, r) => r.width > m.width ? r : m, rows2[0]);
      const lo2 = by1_2 + bH2 * 0.15, hi2 = by2_2 - bH2 * 0.15;
      const midRows2 = rows2.filter(r => r.y >= lo2 && r.y <= hi2);
      const minRow2 = midRows2.length > 0 ? midRows2.reduce((m, r) => r.width < m.width ? r : m, midRows2[0]) : null;
      const htToMax2 = by2_2 - maxRow2.y;
      frontExtras = `
        <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);">
          <span style="color:#b45309;">⟷ Max cross-section</span>
          <span style="color:#b45309;font-weight:600;">${(maxRow2.width/ppm).toFixed(1)} mm</span>
        </div>
        ${minRow2 ? `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);">
          <span style="color:#9f1239;">⟷ Narrowest (waist)</span>
          <span style="color:#9f1239;font-weight:600;">${(minRow2.width/ppm).toFixed(1)} mm</span>
        </div>` : ''}
        ${htToMax2 > 0 ? `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);">
          <span style="color:#5b21b6;">↕ Ht. to max section</span>
          <span style="color:#5b21b6;font-weight:600;">${(htToMax2/ppm).toFixed(1)} mm</span>
        </div>` : ''}`;
    }
  }

  el.innerHTML = `
    <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);"><span style="color:var(--muted);">Width</span><span style="color:var(--teal-light);">${W} mm</span></div>
    <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);"><span style="color:var(--muted);">Height</span><span style="color:var(--teal-light);">${H} mm</span></div>
    ${frontExtras}
    <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);"><span style="color:var(--muted);">Contour points</span><span style="color:var(--subtle);">${poly.pts.length}</span></div>
    <div style="display:flex;justify-content:space-between;padding:6px 0;"><span style="color:var(--muted);">px/mm</span><span style="color:var(--subtle);">${ppm.toFixed(3)}</span></div>`;

}