// ══════════════════════════ ACTIVE CONTOUR (SNAKE) ══════════════════════════
// Kass, Witkin, Terzopoulos 1988 — Szeliski "Computer Vision" Ch.7
// Energy = α·(elasticity) + β·(rigidity) − γ·(edge strength)
// Greedy discrete minimization: each point moves to best neighbor in 5×5 grid

function computeEdgeEnergy() {
  if (!cImg) return null;
  const W = cC.width, H = cC.height;
  const tmp = document.createElement('canvas');
  tmp.width = W; tmp.height = H;
  const ctx = tmp.getContext('2d');
  ctx.drawImage(cImg, 0, 0, W, H);
  const px = ctx.getImageData(0,0,W,H).data;
  const gray = new Uint8ClampedArray(W*H);
  for (let i=0;i<W*H;i++) gray[i]=px[i*4]*.299+px[i*4+1]*.587+px[i*4+2]*.114;
  const blr = bilateralFilter(gray,W,H,2,1.5,25);

  // Sobel gradient magnitude → edge energy field
  const mag = new Float32Array(W*H);
  let maxM=0;
  for (let y=1;y<H-1;y++) for (let x=1;x<W-1;x++) {
    const gx = -blr[(y-1)*W+(x-1)] + blr[(y-1)*W+(x+1)]
               -2*blr[y*W+(x-1)] + 2*blr[y*W+(x+1)]
               -blr[(y+1)*W+(x-1)] + blr[(y+1)*W+(x+1)];
    const gy = -blr[(y-1)*W+(x-1)] - 2*blr[(y-1)*W+x] - blr[(y-1)*W+(x+1)]
               +blr[(y+1)*W+(x-1)] + 2*blr[(y+1)*W+x] + blr[(y+1)*W+(x+1)];
    mag[y*W+x] = Math.sqrt(gx*gx+gy*gy);
    if (mag[y*W+x]>maxM) maxM=mag[y*W+x];
  }
  // Normalize
  if (maxM>0) for (let i=0;i<W*H;i++) mag[i]/=maxM;

  // Blend depth gradient: take max of color edge and depth edge.
  // Depth discontinuities are often cleaner at object boundaries than color edges.
  const dGrad = typeof depthGradient === 'function'
    ? depthGradient(S.contourView, W, H)
    : null;
  if (dGrad) {
    let dMax = 0;
    for (let i = 0; i < dGrad.length; i++) if (dGrad[i] > dMax) dMax = dGrad[i];
    if (dMax > 0)
      for (let i = 0; i < W*H; i++) mag[i] = Math.max(mag[i], dGrad[i] / dMax);
  }

  // Gaussian blur the energy field → "pull" basin around edges
  return _zdceBoxBlur(mag, W, H, Math.max(3, Math.round(Math.min(W,H)*0.015)));
}

// Silent snake run triggered automatically after auto-detect.
// capturedView: the view that triggered this run — abort if user switched away.
function _runSnakeAuto(capturedView) {
  const view = capturedView ?? S.contourView;
  if (view !== S.contourView) return;  // user switched views during setTimeout

  // cImg loads asynchronously; retry once it's ready.
  if (!cC || !cImg || !cImg.complete || cImg.naturalWidth === 0) {
    if (cImg && !cImg.complete) {
      cImg.addEventListener('load', () => _runSnakeAuto(view), { once: true });
    }
    return;
  }
  const poly = S.polys[view];
  if (!poly?.closed || poly.pts.length < 4) return;

  const W = cC.width, H = cC.height;
  const energy = computeEdgeEnergy();
  if (!energy) return;

  const alpha = 0.3;
  const beta  = 0.1;
  const gamma = 4.0;
  const STEP  = 3;
  const ITERS = 50;

  const pts = poly.pts.map(p => ({ x: p.x, y: p.y }));
  const n = pts.length;

  // Gauss-Seidel: read prev/next from pts directly so each update benefits
  // from neighbors that already moved in this iteration (faster convergence).
  for (let iter = 0; iter < ITERS; iter++) {
    for (let i = 0; i < n; i++) {
      const pv = pts[(i - 1 + n) % n];
      const nx2 = pts[(i + 1) % n];
      let bestE = Infinity, bestX = pts[i].x, bestY = pts[i].y;
      for (let dy = -STEP; dy <= STEP; dy++) for (let dx = -STEP; dx <= STEP; dx++) {
        const cx = pts[i].x + dx, cy = pts[i].y + dy;
        if (cx < 1 || cx >= W - 1 || cy < 1 || cy >= H - 1) continue;
        const ix = Math.round(cx), iy = Math.round(cy);
        const d1 = (cx - pv.x) ** 2 + (cy - pv.y) ** 2;
        const d2 = (pv.x - 2*cx + nx2.x) ** 2 + (pv.y - 2*cy + nx2.y) ** 2;
        const E  = alpha * d1 + beta * d2 - gamma * energy[iy * W + ix];
        if (E < bestE) { bestE = E; bestX = cx; bestY = cy; }
      }
      pts[i] = { x: bestX, y: bestY };
    }
  }
  poly.pts = pts;

  // Fix any outer-contour vertices inside a hole — runs after snake so it
  // is not immediately overwritten by the snake's final poly.pts assignment.
  if (typeof _fixContourHolePenetration === 'function')
    _fixContourHolePenetration(view);

  drawContour();
  updateContourInfo();
  persistState();
}

function runSnake() {
  const poly = S.polys[S.contourView];
  if (!poly.closed || poly.pts.length < 4) return alert('Close the contour first');

  const W = cC.width, H = cC.height;
  const energy = computeEdgeEnergy();
  if (!energy) return;

  const alpha = 0.4;  // elasticity (tension)
  const beta  = 0.2;  // rigidity (curvature)
  const gamma = 3.0;  // edge attraction
  const STEP  = 2;    // search radius in pixels
  const ITERS = 60;

  // Work in canvas pixel space (poly.pts are already in canvas coords)
  const pts = poly.pts.map(p=>({x:p.x, y:p.y}));
  const n = pts.length;

  for (let iter=0; iter<ITERS; iter++) {
    for (let i=0; i<n; i++) {
      const pv = pts[(i-1+n)%n];
      const nxt = pts[(i+1)%n];
      let bestE=Infinity, bestX=pts[i].x, bestY=pts[i].y;
      for (let dy=-STEP; dy<=STEP; dy++) for (let dx=-STEP; dx<=STEP; dx++) {
        const cx=pts[i].x+dx, cy=pts[i].y+dy;
        if (cx<1||cx>=W-1||cy<1||cy>=H-1) continue;
        const ix=Math.round(cx), iy=Math.round(cy);
        const d1=(cx-pv.x)**2+(cy-pv.y)**2;
        const d2=(pv.x-2*cx+nxt.x)**2+(pv.y-2*cy+nxt.y)**2;
        const E = alpha*d1 + beta*d2 - gamma*energy[iy*W+ix];
        if (E<bestE) { bestE=E; bestX=cx; bestY=cy; }
      }
      pts[i]={x:bestX, y:bestY};
    }
    // Redraw every 10 iters for live feedback
    if (iter%10===9) {
      poly.pts = pts.map(p=>({...p}));
      drawContour();
    }
  }
  poly.pts = pts;
  drawContour(); updateContourInfo(); persistState();

}