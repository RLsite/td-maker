// ══════════════════════════ ZERO-DCE ANALYTICAL ══════════════════════════
// Zero-Reference Deep Curve Estimation — analytical alpha estimation (no neural net)
// Formula: LE_n(x) = LE_{n-1}(x) + α(x)·LE_{n-1}(x)·(1 − LE_{n-1}(x))   [CVPR 2020]
// α is estimated analytically per-pixel from local brightness vs. target exposure (0.6)

function _zdceBoxBlur(src, W, H, r) {
  const tmp = new Float32Array(W * H);
  const out = new Float32Array(W * H);
  // Horizontal pass
  for (let y = 0; y < H; y++) {
    let sum = 0, cnt = 0;
    for (let x = 0; x <= r && x < W; x++) { sum += src[y*W+x]; cnt++; }
    for (let x = 0; x < W; x++) {
      tmp[y*W+x] = sum / cnt;
      if (x+r+1 < W) { sum += src[y*W+x+r+1]; cnt++; }
      if (x-r >= 0)  { sum -= src[y*W+x-r];   cnt--; }
    }
  }
  // Vertical pass
  for (let x = 0; x < W; x++) {
    let sum = 0, cnt = 0;
    for (let y = 0; y <= r && y < H; y++) { sum += tmp[y*W+x]; cnt++; }
    for (let y = 0; y < H; y++) {
      out[y*W+x] = sum / cnt;
      if (y+r+1 < H) { sum += tmp[(y+r+1)*W+x]; cnt++; }
      if (y-r >= 0)  { sum -= tmp[(y-r)*W+x];   cnt--; }
    }
  }
  return out;
}

// Fixed Zero-DCE: only enhances DARK pixels (local mean < 0.5).
// Never darkens bright regions — preserves white background contrast.
// Problem with original: TARGET=0.6 caused bright BG to be darkened,
// reducing contrast at the exact object/background boundary Canny needs.
function zeroDCEEnhance(gray, W, H) {
  const N   = 4;      // fewer iters = gentler (original 8 was too aggressive)
  const EPS = 0.01;
  const THRESHOLD = 0.50;   // only enhance pixels BELOW this local mean
  const ALPHA_CAP = 0.60;   // soft cap on alpha → avoids over-brightening
  const BLEND     = 0.65;   // blend enhanced with original (preserves texture)
  const blurR = Math.max(6, Math.round(Math.min(W, H) * 0.07));

  const local = _zdceBoxBlur(gray, W, H, blurR);

  const cur = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) cur[i] = gray[i] / 255;

  // Per-pixel alpha: enhance only underexposed regions, never darken
  const alpha = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const v = Math.max(0.02, local[i] / 255);
    if (v >= THRESHOLD) { alpha[i] = 0; continue; }  // bright pixel → untouched
    const raw = (THRESHOLD - v) / (N * v * (1 - v) + EPS);
    alpha[i] = Math.min(ALPHA_CAP, raw);
  }

  for (let iter = 0; iter < N; iter++) {
    for (let i = 0; i < W * H; i++) {
      const v = cur[i];
      cur[i] = Math.min(1, v + alpha[i] * v * (1 - v));
    }
  }

  // Blend with original to preserve local texture contrast
  const out = new Uint8ClampedArray(W * H);
  for (let i = 0; i < W * H; i++) {
    out[i] = Math.round((BLEND * cur[i] + (1 - BLEND) * (gray[i] / 255)) * 255);
  }
  return out;
}

// ══════════════════════════ SAT + AUTO MODE DETECTION ══════════════════
// Ported from TECHNICAL DRAWING project.
// SAT = Summed Area Table → O(1) local mean/variance queries.
// Mode detection: Checkerboard | Otsu | Canny — chosen automatically
// based on border texture analysis, exactly as in the reference project.

function _buildSAT(gray, W, H) {
  const sat1 = new Float64Array((W+1)*(H+1));
  const sat2 = new Float64Array((W+1)*(H+1));
  for (let y=0; y<H; y++) for (let x=0; x<W; x++) {
    const v=gray[y*W+x];
    const i=(y+1)*(W+1)+(x+1);
    sat1[i]=v   + sat1[i-(W+1)] + sat1[i-1] - sat1[i-(W+1)-1];
    sat2[i]=v*v + sat2[i-(W+1)] + sat2[i-1] - sat2[i-(W+1)-1];
  }
  return {sat1, sat2};
}

function _rectQ(sat, x0, y0, x1, y1, W) {
  const s=(x,y)=>sat[y*(W+1)+x];
  return s(x1,y1)-s(x0,y1)-s(x1,y0)+s(x0,y0);
}

function _localSd(sat1, sat2, x, y, r, W, H) {
  const x0=Math.max(0,x-r), y0=Math.max(0,y-r);
  const x1=Math.min(W,x+r+1), y1=Math.min(H,y+r+1);
  const n=(x1-x0)*(y1-y0)||1;
  const m1=_rectQ(sat1,x0,y0,x1,y1,W)/n;
  const m2=_rectQ(sat2,x0,y0,x1,y1,W)/n;
  return Math.sqrt(Math.max(0,m2-m1*m1));
}
function _localMean(sat1, x, y, r, W, H) {
  const x0=Math.max(0,x-r), y0=Math.max(0,y-r);
  const x1=Math.min(W,x+r+1), y1=Math.min(H,y+r+1);
  const n=(x1-x0)*(y1-y0)||1;
  return _rectQ(sat1,x0,y0,x1,y1,W)/n;
}

// Otsu threshold — maximizes between-class variance (Otsu 1979)
function _computeOtsu(gray, W, H) {
  const hist=new Float32Array(256);
  for (let i=0;i<W*H;i++) hist[gray[i]]++;
  const total=W*H;
  let sum=0; for(let i=0;i<256;i++) sum+=i*hist[i];
  let sumB=0, wB=0, best=127, bestVar=0;
  for (let t=0;t<256;t++) {
    wB+=hist[t]/total; if(wB<=0||wB>=1) continue;
    sumB+=t*hist[t]/total;
    const mB=sumB/wB, mF=(sum/total-sumB)/(1-wB);
    const v=wB*(1-wB)*(mB-mF)**2;
    if(v>bestVar){bestVar=v;best=t;}
  }
  return best;
}

// Analyze border region → decide: 'checkerboard' | 'otsu' | 'canny'
function _autoDetectMode(gray, W, H, sat1, sat2) {
  const texR   = Math.max(2, Math.round(Math.min(W,H)*0.025));
  const borderW = Math.round(Math.min(W,H)*0.06);
  let bgSum=0, sdSum=0, bN=0;
  const addBorder = (x,y) => {
    bgSum+=gray[y*W+x];
    sdSum+=_localSd(sat1,sat2,x,y,texR,W,H);
    bN++;
  };
  for (let x=0;x<W;x++) for(let y=0;y<borderW;y++) { addBorder(x,y); addBorder(x,H-1-y); }
  for (let y=borderW;y<H-borderW;y++) for(let x=0;x<borderW;x++) { addBorder(x,y); addBorder(W-1-x,y); }
  const bgMean  = bgSum/bN;
  const borderSdMean = sdSum/bN;

  // Checkerboard: high local stddev at border → calibration sheet pattern
  if (borderSdMean > 8) return {mode:'checkerboard', texR, borderSdMean, bgMean};

  // Otsu: good contrast between object and background
  const otsu = _computeOtsu(gray, W, H);
  let lo=255,hi=0; for(let i=0;i<W*H;i++){if(gray[i]<lo)lo=gray[i];if(gray[i]>hi)hi=gray[i];}
  if (hi-lo > 40) {
    // Determine object color from border: if border is mostly bright → object is dark
    const isLight = bgMean < otsu; // dark background → bright object
    return {mode:'otsu', otsu, isLight};
  }

  return {mode:'canny'};
}

// Flood fill through WHITE (object) pixels from the image border, then remove them.
// Removes ruler marks and calibration grid edges that are connected to the border,
// while keeping the object in the centre (elephant etc.) which is not border-connected.
function _removeBorderConnected(obj, W, H) {
  const vis = new Uint8ClampedArray(W*H);
  const stack = [];
  const push = (x, y) => {
    const i = y*W+x;
    if (obj[i]===255 && !vis[i]) { vis[i]=1; stack.push(i); }
  };
  for (let x=0;x<W;x++) { push(x,0); push(x,H-1); }
  for (let y=1;y<H-1;y++) { push(0,y); push(W-1,y); }
  while (stack.length) {
    const i=stack.pop(), x=i%W, y=(i/W)|0;
    if(x>0)   push(x-1,y); if(x<W-1) push(x+1,y);
    if(y>0)   push(x,y-1); if(y<H-1) push(x,y+1);
  }
  const out = new Uint8ClampedArray(W*H);
  for (let i=0;i<W*H;i++) if (obj[i]===255 && !vis[i]) out[i]=255;
  return out;
}

// Like _removeBorderConnected but reverts if the result loses >60% of mask pixels.
// Prevents accidentally removing the main object when it touches the image border
// (e.g. side view of a large animal filling the frame).
// TUNING: if ruler still appears in side-view contours, lower to 0.20.
//         if elephant is unexpectedly removed on tight crops, raise to 0.50.
const _SAFE_BORDER_SURVIVAL = 0.40;
function _safeRemoveBorderConnected(obj, W, H) {
  let bc = 0; for (let i = 0; i < obj.length; i++) if (obj[i]) bc++;
  if (!bc) return obj;
  const trimmed = _removeBorderConnected(obj, W, H);
  let ac = 0; for (let i = 0; i < trimmed.length; i++) if (trimmed[i]) ac++;
  const survivalRate = ac / bc;
  console.debug(`[borderRM] survival=${(survivalRate*100).toFixed(1)}% threshold=${(_SAFE_BORDER_SURVIVAL*100).toFixed(0)}% → ${survivalRate >= _SAFE_BORDER_SURVIVAL ? 'removed' : 'REVERTED'}`);
  return survivalRate >= _SAFE_BORDER_SURVIVAL ? trimmed : obj;
}

// ── CLAHE — Contrast Limited Adaptive Histogram Equalization ──────────
// Ramamurthy & Vivekananda 2003; standard preprocessing for edge detection
// Divides image into tiles, equalizes histogram in each, bilinear-interpolates
// Much better than Zero-DCE for technical drawing: enhances LOCAL contrast
// without changing global exposure, preserves object/background boundary.
function claheEnhance(gray, W, H, tileW=64, tileH=64, clipLimit=3.5) {
  const nTX=Math.ceil(W/tileW), nTY=Math.ceil(H/tileH);
  const LUTs=[];

  for (let ty=0;ty<nTY;ty++) for (let tx=0;tx<nTX;tx++) {
    const x0=tx*tileW, y0=ty*tileH;
    const x1=Math.min(x0+tileW,W), y1=Math.min(y0+tileH,H);
    const hist=new Float32Array(256);
    let n=0;
    for (let y=y0;y<y1;y++) for (let x=x0;x<x1;x++) { hist[gray[y*W+x]]++; n++; }
    // Clip excess → redistribute evenly (limits noise amplification)
    const clip=clipLimit*n/256;
    let excess=0;
    for (let i=0;i<256;i++) { if (hist[i]>clip){excess+=hist[i]-clip;hist[i]=clip;} }
    const add=excess/256;
    for (let i=0;i<256;i++) hist[i]+=add;
    // CDF → lookup table
    const lut=new Uint8ClampedArray(256);
    let sum=0;
    for (let i=0;i<256;i++) { sum+=hist[i]; lut[i]=Math.round(sum/n*255); }
    LUTs.push(lut);
  }

  // Bilinear interpolation between four surrounding tile LUTs
  const out=new Uint8ClampedArray(W*H);
  for (let y=0;y<H;y++) for (let x=0;x<W;x++) {
    const v=gray[y*W+x];
    const txF=x/tileW-0.5, tyF=y/tileH-0.5;
    const tx0=Math.max(0,Math.floor(txF)), tx1=Math.min(nTX-1,tx0+1);
    const ty0=Math.max(0,Math.floor(tyF)), ty1=Math.min(nTY-1,ty0+1);
    const fx=txF-Math.floor(txF), fy=tyF-Math.floor(tyF);
    const v00=LUTs[ty0*nTX+tx0][v], v10=LUTs[ty0*nTX+tx1][v];
    const v01=LUTs[ty1*nTX+tx0][v], v11=LUTs[ty1*nTX+tx1][v];
    out[y*W+x]=Math.round(v00*(1-fx)*(1-fy)+v10*fx*(1-fy)+v01*(1-fx)*fy+v11*fx*fy);
  }
  return out;
}

// ── CV helpers: morphology & blob ────────────────────────────
function dilateEdges(edges, W, H, r) {
  const out = new Uint8ClampedArray(W*H);
  for (let y=0; y<H; y++) for (let x=0; x<W; x++) {
    if (!edges[y*W+x]) continue;
    for (let dy=-r; dy<=r; dy++) for (let dx=-r; dx<=r; dx++) {
      const ny=y+dy, nx=x+dx;
      if (nx>=0&&nx<W&&ny>=0&&ny<H) out[ny*W+nx]=255;
    }
  }
  return out;
}
function erodeMask(mask, W, H, r) {
  const out = new Uint8ClampedArray(W*H);
  for (let y=r; y<H-r; y++) for (let x=r; x<W-r; x++) {
    if (!mask[y*W+x]) continue;
    let ok = true;
    outer: for (let dy=-r; dy<=r; dy++) for (let dx=-r; dx<=r; dx++) {
      if (!mask[(y+dy)*W+(x+dx)]) { ok=false; break outer; }
    }
    if (ok) out[y*W+x]=255;
  }
  return out;
}
function morphClose(mask, W, H, r) { return erodeMask(dilateEdges(mask,W,H,r), W,H,r); }
function unsharpMask(gray, W, H, k=1.2) {
  // Inline from sharpen.js — Gaussian blur + subtract
  const sigma = 2.0, rad = Math.ceil(3*sigma);
  const ker = new Float32Array(2*rad+1);
  let ks = 0;
  for (let x=-rad; x<=rad; x++) { ker[x+rad]=Math.exp(-(x*x)/(2*sigma*sigma)); ks+=ker[x+rad]; }
  for (let i=0; i<ker.length; i++) ker[i]/=ks;
  const tmp = new Float32Array(W*H), blr = new Float32Array(W*H);
  for (let y=0; y<H; y++) for (let x=0; x<W; x++) {
    let s=0,w=0; for (let dx=-rad; dx<=rad; dx++) { const nx=x+dx; if(nx>=0&&nx<W){s+=gray[y*W+nx]*ker[dx+rad];w+=ker[dx+rad];} } tmp[y*W+x]=s/w;
  }
  for (let x=0; x<W; x++) for (let y=0; y<H; y++) {
    let s=0,w=0; for (let dy=-rad; dy<=rad; dy++) { const ny=y+dy; if(ny>=0&&ny<H){s+=tmp[ny*W+x]*ker[dy+rad];w+=ker[dy+rad];} } blr[y*W+x]=s/w;
  }
  const out = new Uint8ClampedArray(W*H);
  for (let i=0; i<W*H; i++) out[i]=Math.max(0,Math.min(255,Math.round(gray[i]+k*(gray[i]-blr[i]))));
  return out;
}
function floodFillBackground(edges, W, H) {
  const bg = new Uint8ClampedArray(W*H);
  const q = [];
  for (let x=0; x<W; x++) {
    if (!edges[x])         { bg[x]=1; q.push(x); }
    if (!edges[(H-1)*W+x]) { bg[(H-1)*W+x]=1; q.push((H-1)*W+x); }
  }
  for (let y=1; y<H-1; y++) {
    if (!edges[y*W])     { bg[y*W]=1; q.push(y*W); }
    if (!edges[y*W+W-1]) { bg[y*W+W-1]=1; q.push(y*W+W-1); }
  }
  let qi=0;
  while (qi<q.length) {
    const idx=q[qi++], y=Math.floor(idx/W), x=idx%W;
    const ns=[];
    if (x>0) ns.push(idx-1); if (x<W-1) ns.push(idx+1);
    if (y>0) ns.push(idx-W); if (y<H-1) ns.push(idx+W);
    for (const n of ns) if (!bg[n]&&!edges[n]) { bg[n]=1; q.push(n); }
  }
  return bg;
}
function findLargestBlob(mask, W, H) {
  const vis = new Uint8ClampedArray(W*H);
  let best=null, bestScore=-1;
  for (let i=0; i<W*H; i++) {
    if (!mask[i]||vis[i]) continue;
    const px=[], q=[i]; vis[i]=1; let qi=0;
    let minX=W,maxX=0,minY=H,maxY=0,sumX=0,sumY=0,onBorder=false;
    while (qi<q.length) {
      const idx=q[qi++]; px.push(idx);
      const y=Math.floor(idx/W), x=idx%W;
      sumX+=x; sumY+=y;
      if (x<minX) minX=x; if (x>maxX) maxX=x;
      if (y<minY) minY=y; if (y>maxY) maxY=y;
      if (x===0||x===W-1||y===0||y===H-1) onBorder=true;
      if (x>0   &&mask[idx-1]&&!vis[idx-1]) { vis[idx-1]=1; q.push(idx-1); }
      if (x<W-1 &&mask[idx+1]&&!vis[idx+1]) { vis[idx+1]=1; q.push(idx+1); }
      if (y>0   &&mask[idx-W]&&!vis[idx-W]) { vis[idx-W]=1; q.push(idx-W); }
      if (y<H-1 &&mask[idx+W]&&!vis[idx+W]) { vis[idx+W]=1; q.push(idx+W); }
    }
    if (px.length < 20) continue;
    const sz=px.length;
    const bw=maxX-minX+1, bh=maxY-minY+1;
    const cx=sumX/sz, cy=sumY/sz;
    // Compactness: how well the blob fills its bounding box (1 = solid rectangle)
    const compact = sz/(bw*bh);
    // Aspect: penalise very elongated shapes like a ruler (thin & long → low score)
    const aspect = Math.min(bw,bh)/Math.max(bw,bh);
    // Centrality: prefer blobs whose centroid is near image centre
    const dcx=Math.abs(cx-W/2)/(W/2), dcy=Math.abs(cy-H/2)/(H/2);
    const central = 1 - Math.min(1, Math.sqrt(dcx*dcx+dcy*dcy)/Math.SQRT2);
    // Border penalty: rulers are small & border-touching; the main object can also touch
    // the border (e.g. legs at the bottom of a side-view crop). Scale the penalty by blob
    // size relative to the image: large blobs are almost certainly the main object.
    const largeFrac = sz / (W * H);
    const borderMul = onBorder ? (largeFrac > 0.10 ? 0.80 : 0.20) : 1.0;
    const score = sz * compact * (0.5+0.5*aspect) * (0.7+0.3*central) * borderMul;
    if (score>bestScore) { bestScore=score; best=px; }
  }
  return best;
}
// Returns connected components in `mask` that are NOT in `mainBlobPx`,
// each converted to a simplified polygon in canvas-space coords.
function _findSecondaryBlobs(mask, W, H, mainBlobPx, scaleX, scaleY) {
  const vis = new Uint8ClampedArray(W * H);
  if (mainBlobPx) mainBlobPx.forEach(i => { vis[i] = 1; });
  const minArea = Math.max(50, (mainBlobPx?.length ?? 200) * 0.03);
  const rawFrags = [];
  for (let i = 0; i < W * H; i++) {
    if (!mask[i] || vis[i]) continue;
    const px = [], q = [i]; vis[i] = 1; let qi = 0;
    while (qi < q.length) {
      const idx = q[qi++]; px.push(idx);
      const x = idx % W, y = (idx / W) | 0;
      if (x > 0   && mask[idx-1] && !vis[idx-1]) { vis[idx-1]=1; q.push(idx-1); }
      if (x < W-1 && mask[idx+1] && !vis[idx+1]) { vis[idx+1]=1; q.push(idx+1); }
      if (y > 0   && mask[idx-W] && !vis[idx-W]) { vis[idx-W]=1; q.push(idx-W); }
      if (y < H-1 && mask[idx+W] && !vis[idx+W]) { vis[idx+W]=1; q.push(idx+W); }
    }
    if (px.length < minArea) continue;
    rawFrags.push(px);
  }
  rawFrags.sort((a, b) => b.length - a.length);
  const result = [];
  for (const blobPx of rawFrags.slice(0, 3)) {
    const bMask = new Uint8ClampedArray(W * H);
    blobPx.forEach(i => { bMask[i] = 255; });
    const outer = _suzukiAbe(bMask, W, H)
      .filter(c => !c.isHole && c.pts.length >= 4)
      .sort((a, b) => _polyArea2D(b.pts) - _polyArea2D(a.pts))[0];
    if (!outer) continue;
    const step = Math.max(1, Math.floor(outer.pts.length / 200));
    const simp = douglasPeucker(outer.pts.filter((_, j) => j % step === 0), 1.0);
    if (simp.length < 4) continue;
    result.push({ pts: simp.map(p => ({ x: p.x * scaleX, y: p.y * scaleY })), closed: true });
  }
  return result;
}
// ── Suzuki-Abe Border Following (CVGIP 30:32-46, 1985) ──────────────────────
// Single scan finds outer contours + hole contours with topology.
// Input:  mask Uint8Array/Uint8ClampedArray W×H (nonzero = object)
// Output: Array of { pts:[{x,y},...], isHole:bool }
function _suzukiAbe(mask, W, H) {
  const W2 = W + 2, H2 = H + 2;
  const F = new Int32Array(W2 * H2);
  for (let r = 0; r < H; r++)
    for (let c = 0; c < W; c++)
      F[(r+1)*W2+(c+1)] = mask[r*W+c] ? 1 : 0;

  // 8-neighbor CCW order (image-Y-down): E NE N NW W SW S SE
  const DR = [0,-1,-1,-1, 0, 1, 1, 1];
  const DC = [1, 1, 0,-1,-1,-1, 0, 1];
  const dirOf = (dr, dc) => { for (let k=0;k<8;k++) if(DR[k]===dr&&DC[k]===dc) return k; return 0; };

  const contours = [];
  let NBD = 1;

  const borderFollow = (r0, c0, rfrom, cfrom) => {
    NBD++;
    const nbd = NBD;
    const startK = dirOf(rfrom - r0, cfrom - c0);
    let p1r = -1;
    for (let i = 0; i < 8; i++) {
      const k = (startK + i) % 8;
      const nr = r0 + DR[k], nc = c0 + DC[k];
      if (F[nr*W2+nc] !== 0) { p1r = nr; break; }
    }
    if (p1r < 0) { F[r0*W2+c0] = -nbd; return [{ x:c0-1, y:r0-1 }]; }

    const pts = [];
    let i2r = rfrom, i2c = cfrom;
    let i3r = r0,    i3c = c0;
    while (true) {
      const bk = dirOf(i2r - i3r, i2c - i3c);
      let i4r = -1, i4c = -1, i4step = -1;
      // Start from i=1 (skip the back direction itself) to avoid immediately
      // returning to the previous pixel, which caused 2-point early termination.
      for (let i = 1; i <= 8; i++) {
        const k = (bk + i) % 8;
        const nr = i3r + DR[k], nc = i3c + DC[k];
        if (F[nr*W2+nc] !== 0) { i4r = nr; i4c = nc; i4step = i; break; }
      }
      // Guard: no non-background neighbor found (thin junction)
      if (i4r < 0) {
        if (F[i3r*W2+i3c] === 1) F[i3r*W2+i3c] = -nbd;
        pts.push({ x: i3c - 1, y: i3r - 1 });
        break;
      }
      if (F[i3r*W2+i3c] === 1)
        F[i3r*W2+i3c] = (i4step > 1) ? -nbd : nbd;
      pts.push({ x: i3c - 1, y: i3r - 1 });
      // Terminate when we return to the starting pixel after at least one step
      if (i3r === r0 && i3c === c0 && pts.length > 1) break;
      if (pts.length > W * H) break;
      i2r = i3r; i2c = i3c;
      i3r = i4r; i3c = i4c;
    }
    return pts;
  };

  for (let r = 1; r < H2-1; r++) {
    for (let c = 1; c < W2-1; c++) {
      const v = F[r*W2+c];
      if (v === 1 && F[r*W2+(c-1)] === 0) {
        contours.push({ pts: borderFollow(r, c, r, c-1), isHole: false });
      } else if (v >= 1 && F[r*W2+(c+1)] === 0) {
        contours.push({ pts: borderFollow(r, c, r, c+1), isHole: true });
      }
    }
  }
  return contours;
}

// Shoelace polygon area — returns ~0 for collinear/spurious hole contours
function _polyArea2D(pts) {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const j = (i+1) % n;
    a += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
  }
  return Math.abs(a) * 0.5;
}

function mooreBoundaryTraceMask(mask, W, H) {
  let sx=-1, sy=-1;
  outer: for (let y=0; y<H; y++) for (let x=0; x<W; x++) if (mask[y*W+x]) { sx=x; sy=y; break outer; }
  if (sx===-1) return [];
  const isObj=(x,y)=>x>=0&&x<W&&y>=0&&y<H&&mask[y*W+x]>0;
  const dirs=[[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1],[0,-1],[1,-1]];
  const pts=[{x:sx,y:sy}]; let cx=sx,cy=sy,pd=6;
  for (let iter=0; iter<30000; iter++) {
    let found=false;
    for (let d=0; d<8; d++) {
      const dir=(pd+5+d)%8, nx=cx+dirs[dir][0], ny=cy+dirs[dir][1];
      if (isObj(nx,ny)) {
        if (nx===sx&&ny===sy&&pts.length>3) return pts;
        pts.push({x:nx,y:ny}); pd=dir; cx=nx; cy=ny; found=true; break;
      }
    }
    if (!found) break;
  }
  return pts;
}

// ── Auto-detect contour — smart mode detection ────────────────
// Ported logic from TECHNICAL DRAWING project:
//   SAT border analysis → Checkerboard | Otsu | Canny
// dilScale (incremented by 🎯 דייק button) controls morphClose radius.
// ── Cross-view seed ───────────────────────────────────────────────────────────
// Returns { cx, cy, rx, ry, W, H } in original-image pixels for the current view,
// estimated from other views' segMeta bounding-boxes + objectModel dims.
// Returns null when no usable cross-view data exists.
function _crossViewSeed(view) {
  // Dimension that each view exposes: [horizontal_dim, vertical_dim]
  const viewAxes = {
    front: ['width',  'height'],
    side:  ['depth',  'height'],
    top:   ['width',  'depth'],
  };
  const [myA, myB] = viewAxes[view] ?? ['width', 'height'];

  const knownMm = {};   // { width, height, depth } — values in mm

  // Source 1: objectModel (most authoritative if already computed)
  const od = S.objectModel?.dims;
  if (od) {
    if (od.W)  knownMm.width  = od.W;
    if (od.H)  knownMm.height = od.H;
    if (od.D)  knownMm.depth  = od.D;
  }

  // Source 2: other views' segMeta bbox (works even before objectModel is built)
  for (const [v, [dA, dB]] of Object.entries(viewAxes)) {
    if (v === view) continue;
    const sm  = S.segMeta?.[v];
    const ppm = S.scale?.[v];
    if (!sm?.bbox || !ppm) continue;
    const { bbox, W: mW, H: mH, origW: oW, origH: oH } = sm;
    const wMm = (bbox.maxX - bbox.minX) * (oW ?? mW) / mW / ppm;
    const hMm = (bbox.maxY - bbox.minY) * (oH ?? mH) / mH / ppm;
    if (wMm > 0 && !knownMm[dA]) knownMm[dA] = wMm;
    if (hMm > 0 && !knownMm[dB]) knownMm[dB] = hMm;
  }

  const wMm = knownMm[myA];
  const hMm = knownMm[myB];
  if (!wMm && !hMm) return null;   // genuinely no data — fall through to PATH B

  // Get this view's image dimensions from segMeta or fall back to upload constraints
  const mySm = S.segMeta?.[view];
  const imgW = mySm?.origW ?? mySm?.W ?? 900;
  const imgH = mySm?.origH ?? mySm?.H ?? 700;

  // Convert mm → px using current view's PPM; fall back to 40% of image dimension
  const ppm = S.scale?.[view];
  const rx = ppm && wMm ? Math.min((wMm * ppm) / 2, imgW * 0.45) : imgW * 0.35;
  const ry = ppm && hMm ? Math.min((hMm * ppm) / 2, imgH * 0.45) : imgH * 0.35;

  return { cx: imgW / 2, cy: imgH / 2, rx, ry, W: imgW, H: imgH };
}

function autoDetectContour() {
  const view = S.contourView;
  const url = S.imgs[view];
  if (!url) return alert('Please upload an image first');
  _pushUndo();
  showProcessing('Detecting contour…');

  // ── PATH A: saved segmentation mask from Step 2 (always preferred when available) ──
  // Prefer the Computed (ISO-improved + sealed/filled) mask; fall back to raw.
  // When a mask exists it is always used — raw image processing is a last resort only.
  const improvedSeg = S.segMaskImproved?.[view];
  const rawSeg      = S.segMasks?.[view];
  const savedSeg    = improvedSeg ?? rawSeg;
  if (savedSeg) {
    _contourFromSegMask(savedSeg.mask, savedSeg.W, savedSeg.H);
    return;
  }

  // ── PATH A.5: cross-view seed — no mask for this view, but other views have data ──
  // Query other views' segMeta + scale to estimate object size in this view.
  // Rasterises an ellipse of that size and feeds it through _finishContourFromMask
  // (Suzuki-Abe → smooth → snap) so real image edges pull the ellipse into shape.
  const seed = _crossViewSeed(view);
  if (seed) {
    const img = new Image();
    img.onerror = () => hideProcessing();
    img.onload = () => {
      if (view !== S.contourView) { hideProcessing(); return; }
      const maxW = 900, maxH = 700;
      const r  = Math.min(maxW / img.width, maxH / img.height, 1);
      const sW = Math.round(img.width  * r);
      const sH = Math.round(img.height * r);
      const tmpC = document.createElement('canvas');
      tmpC.width = sW; tmpC.height = sH;
      const tmpCtx = tmpC.getContext('2d');
      tmpCtx.drawImage(img, 0, 0, sW, sH);
      const px   = tmpCtx.getImageData(0, 0, sW, sH).data;
      const gray = new Uint8ClampedArray(sW * sH);
      for (let i = 0; i < sW * sH; i++)
        gray[i] = px[i*4]*0.299 + px[i*4+1]*0.587 + px[i*4+2]*0.114;

      // Rasterise seed ellipse at working scale
      const obj = new Uint8ClampedArray(sW * sH);
      const cx = seed.cx * sW / seed.W;
      const cy = seed.cy * sH / seed.H;
      const rx = seed.rx * sW / seed.W;
      const ry = seed.ry * sH / seed.H;
      for (let y = 0; y < sH; y++) {
        for (let x = 0; x < sW; x++) {
          const dx = (x - cx) / rx, dy = (y - cy) / ry;
          if (dx*dx + dy*dy <= 1) obj[y * sW + x] = 255;
        }
      }

      try {
        _finishContourFromMask(obj, sW, sH, r, gray, 12);
      } catch(e) {
        hideProcessing();
        console.error('[contour] PATH A.5 failed:', e);
        alert('Contour detection failed — please try again');
      }
    };
    img.src = url;
    return;
  }

  // ── PATH B: smart Checkerboard / Otsu / Canny (no silhouette mask available) ──
  const sensEl = document.getElementById('canny-sens');
  const sens = sensEl ? parseInt(sensEl.value) : 5;
  const highT = Math.round(110 - (sens-1)*10);
  const lowT  = Math.round(highT/3);
  const dilR  = Math.max(2, Math.round(3 * (S.dilScale?.[view]||1)));

  const tmpC = document.createElement('canvas');
  const tmpCtx = tmpC.getContext('2d');
  const img = new Image();
  img.onerror = () => hideProcessing();
  img.onload = () => {
    if (view !== S.contourView) { hideProcessing(); return; }
    const maxW=900, maxH=700;
    const r=Math.min(maxW/img.width, maxH/img.height, 1);
    tmpC.width=Math.round(img.width*r); tmpC.height=Math.round(img.height*r);
    tmpCtx.drawImage(img, 0, 0, tmpC.width, tmpC.height);
    const W=tmpC.width, H=tmpC.height;
    const src=tmpCtx.getImageData(0,0,W,H).data;

    let gray=new Uint8ClampedArray(W*H);
    for (let i=0;i<W*H;i++) gray[i]=src[i*4]*.299+src[i*4+1]*.587+src[i*4+2]*.114;

    const enhMode=document.getElementById('enhance-mode')?.value??'clahe';
    if (enhMode==='clahe') gray=claheEnhance(gray,W,H);
    else if (enhMode==='zdce') gray=zeroDCEEnhance(gray,W,H);

    // ── Mode detection (SAT border analysis) ──────────
    const {sat1,sat2}=_buildSAT(gray,W,H);
    const modeInfo=_autoDetectMode(gray,W,H,sat1,sat2);
    if (!S.lastMode) S.lastMode={};
    S.lastMode[view]=modeInfo.mode;

    let obj;
    if (modeInfo.mode==='checkerboard') {
      // Checkerboard: pixels with LOW local stddev → these are uniform → object sits on grid
      const sdThresh = modeInfo.borderSdMean * (0.35 + sens/10*0.45);
      obj=new Uint8ClampedArray(W*H);
      for (let y=0;y<H;y++) for (let x=0;x<W;x++) {
        const sd=_localSd(sat1,sat2,x,y,modeInfo.texR,W,H);
        if (sd<sdThresh) obj[y*W+x]=255;
      }
      obj=morphClose(obj,W,H,dilR);
      obj=_safeRemoveBorderConnected(obj,W,H);

    } else if (modeInfo.mode==='otsu') {
      // Otsu: threshold → remove border-connected background
      const t=modeInfo.otsu;
      obj=new Uint8ClampedArray(W*H);
      for (let i=0;i<W*H;i++) obj[i]=(modeInfo.isLight ? gray[i]>=t : gray[i]<=t) ? 255 : 0;
      obj=morphClose(obj,W,H,dilR);
      obj=_safeRemoveBorderConnected(obj,W,H);

    } else {
      // Canny: full edge → flood fill pipeline
      const sharpened=unsharpMask(gray,W,H,1.2);
      const denoised=bilateralFilter(sharpened,W,H,2,1.5,30);
      const edges=cannyEdges(denoised,W,H,lowT,highT);
      const dilated=dilateEdges(edges,W,H,2);
      const closed=dilateEdges(dilated,W,H,1);
      const bg=floodFillBackground(closed,W,H);
      obj=new Uint8ClampedArray(W*H);
      for (let i=0;i<W*H;i++) if (!bg[i]&&!closed[i]) obj[i]=255;
      obj=morphClose(obj,W,H,dilR);
      obj=_safeRemoveBorderConnected(obj,W,H);
    }

    // Pass gray to _finishContourFromMask for edge snapping
    try {
      _finishContourFromMask(obj,W,H,r,gray);
    } catch(e) {
      hideProcessing();
      console.error('[contour] PATH B failed:', e);
      alert('Contour detection failed — please try again');
    }
  };
  img.src=url;
}

// Increment dilScale for this view and re-run (bypasses saved seg mask)
function refineContour() {
  const view=S.contourView;
  if (!S.dilScale) S.dilScale={};
  S.dilScale[view]=Math.min(3,(S.dilScale[view]||1)+0.6);  // cap at 3 → dilR max=9
  autoDetectContour();
  const btn=document.getElementById('refine-btn');
  const lvl=Math.round((S.dilScale[view]-1)/0.6);
  if (btn) btn.textContent=`🎯 Refine ${lvl>0?'×'+lvl:''}`;
}

// Move each polygon vertex to the strongest gradient along its outward normal.
// searchR: pixels to search each side. Aligns the contour to the actual physical edge.
function _snapToEdges(pts, gray, W, H, searchR) {
  // Precompute Sobel components for bilinear sub-pixel sampling.
  // Divide by 4 to keep values in [-255,255] (same scale as simple central difference)
  // so NORM=130000 stays valid for the depth-blend path.
  const gxF = new Float32Array(W * H);
  const gyF = new Float32Array(W * H);
  for (let y = 1; y < H-1; y++) for (let x = 1; x < W-1; x++) {
    gxF[y*W+x] = (-gray[(y-1)*W+x-1] + gray[(y-1)*W+x+1]
                  -2*gray[y*W+x-1]    + 2*gray[y*W+x+1]
                  -gray[(y+1)*W+x-1]  + gray[(y+1)*W+x+1]) / 4;
    gyF[y*W+x] = (-gray[(y-1)*W+x-1] - 2*gray[(y-1)*W+x] - gray[(y-1)*W+x+1]
                  +gray[(y+1)*W+x-1]  + 2*gray[(y+1)*W+x] + gray[(y+1)*W+x+1]) / 4;
  }
  const bilSample = (arr, fx, fy) => {
    const x0 = fx|0, y0 = fy|0;
    const dx = fx-x0, dy = fy-y0;
    return arr[y0*W+x0]*(1-dx)*(1-dy) + arr[y0*W+x0+1]*dx*(1-dy) +
           arr[(y0+1)*W+x0]*(1-dx)*dy + arr[(y0+1)*W+x0+1]*dx*dy;
  };

  const dGrad = (typeof depthGradient === 'function')
    ? depthGradient(S.contourView, W, H)
    : null;

  return pts.map((p, i) => {
    const prev = pts[(i-1+pts.length)%pts.length];
    const next = pts[(i+1)%pts.length];
    const tx=next.x-prev.x, ty=next.y-prev.y;
    const len=Math.sqrt(tx*tx+ty*ty)||1;
    const nx=-ty/len, ny=tx/len;

    let bestG=-1, bestX=p.x, bestY=p.y;
    for (let d=-searchR; d<=searchR; d+=0.5) {  // 0.5px sub-pixel steps
      const fx=p.x+nx*d, fy=p.y+ny*d;
      if (fx<1||fx>=W-2||fy<1||fy>=H-2) continue;
      const gx = bilSample(gxF, fx, fy);
      const gy = bilSample(gyF, fx, fy);
      let g = gx*gx + gy*gy;
      if (dGrad) {
        const ix=Math.round(fx), iy=Math.round(fy);
        const dg = dGrad[Math.min(iy,H-1)*W+Math.min(ix,W-1)];
        const NORM = 130000;
        const cNorm = g / NORM;
        const dNorm = (dg * dg) / NORM;
        const colorW = Math.min(1, cNorm * 5);
        const depthW = 0.10 + (1 - colorW) * 0.80;
        g = NORM * ((1 - depthW) * cNorm + depthW * dNorm);
      }
      if (g>bestG) { bestG=g; bestX=fx; bestY=fy; }
    }
    return {x:bestX, y:bestY};
  });
}

// Removes connected components whose pixel count is below minRatio * (largest blob size).
// Eliminates ruler tick marks and speckles before morphClose can bridge them to the object.
function _removeSmallBlobs(mask, W, H, minRatio = 0.05) {
  const vis = new Uint8ClampedArray(W * H);
  const blobs = [];
  for (let i = 0; i < W * H; i++) {
    if (!mask[i] || vis[i]) continue;
    const px = [], q = [i]; vis[i] = 1; let qi = 0;
    while (qi < q.length) {
      const idx = q[qi++]; px.push(idx);
      const x = idx % W, y = (idx / W) | 0;
      if (x > 0   && mask[idx-1] && !vis[idx-1]) { vis[idx-1]=1; q.push(idx-1); }
      if (x < W-1 && mask[idx+1] && !vis[idx+1]) { vis[idx+1]=1; q.push(idx+1); }
      if (y > 0   && mask[idx-W] && !vis[idx-W]) { vis[idx-W]=1; q.push(idx-W); }
      if (y < H-1 && mask[idx+W] && !vis[idx+W]) { vis[idx+W]=1; q.push(idx+W); }
    }
    blobs.push(px);
  }
  if (!blobs.length) return mask;
  const maxSize = Math.max(...blobs.map(b => b.length));
  const minSize = maxSize * minRatio;
  const out = new Uint8ClampedArray(W * H);
  for (const b of blobs) if (b.length >= minSize) b.forEach(i => out[i] = 255);
  return out;
}

// Derive contour polygon from a saved segmentation mask.
// Uses the original image for gradient-based edge snapping after D-P.
function _contourFromSegMask(mask, mW, mH) {
  const view = S.contourView;
  const url  = S.imgs[view];
  const maxW=900, maxH=700;
  const r  = Math.min(maxW/mW, maxH/mH, 1);
  const sW = Math.round(mW*r), sH = Math.round(mH*r);

  // Scale binary mask to working size (nearest-neighbour)
  let obj;
  if (r === 1) {
    obj = mask.slice();
  } else {
    obj = new Uint8ClampedArray(sW*sH);
    for (let y=0;y<sH;y++) for (let x=0;x<sW;x++) {
      const sx=Math.round(x/r), sy=Math.round(y/r);
      obj[y*sW+x] = (sx<mW&&sy<mH&&mask[sy*mW+sx]>128) ? 255 : 0;
    }
  }
  // Drop isolated noise blobs (ruler ticks, speckles) before morphClose can merge them
  // into the object. Keeps any blob >= 5% of the largest blob's area.
  obj = _removeSmallBlobs(obj, sW, sH, 0.05);

  // Disk close (r=4): fills texture gaps up to 8px wide. Seg mask is already clean so we
  // use r=4 (not 8) to avoid bridging nearby rulers into the object silhouette.
  obj = morphCloseDisk(obj, sW, sH, 4);

  // Remove blobs connected to the image border (ruler runs along the frame edge).
  // Safe version: reverts if the main object itself was border-connected (common in side
  // views where the animal fills the frame). The seg mask already isolated the object.
  obj = _safeRemoveBorderConnected(obj, sW, sH);

  // Second small-blob pass: morphClose can create new small islands; remove anything
  // that fell below 5% of the dominant blob after border removal.
  obj = _removeSmallBlobs(obj, sW, sH, 0.05);

  // Load original image at same working size for bg-sample filtering + edge snapping
  const img = new Image();
  img.onerror = () => hideProcessing();
  img.onload = () => {
    // Stale check: user switched views while the image was loading — discard result.
    // _finishContourFromMask reads S.contourView internally, so running it now would
    // write to the wrong view's polygon.
    if (view !== S.contourView) { hideProcessing(); return; }

    const tmpC=document.createElement('canvas'); tmpC.width=sW; tmpC.height=sH;
    const tmpCtx=tmpC.getContext('2d'); tmpCtx.drawImage(img,0,0,sW,sH);
    const px=tmpCtx.getImageData(0,0,sW,sH).data;
    const gray=new Uint8ClampedArray(sW*sH);
    for (let i=0;i<sW*sH;i++) gray[i]=px[i*4]*.299+px[i*4+1]*.587+px[i*4+2]*.114;

    // Apply background samples: within each circle, raw luma within bgTol → background.
    const samples = S.bgSamples?.[view];
    if (samples?.length) {
      for (const s of samples) {
        const r2=s.corrR*s.corrR;
        for (let dy=-s.corrR; dy<=s.corrR; dy++) for (let dx=-s.corrR; dx<=s.corrR; dx++) {
          if (dx*dx+dy*dy>r2) continue;
          const nx=s.px+dx, ny=s.py+dy;
          if (nx<0||nx>=sW||ny<0||ny>=sH) continue;
          if (Math.abs(gray[ny*sW+nx]-s.bgMean)<=s.bgTol) obj[ny*sW+nx]=0;
        }
      }
    }

    // searchR=5: enough to pull the smoothed contour onto the real image edge
    // without drifting onto the ruler (ruler is already removed from the mask).
    try {
      _finishContourFromMask(obj, sW, sH, r, gray, 5);
    } catch(e) {
      hideProcessing();
      console.error('[contour] _contourFromSegMask failed:', e);
      alert('Contour detection failed — please try again');
    }
  };
  img.src = url;
}

// ── Remove collinear points ───────────────────────────────────────────────────
// If point B lies within `tol` pixels of the line A→C, it is redundant.
// Runs iteratively until no more removals are possible.
function _removeCollinear(pts, tol) {
  tol = tol ?? 1.5;
  let result = pts.slice();
  let changed = true;
  while (changed && result.length >= 4) {
    changed = false;
    const n = result.length;
    const out = [];
    for (let i = 0; i < n; i++) {
      const a = result[(i - 1 + n) % n];
      const b = result[i];
      const c = result[(i + 1) % n];
      const dx = c.x - a.x, dy = c.y - a.y;
      const len = Math.sqrt(dx*dx + dy*dy);
      if (len < 0.1) { out.push(b); continue; }
      const dist = Math.abs(dy * b.x - dx * b.y + c.x * a.y - c.y * a.x) / len;
      if (dist < tol) { changed = true; continue; } // collinear — drop b
      out.push(b);
    }
    result = out;
  }
  return result;
}

// ── Adaptive quality-driven contour smoother ─────────────────────────────────
// Uses per-quadrant segmentation reliability scores (from _computeSegScore) to:
//   Pass 1 — Spike removal: removes NOISE spikes (both legs short) in low-quality regions.
//             NEVER removes real corners — a real corner always has ≥1 long leg.
//   Pass 2 — Gaussian smoothing: low-quality regions get stronger blur.
//             Corners (angle < cornerDeg) are pinned and NOT moved by smoothing.
// High-quality regions (score ≥ 8) are left untouched to preserve sharp detail.
function _adaptiveQualitySmooth(pts, W, H, regions) {
  if (!pts || pts.length < 4) return pts;

  const cx = W / 2, cy = H / 2;
  // Minimum leg length to be considered a "real corner" (not noise)
  const cornerLegMin = Math.max(4, Math.min(W, H) * 0.015);

  function ptQ(p) {
    const dx = p.x - cx, dy = p.y - cy;
    if (Math.abs(dy) >= Math.abs(dx))
      return dy < 0 ? (regions?.top ?? 5) : (regions?.bottom ?? 5);
    return dx > 0 ? (regions?.right ?? 5) : (regions?.left ?? 5);
  }

  // ── Pass 1: noise spike removal ──────────────────────────────────────────
  // Rule: remove point P if angle at P is tight AND both legs are short (noise).
  // A real corner (both legs long, or one leg long) is ALWAYS preserved.
  let result = pts.slice();
  let changed = true;
  while (changed && result.length >= 4) {
    changed = false;
    const n = result.length;
    const out = [];
    for (let i = 0; i < n; i++) {
      const p  = result[i];
      const a  = result[(i - 1 + n) % n];
      const c  = result[(i + 1) % n];
      const q  = ptQ(p);
      const ax = a.x - p.x, ay = a.y - p.y;
      const bx = c.x - p.x, by = c.y - p.y;
      const la = Math.sqrt(ax*ax + ay*ay);
      const lb = Math.sqrt(bx*bx + by*by);
      if (la > 0.5 && lb > 0.5) {
        // Preserve if either leg is long — that's a real corner
        const isRealCorner = Math.max(la, lb) >= cornerLegMin;
        if (!isRealCorner) {
          const cos   = (ax*bx + ay*by) / (la * lb);
          const angle = Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI;
          const thresh = 12 + (10 - q) * 6; // q=10→12°, q=5→42°, q=1→66°
          if (angle < thresh) { changed = true; continue; }
        }
      }
      out.push(p);
    }
    result = out;
  }

  // ── Pass 2: Gaussian smoothing — pin corners ──────────────────────────────
  // Corners (angle < 150° with long legs) are fixed points — smoothing skips them.
  const n = result.length;
  if (n < 4) return result;

  // Pre-compute which points are corners (must not be moved by smoothing)
  const isCorner = result.map((p, i) => {
    const q = ptQ(p);
    if (q >= 8) return false; // high-quality: no smoothing anyway
    const a = result[(i-1+n)%n], c = result[(i+1)%n];
    const ax=a.x-p.x, ay=a.y-p.y, bx=c.x-p.x, by=c.y-p.y;
    const la=Math.sqrt(ax*ax+ay*ay), lb=Math.sqrt(bx*bx+by*by);
    if (Math.max(la,lb) < cornerLegMin) return false; // short legs = noise, not corner
    const cos=(ax*bx+ay*by)/(la*lb);
    const angle=Math.acos(Math.max(-1,Math.min(1,cos)))*180/Math.PI;
    return angle < 150; // genuine direction change = corner
  });

  return result.map((p, i) => {
    const q = ptQ(p);
    if (q >= 8 || isCorner[i]) return p; // high-quality or corner: leave untouched
    const radius = q < 4 ? 3 : 1;
    let sx = 0, sy = 0, sw = 0;
    for (let d = -radius; d <= radius; d++) {
      const j = (i + d + n) % n;
      const w = Math.exp(-d * d / (radius * radius * 0.5));
      sx += result[j].x * w;
      sy += result[j].y * w;
      sw += w;
    }
    return { x: sx / sw, y: sy / sw };
  });
}

// ── Ray-casting point-in-polygon ─────────────────────────────────────────────
function _ptInPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x, yi = pts[i].y;
    const xj = pts[j].x, yj = pts[j].y;
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi))
      inside = !inside;
  }
  return inside;
}

// ── Cross-view: fix outer contour that penetrates a hole ─────────────────────
// Any outer-contour vertex found inside a hole polygon is snapped to the nearest
// point on that hole's boundary edge.
function _fixContourHolePenetration(view) {
  const poly  = S.polys?.[view];
  const holes = S.holes?.[view];
  if (!poly?.pts?.length || !holes?.length) return;

  let fixed = 0;
  for (const hole of holes) {
    if (hole.length < 3) continue;
    for (const pt of poly.pts) {
      if (!_ptInPoly(pt.x, pt.y, hole)) continue;
      // Snap to nearest point on hole boundary
      let bestD = Infinity, bestX = pt.x, bestY = pt.y;
      for (let i = 0; i < hole.length; i++) {
        const a = hole[i], b = hole[(i+1) % hole.length];
        // Closest point on segment a→b
        const dx = b.x-a.x, dy = b.y-a.y;
        const len2 = dx*dx + dy*dy;
        const t = len2 > 0 ? Math.max(0, Math.min(1, ((pt.x-a.x)*dx + (pt.y-a.y)*dy) / len2)) : 0;
        const cx = a.x + t*dx, cy = a.y + t*dy;
        const d = (pt.x-cx)**2 + (pt.y-cy)**2;
        if (d < bestD) { bestD = d; bestX = cx; bestY = cy; }
      }
      pt.x = bestX; pt.y = bestY;
      fixed++;
    }
  }
  if (fixed) console.log(`[contour] hole-penetration fix: ${fixed} vertices snapped`);
}

// ── Cross-view: check contour is within expected object bounds ────────────────
// Uses objectModel.dims + current-view scale to compute expected bbox size.
// If contour bbox exceeds 1.6× expected in width OR height, the contour likely
// traced background noise — re-simplify the pts array in-place.
function _crossViewCheckBounds(view, pts, _W, _H, r) {
  if (!pts || pts.length < 3) return;
  const od  = S.objectModel?.dims;
  const ppm = S.scale?.[view];
  if (!od || !ppm || !r) return;

  const viewAxes = { front: ['W','H'], side: ['D','H'], top: ['W','D'] };
  const [dA, dB] = viewAxes[view] ?? ['W','H'];
  const aMm = od[dA], bMm = od[dB];
  if (!aMm || !bMm) return;

  const expectedWpx = aMm * ppm * r;  // expected width in working-space px
  const expectedHpx = bMm * ppm * r;

  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  const actualW = Math.max(...xs) - Math.min(...xs);
  const actualH = Math.max(...ys) - Math.min(...ys);

  const wRatio = actualW / expectedWpx;
  const hRatio = actualH / expectedHpx;

  if (wRatio > 1.6 || hRatio > 1.6) {
    console.warn(`[contour] bounds check: ${Math.round(actualW)}×${Math.round(actualH)}px vs expected ~${Math.round(expectedWpx)}×${Math.round(expectedHpx)}px — re-simplifying`);
    const tightened = douglasPeucker(pts, 3.0);
    pts.length = 0;
    tightened.forEach(p => pts.push(p));
  }
}

// ── Cross-view: prune spurious holes ─────────────────────────────────────────
// Two-pass validation:
// 1. If segMeta for this view says the mask has no holes → clear all phantom holes.
// 2. If other closed views have fewer holes → prune to their max.
function _crossViewPruneHoles(view) {
  if (!S.holes?.[view]?.length) return;

  // Hard constraint from segmentation mask: if no holes exist in the mask, any
  // hole found by contour fitting is an artifact (contour drifted outside silhouette).
  const knownHoles = S.segMeta?.[view]?.holeCount;
  if (knownHoles === 0) {
    console.log(`[contour] segMeta confirms no holes for ${view} — clearing ${S.holes[view].length} phantom hole(s)`);
    S.holes[view] = [];
    return;
  }

  // Soft constraint from other views: don't have significantly more holes than peers.
  const myHoles = S.holes[view];
  const otherCounts = ['front', 'side', 'top']
    .filter(v => v !== view && S.polys?.[v]?.closed)
    .map(v => (S.holes?.[v] ?? []).length);

  if (!otherCounts.length) return;

  const maxExpected = Math.max(...otherCounts) + 1;
  if (myHoles.length <= maxExpected) return;

  console.log(`[contour] cross-view holes: expected ≤${maxExpected}, got ${myHoles.length} — pruning`);
  S.holes[view] = myHoles
    .map(h => ({ pts: h, area: Math.abs(_polyArea2D(h)) }))
    .sort((a, b) => b.area - a.area)
    .slice(0, Math.max(0, maxExpected))
    .map(h => h.pts);
}

// ── Cross-view: check contour perimeter against objectModel ───────────────────
// pts are in working-space coords (W×H); r = working/original scale.
// If actual perimeter > 2.5× the expected ellipse perimeter, the contour
// likely traced background noise — re-simplify aggressively.
function _crossViewCheckPerimeter(view, pts, _W, _H, r) {
  if (!pts || pts.length < 3) return;

  const od   = S.objectModel?.dims;
  const ppm  = S.scale?.[view];
  if (!od || !ppm || !r) return;

  const viewAxes = { front: ['W','H'], side: ['D','H'], top: ['W','D'] };
  const [dA, dB] = viewAxes[view] ?? ['W','H'];
  const aMm = od[dA], bMm = od[dB];
  if (!aMm || !bMm) return;

  // Ramanujan perimeter of expected bounding ellipse (semi-axes = half dims)
  const a = aMm / 2, b = bMm / 2;
  const h = ((a - b) / (a + b)) ** 2;
  const expectedMm = Math.PI * (a + b) * (1 + 3*h / (10 + Math.sqrt(4 - 3*h)));

  // Actual perimeter in mm (working-space px → original px → mm)
  let perimPx = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i+1) % pts.length];
    perimPx += Math.sqrt((q.x-p.x)**2 + (q.y-p.y)**2);
  }
  const actualMm = perimPx / (ppm * r);

  const ratio = actualMm / expectedMm;
  if (ratio > 2.5) {
    console.warn(`[contour] cross-view perim: ${Math.round(actualMm)}mm vs expected ~${Math.round(expectedMm)}mm (ratio ${ratio.toFixed(1)}) — re-simplifying`);
    // Aggressively re-simplify to remove the noise spike chain
    const resimplified = douglasPeucker(pts, 4.0);
    pts.length = 0;
    resimplified.forEach(p => pts.push(p));
  }
}

// Pure contour extraction from a binary mask — no side effects on S.*
// Returns { pts, W, H } in mask-local coordinates, or null if nothing found.
// Used by ISO pipeline to build per-face contour templates.
function _extractContourFromMask(mask, W, H, gray) {
  const blob = findLargestBlob(mask, W, H);
  if (!blob || blob.length < 50) return null;
  const blobMask = new Uint8ClampedArray(W * H);
  blob.forEach(i => { blobMask[i] = 255; });
  const sealed = _sealBorderConcavities(blobMask, W, H);
  const filled = morphFillHoles(sealed, W, H);
  const outers = _suzukiAbe(filled, W, H).filter(c => !c.isHole && c.pts.length >= 4);
  if (!outers.length) return null;
  const outerPts = outers.reduce((a, b) => b.pts.length > a.pts.length ? b : a).pts;
  const step = Math.max(1, Math.floor(outerPts.length / 1500));
  let pts = douglasPeucker(outerPts.filter((_, i) => i % step === 0), 0.5);
  if (gray) pts = _snapToEdges(pts, gray, W, H, 6);
  pts = _removeCollinear(pts, 1.5);
  if (pts.length < 4) return null;
  return { pts, W, H };
}

// Fallback: when the orthographic contour is degenerate, warp the stored ISO face
// contour (same view) into the orthographic working-space and store it in S.polys.
// workW / workH are the dimensions of the orthographic working mask.
// Returns true if fallback was applied successfully.
function _tryIsoContourFallback(view, workW, workH) {
  const isoC = S.isoContours?.[view];
  if (!isoC || isoC.pts.length < 4) return false;
  // Scale ISO face local coords → orthographic working-space coords.
  // The ISO face is slightly foreshortened but the silhouette SHAPE is far
  // better than the degenerate arch-threading result, so use it as-is.
  const scX = workW / isoC.W, scY = workH / isoC.H;
  let pts = isoC.pts.map(p => ({ x: p.x * scX, y: p.y * scY }));
  pts = _removeCollinear(pts, 1.5);
  if (pts.length < 4) return false;
  if (!cC) initContour();
  const cScX = cC ? cC.width / workW : 1;
  const cScY = cC ? cC.height / workH : 1;
  S.polys[view] = { pts: pts.map(p => ({ x: p.x * cScX, y: p.y * cScY })), closed: true };
  if (!S.polyCanvasSize) S.polyCanvasSize = {};
  S.polyCanvasSize[view] = { w: cC ? cC.width : workW, h: cC ? cC.height : workH };
  return true;
}

// ── Seal open concavities at image borders ────────────────────────────────────
// Problem: arch openings (or other concavities) that touch the image border
// are treated as "exterior" by morphFillHoles → BFS enters them → not filled.
// Solution: for each of the 4 borders, find the object's extreme row/column and
// fill any gap (black run between white pixels) at that extreme with white pixels.
// This creates a 1-pixel seal so morphFillHoles can treat the arch as a true hole.
function _sealBorderConcavities(mask, W, H) {
  const result = mask.slice();

  // Find bounding box of object
  let minX=W, maxX=0, minY=H, maxY=0;
  for (let y=0; y<H; y++) for (let x=0; x<W; x++) {
    if (!mask[y*W+x]) continue;
    if (x<minX) minX=x; if (x>maxX) maxX=x;
    if (y<minY) minY=y; if (y>maxY) maxY=y;
  }
  if (maxX<=minX || maxY<=minY) return result;

  // Seal a row only when it is almost fully filled (≥65% density).
  // 65% catches true arch openings (table underside, horseshoe) while leaving
  // sparse rows like the gap between animal legs untouched.
  function sealRow(y) {
    let l=W, r=-1, cnt=0;
    for (let x=minX; x<=maxX; x++) if (mask[y*W+x]) { if(x<l)l=x; if(x>r)r=x; cnt++; }
    if (r < l) return;
    if (cnt < (r - l + 1) * 0.65) return;
    for (let x=l; x<=r; x++) result[y*W+x]=255;
  }
  function sealCol(x) {
    let t=H, b=-1, cnt=0;
    for (let y=minY; y<=maxY; y++) if (mask[y*W+x]) { if(y<t)t=y; if(y>b)b=y; cnt++; }
    if (b < t) return;
    if (cnt < (b - t + 1) * 0.65) return;
    for (let y=t; y<=b; y++) result[y*W+x]=255;
  }

  // Only seal the single extreme row/column — avoids false-sealing concavities
  // that are several rows deep (like the arch under a table with thick legs).
  sealRow(maxY); sealRow(minY);
  sealCol(minX); sealCol(maxX);

  return result;
}

// Shared finalisation: best blob → Moore trace → D-P → edge snap → outer poly + holes.
// gray is optional; when provided, outer vertices are snapped to nearest gradient.
// snapR controls how far (pixels) each vertex may move toward the gradient (default 6).
// Use snapR=2 when the mask already defines the boundary precisely (e.g. from seg mask).
function _finishContourFromMask(obj, W, H, _r, gray, snapR = 6) {
  const blob = findLargestBlob(obj, W, H);
  let blobMask;
  if (blob && blob.length > 50) {
    blobMask = new Uint8ClampedArray(W*H);
    blob.forEach(i => blobMask[i] = 255);
  }

  // Fallback: raw threshold if no blob found
  if (!blobMask) {
    const thresh = segThresholds[S.contourView] ?? 120;
    const fallMask = new Uint8ClampedArray(W*H);
    for (let i=0; i<W*H; i++) if (obj[i] > 128 || obj[i] > thresh) fallMask[i]=255;
    const fb = findLargestBlob(fallMask, W, H);
    if (!fb) { hideProcessing(); alert('Could not find contour — try adjusting sensitivity'); return; }
    blobMask = new Uint8ClampedArray(W*H);
    fb.forEach(i => blobMask[i] = 255);
  }

  // ── Seal open concavities at image borders ────────────────────────────────
  // When arch openings (or any concavity) touch the image border, morphFillHoles
  // cannot fill them — BFS from the border enters through the opening.
  // Fix: at the object's bottom/top/left/right extremes, draw a 1-pixel seal across
  // any gap between the leftmost and rightmost white pixels on that row/column.
  // This closes the opening without changing the true outer boundary shape.
  const sealedMask = _sealBorderConcavities(blobMask, W, H);

  // ── Pass 1: fill enclosed holes → clean outer boundary ───────────────────
  // Now that border concavities are sealed, morphFillHoles correctly identifies
  // all interior holes (arches, cutouts) and fills them for outer-contour tracing.
  const filledMask = morphFillHoles(sealedMask, W, H);

  // ── Outer contour: from the hole-free filled mask ─────────────────────────
  const outerContours = _suzukiAbe(filledMask, W, H);
  const outers = outerContours.filter(c => !c.isHole && c.pts.length >= 4);
  if (!outers.length) { hideProcessing(); alert('Could not detect contour'); return; }
  const outerPts = outers.reduce((a, b) => b.pts.length > a.pts.length ? b : a).pts;

  // Subsample pixel-level trace to ≤2500 pts, then smooth out staircase artefacts
  // before D-P.  Without smoothing, D-P at eps=0.4 keeps every staircase step;
  // with smoothing the diagonal steps merge into a clean curve and D-P removes them.
  const step = Math.max(1, Math.floor(outerPts.length / 2500));
  const sub  = outerPts.filter((_, i) => i % step === 0);

  // Smooth staircase artefacts first, then detect corners on clean data.
  // Running corner detection on the raw pixel trace produces false corners
  // at every horizontal/vertical staircase step.
  const smoothed = _laplacianSmooth(sub, 10, 0.5);
  const cornerSet = _detectCorners(smoothed, 45);
  const cornerPts = [...cornerSet].map(i => ({ x: smoothed[i].x, y: smoothed[i].y }));

  let simplified = douglasPeucker(smoothed, 2.0);
  simplified = _reinsertCorners(simplified, cornerPts, 4);

  // ── Adaptive quality-driven post-processing ───────────────────────────────
  // segRegions[v] carries per-quadrant reliability scores (1–10, 10 = best).
  // Low-score regions get spike removal + Gaussian smoothing.
  // Corners (sharp angles with long legs) are always preserved.
  simplified = _adaptiveQualitySmooth(simplified, W, H, S.segRegions?.[S.contourView]);

  // Snap each vertex to the nearest strong gradient along its outward normal
  if (gray) simplified = _snapToEdges(simplified, gray, W, H, snapR);

  // Apply symmetry: mirror the stronger half onto the weaker half.
  // Uses the symmetry axis detected from the mask in Background Separation.
  const sym = S.symmetry?.[S.contourView];
  if (sym && sym.score >= 0.82) {
    simplified = applyContourSymmetry(simplified, sym, gray, W, H);
  }

  // Remove any collinear points introduced by snapping or smoothing.
  // Rule: if point B lies within 1.5px of line A→C, drop B.
  simplified = _removeCollinear(simplified, 1.5);

  // Cap point count after symmetry/snap to prevent performance degradation.
  // If user set a target use that, otherwise cap at 300.
  const _ptCap = S.contourTargetPts ?? 300;
  if (simplified.length > _ptCap) simplified = _resamplePts(simplified, _ptCap, true);

  // ── ISO fallback quality gate ─────────────────────────────────────────────
  // If the polygon is degenerate (< 5 points, or area < 30% of blob), the
  // arch-threading failure destroyed the outline.  Warp the ISO face contour
  // for this view into orthographic space and use it instead.
  const _polyArea = simplified.length >= 3 ? _polyArea2D(simplified) : 0;
  const _blobArea = blob ? blob.length : 1;
  if ((simplified.length < 5 || _polyArea < _blobArea * 0.30) &&
      _tryIsoContourFallback(S.contourView, W, H)) {
    if (!S.holes) S.holes = {};
    S.holes[S.contourView] = [];
    _applyContourTargetPts();
    updateContourInfo();
    if (!S.polyCanvasSize) S.polyCanvasSize = {};
    S.polyCanvasSize[S.contourView] = { w: cC ? cC.width : W, h: cC ? cC.height : H };
    hideProcessing();
    drawContour();
    persistState();
    return;
  }

  // Cross-view checks run on `simplified` (working-space) BEFORE it is committed
  // to S.polys.  Running them after the .map() copy would be a stale mutation.
  _crossViewCheckPerimeter(S.contourView, simplified, W, H, _r);
  _crossViewCheckBounds(S.contourView, simplified, W, H, _r);

  if (!cC) initContour();
  const scaleX = cC ? cC.width/W : 1;
  const scaleY = cC ? cC.height/H : 1;
  S.polys[S.contourView] = {
    pts: simplified.map(p => ({ x: p.x*scaleX, y: p.y*scaleY })),
    closed: true
  };

  // ── Pass 2: holes = pixels filled by morphFillHoles but empty in blobMask ──
  // These are exactly the enclosed background regions — each one is a hole.
  if (!S.holes) S.holes = {};
  const holeMask = new Uint8ClampedArray(W * H);
  for (let i = 0; i < W * H; i++) {
    if (filledMask[i] === 255 && blobMask[i] === 0) holeMask[i] = 255;
  }
  const holeRegionContours = _suzukiAbe(holeMask, W, H);
  const minHoleArea = Math.max(30, (blob ? blob.length : W * H) * 0.001);
  S.holes[S.contourView] = holeRegionContours
    .filter(c => !c.isHole && c.pts.length >= 4 && _polyArea2D(c.pts) >= minHoleArea)
    .map(c => {
      const hs = Math.max(1, Math.floor(c.pts.length / 1000));
      const hSimp = douglasPeucker(c.pts.filter((_, i) => i % hs === 0), 0.4);
      return hSimp.map(p => ({ x: p.x*scaleX, y: p.y*scaleY }));
    })
    .filter(h => h.length >= 3);

  // ── Cross-view validation (holes only — perimeter/bounds ran earlier) ────────
  _crossViewPruneHoles(S.contourView);

  // Expose secondary disconnected blobs as draggable merge fragments
  if (!S.polyFragments) S.polyFragments = {};
  const _secFrags = _findSecondaryBlobs(obj, W, H, blob, scaleX, scaleY);
  if (_secFrags.length) S.polyFragments[S.contourView] = _secFrags;
  else delete S.polyFragments[S.contourView];

  _applyContourTargetPts();

  // Cross-validate polygon area against the segmentation silhouette.
  // If the polygon enclosed background (ratio > 1.20) or missed the object (ratio < 0.80),
  // clamp each out-of-silhouette vertex to its nearest white pixel in the mask.
  updateContourInfo();
  const ci = S.contourInfo?.[S.contourView];
  if (ci?.areaRatio != null && (ci.areaRatio > 1.20 || ci.areaRatio < 0.80)) {
    _clampPolyToSilhouette(S.contourView);
    updateContourInfo(); // recompute ratio after correction
  }

  // Store canvas size so scale step can re-project polygon to its own canvas
  if (!S.polyCanvasSize) S.polyCanvasSize = {};
  S.polyCanvasSize[S.contourView] = { w: cC ? cC.width : W, h: cC ? cC.height : H };

  // ── Cross-view model validation ───────────────────────────────────────────
  // Compare detected contour dimensions against the 3-view object model.
  // simplified pts are in working space (W×H); _r converts original→working.
  const _ppm = S.scale?.[S.contourView]; // original image px/mm
  if (_ppm && _r && S.objectModel && simplified.length > 2) {
    const ppmW = _ppm * _r; // px/mm in working space
    const xs = simplified.map(p => p.x), ys = simplified.map(p => p.y);
    const detWmm = (Math.max(...xs) - Math.min(...xs)) / ppmW;
    const detHmm = (Math.max(...ys) - Math.min(...ys)) / ppmW;
    const v = S.contourView;
    const { dims } = S.objectModel;
    const expW = v === 'side' ? dims.D : dims.W;
    const expH = v === 'top'  ? dims.D : dims.H;
    function fmtCheck(det, exp, label) {
      if (!det) return '';
      const str = `${label}: ${Math.round(det)} mm`;
      if (!exp) return str;
      const ratio = Math.min(det,exp)/Math.max(det,exp);
      return ratio > 0.85
        ? `${str} <span style="color:#10B981">✓</span>`
        : `${str} <span style="color:#EF4444">⚠ expected ${Math.round(exp)}</span>`;
    }
    S._contourModelCheck = fmtCheck(detWmm,expW,'W') + ' · ' + fmtCheck(detHmm,expH,'H');
  } else {
    S._contourModelCheck = null;
  }

  // Layer 3: shape intelligence — eccentricity + solidity from blob regionprops
  if (blob) {
    const rp = regionPropsBlob(blob, W);
    if (rp) ctxWrite(S.contourView, 'shape', {
      eccentricity: rp.eccentricity, solidity: rp.solidity,
      majorAxis: rp.majorAxis, minorAxis: rp.minorAxis,
      blobArea: rp.area,
    });
  }

  hideProcessing();
  drawContour();
  persistState();  // save immediately so contour survives refresh even if snake never runs
  // Run snake quietly to pull the smoothed contour onto real image edges.
  // Capture view now — user may switch views before the timeout fires.
  const _snakeView = S.contourView;
  setTimeout(() => _runSnakeAuto(_snakeView), 0);

  // Update Step 3 model bar with cross-view check result
  const _modelBar = document.getElementById('model-bar');
  if (_modelBar) {
    _renderModelBar(_modelBar);
    if (S._contourModelCheck) {
      const _sep = document.createElement('span');
      _sep.style.cssText = 'width:1px;height:16px;background:var(--border);flex-shrink:0;align-self:center;margin:0 8px;';
      _modelBar.appendChild(_sep);
      const _det = document.createElement('span');
      _det.style.cssText = 'font-size:11px;color:var(--muted);align-self:center;';
      _det.innerHTML = 'Detected: ' + S._contourModelCheck;
      _modelBar.appendChild(_det);
    }
  }
  persistState();
}

// Moves any polygon vertex that falls outside the silhouette mask to the nearest
// white pixel along the line from vertex toward the polygon centroid.
function _clampPolyToSilhouette(view) {
  const seg = S.segMasks?.[view];
  const poly = S.polys?.[view];
  if (!seg || !poly?.closed || poly.pts.length < 3 || !cC) return;

  const { mask, W: mW, H: mH } = seg;
  const toMX = mW / cC.width, toMY = mH / cC.height;

  // Centroid in canvas space
  const cx = poly.pts.reduce((s, p) => s + p.x, 0) / poly.pts.length;
  const cy = poly.pts.reduce((s, p) => s + p.y, 0) / poly.pts.length;

  poly.pts = poly.pts.map(p => {
    const mx = Math.round(p.x * toMX), my = Math.round(p.y * toMY);
    // If already inside the silhouette, keep as-is
    if (mx >= 0 && mx < mW && my >= 0 && my < mH && mask[my * mW + mx]) return p;

    // Walk toward centroid until we hit a silhouette pixel
    const dx = cx - p.x, dy = cy - p.y;
    const dist = Math.sqrt(dx*dx + dy*dy) || 1;
    const steps = Math.ceil(dist);
    for (let k = 1; k <= steps; k++) {
      const nx = p.x + dx / dist * k, ny = p.y + dy / dist * k;
      const nmx = Math.round(nx * toMX), nmy = Math.round(ny * toMY);
      if (nmx >= 0 && nmx < mW && nmy >= 0 && nmy < mH && mask[nmy * mW + nmx])
        return { x: nx, y: ny };
    }
    return p; // couldn't find — keep original
  });
}

// ── Contour point-count control ──────────────────────────────────────────────
// Uniformly resample a polygon to exactly targetN points along its perimeter.
function _resamplePts(pts, targetN, closed = true) {
  const n = pts.length;
  if (n < 2 || targetN < 2) return pts;
  const segCount = closed ? n : n - 1;
  const cum = [0];
  for (let i = 0; i < segCount; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    cum.push(cum[i] + Math.hypot(b.x - a.x, b.y - a.y));
  }
  const total = cum[segCount];
  if (total < 1e-6) return pts;
  const step = total / targetN;
  const out = [];
  for (let k = 0; k < targetN; k++) {
    const d = k * step;
    let i = 0;
    while (i < segCount - 1 && cum[i + 1] <= d) i++;
    const sl = cum[i + 1] - cum[i];
    const t = sl < 1e-10 ? 0 : (d - cum[i]) / sl;
    const a = pts[i], b = pts[(i + 1) % n];
    out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  }
  return out;
}

// Apply S.contourTargetPts resample to current polygon (called after auto-detect).
function _applyContourTargetPts() {
  const targetN = S.contourTargetPts;
  if (!targetN || targetN < 3) return;
  const poly = S.polys[S.contourView];
  if (!poly || poly.pts.length < 3) return;
  poly.pts = _resamplePts(poly.pts, targetN, poly.closed);
}

// Public: resample current polygon to N and persist (called from UI select).
function resampleContour(targetN) {
  S.contourTargetPts = targetN;
  const poly = S.polys[S.contourView];
  if (!poly || poly.pts.length < 3) { persistState(); return; }
  poly.pts = _resamplePts(poly.pts, targetN, poly.closed);
  // Sync select display
  const sel = document.getElementById('pts-count-sel');
  if (sel) sel.value = String(targetN);
  drawContour(); updateContourInfo(); persistState();
}

// Laplacian smoothing of a closed polygon.
// Each pass replaces every point with a weighted average of itself and its two neighbours.
// alpha=0.5 → standard Laplacian. Run 8-12 passes to remove pixel staircase artefacts
// without noticeably shrinking the polygon (Taubin's dual-pass avoids shrinkage: see below).
// locked: optional Set of indices whose position must not change (corner anchors)
function _laplacianSmooth(pts, passes, alpha, locked) {
  if (pts.length < 4) return pts;
  alpha = alpha ?? 0.5;
  let out = pts.map(p => ({ x: p.x, y: p.y }));
  const w0 = 1 - alpha, wN = alpha / 2;
  for (let pass = 0; pass < passes; pass++) {
    const n = out.length;
    const tmp = new Array(n);
    for (let i = 0; i < n; i++) {
      if (locked?.has(i)) { tmp[i] = { x: out[i].x, y: out[i].y }; continue; }
      const prev = out[(i - 1 + n) % n];
      const next = out[(i + 1) % n];
      tmp[i] = { x: out[i].x * w0 + (prev.x + next.x) * wN,
                 y: out[i].y * w0 + (prev.y + next.y) * wN };
    }
    out = tmp;
  }
  return out;
}

// Detect sharp direction changes in a closed polygon.
// Returns a Set of indices where the turning angle >= minAngleDeg.
// Uses an adaptive window to suppress pixel-staircase noise.
function _detectCorners(pts, minAngleDeg = 45) {
  const N = pts.length;
  if (N < 6) return new Set();
  const W = Math.max(5, Math.floor(N / 40));
  // cos threshold: a turn ≥ minAngleDeg means the angle between v1 and v2 is ≤ (180−min)
  const cosThresh = Math.cos((180 - minAngleDeg) * Math.PI / 180);
  const corners = new Set();
  for (let i = 0; i < N; i++) {
    const a = pts[(i - W + N) % N];
    const b = pts[i];
    const c = pts[(i + W) % N];
    const v1x = b.x - a.x, v1y = b.y - a.y;
    const v2x = c.x - b.x, v2y = c.y - b.y;
    const len1 = Math.sqrt(v1x*v1x + v1y*v1y);
    const len2 = Math.sqrt(v2x*v2x + v2y*v2y);
    if (len1 < 2 || len2 < 2) continue;
    const cos = (v1x*v2x + v1y*v2y) / (len1 * len2);
    if (cos < cosThresh) corners.add(i);
  }
  return corners;
}

// After D-P simplification, ensure every corner point still appears.
// Any corner dropped by D-P is re-inserted onto the nearest polygon segment.
function _reinsertCorners(simplified, cornerPts, snapDist = 4) {
  let result = simplified.slice();
  for (const cp of cornerPts) {
    const snap2 = snapDist * snapDist;
    if (result.some(p => (p.x-cp.x)**2 + (p.y-cp.y)**2 < snap2)) continue;
    let bestD = Infinity, bestIdx = 0;
    for (let i = 0; i < result.length; i++) {
      const a = result[i], b = result[(i+1) % result.length];
      const dx = b.x-a.x, dy = b.y-a.y;
      const len2 = dx*dx + dy*dy;
      const t = len2 > 0 ? Math.max(0, Math.min(1, ((cp.x-a.x)*dx+(cp.y-a.y)*dy)/len2)) : 0;
      const d = (cp.x-a.x-t*dx)**2 + (cp.y-a.y-t*dy)**2;
      if (d < bestD) { bestD = d; bestIdx = i; }
    }
    result.splice(bestIdx + 1, 0, { x: cp.x, y: cp.y });
  }
  return result;
}

function douglasPeucker(pts, eps) {
  if (pts.length <= 2) return pts;
  let maxD = 0, maxI = 0;
  const a = pts[0], b = pts[pts.length - 1];
  const dx = b.x - a.x, dy = b.y - a.y, len = Math.sqrt(dx*dx + dy*dy);
  for (let i = 1; i < pts.length - 1; i++) {
    const d = len === 0
      ? Math.sqrt((pts[i].x-a.x)**2+(pts[i].y-a.y)**2)
      : Math.abs(dy*pts[i].x - dx*pts[i].y + b.x*a.y - b.y*a.x) / len;
    if (d > maxD) { maxD = d; maxI = i; }
  }
  if (maxD > eps) {
    const L = douglasPeucker(pts.slice(0, maxI + 1), eps);
    const R = douglasPeucker(pts.slice(maxI), eps);
    return [...L.slice(0, -1), ...R];
  }
  return [a, b];
}

// ══════════════════════════ SCIKIT-IMAGE EQUIVALENTS ══════════════════════════
// Pure-JS ports of the most impactful skimage algorithms — browser-only, no Python.

// ─── Sauvola Adaptive Threshold (skimage.filters.threshold_sauvola) ───────────
// Spatially-variable binarisation: T(x,y) = m(x,y) * (1 + k*(σ(x,y)/R − 1))
// m = local mean, σ = local stddev; uses SAT for O(W*H) total cost.
// Beats global Otsu on images with uneven lighting (shadows, gradients).
function thresholdSauvola(gray, W, H, windowSize, k = 0.2) {
  const R  = 128;
  const ws = windowSize ?? Math.max(9, Math.min(51, (Math.floor(Math.min(W, H) * 0.10) | 1)));
  const rad = ((ws % 2 === 0 ? ws + 1 : ws) - 1) >> 1;
  const { sat1, sat2 } = _buildSAT(gray, W, H);
  const mask = new Uint8ClampedArray(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const m  = _localMean(sat1, x, y, rad, W, H);
      const sd = _localSd(sat1, sat2, x, y, rad, W, H);
      const t  = m * (1 + k * (sd / R - 1));
      mask[y * W + x] = gray[y * W + x] < t ? 255 : 0;
    }
  }
  return mask;
}

// ─── Fill Interior Holes (skimage.morphology.remove_small_holes) ─────────────
// BFS from border background pixels; remaining enclosed background → filled.
function morphFillHoles(mask, W, H) {
  const ext = new Uint8ClampedArray(W * H);
  const q   = [];
  const push = (x, y) => {
    const i = y * W + x;
    if (!mask[i] && !ext[i]) { ext[i] = 1; q.push(i); }
  };
  for (let x = 0; x < W; x++) { push(x, 0); push(x, H - 1); }
  for (let y = 1; y < H - 1; y++) { push(0, y); push(W - 1, y); }
  let qi = 0;
  while (qi < q.length) {
    const i = q[qi++], x = i % W, y = (i / W) | 0;
    if (x > 0)     push(x - 1, y);
    if (x < W - 1) push(x + 1, y);
    if (y > 0)     push(x, y - 1);
    if (y < H - 1) push(x, y + 1);
  }
  const out = new Uint8ClampedArray(W * H);
  for (let i = 0; i < W * H; i++) out[i] = (mask[i] || !ext[i]) ? 255 : 0;
  return out;
}

// ─── Disk Structuring Element (skimage.morphology.disk) ───────────────────────
// Returns [dx,dy] offset list for a circular SE — smoother than a square kernel.
function _diskOffsets(r) {
  const offs = [], r2 = r * r;
  for (let dy = -r; dy <= r; dy++)
    for (let dx = -r; dx <= r; dx++)
      if (dx * dx + dy * dy <= r2) offs.push([dx, dy]);
  return offs;
}

// Morphological close with disk SE — skimage.morphology.closing(img, disk(r))
function morphCloseDisk(mask, W, H, r) {
  const offs = _diskOffsets(r);
  const dil  = new Uint8ClampedArray(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!mask[y * W + x]) continue;
    for (const [dx, dy] of offs) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && nx < W && ny >= 0 && ny < H) dil[ny * W + nx] = 255;
    }
  }
  const out = new Uint8ClampedArray(W * H);
  for (let y = r; y < H - r; y++) for (let x = r; x < W - r; x++) {
    if (!dil[y * W + x]) continue;
    let ok = true;
    for (const [dx, dy] of offs) { if (!dil[(y + dy) * W + (x + dx)]) { ok = false; break; } }
    if (ok) out[y * W + x] = 255;
  }
  return out;
}

// Morphological open with disk SE — skimage.morphology.opening(img, disk(r))
function morphOpenDisk(mask, W, H, r) {
  const offs = _diskOffsets(r);
  const ero  = new Uint8ClampedArray(W * H);
  for (let y = r; y < H - r; y++) for (let x = r; x < W - r; x++) {
    if (!mask[y * W + x]) continue;
    let ok = true;
    for (const [dx, dy] of offs) { if (!mask[(y + dy) * W + (x + dx)]) { ok = false; break; } }
    if (ok) ero[y * W + x] = 255;
  }
  const out = new Uint8ClampedArray(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!ero[y * W + x]) continue;
    for (const [dx, dy] of offs) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && nx < W && ny >= 0 && ny < H) out[ny * W + nx] = 255;
    }
  }
  return out;
}

// Morphological dilation with disk SE — standalone (first half of morphCloseDisk)
function morphDilateDisk(mask, W, H, r) {
  const offs = _diskOffsets(r);
  const out  = new Uint8ClampedArray(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!mask[y * W + x]) continue;
    for (const [dx, dy] of offs) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && nx < W && ny >= 0 && ny < H) out[ny * W + nx] = 255;
    }
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════════
// SYMMETRY DETECTION & APPLICATION
// ════════════════════════════════════════════════════════════════════════════

// Detect the dominant symmetry axis (vertical or horizontal) of a binary mask.
// Uses column/row pixel-count profiles and centroid alignment.
// Returns { axis, score, dir:'v'|'h' } or null if no clear symmetry (score < 0.78).
function detectMaskSymmetry(mask, W, H) {
  const colCount = new Int32Array(W);
  const rowCount = new Int32Array(H);
  let totalPx = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!mask[y * W + x]) continue;
    colCount[x]++; rowCount[y]++; totalPx++;
  }
  if (totalPx < 100) return null;

  // Centroid
  let cxSum = 0, cySum = 0;
  for (let x = 0; x < W; x++) cxSum += x * colCount[x];
  for (let y = 0; y < H; y++) cySum += y * rowCount[y];
  const cx0 = Math.round(cxSum / totalPx);
  const cy0 = Math.round(cySum / totalPx);

  // Per-column mean Y and per-row mean X — used for the alignment check below.
  // True bilateral symmetry: column x and its mirror have pixels at similar Y-positions.
  // Side-view false positive: column heights match (vScore high) but Y-positions differ
  // because front of animal ≠ rear of animal.
  const meanY = new Float32Array(W);
  const meanX = new Float32Array(H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!mask[y*W+x]) continue;
    meanY[x] += y; meanX[y] += x;
  }
  for (let x = 0; x < W; x++) if (colCount[x]) meanY[x] /= colCount[x];
  for (let y = 0; y < H; y++) if (rowCount[y]) meanX[y] /= rowCount[y];

  // Profile score: how well column/row counts mirror around the axis
  function vScore(ax) {
    let ov = 0, tot = 0;
    for (let x = 0; x < W; x++) {
      const mx = 2 * ax - x;
      if (mx < 0 || mx >= W) continue;
      ov  += Math.min(colCount[x], colCount[mx]);
      tot += Math.max(colCount[x], colCount[mx]);
    }
    return tot > 0 ? ov / tot : 0;
  }
  function hScore(ay) {
    let ov = 0, tot = 0;
    for (let y = 0; y < H; y++) {
      const my = 2 * ay - y;
      if (my < 0 || my >= H) continue;
      ov  += Math.min(rowCount[y], rowCount[my]);
      tot += Math.max(rowCount[y], rowCount[my]);
    }
    return tot > 0 ? ov / tot : 0;
  }

  // Alignment score: paired columns must have pixels at similar Y positions.
  // Catches side-view false positives where column heights match but shapes differ.
  function vAlignScore(ax) {
    let diff = 0, cnt = 0;
    for (let x = 0; x < ax; x++) {
      const mx = 2 * ax - x;
      if (mx >= W || !colCount[x] || !colCount[mx]) continue;
      diff += Math.abs(meanY[x] - meanY[mx]) / H;
      cnt++;
    }
    return cnt > 0 ? 1 - diff / cnt : 0;
  }
  function hAlignScore(ay) {
    let diff = 0, cnt = 0;
    for (let y = 0; y < ay; y++) {
      const my = 2 * ay - y;
      if (my >= H || !rowCount[y] || !rowCount[my]) continue;
      diff += Math.abs(meanX[y] - meanX[my]) / W;
      cnt++;
    }
    return cnt > 0 ? 1 - diff / cnt : 0;
  }

  // Fine-scan ±15px around centroid for best axis
  let bestV = 0, bestVAx = cx0;
  for (let dx = -15; dx <= 15; dx++) {
    const s = vScore(cx0 + dx);
    if (s > bestV) { bestV = s; bestVAx = cx0 + dx; }
  }
  let bestH = 0, bestHAx = cy0;
  for (let dy = -15; dy <= 15; dy++) {
    const s = hScore(cy0 + dy);
    if (s > bestH) { bestH = s; bestHAx = cy0 + dy; }
  }

  // TUNING: raise to 0.82 if false positives occur (non-symmetric views wrongly mirrored).
  //         lower to 0.75 if symmetric views are missed (score just below threshold).
  const THRESH = 0.78;
  const ALIGN_THRESH = 0.80;
  // Store mW/mH so callers can convert axis to any target coordinate system via
  //   axisInTarget = (dir==='v') ? sym.axis / sym.mW * targetW : sym.axis / sym.mH * targetH
  console.debug(`[symmetry] bestV=${bestV.toFixed(3)} bestH=${bestH.toFixed(3)} thresh=${THRESH}`);
  if (bestV >= bestH && bestV >= THRESH && vAlignScore(bestVAx) >= ALIGN_THRESH)
    return { axis: bestVAx, score: bestV, dir: 'v', mW: W, mH: H };
  if (bestH >  bestV && bestH >= THRESH && hAlignScore(bestHAx) >= ALIGN_THRESH)
    return { axis: bestHAx, score: bestH, dir: 'h', mW: W, mH: H };
  return null;
}

// Apply detected symmetry to improve a binary mask.
// Strategy: for each pixel pair (p, mirror(p)):
//   - If BOTH are object → keep
//   - If BOTH are background → keep
//   - If only ONE is object → use it for BOTH (fill the weaker side)
// The net effect: noise that is asymmetric gets suppressed;
//   missing pixels on the weaker side get filled from the stronger side.
function applyMaskSymmetry(mask, W, H, sym) {
  if (!sym) return mask;
  const result = mask.slice();
  const ax = sym.axis;

  if (sym.dir === 'v') {
    // Count boundary transitions per side: fewer = cleaner (less noise).
    let lTrans = 0, rTrans = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 1; x < ax && x < W; x++)
        if (mask[y*W+x] !== mask[y*W+x-1]) lTrans++;
      for (let x = ax+1; x < W; x++)
        if (mask[y*W+x] !== mask[y*W+x-1]) rTrans++;
    }
    const useLeft = (lTrans / Math.max(1, ax)) <= (rTrans / Math.max(1, W - ax));
    for (let y = 0; y < H; y++) for (let x = 0; x < ax; x++) {
      const mx = 2 * ax - x;
      if (mx < 0 || mx >= W) continue;
      if (useLeft) result[y*W+mx] = mask[y*W+x];   // mirror left → right
      else         result[y*W+x]  = mask[y*W+mx];  // mirror right → left
    }
  } else {
    let tTrans = 0, bTrans = 0;
    for (let x = 0; x < W; x++) {
      for (let y = 1; y < ax && y < H; y++)
        if (mask[y*W+x] !== mask[(y-1)*W+x]) tTrans++;
      for (let y = ax+1; y < H; y++)
        if (mask[y*W+x] !== mask[(y-1)*W+x]) bTrans++;
    }
    const useTop = (tTrans / Math.max(1, ax)) <= (bTrans / Math.max(1, H - ax));
    for (let y = 0; y < ax; y++) for (let x = 0; x < W; x++) {
      const my = 2 * ax - y;
      if (my < 0 || my >= H) continue;
      if (useTop) result[my*W+x] = mask[y*W+x];   // mirror top → bottom
      else        result[y*W+x]  = mask[my*W+x];  // mirror bottom → top
    }
  }
  return result;
}

// Apply symmetry to a closed contour polygon.
// The better half (higher mean gradient along boundary) is mirrored to the weaker half.
function applyContourSymmetry(pts, sym, gray, W, H) {
  if (!sym || pts.length < 6) return pts;
  // sym.axis is in mask coordinates (sym.mW × sym.mH); scale to this canvas (W × H).
  const ax = sym.dir === 'v'
    ? (sym.mW ? sym.axis / sym.mW * W : sym.axis)
    : (sym.mH ? sym.axis / sym.mH * H : sym.axis);

  if (sym.dir === 'v') {
    // Score each point by local gradient strength — higher = more reliable
    const scored = pts.map(p => {
      if (!gray) return { p, g: 1 };
      const xi = Math.round(p.x), yi = Math.round(p.y);
      if (xi < 1 || xi >= W-1 || yi < 1 || yi >= H-1) return { p, g: 0 };
      const gx = gray[yi*W+xi+1] - gray[yi*W+xi-1];
      const gy = gray[(yi+1)*W+xi] - gray[(yi-1)*W+xi];
      return { p, g: Math.sqrt(gx*gx + gy*gy) };
    });

    // Mean gradient left vs right of axis
    const left  = scored.filter(s => s.p.x <= ax);
    const right = scored.filter(s => s.p.x >  ax);
    const gLeft  = left.length  ? left.reduce((s,v) => s+v.g, 0) / left.length  : 0;
    const gRight = right.length ? right.reduce((s,v) => s+v.g, 0) / right.length : 0;

    // Mirror the stronger half onto the weaker half
    const strongSide = gLeft >= gRight ? left : right;
    // mirror direction: strongSide already selects the correct half

    const mirrored = strongSide.map(s => ({
      x: 2 * ax - s.p.x,
      y: s.p.y
    }));

    // Merge: keep all strong-side points + mirrored points (sorted by angle)
    const allPts = [...strongSide.map(s => s.p), ...mirrored];
    // Sort by angle from centroid
    const cx = allPts.reduce((s, p) => s + p.x, 0) / allPts.length;
    const cy = allPts.reduce((s, p) => s + p.y, 0) / allPts.length;
    allPts.sort((a, b) => Math.atan2(a.y-cy, a.x-cx) - Math.atan2(b.y-cy, b.x-cx));
    return allPts;
  } else {
    // Horizontal — mirror top/bottom
    const scored = pts.map(p => {
      if (!gray) return { p, g: 1 };
      const xi = Math.round(p.x), yi = Math.round(p.y);
      if (xi < 1 || xi >= W-1 || yi < 1 || yi >= H-1) return { p, g: 0 };
      const gx = gray[yi*W+xi+1] - gray[yi*W+xi-1];
      const gy = gray[(yi+1)*W+xi] - gray[(yi-1)*W+xi];
      return { p, g: Math.sqrt(gx*gx + gy*gy) };
    });
    const top    = scored.filter(s => s.p.y <= ax);
    const bottom = scored.filter(s => s.p.y >  ax);
    const gTop    = top.length    ? top.reduce((s,v) => s+v.g, 0) / top.length    : 0;
    const gBottom = bottom.length ? bottom.reduce((s,v) => s+v.g, 0) / bottom.length : 0;
    const strongSide = gTop >= gBottom ? top : bottom;
    const mirrored = strongSide.map(s => ({ x: s.p.x, y: 2 * ax - s.p.y }));
    const allPts = [...strongSide.map(s => s.p), ...mirrored];
    const cx = allPts.reduce((s, p) => s + p.x, 0) / allPts.length;
    const cy = allPts.reduce((s, p) => s + p.y, 0) / allPts.length;
    allPts.sort((a, b) => Math.atan2(a.y-cy, a.x-cx) - Math.atan2(b.y-cy, b.x-cx));
    return allPts;
  }
}

// ─── Region Properties (skimage.measure.regionprops) ─────────────────────────
// Input: blob = pixel-index array from findLargestBlob, W = image width.
// Returns: area, bbox, centroid, eccentricity [0→circle, 1→line], solidity,
//          majorAxis, minorAxis (all in pixels).
function regionPropsBlob(blob, W) {
  if (!blob || blob.length < 4) return null;
  let sumX = 0, sumY = 0, minX = W, maxX = 0, minY = 1e9, maxY = 0;
  for (const i of blob) {
    const x = i % W, y = (i / W) | 0;
    sumX += x; sumY += y;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const n = blob.length, cx = sumX / n, cy = sumY / n;
  let mu20 = 0, mu02 = 0, mu11 = 0;
  for (const i of blob) {
    const dx = (i % W) - cx, dy = ((i / W) | 0) - cy;
    mu20 += dx * dx; mu02 += dy * dy; mu11 += dx * dy;
  }
  mu20 /= n; mu02 /= n; mu11 /= n;
  const disc = Math.sqrt(Math.max(0, (mu20 - mu02) ** 2 + 4 * mu11 * mu11));
  const l1 = (mu20 + mu02 + disc) / 2, l2 = (mu20 + mu02 - disc) / 2;
  const eccentricity = l1 > 1e-9 ? Math.sqrt(Math.max(0, 1 - l2 / l1)) : 0;
  const step    = Math.max(1, Math.floor(n / 800));
  const samples = blob.filter((_, i) => i % step === 0).map(i => ({ x: i % W, y: (i / W) | 0 }));
  const hull    = (typeof geoConvexHull === 'function') ? geoConvexHull(samples) : samples;
  let hullArea  = 0;
  if (hull.length >= 3 && typeof geoArea === 'function') hullArea = Math.abs(geoArea(hull));
  else hullArea = (maxX - minX + 1) * (maxY - minY + 1);
  return {
    area: n, bbox: { minX, minY, maxX, maxY }, centroid: { x: cx, y: cy },
    eccentricity: Math.min(1, Math.max(0, eccentricity)),
    solidity: hullArea > 0 ? Math.min(1, n / hullArea) : 1,
    majorAxis: 4 * Math.sqrt(Math.max(0, l1)),
    minorAxis: 4 * Math.sqrt(Math.max(0, l2)),
  };
}