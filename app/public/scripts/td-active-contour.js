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

  // Gaussian blur the energy field → "pull" basin around edges
  return _zdceBoxBlur(mag, W, H, Math.max(3, Math.round(Math.min(W,H)*0.015)));
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
    const prev = pts.map((_,i)=>pts[(i-1+n)%n]);
    const next = pts.map((_,i)=>pts[(i+1)%n]);
    for (let i=0; i<n; i++) {
      let bestE=Infinity, bestX=pts[i].x, bestY=pts[i].y;
      for (let dy=-STEP; dy<=STEP; dy++) for (let dx=-STEP; dx<=STEP; dx++) {
        const nx=pts[i].x+dx, ny=pts[i].y+dy;
        if (nx<1||nx>=W-1||ny<1||ny>=H-1) continue;
        const ix=Math.round(nx), iy=Math.round(ny);
        // Internal: elasticity
        const d1=(nx-prev[i].x)**2+(ny-prev[i].y)**2;
        // Internal: rigidity (second derivative)
        const d2=(prev[i].x-2*nx+next[i].x)**2+(prev[i].y-2*ny+next[i].y)**2;
        const Eint = alpha*d1 + beta*d2;
        // External: negative edge energy
        const Eext = -gamma * energy[iy*W+ix];
        const E = Eint+Eext;
        if (E<bestE) { bestE=E; bestX=nx; bestY=ny; }
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