// ══════════════════════════ STEP 9: LAYOUT ══════════════════════════
function initLayout() { setTimeout(renderLayout, 50); }

function renderLayout() {
  const c = document.getElementById('layout-canvas');
  if (!c) return;
  const drawScale = parseFloat(document.getElementById('draw-scale')?.value ?? 1);
  const partName = document.getElementById('part-name')?.value ?? 'Part';

  // A3 landscape canvas
  const CW = c.parentElement.clientWidth - 2;
  const CH = Math.round(CW * (297 / 420));
  c.width = CW; c.height = CH;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, CW, CH);

  const M = Math.round(CW * 0.035);
  const TB_H = Math.round(CH * 0.14);
  const fs = Math.round(CW * 0.011);

  // Collect view data in mm
  const vmm = {};
  ['front','side','top'].forEach(v => {
    const poly = S.polys[v], ppm = S.scale[v];
    if (!ppm || !poly.pts.length) { vmm[v] = { w:0, h:0, empty:true }; return; }
    const xs = poly.pts.map(p => p.x / ppm), ys = poly.pts.map(p => p.y / ppm);
    vmm[v] = { w: Math.max(...xs)-Math.min(...xs), h: Math.max(...ys)-Math.min(...ys),
               minX: Math.min(...xs), minY: Math.min(...ys) };
  });

  const fW = vmm.front.w||80, fH = vmm.front.h||60;
  const sW = vmm.side.w||40,  sH = vmm.side.h||fH;
  const tW = vmm.top.w||fW,   tH = vmm.top.h||40;

  // First-angle layout: front BL, side BR, top TL
  // ┌──────────────────────────────────────┐
  // │  [Top/על]  │       ISO empty         │
  // ├────────────┼─────────────────────────┤
  // │  [Front]   │  [Side/צד]              │
  // ├──────────────────────────────────────┤
  // │           TITLE BLOCK                │
  // └──────────────────────────────────────┘

  const GAP_MM = 18;
  const totalW_mm = fW + GAP_MM + sW;
  const totalH_mm = tH + GAP_MM + fH;

  const availW = CW - 2*M;
  const availH = CH - 2*M - TB_H;
  const mmToPx = Math.min(availW / (totalW_mm * drawScale), availH / (totalH_mm * drawScale));

  const fWpx = fW * mmToPx, fHpx = fH * mmToPx;
  const sWpx = sW * mmToPx, sHpx = sH * mmToPx;
  const tWpx = tW * mmToPx, tHpx = tH * mmToPx;
  const gapPx = GAP_MM * mmToPx;

  const totalWpx = fWpx + gapPx + sWpx;
  const totalHpx = tHpx + gapPx + fHpx;
  const baseX = M + (availW - totalWpx) / 2;
  const baseY = M + (availH - totalHpx) / 2;

  const frontX = baseX, frontY = baseY + tHpx + gapPx;
  const sideX  = baseX + fWpx + gapPx, sideY = frontY;
  const topX   = baseX, topY = baseY;

  // Draw contour in box (in mm, mapped to px)
  const drawViewContour = (v, bx, by, bw, bh) => {
    const poly = S.polys[v];
    if (!poly.pts.length) {
      // Empty placeholder
      ctx.setLineDash([6,4]);
      ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 0.8;
      ctx.strokeRect(bx, by, bw, bh);
      ctx.setLineDash([]);
      return;
    }
    const ppm = S.scale[v] || 1;
    const xs = poly.pts.map(p => p.x/ppm), ys = poly.pts.map(p => p.y/ppm);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const scl = Math.min(bw / (maxX-minX||1), bh / (maxY-minY||1));
    const ox = bx + (bw - (maxX-minX)*scl) / 2;
    const oy = by + (bh - (maxY-minY)*scl) / 2;
    const px = x => ox + (x - minX) * scl;
    const py = y => oy + (y - minY) * scl;

    // Center / symmetry lines
    // Use detected symmetry axis when available (teal), otherwise geometric centre (grey).
    const sym = S.symmetry?.[v];
    const srcW = S.polyCanvasSize?.[v]?.w ?? 1;
    const srcH = S.polyCanvasSize?.[v]?.h ?? 1;
    // sym.axis is in mask-px (sym.mW × sym.mH); convert to contour-canvas-px first, then pseudo-mm
    const symAxisMm = sym
      ? (sym.dir === 'v'
          ? (sym.mW ? sym.axis / sym.mW * srcW : sym.axis) / ppm
          : (sym.mH ? sym.axis / sym.mH * srcH : sym.axis) / ppm)
      : null;
    const cxc = sym?.dir === 'v' ? px(symAxisMm) : ox + (maxX-minX)*scl/2;
    const cyc = sym?.dir === 'h' ? py(symAxisMm) : oy + (maxY-minY)*scl/2;
    const axisColor = sym ? '#0D9488' : '#94a3b8';
    ctx.setLineDash([4,3]); ctx.strokeStyle = axisColor; ctx.lineWidth = sym ? 0.8 : 0.6;
    ctx.beginPath(); ctx.moveTo(cxc, by-6); ctx.lineTo(cxc, by+bh+6); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(bx-6, cyc); ctx.lineTo(bx+bw+6, cyc); ctx.stroke();
    ctx.setLineDash([]);
    // Tick marks at ends of detected symmetry axis (⊣⊢ style, matching DXF export)
    if (sym) {
      const T = 4;
      ctx.strokeStyle = axisColor; ctx.lineWidth = 0.8;
      if (sym.dir === 'v') {
        ctx.beginPath(); ctx.moveTo(cxc-T, by-6);    ctx.lineTo(cxc+T, by-6);    ctx.stroke();
        ctx.beginPath(); ctx.moveTo(cxc-T, by+bh+6); ctx.lineTo(cxc+T, by+bh+6); ctx.stroke();
      } else {
        ctx.beginPath(); ctx.moveTo(bx-6,    cyc-T); ctx.lineTo(bx-6,    cyc+T); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(bx+bw+6, cyc-T); ctx.lineTo(bx+bw+6, cyc+T); ctx.stroke();
      }
    }

    // Contour (outer + holes with evenodd so holes are transparent)
    const viewHoles = S.holes?.[v];
    ctx.beginPath();
    ctx.moveTo(px(xs[0]), py(ys[0]));
    for (let i=1; i<poly.pts.length; i++) ctx.lineTo(px(xs[i]), py(ys[i]));
    if (poly.closed) ctx.closePath();
    if (viewHoles) viewHoles.forEach(hole => {
      if (hole.length < 3) return;
      const hxs = hole.map(p => p.x / ppm), hys = hole.map(p => p.y / ppm);
      ctx.moveTo(px(hxs[0]), py(hys[0]));
      for (let i=1; i<hole.length; i++) ctx.lineTo(px(hxs[i]), py(hys[i]));
      ctx.closePath();
    });
    ctx.fillStyle = 'rgba(0,0,0,0.04)';
    ctx.fill('evenodd');
    ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5;
    ctx.stroke();
    if (viewHoles) viewHoles.forEach(hole => {
      if (hole.length < 3) return;
      const hxs = hole.map(p => p.x / ppm), hys = hole.map(p => p.y / ppm);
      ctx.beginPath();
      ctx.moveTo(px(hxs[0]), py(hys[0]));
      for (let i=1; i<hole.length; i++) ctx.lineTo(px(hxs[i]), py(hys[i]));
      ctx.closePath();
      ctx.strokeStyle = '#000'; ctx.lineWidth = 0.8; ctx.stroke();
    });
  };

  drawViewContour('front', frontX, frontY, fWpx, fHpx);
  drawViewContour('side',  sideX,  sideY,  sWpx, sHpx);
  drawViewContour('top',   topX,   topY,   tWpx, tHpx);

  // Projection lines (thin dash between aligned views)
  ctx.setLineDash([3,3]); ctx.strokeStyle = '#94a3b8'; ctx.lineWidth = 0.7;
  // Horizontal: front → side
  ctx.beginPath(); ctx.moveTo(frontX+fWpx, frontY+fHpx/2); ctx.lineTo(sideX, sideY+sHpx/2); ctx.stroke();
  // Vertical: top → front
  ctx.beginPath(); ctx.moveTo(topX+tWpx/2, topY+tHpx); ctx.lineTo(frontX+fWpx/2, frontY); ctx.stroke();
  ctx.setLineDash([]);

  // View labels
  ctx.fillStyle = '#64748b'; ctx.textAlign = 'center';
  ctx.font = `${fs}px Fira Sans, sans-serif`;
  ctx.fillText('Front View', frontX + fWpx/2, frontY + fHpx + fs + 6);
  ctx.fillText('Side View',  sideX  + sWpx/2, sideY  + sHpx + fs + 6);
  ctx.fillText('Top View',   topX   + tWpx/2, topY   - 6);

  // Dimension annotations (if scale available)
  ctx.strokeStyle = '#475569'; ctx.fillStyle = '#475569'; ctx.lineWidth = 0.8;
  ctx.font = `${fs-1}px Fira Code, monospace`;
  const dimOff = 16;
  const dimArrow = (x1, y1, x2, y2, txt) => {
    ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke();
    // tick marks
    const ang = Math.atan2(y2-y1, x2-x1);
    [[x1,y1],[x2,y2]].forEach(([x,y]) => {
      ctx.beginPath(); ctx.moveTo(x+Math.cos(ang+Math.PI/2)*4, y+Math.sin(ang+Math.PI/2)*4);
      ctx.lineTo(x+Math.cos(ang-Math.PI/2)*4, y+Math.sin(ang-Math.PI/2)*4); ctx.stroke();
    });
    ctx.textAlign = 'center';
    const mx=(x1+x2)/2, my=(y1+y2)/2;
    const off = ang > 0.5 ? -8 : 8;
    ctx.fillText(txt, mx + Math.cos(ang+Math.PI/2)*off, my + Math.sin(ang+Math.PI/2)*off);
  };
  if (!vmm.front.empty && S.scale.front) {
    dimArrow(frontX, frontY+fHpx+dimOff, frontX+fWpx, frontY+fHpx+dimOff, `W ${fW.toFixed(1)}mm`);
    ctx.save(); ctx.translate(frontX-dimOff, frontY+fHpx/2); ctx.rotate(-Math.PI/2);
    dimArrow(-fHpx/2, 0, fHpx/2, 0, `H ${fH.toFixed(1)}mm`);
    ctx.restore();
  }
  if (!vmm.top.empty && S.scale.top) {
    ctx.save(); ctx.translate(topX+tWpx+dimOff, topY+tHpx/2); ctx.rotate(Math.PI/2);
    dimArrow(-tHpx/2, 0, tHpx/2, 0, `D ${tH.toFixed(1)}mm`);
    ctx.restore();
  }

  // Title block
  const tbY = CH - M - TB_H;
  ctx.fillStyle = '#f8fafc'; ctx.fillRect(M, tbY, CW-2*M, TB_H);
  ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.strokeRect(M, tbY, CW-2*M, TB_H);
  // Divider
  ctx.beginPath(); ctx.moveTo(CW-M-(CW-2*M)*0.35, tbY); ctx.lineTo(CW-M-(CW-2*M)*0.35, tbY+TB_H); ctx.stroke();

  const lfs = Math.round(fs * 1.1);
  ctx.textAlign = 'right'; ctx.fillStyle = '#0D9488';
  ctx.font = `bold ${lfs+2}px Fira Sans, sans-serif`;
  ctx.fillText(partName, CW-M-8, tbY + TB_H*0.42);

  ctx.font = `${lfs-1}px Fira Sans, sans-serif`; ctx.fillStyle = '#64748b';
  ctx.fillText(`Scale: 1:${drawScale}`, CW-M-8, tbY + TB_H*0.70);
  ctx.fillText(new Date().toLocaleDateString('en-GB'), CW-M-8, tbY + TB_H*0.90);

  ctx.textAlign = 'left'; ctx.fillStyle = '#334155';
  ctx.font = `bold ${lfs}px Fira Code, monospace`;
  ctx.fillText('TD Maker', M+10, tbY + TB_H*0.38);
  ctx.font = `${lfs-2}px Fira Sans, sans-serif`; ctx.fillStyle = '#94a3b8';
  ctx.fillText('Technical Drawing — ISO 128', M+10, tbY + TB_H*0.60);
  if (S.dims) {
    ctx.fillStyle = '#475569'; ctx.font = `${lfs-2}px Fira Code, monospace`;
    ctx.fillText(`W=${S.dims.W}  H=${S.dims.H}  D=${S.dims.D}  mm`, M+10, tbY + TB_H*0.82);
  }

  // Outer border (double line)
  ctx.strokeStyle = '#000'; ctx.lineWidth = 2;
  ctx.strokeRect(M/2, M/2, CW-M, CH-M);
  ctx.strokeStyle = '#000'; ctx.lineWidth = 0.5;
  ctx.strokeRect(M*0.75, M*0.75, CW-M*1.5, CH-M*1.5);

  copyToExport();
}

function copyToExport() {
  const src = document.getElementById('layout-canvas');
  const dst = document.getElementById('export-preview');
  if (!src || !dst) return;
  dst.width = src.width; dst.height = src.height;
  dst.getContext('2d').drawImage(src, 0, 0);

}