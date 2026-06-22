// ══════════════════════════ GMM COLOR SEGMENTATION ══════════════════════════
// GrabCut simplified — Rother, Kolmogorov, Blake 2004
// Without full graph cut: uses GMM fg/bg color models + distance threshold
// User marks bounding box → center pixels = fg model, border pixels = bg model

function gmmSegment() {
  if (!S.segImgData) return;
  const W=segOut.width, H=segOut.height;
  const src=S.segImgData.data;

  // Compute per-pixel RGB
  const r=new Float32Array(W*H), g=new Float32Array(W*H), b=new Float32Array(W*H);
  for (let i=0;i<W*H;i++) { r[i]=src[i*4]; g[i]=src[i*4+1]; b[i]=src[i*4+2]; }

  // Foreground samples: inner 50% of image
  const mx1=Math.floor(W*.25), mx2=Math.floor(W*.75);
  const my1=Math.floor(H*.25), my2=Math.floor(H*.75);
  const fgR=[], fgG=[], fgB=[], bgR=[], bgG=[], bgB=[];
  for (let y=0;y<H;y++) for (let x=0;x<W;x++) {
    const i=y*W+x;
    if (x>=mx1&&x<mx2&&y>=my1&&y<my2) { fgR.push(r[i]); fgG.push(g[i]); fgB.push(b[i]); }
    else if (x<10||x>=W-10||y<10||y>=H-10) { bgR.push(r[i]); bgG.push(g[i]); bgB.push(b[i]); }
  }

  const mean=(a)=>a.reduce((s,v)=>s+v,0)/a.length;
  const std=(a,m)=>Math.sqrt(a.reduce((s,v)=>s+(v-m)**2,0)/a.length)+1;

  const fgMR=mean(fgR), fgMG=mean(fgG), fgMB=mean(fgB);
  const bgMR=mean(bgR), bgMG=mean(bgG), bgMB=mean(bgB);
  const fgSR=std(fgR,fgMR), fgSG=std(fgG,fgMG), fgSB=std(fgB,fgMB);
  const bgSR=std(bgR,bgMR), bgSG=std(bgG,bgMG), bgSB=std(bgB,bgMB);

  // Mahalanobis-like distance to each Gaussian
  const out=segCtxO.createImageData(W,H);
  for (let i=0;i<W*H;i++) {
    const dfg=((r[i]-fgMR)/fgSR)**2+((g[i]-fgMG)/fgSG)**2+((b[i]-fgMB)/fgSB)**2;
    const dbg=((r[i]-bgMR)/bgSR)**2+((g[i]-bgMG)/bgSG)**2+((b[i]-bgMB)/bgSB)**2;
    const v=(dfg<dbg)?255:0;
    out.data[i*4]=out.data[i*4+1]=out.data[i*4+2]=v; out.data[i*4+3]=255;
  }
  segCtxO.putImageData(out,0,0);
}

// ── Contour quality helpers ───────────────────────────────────
function _cqArea(p) {
  let a=0; const n=p.length;
  for (let i=0; i<n; i++) { const a1=p[i], b=p[(i+1)%n]; a+=a1.x*b.y-b.x*a1.y; }
  return Math.abs(a)/2;
}
function _cqBbox(p) {
  let x0=Infinity,x1=-Infinity,y0=Infinity,y1=-Infinity;
  for (const pt of p) { x0=Math.min(x0,pt.x); x1=Math.max(x1,pt.x); y0=Math.min(y0,pt.y); y1=Math.max(y1,pt.y); }
  return { w: x1-x0, h: y1-y0, minX:x0, minY:y0 };
}
function _cqPerim(p) {
  let s=0; const n=p.length;
  for (let i=0; i<n; i++) { const a=p[i], b=p[(i+1)%n]; s+=Math.sqrt((b.x-a.x)**2+(b.y-a.y)**2); }
  return s;
}
function _cqSelfIntersect(p) {
  const n=p.length;
  const ccw=(A,B,C)=>(C.y-A.y)*(B.x-A.x)>(B.y-A.y)*(C.x-A.x);
  for (let i=0; i<n; i++) for (let j=i+2; j<n; j++) {
    if (i===0&&j===n-1) continue;
    const [p1,p2,p3,p4]=[p[i],p[(i+1)%n],p[j],p[(j+1)%n]];
    if (ccw(p1,p3,p4)!==ccw(p2,p3,p4)&&ccw(p1,p2,p3)!==ccw(p1,p2,p4)) return true;
  }
  return false;
}
function scoreContourSimple(pts) {
  if (!pts || pts.length < 3) return { score: 0, label: 'Error', color: '#f87171', issues: ['No points'] };
  const area  = _cqArea(pts);
  const perim = _cqPerim(pts);
  const circ  = (4*Math.PI*area) / (perim*perim+1e-6);
  const selfX = _cqSelfIntersect(pts);

  // Convexity: hull area / poly area (1=fully convex)
  let convexity = 1;
  try {
    const hull = convexHullAndrews(pts.map(p=>({x:p.x,y:p.y})));
    if (hull && hull.length >= 3) convexity = Math.min(1, area / (_polyArea(hull)+1e-6));
  } catch(_){}

  // Smoothness: average angle change between consecutive edges
  let angleSum=0;
  for (let i=0;i<pts.length;i++) {
    const a=pts[(i-1+pts.length)%pts.length], b=pts[i], c=pts[(i+1)%pts.length];
    const ax=b.x-a.x,ay=b.y-a.y,bx=c.x-b.x,by=c.y-b.y;
    const cross=Math.abs(ax*by-ay*bx)/(Math.sqrt(ax*ax+ay*ay)*Math.sqrt(bx*bx+by*by)+1e-9);
    angleSum+=Math.asin(Math.min(1,cross));
  }
  const smoothness = 1 - Math.min(1, angleSum/pts.length/(Math.PI/4));

  const issues=[];
  let score=100;
  if (pts.length<4)       { score-=30; issues.push('few points'); }
  if (area<200)           { score-=35; issues.push('small object'); }
  if (selfX)              { score-=50; issues.push('self-intersection'); }
  if (circ<0.05)          { score-=20; issues.push('not closed'); }
  if (convexity<0.6)      { score-=15; issues.push('low convexity'); }
  if (smoothness<0.4)     { score-=10; issues.push('sharp edges'); }

  score=Math.max(0,Math.min(100,Math.round(score)));
  const label=score>=80?'Excellent':score>=60?'Good':score>=40?'Needs work':'Error';
  const color=score>=80?'#4ade80':score>=60?'var(--teal-light)':score>=40?'#fbbf24':'#f87171';
  return { score, label, color, issues };
}

function updateContourInfo() {
  if (typeof _updateAddHoleBtn === 'function') _updateAddHoleBtn();
  const poly = S.polys[S.contourView];
  const v = S.contourView;
  const el = document.getElementById('contour-info');
  if (!poly.closed) {
    el.textContent = poly.pts.length ? `${poly.pts.length} points` : '';
    el.style.color = 'var(--muted)';
    return;
  }

  const bbox = _cqBbox(poly.pts);
  S.contourBbox[v] = { minX: bbox.minX, minY: bbox.minY, maxX: bbox.minX + bbox.w, maxY: bbox.minY + bbox.h };

  // ── Area cross-validation against segmentation silhouette ──
  const areaPx  = _cqArea(poly.pts);
  const perimPx = _cqPerim(poly.pts);
  const sm = S.segMeta?.[v];
  let areaRatio = null;
  if (sm?.area && cC) {
    // Convert silhouette pixel count (mask space) to canvas-pixel area for comparison
    const maskToCanvasSq = (cC.width / sm.W) * (cC.height / sm.H);
    const expectedPx = sm.area * maskToCanvasSq;
    areaRatio = areaPx / expectedPx;
  }

  // Store everything so downstream steps (dimensions, layout) can use it
  S.contourInfo[v] = { areaPx, perimPx, areaRatio };

  // Compose area-match badge
  let areaBadge = '';
  if (areaRatio !== null) {
    const pct = Math.round(areaRatio * 100);
    if (areaRatio > 1.20)
      areaBadge = ` &nbsp;·&nbsp; <span style="color:#f87171;font-weight:600;" title="Contour larger than silhouette — background may be included">⚠ area ${pct}%</span>`;
    else if (areaRatio < 0.80)
      areaBadge = ` &nbsp;·&nbsp; <span style="color:#fbbf24;font-weight:600;" title="Contour smaller than silhouette — part of object may be missing">⚠ area ${pct}%</span>`;
    else
      areaBadge = ` &nbsp;·&nbsp; <span style="color:#4ade80;font-size:11px;">✓ area ${pct}%</span>`;
  }

  const q = scoreContourSimple(poly.pts);
  const modeMap = { checkerboard:'Grid ✓', otsu:'Otsu ✓', canny:'Canny', sauvola:'Sauvola ✓' };
  const modeTag = S.lastMode?.[v];
  const modeStr = modeTag ? ` &nbsp;·&nbsp; <span style="color:#94a3b8;font-size:11px;">${modeMap[modeTag]||modeTag}</span>` : '';
  const dilLvl = S.dilScale?.[v] || 1;
  const dilStr = dilLvl > 1 ? ` &nbsp;·&nbsp; <span style="color:#67e8f9;font-size:11px;">Refine ×${Math.round((dilLvl-1)/0.6)}</span>` : '';

  // Symmetry badge — shown when Background Separation detected a symmetry axis
  const sym = S.symmetry?.[v];
  const symStr = sym
    ? ` &nbsp;·&nbsp; <span style="color:#2dd4bf;font-size:11px;" title="Symmetry axis detected (score ${Math.round(sym.score*100)}%) — contour was mirrored">${sym.dir==='v' ? '⟺' : '⇳'} Sym ${Math.round(sym.score*100)}%</span>`
    : '';

  // regionprops — eccentricity from polygon 2nd moments (skimage.measure.regionprops)
  const n = poly.pts.length;
  const cx = poly.pts.reduce((s,p) => s+p.x, 0) / n;
  const cy = poly.pts.reduce((s,p) => s+p.y, 0) / n;
  let mu20 = 0, mu02 = 0, mu11 = 0;
  for (const p of poly.pts) { const dx=p.x-cx, dy=p.y-cy; mu20+=dx*dx; mu02+=dy*dy; mu11+=dx*dy; }
  mu20 /= n; mu02 /= n; mu11 /= n;
  const disc2 = Math.sqrt(Math.max(0, (mu20-mu02)**2 + 4*mu11*mu11));
  const l1 = (mu20+mu02+disc2)/2, l2 = (mu20+mu02-disc2)/2;
  const ecc = l1 > 1e-6 ? Math.sqrt(Math.max(0, 1-l2/l1)) : 0;
  const eccStr = ` &nbsp;·&nbsp; <span style="color:#94a3b8;font-size:11px;" title="eccentricity: 0=circle, 1=line (skimage regionprops)">ecc ${ecc.toFixed(2)}</span>`;

  el.innerHTML = `✓ Closed contour &nbsp;·&nbsp; ${poly.pts.length} points &nbsp;·&nbsp; <span style="color:${q.color};font-weight:600;">${q.label} (${q.score}%)</span>${modeStr}${dilStr}${symStr} &nbsp;·&nbsp; ${Math.round(bbox.w)}×${Math.round(bbox.h)} px${areaBadge}${eccStr}`;
  el.style.color = 'var(--text)';
  for (const vv of ['front','side','top']) {
    const b = document.getElementById(`ctab-badge-${vv}`);
    if (b) b.textContent = S.polys?.[vv]?.closed ? ' ✓' : '';
  }
}

function undoPoint() {
  const poly = S.polys[S.contourView];
  if (poly.closed) { poly.closed = false; } else { poly.pts.pop(); }
  drawContour(); updateContourInfo();
}

function clearContour() {
  const view = S.contourView;
  S.polys[view] = { pts: [], closed: false }; S.mouse = null;
  if (S.dilScale) delete S.dilScale[view];
  if (S.lastMode) delete S.lastMode[view];
  if (S.bgSamples) delete S.bgSamples[view];
  const btn = document.getElementById('refine-btn');
  if (btn) btn.textContent = '🎯 Refine';
  if (cC?.dataset?.guided) { delete cC.dataset.guided; cGuidedSeeds = []; }
  const guidedBtn = document.getElementById('guided-btn');
  if (guidedBtn) { guidedBtn.style.background=''; guidedBtn.style.borderColor='var(--border)'; }
  cBgSampleMode = false;
  _refreshBgSampleBtn();
  drawContour(); updateContourInfo(); persistState();
}

// ── CV helpers: bilateral filter ─────────────────────────────
function bilateralFilter(gray, W, H, radius, sigS, sigI) {
  const out = new Uint8ClampedArray(gray.length);
  const sLut = new Float32Array(radius*radius+1);
  const iLut = new Float32Array(256);
  const s2S = 2*sigS*sigS, s2I = 2*sigI*sigI;
  for (let d=0; d<=radius*radius; d++) sLut[d] = Math.exp(-d/s2S);
  for (let di=0; di<256; di++) iLut[di] = Math.exp(-(di*di)/s2I);
  for (let y=0; y<H; y++) {
    for (let x=0; x<W; x++) {
      const ci = y*W+x, cv = gray[ci];
      let ws=0, ps=0;
      for (let dy=-radius; dy<=radius; dy++) {
        for (let dx=-radius; dx<=radius; dx++) {
          const ny=y+dy, nx=x+dx;
          if (nx<0||nx>=W||ny<0||ny>=H) continue;
          const ni=ny*W+nx, nv=gray[ni];
          const w = sLut[dx*dx+dy*dy] * iLut[Math.abs(cv-nv)];
          ws+=w; ps+=nv*w;
        }
      }
      out[ci] = Math.round(ps/ws);
    }
  }
  return out;
}

// ── CV helpers: Canny edge detection ─────────────────────────
function cannyGaussianKernel(sigma) {
  const r = Math.max(1, Math.ceil(3*sigma));
  const k = new Float32Array(2*r+1);
  let s=0;
  for (let i=0; i<=2*r; i++) { k[i]=Math.exp(-((i-r)**2)/(2*sigma*sigma)); s+=k[i]; }
  for (let i=0; i<=2*r; i++) k[i]/=s;
  return { k, r };
}
function cannyBlur(gray, W, H, sigma) {
  const { k, r } = cannyGaussianKernel(sigma);
  const tmp = new Float32Array(W*H), out = new Float32Array(W*H);
  for (let y=0; y<H; y++) for (let x=0; x<W; x++) {
    let s=0,w=0; for (let d=-r; d<=r; d++) { const nx=x+d; if (nx>=0&&nx<W){s+=k[d+r]*gray[y*W+nx];w+=k[d+r];} } tmp[y*W+x]=s/w;
  }
  for (let y=0; y<H; y++) for (let x=0; x<W; x++) {
    let s=0,w=0; for (let d=-r; d<=r; d++) { const ny=y+d; if (ny>=0&&ny<H){s+=k[d+r]*tmp[ny*W+x];w+=k[d+r];} } out[y*W+x]=s/w;
  }
  return out;
}
function cannySobel(blur, W, H) {
  const mag = new Float32Array(W*H), dir = new Float32Array(W*H);
  for (let y=1; y<H-1; y++) for (let x=1; x<W-1; x++) {
    const gx = -blur[(y-1)*W+(x-1)] + blur[(y-1)*W+(x+1)] - 2*blur[y*W+(x-1)] + 2*blur[y*W+(x+1)] - blur[(y+1)*W+(x-1)] + blur[(y+1)*W+(x+1)];
    const gy = -blur[(y-1)*W+(x-1)] - 2*blur[(y-1)*W+x] - blur[(y-1)*W+(x+1)] + blur[(y+1)*W+(x-1)] + 2*blur[(y+1)*W+x] + blur[(y+1)*W+(x+1)];
    mag[y*W+x] = Math.sqrt(gx*gx+gy*gy);
    dir[y*W+x] = Math.atan2(gy,gx);
  }
  return { mag, dir };
}
function cannyNMS(mag, dir, W, H) {
  const out = new Float32Array(W*H);
  for (let y=1; y<H-1; y++) for (let x=1; x<W-1; x++) {
    const i=y*W+x, a=dir[i], m=mag[i];
    const ang = ((a*180/Math.PI)%180+180)%180;
    let q=0,r=0;
    if (ang<22.5||ang>=157.5) { q=mag[i+1]; r=mag[i-1]; }
    else if (ang<67.5) { q=mag[(y+1)*W+(x+1)]; r=mag[(y-1)*W+(x-1)]; }
    else if (ang<112.5) { q=mag[(y+1)*W+x]; r=mag[(y-1)*W+x]; }
    else { q=mag[(y+1)*W+(x-1)]; r=mag[(y-1)*W+(x+1)]; }
    if (m>=q && m>=r) out[i]=m;
  }
  return out;
}
function cannyThreshold(nms, W, H, low, high) {
  const WEAK=1, STRONG=2;
  const out = new Uint8Array(W*H);
  for (let i=0; i<W*H; i++) { if (nms[i]>=high) out[i]=STRONG; else if (nms[i]>=low) out[i]=WEAK; }
  const dirs = [-1,1,-W,W,-W-1,-W+1,W-1,W+1];
  const q = [];
  for (let i=0; i<W*H; i++) if (out[i]===STRONG) q.push(i);
  let qi=0;
  while (qi<q.length) { const i=q[qi++]; for (const d of dirs) { const n=i+d; if (n>=0&&n<W*H&&out[n]===WEAK){out[n]=STRONG;q.push(n);} } }
  const res = new Uint8ClampedArray(W*H);
  for (let i=0; i<W*H; i++) if (out[i]===STRONG) res[i]=255;
  return res;
}
function cannyEdges(gray, W, H, low=30, high=80) {
  const blur = cannyBlur(gray, W, H, 1.4);
  const { mag, dir } = cannySobel(blur, W, H);
  const nms = cannyNMS(mag, dir, W, H);
  return cannyThreshold(nms, W, H, low, high);

}