// ══════════════════════════ STEP 6: VISUAL HULL ══════════════════════════
const hull = { az: 315, el: 22, zoom: 1, drag: null, grid: true };

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

function initVisualHull() {
  updateHullDims();
  hull._topFlip = _detectTopViewFlip();
  const c = document.getElementById('hull-canvas');
  if (!c) return;
  c.onmousedown = (e) => { hull.drag = { x: e.clientX, az: hull.az }; c.style.cursor = 'grabbing'; };
  c.onmousemove = (e) => { if (!hull.drag) return; hull.az = hull.drag.az + (e.clientX - hull.drag.x) * 0.6; renderVisualHull(); };
  c.onmouseup = c.onmouseleave = () => { hull.drag = null; c.style.cursor = 'grab'; };
  c.onwheel = (e) => { e.preventDefault(); hull.zoom = Math.max(0.3, Math.min(4, hull.zoom * (e.deltaY < 0 ? 1.1 : 0.91))); renderVisualHull(); };
  renderVisualHull();
}

function updateHullDims() {
  ['W','H','D'].forEach(k => {
    const el = document.getElementById(`hull-dim-${k}`);
    if (el && S.dims) el.textContent = S.dims[k] !== '—' ? S.dims[k] : '—';
  });
}

function resetHullView() { hull.az = 225; hull.el = 22; hull.zoom = 1; renderVisualHull(); }

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

function renderVisualHull() {
  const c = document.getElementById('hull-canvas');
  if (!c) return;
  const ctx = c.getContext('2d');
  const CW = c.parentElement.clientWidth - 2;
  const CH = Math.round(CW * 0.55);
  c.width = CW; c.height = CH;

  const dW = parseFloat(S.dims?.W) || 100;
  const dH = parseFloat(S.dims?.H) || 80;
  const dD = parseFloat(S.dims?.D) || 60;
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
    { idx:[4,5,6,7], norm:[0,0,1],  poly:null,    color:'rgba(13,148,136,.05)' },
    { idx:[7,6,2,3], norm:[0,1,0],  poly:'top',   color:'rgba(99,102,241,.14)' },
    { idx:[0,1,5,4], norm:[0,-1,0], poly:null,    color:'rgba(100,116,139,.06)' },
    // Right side: idx [2,6,5,1] → fu=[0,0,dD] (front→back), fv=[0,-dH,0] (top→bottom)
    { idx:[2,6,5,1], norm:[1,0,0],  poly:'side',  color:'rgba(249,115,22,.14)' },
    // Left side: idx [7,3,0,4] → fu=[0,0,-dD] (back→front, mirrored depth), fv=[0,-dH,0]
    // This is the depth-mirror of the right face — correct for a visual hull where the
    // left projection is the mirror image of the right projection.
    { idx:[7,3,0,4], norm:[-1,0,0], poly:'side',  color:'rgba(249,115,22,.14)' },
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

      // Physical face dimensions (mm): front→[W,H], side→[D,H], top→[W,D]
      const face_u_mm = f.poly === 'side' ? dD : dW;
      const face_v_mm = f.poly === 'top'  ? dD : dH;

      // Build a ptToUV function: normalises contour point to [0,1] on the face.
      // When scale is available use mm coords; without scale fall back to canvas pixels.
      const ppm = S.scale?.[f.poly];
      const flipV = f.poly === 'top' && !!hull._topFlip;
      const applyFlip = v => flipV ? 1 - v : v;
      let ptToUV;
      if (ppm && face_u_mm > 0 && face_v_mm > 0) {
        const xs_mm = poly.pts.map(p => p.x / ppm);
        const ys_mm = poly.pts.map(p => p.y / ppm);
        const minXmm = Math.min(...xs_mm), maxXmm = Math.max(...xs_mm);
        const minYmm = Math.min(...ys_mm), maxYmm = Math.max(...ys_mm);
        const contourW_mm = maxXmm - minXmm;
        const contourH_mm = maxYmm - minYmm;
        // Centre horizontally (camera centres object in frame)
        const offU = (face_u_mm - contourW_mm) / (2 * face_u_mm);
        // Front/side: bottom-align so the floor sits at v=1 across all views.
        // Top: centre depth axis; orientation determined by _detectTopViewFlip().
        const offV = f.poly === 'top'
          ? (face_v_mm - contourH_mm) / (2 * face_v_mm)
          : Math.max(0, (face_v_mm - contourH_mm) / face_v_mm);
        ptToUV = pt => ({
          u: (pt.x / ppm - minXmm) / face_u_mm + offU,
          v: applyFlip((pt.y / ppm - minYmm) / face_v_mm + offV),
        });
      } else {
        ptToUV = pt => ({ u: pt.x / srcW, v: applyFlip(pt.y / srcH) });
      }

      // Face axes in 3D (u = along first edge, v = along last edge)
      const [fc0,fc1,,fc3] = f.idx.map(i => c3[i]);
      const fu = [fc1[0]-fc0[0], fc1[1]-fc0[1], fc1[2]-fc0[2]];
      const fv = [fc3[0]-fc0[0], fc3[1]-fc0[1], fc3[2]-fc0[2]];
      const mapFace = (u,v) => proj(fc0[0]+fu[0]*u+fv[0]*v, fc0[1]+fu[1]*u+fv[1]*v, fc0[2]+fu[2]*u+fv[2]*v);

      ctx.save();
      ctx.beginPath(); ctx.moveTo(fp[0].x,fp[0].y); fp.slice(1).forEach(p=>ctx.lineTo(p.x,p.y)); ctx.closePath(); ctx.clip();
      ctx.beginPath();
      const uv0 = ptToUV(poly.pts[0]);
      const p0 = mapFace(uv0.u, uv0.v);
      ctx.moveTo(p0.x, p0.y);
      poly.pts.slice(1).forEach(pt => { const uv = ptToUV(pt); ctx.lineTo(mapFace(uv.u, uv.v).x, mapFace(uv.u, uv.v).y); });
      if (poly.closed) ctx.closePath();
      ctx.strokeStyle = '#0D9488'; ctx.lineWidth = 1.5; ctx.stroke();
      if (poly.closed) { ctx.fillStyle = 'rgba(13,148,136,.12)'; ctx.fill(); }
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

}