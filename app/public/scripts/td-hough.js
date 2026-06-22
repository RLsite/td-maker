// ══════════════════════════ HOUGH TRANSFORM + LSD ══════════════════════════
// skimage.transform.hough_line    → straight line detection (rho/theta space)
// skimage.transform.hough_circle  → circular feature detection (bolt holes)
// LSD (Grompone von Gioi 2010)    → line segment detector from gradients
//
// These enrich S.ctx[view].lines and S.ctx[view].circles so every downstream
// step — contour correction, dimension inference, DXF export — can benefit.

// ─── Hough Line Transform ─────────────────────────────────────────────────────
// edges: Uint8ClampedArray W×H (nonzero = edge pixel)
// Returns lines sorted strongest-first. Each line: {rho, theta, votes, x1,y1,x2,y2}
// theta=0 → vertical line, theta=PI/2 → horizontal line
function houghLines(edges, W, H, { nAngles = 180, minVotesFrac = 0.15 } = {}) {
  const maxRho = Math.ceil(Math.sqrt(W * W + H * H));
  const nRho   = 2 * maxRho + 1;
  const acc    = new Int32Array(nRho * nAngles);
  const cosT   = new Float32Array(nAngles);
  const sinT   = new Float32Array(nAngles);
  for (let t = 0; t < nAngles; t++) {
    const a = t * Math.PI / nAngles;
    cosT[t] = Math.cos(a); sinT[t] = Math.sin(a);
  }

  // Vote — only edge pixels contribute
  let edgeCnt = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!edges[y * W + x]) continue;
    edgeCnt++;
    for (let t = 0; t < nAngles; t++) {
      const rho = Math.round(x * cosT[t] + y * sinT[t]) + maxRho;
      acc[rho * nAngles + t]++;
    }
  }

  if (!edgeCnt) return [];
  // Threshold scales with image diagonal so large images don't swamp small features
  const minV = Math.max(10, Math.round(Math.sqrt(W * H) * minVotesFrac));

  const lines = [];
  for (let r = 2; r < nRho - 2; r++) {
    for (let t = 2; t < nAngles - 2; t++) {
      const v = acc[r * nAngles + t];
      if (v < minV) continue;
      // Non-maximum suppression — 5×5 neighbourhood in ρ×θ space
      let isMax = true;
      outer: for (let dr = -2; dr <= 2; dr++)
        for (let dt = -2; dt <= 2; dt++) {
          if (!dr && !dt) continue;
          if (acc[(r + dr) * nAngles + (t + dt)] >= v) { isMax = false; break outer; }
        }
      if (!isMax) continue;

      const rho = r - maxRho, theta = t * Math.PI / nAngles;
      const c = cosT[t], s = sinT[t];
      let x1, y1, x2, y2;
      if (Math.abs(s) > 0.01) {
        x1 = 0;     y1 = (rho - x1 * c) / s;
        x2 = W - 1; y2 = (rho - x2 * c) / s;
      } else {
        y1 = 0;     x1 = (rho - y1 * s) / (c || 1e-9);
        y2 = H - 1; x2 = (rho - y2 * s) / (c || 1e-9);
      }
      const angleDeg = theta * 180 / Math.PI;
      lines.push({
        rho, theta, votes: v,
        x1, y1, x2, y2,
        isHorizontal: angleDeg > 75 && angleDeg < 105,
        isVertical:   angleDeg < 15 || angleDeg > 165,
      });
    }
  }
  return lines.sort((a, b) => b.votes - a.votes);
}

// ─── Hough Circle Transform ────────────────────────────────────────────────────
// edges: Uint8ClampedArray W×H
// Returns circles sorted strongest-first. Each: {cx, cy, r, votes, normVotes}
// normVotes = votes / expected_perimeter_samples (1.0 = perfect circle)
function houghCircles(edges, W, H, { minR = 8, maxR = 80, threshold = 0.45 } = {}) {
  // Collect edge pixel coordinates once (sparse accumulation)
  const edgePts = [];
  for (let i = 0; i < W * H; i++) if (edges[i]) edgePts.push([i % W, (i / W) | 0]);
  if (!edgePts.length) return [];

  const candidates = [];
  const acc = new Int32Array(W * H); // reused across radii

  for (let r = minR; r <= maxR; r++) {
    acc.fill(0);
    const steps = Math.max(8, Math.round(2 * Math.PI * r));  // samples per circle

    for (const [ex, ey] of edgePts) {
      for (let i = 0; i < steps; i++) {
        const a  = 2 * Math.PI * i / steps;
        const cx = Math.round(ex - r * Math.cos(a));
        const cy = Math.round(ey - r * Math.sin(a));
        if (cx >= 0 && cx < W && cy >= 0 && cy < H) acc[cy * W + cx]++;
      }
    }

    const minV = Math.round(steps * threshold);
    for (let cy = r; cy < H - r; cy++) for (let cx = r; cx < W - r; cx++) {
      const v = acc[cy * W + cx];
      if (v < minV) continue;
      // Non-max suppression: 5×5 window
      let ok = true;
      outer2: for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          if (!dy && !dx) continue;
          if (acc[(cy + dy) * W + (cx + dx)] > v) { ok = false; break outer2; }
        }
      if (ok) candidates.push({ cx, cy, r, votes: v, normVotes: v / steps });
    }
  }

  // Sort by normalised votes, then spatial NMS across radii
  candidates.sort((a, b) => b.normVotes - a.normVotes);
  const kept = [];
  for (const c of candidates) {
    const overlap = kept.some(k =>
      Math.hypot(c.cx - k.cx, c.cy - k.cy) < Math.min(c.r, k.r) * 0.8);
    if (!overlap) kept.push(c);
  }
  return kept;
}

// ─── LSD — Line Segment Detector ──────────────────────────────────────────────
// Simplified port of Grompone von Gioi's LSD (2010).
// Detects straight line segments directly from image gradients.
// Returns [{x1,y1,x2,y2,angle,length,pixelCount}] sorted by length descending.
function lsdDetect(gray, W, H, { minLen = 15, gradThresh = 18, angleTolDeg = 22.5 } = {}) {
  // Gaussian blur (σ=0.8) to reduce noise
  const sigma = 0.8, kRad = 2;
  const ker = new Float32Array(2 * kRad + 1);
  let ks = 0;
  for (let x = -kRad; x <= kRad; x++) { ker[x + kRad] = Math.exp(-(x*x)/(2*sigma*sigma)); ks += ker[x + kRad]; }
  for (let i = 0; i < ker.length; i++) ker[i] /= ks;
  const tmp = new Float32Array(W * H), blr = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let s = 0; for (let dx = -kRad; dx <= kRad; dx++) s += gray[y*W + Math.max(0, Math.min(W-1, x+dx))] * ker[dx+kRad];
    tmp[y*W+x] = s;
  }
  for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) {
    let s = 0; for (let dy = -kRad; dy <= kRad; dy++) s += tmp[Math.max(0, Math.min(H-1, y+dy))*W+x] * ker[dy+kRad];
    blr[y*W+x] = s;
  }

  // Gradient magnitude and LEVEL-LINE angle (perpendicular to gradient)
  const mag = new Float32Array(W * H);
  const ang = new Float32Array(W * H);
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const gx = (blr[y*W+x+1] - blr[y*W+x-1]) * 0.5;
    const gy = (blr[(y+1)*W+x] - blr[(y-1)*W+x]) * 0.5;
    mag[y*W+x] = Math.sqrt(gx*gx + gy*gy);
    ang[y*W+x] = Math.atan2(-gx, gy); // level-line direction
  }

  const tolRad  = angleTolDeg * Math.PI / 180;
  const usedMap = new Uint8Array(W * H);
  const segments = [];

  // Process pixels in descending gradient order (highest-confidence first)
  const seeds = [];
  for (let i = 0; i < W * H; i++) if (mag[i] > gradThresh) seeds.push(i);
  seeds.sort((a, b) => mag[b] - mag[a]);

  for (const seed of seeds) {
    if (usedMap[seed]) continue;

    // BFS: grow region of pixels with aligned level-line angles
    const group = [seed];
    usedMap[seed] = 1;
    const refAngle = ang[seed];
    const q = [seed]; let qi = 0;

    while (qi < q.length) {
      const idx = q[qi++], x = idx % W, y = (idx / W) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
        const ni = ny * W + nx;
        if (usedMap[ni] || mag[ni] < gradThresh * 0.5) continue;
        let da = Math.abs(ang[ni] - refAngle);
        if (da > Math.PI) da = 2 * Math.PI - da;
        if (da > Math.PI / 2) da = Math.PI - da;
        if (da < tolRad) { usedMap[ni] = 1; group.push(ni); q.push(ni); }
      }
    }

    if (group.length < minLen) continue;

    // PCA — find principal axis direction
    let sx = 0, sy = 0;
    for (const i of group) { sx += i % W; sy += (i / W) | 0; }
    const cx = sx / group.length, cy = sy / group.length;
    let mxx = 0, myy = 0, mxy = 0;
    for (const i of group) {
      const dx = (i % W) - cx, dy = ((i / W) | 0) - cy;
      mxx += dx * dx; myy += dy * dy; mxy += dx * dy;
    }
    mxx /= group.length; myy /= group.length; mxy /= group.length;
    const disc = Math.sqrt(Math.max(0, (mxx - myy) ** 2 + 4 * mxy * mxy));
    const l1 = (mxx + myy + disc) / 2;
    let ux = mxy, uy = l1 - mxx;
    const ul = Math.sqrt(ux*ux + uy*uy) || 1;
    ux /= ul; uy /= ul;

    // Project onto axis to find segment endpoints
    let tMin = Infinity, tMax = -Infinity;
    for (const i of group) {
      const t = ((i % W) - cx) * ux + (((i / W) | 0) - cy) * uy;
      if (t < tMin) tMin = t;
      if (t > tMax) tMax = t;
    }
    if (tMax - tMin < minLen) continue;

    segments.push({
      x1: Math.round(cx + ux * tMin), y1: Math.round(cy + uy * tMin),
      x2: Math.round(cx + ux * tMax), y2: Math.round(cy + uy * tMax),
      angle: Math.atan2(uy, ux),
      length: tMax - tMin,
      pixelCount: group.length,
    });
  }
  return segments.sort((a, b) => b.length - a.length);
}

// ─── UI: Detect straight lines (Hough) in current view ───────────────────────
// Draws detected lines on the contour canvas overlay and stores in ctx.
function detectLinesInView() {
  const view = S.contourView;
  const url  = S.imgs[view];
  if (!url) return;

  const img = new Image();
  img.onload = () => {
    const maxW = 900, maxH = 700;
    const sc = Math.min(maxW / img.width, maxH / img.height, 1);
    const W  = Math.round(img.width * sc), H = Math.round(img.height * sc);
    const tmp = document.createElement('canvas'); tmp.width = W; tmp.height = H;
    const ctx = tmp.getContext('2d'); ctx.drawImage(img, 0, 0, W, H);
    const src = ctx.getImageData(0, 0, W, H).data;

    const gray = new Uint8ClampedArray(W * H);
    for (let i = 0; i < W * H; i++) gray[i] = src[i*4]*0.299 + src[i*4+1]*0.587 + src[i*4+2]*0.114;

    // Use existing Canny edges
    const enhanced = claheEnhance(gray, W, H);
    const sharpened = unsharpMask(enhanced, W, H, 1.2);
    const edges = cannyEdges(sharpened, W, H, 30, 90);

    const lines = houghLines(edges, W, H).slice(0, 20); // top 20
    ctxWrite(view, 'lines', { list: lines, W, H, sc });

    // Draw on contour canvas
    _overlayLines(view, lines, W, H, sc);
    _updateCtxBadge(view);
  };
  img.src = url;
}

// ─── UI: Detect circles (bolt holes) in current view ─────────────────────────
function detectCirclesInView() {
  const view = S.contourView;
  const seg  = S.segMasks?.[view];
  if (!seg) { alert('Run segmentation (Step 2) first'); return; }

  // Work on the edge of the segmentation mask
  const { mask, W, H } = seg;
  const edges = new Uint8ClampedArray(W * H);
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    if (!mask[y*W+x]) continue;
    const isBoundary = !mask[(y-1)*W+x] || !mask[(y+1)*W+x] ||
                       !mask[y*W+x-1]   || !mask[y*W+x+1];
    if (isBoundary) edges[y*W+x] = 255;
  }

  // Scale radius range from mask pixels → reasonable range
  const minR = Math.max(4,  Math.round(Math.min(W, H) * 0.02));
  const maxR = Math.min(120, Math.round(Math.min(W, H) * 0.25));
  const circles = houghCircles(edges, W, H, { minR, maxR }).slice(0, 15);
  ctxWrite(view, 'circles', { list: circles, W, H });

  _overlayCircles(view, circles, W, H);
  _updateCtxBadge(view);
}

// ─── Draw detected lines on contour canvas ────────────────────────────────────
function _overlayLines(view, lines, srcW, srcH, sc) {
  if (!cC || !cCtx) return;
  const sx = cC.width  / srcW;
  const sy = cC.height / srcH;
  drawContour(); // redraw base first
  cCtx.save();
  cCtx.lineWidth = 1.5;
  cCtx.strokeStyle = 'rgba(251,191,36,0.75)'; // amber
  for (const ln of lines) {
    cCtx.beginPath();
    cCtx.moveTo(ln.x1 * sx, ln.y1 * sy);
    cCtx.lineTo(ln.x2 * sx, ln.y2 * sy);
    cCtx.stroke();
  }
  cCtx.restore();
  document.getElementById('contour-info').textContent =
    `${lines.length} lines detected (Hough) · ${ctxSummary(view)}`;
}

// ─── Draw detected circles on contour canvas ──────────────────────────────────
function _overlayCircles(view, circles, srcW, srcH) {
  if (!cC || !cCtx) return;
  const sx = cC.width  / srcW;
  const sy = cC.height / srcH;
  drawContour();
  cCtx.save();
  cCtx.strokeStyle = 'rgba(167,139,250,0.9)'; // violet
  cCtx.lineWidth = 2;
  for (const ci of circles) {
    cCtx.beginPath();
    cCtx.arc(ci.cx * sx, ci.cy * sy, ci.r * ((sx + sy) / 2), 0, 2 * Math.PI);
    cCtx.stroke();
  }
  cCtx.restore();
  document.getElementById('contour-info').textContent =
    `${circles.length} circle${circles.length !== 1 ? 's' : ''} detected (Hough) · ${ctxSummary(view)}`;
}

// ─── Update context badge in contour tab ─────────────────────────────────────
function _updateCtxBadge(view) {
  const el = document.getElementById(`ctx-badge-${view}`);
  if (el) el.textContent = ctxSummary(view);
}
