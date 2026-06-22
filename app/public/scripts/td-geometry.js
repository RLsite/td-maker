// ══════════════════════════ GEOMETRY — Shapely-equivalent pure-JS ══════════════════════════
// geoConvexHull   — convex_hull
// geoOffsetPolygon — buffer
// geoOffsetCurve  — offset_curve  (for CNC paths)
// geoMakeValid    — make_valid    (remove self-intersections)
// geoArea         — .area
// geoPerimeter    — .length
// geoSegIntersect — segment × segment
// geoPointInPoly  — point-in-polygon (winding number)

// ─── Signed area (Shoelace) ───────────────────────────────────────────────────
// Positive = CCW, Negative = CW
function geoArea(pts) {
  let a = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
  }
  return a / 2;
}

// ─── Perimeter ────────────────────────────────────────────────────────────────
function geoPerimeter(pts) {
  let p = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    p += Math.hypot(pts[j].x - pts[i].x, pts[j].y - pts[i].y);
  }
  return p;
}

// ─── Segment intersection ─────────────────────────────────────────────────────
// Returns {x,y,t,u} where t ∈ [0,1] on a1→a2 and u ∈ [0,1] on b1→b2, or null
function geoSegIntersect(a1, a2, b1, b2) {
  const dx1 = a2.x - a1.x, dy1 = a2.y - a1.y;
  const dx2 = b2.x - b1.x, dy2 = b2.y - b1.y;
  const denom = dx1 * dy2 - dy1 * dx2;
  if (Math.abs(denom) < 1e-10) return null;
  const dx3 = b1.x - a1.x, dy3 = b1.y - a1.y;
  const t = (dx3 * dy2 - dy3 * dx2) / denom;
  const u = (dx3 * dy1 - dy3 * dx1) / denom;
  if (t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9) {
    return { x: a1.x + t * dx1, y: a1.y + t * dy1, t, u };
  }
  return null;
}

// ─── Point in polygon ─────────────────────────────────────────────────────────
// Winding number — robust, works with holes
function geoPointInPoly(pt, poly) {
  let w = 0;
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    if (a.y <= pt.y) {
      if (b.y > pt.y && (b.x - a.x) * (pt.y - a.y) - (pt.x - a.x) * (b.y - a.y) > 0) w++;
    } else {
      if (b.y <= pt.y && (b.x - a.x) * (pt.y - a.y) - (pt.x - a.x) * (b.y - a.y) < 0) w--;
    }
  }
  return w !== 0;
}

// ─── Convex Hull — Andrew's Monotone Chain O(n log n) ────────────────────────
// Equivalent to Shapely's .convex_hull
function geoConvexHull(pts) {
  if (pts.length < 3) return [...pts];
  const s = [...pts].sort((a, b) => a.x !== b.x ? a.x - b.x : a.y - b.y);
  const cross = (O, A, B) => (A.x - O.x) * (B.y - O.y) - (A.y - O.y) * (B.x - O.x);
  const lo = [], hi = [];
  for (const p of s) {
    while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop();
    lo.push(p);
  }
  for (let i = s.length - 1; i >= 0; i--) {
    const p = s[i];
    while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], p) <= 0) hi.pop();
    hi.push(p);
  }
  lo.pop(); hi.pop();
  return [...lo, ...hi];
}

// ─── Make Valid — remove self-intersections ────────────────────────────────────
// Equivalent to Shapely's make_valid()
// Splits at first self-intersection and returns the larger sub-polygon.
// Recurses until no intersections remain.
function geoMakeValid(pts) {
  const n = pts.length;
  if (n < 3) return pts;
  for (let i = 0; i < n; i++) {
    const a1 = pts[i], a2 = pts[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // adjacent closing edge
      const b1 = pts[j], b2 = pts[(j + 1) % n];
      const ix = geoSegIntersect(a1, a2, b1, b2);
      if (!ix) continue;
      const p = { x: ix.x, y: ix.y };
      // Two sub-polygons at the intersection
      const sub1 = [p, ...pts.slice(i + 1, j + 1)];
      const sub2 = [p, ...pts.slice(j + 1), ...pts.slice(0, i + 1)];
      const best = Math.abs(geoArea(sub1)) >= Math.abs(geoArea(sub2)) ? sub1 : sub2;
      return geoMakeValid(best);
    }
  }
  return pts; // already valid
}

// ─── Offset Polygon — buffer ──────────────────────────────────────────────────
// Equivalent to Shapely's .buffer(distance)
// Moves each vertex outward (distPx > 0) or inward (< 0) along the bisector.
// Works well for most convex and mildly concave shapes.
function geoOffsetPolygon(pts, distPx) {
  const n = pts.length;
  if (n < 3 || distPx === 0) return [...pts];

  // Normalise to CCW so outward normals are consistent
  let work = [...pts];
  if (geoArea(work) < 0) work.reverse();

  const result = [];
  for (let i = 0; i < n; i++) {
    const prev = work[(i - 1 + n) % n];
    const curr = work[i];
    const next = work[(i + 1) % n];

    const e1x = curr.x - prev.x, e1y = curr.y - prev.y;
    const e2x = next.x - curr.x, e2y = next.y - curr.y;
    const l1 = Math.hypot(e1x, e1y) || 1;
    const l2 = Math.hypot(e2x, e2y) || 1;

    // Left-hand outward normal of each CCW edge
    const n1x = -e1y / l1, n1y = e1x / l1;
    const n2x = -e2y / l2, n2y = e2x / l2;

    // Average bisector normal at vertex
    const bx = n1x + n2x, by = n1y + n2y;
    const bl = Math.hypot(bx, by) || 1;

    // Scale so we maintain exactly distPx from both edges
    const dot = (bx / bl) * n1x + (by / bl) * n1y;
    const scale = Math.abs(dot) < 0.15 ? 1 / 0.15 : 1 / dot;
    const s = Math.min(Math.abs(scale), 8) * Math.sign(scale);

    result.push({
      x: curr.x + (bx / bl) * distPx * s,
      y: curr.y + (by / bl) * distPx * s,
    });
  }
  return result;
}

// ─── Offset Curve — parallel open polyline (CNC tool path) ───────────────────
// Equivalent to Shapely's LineString.offset_curve(distance)
// distPx > 0 = left of direction, < 0 = right
function geoOffsetCurve(pts, distPx) {
  const n = pts.length;
  if (n < 2) return [...pts];

  // Per-vertex outward normal along open path
  const normals = pts.map((p, i) => {
    let dx, dy;
    if (i === 0) {
      dx = pts[1].x - pts[0].x; dy = pts[1].y - pts[0].y;
    } else if (i === n - 1) {
      dx = pts[n-1].x - pts[n-2].x; dy = pts[n-1].y - pts[n-2].y;
    } else {
      // Average of adjacent edge directions
      const dx1 = pts[i].x - pts[i-1].x, dy1 = pts[i].y - pts[i-1].y;
      const l1 = Math.hypot(dx1, dy1) || 1;
      const dx2 = pts[i+1].x - pts[i].x, dy2 = pts[i+1].y - pts[i].y;
      const l2 = Math.hypot(dx2, dy2) || 1;
      const nx1 = -dy1/l1, ny1 = dx1/l1;
      const nx2 = -dy2/l2, ny2 = dx2/l2;
      const bx = nx1+nx2, by = ny1+ny2;
      const bl = Math.hypot(bx, by) || 1;
      const dot = (bx/bl)*nx1 + (by/bl)*ny1;
      const s = Math.abs(dot) < 0.15 ? 1/0.15 : 1/dot;
      return { nx: bx/bl*Math.min(Math.abs(s),6)*Math.sign(s), ny: by/bl*Math.min(Math.abs(s),6)*Math.sign(s) };
    }
    const l = Math.hypot(dx, dy) || 1;
    return { nx: -dy/l, ny: dx/l };
  });

  return pts.map((p, i) => ({
    x: p.x + normals[i].nx * distPx,
    y: p.y + normals[i].ny * distPx,
  }));
}

// ─── UI handlers called from contour step ─────────────────────────────────────

// convex_hull: from segmentation mask boundary pixels → polygon
function applyConvexHull() {
  const v = S.contourView;
  let hullPts;

  const seg = S.segMasks?.[v];
  if (seg) {
    // Sample every boundary pixel of the segmentation mask
    const { mask, W, H } = seg;
    const bpts = [];
    for (let y = 0; y < H; y += 2) {
      for (let x = 0; x < W; x += 2) {
        if (!mask[y * W + x]) continue;
        const isBoundary =
          (x > 0 && !mask[y*W + x-1]) || (x < W-1 && !mask[y*W + x+1]) ||
          (y > 0 && !mask[(y-1)*W + x]) || (y < H-1 && !mask[(y+1)*W + x]);
        if (isBoundary) bpts.push({ x, y });
      }
    }
    if (bpts.length < 3) return;
    hullPts = geoConvexHull(bpts);
    if (!S.polyCanvasSize) S.polyCanvasSize = {};
    S.polyCanvasSize[v] = { w: W, h: H };
  } else {
    const poly = S.polys[v];
    if (!poly || poly.pts.length < 3) return;
    hullPts = geoConvexHull(poly.pts);
  }

  if (hullPts.length < 3) return;
  S.polys[v] = { pts: hullPts, closed: true };
  drawContour(); updateContourInfo(); persistState();
  _flashBtn('hull-btn');
}

// make_valid: remove self-intersections from current contour
function applyMakeValid() {
  const v = S.contourView;
  const poly = S.polys[v];
  if (!poly || poly.pts.length < 3) return;
  const fixed = geoMakeValid(poly.pts);
  if (fixed.length >= 3) {
    S.polys[v] = { pts: fixed, closed: true };
    drawContour(); updateContourInfo(); persistState();
    _flashBtn('fix-btn');
  }
}

// buffer: offset polygon by N mm inward or outward
function applyBuffer() {
  const v = S.contourView;
  const poly = S.polys[v];
  const ppm  = S.scale[v];
  const mmEl = document.getElementById('buf-mm');
  if (!poly || poly.pts.length < 3 || !mmEl) return;
  const mm     = parseFloat(mmEl.value) || 0;
  const distPx = ppm ? mm * ppm : mm; // fallback: treat mm as px if no scale
  const result = geoOffsetPolygon(poly.pts, distPx);
  if (result.length >= 3) {
    S.polys[v] = { pts: result, closed: true };
    drawContour(); updateContourInfo(); persistState();
  }
}

function _flashBtn(id) {
  const b = document.getElementById(id);
  if (!b) return;
  const orig = b.style.color;
  b.style.color = '#14B8A6';
  setTimeout(() => { b.style.color = orig; }, 800);
}

// ─── vpype-style line merge (vpype `linemerge`) ───────────────────────────────
// Merges collinear, nearby line segments into longer ones.
// segments: [{x1,y1,x2,y2}]  angleTolDeg: max angle diff to merge (default 5°)
// distTol: max perpendicular distance + gap in pixels (default 8)
function geoLineMerge(segments, angleTolDeg = 5, distTol = 8) {
  if (!segments.length) return [];
  const tolRad = angleTolDeg * Math.PI / 180;

  // Normalise: angle in [0,π), ensure canonical direction
  const S2 = segments.map(s => {
    let a = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
    if (a < 0) a += Math.PI;
    if (a >= Math.PI) a -= Math.PI;
    return (s.x1 > s.x2 || (s.x1 === s.x2 && s.y1 > s.y2))
      ? { x1: s.x2, y1: s.y2, x2: s.x1, y2: s.y1, angle: a }
      : { ...s, angle: a };
  });

  const used = new Uint8Array(S2.length);
  const result = [];

  for (let i = 0; i < S2.length; i++) {
    if (used[i]) continue;
    const group = [S2[i]]; used[i] = 1;
    const a = S2[i];
    const dx = Math.cos(a.angle), dy = Math.sin(a.angle);
    const len0 = Math.hypot(a.x2 - a.x1, a.y2 - a.y1) || 1;

    for (let j = i + 1; j < S2.length; j++) {
      if (used[j]) continue;
      const b = S2[j];
      // Angle similarity
      let da = Math.abs(a.angle - b.angle);
      if (da > Math.PI / 2) da = Math.PI - da;
      if (da > tolRad) continue;
      // Perpendicular distance from b midpoint to line a
      const mx = (b.x1 + b.x2) / 2, my = (b.y1 + b.y2) / 2;
      const perp = Math.abs(-(a.y2 - a.y1) * (mx - a.x1) + (a.x2 - a.x1) * (my - a.y1)) / (len0 || 1);
      if (perp > distTol) continue;
      // Along-axis gap between projections
      const t1 = (b.x1 - a.x1) * dx + (b.y1 - a.y1) * dy;
      const t2 = (b.x2 - a.x1) * dx + (b.y2 - a.y1) * dy;
      const tA = (a.x2 - a.x1) * dx + (a.y2 - a.y1) * dy;
      const gap = Math.max(0, Math.min(t1, t2) - tA, -(Math.max(t1, t2)));
      if (gap > distTol) continue;
      group.push(b); used[j] = 1;
    }

    if (group.length === 1) { result.push(group[0]); continue; }

    // Extend to extreme endpoints along direction of first segment
    let tMin = Infinity, tMax = -Infinity, ptMin = null, ptMax = null;
    for (const s of group) {
      for (const [px, py] of [[s.x1, s.y1], [s.x2, s.y2]]) {
        const t = (px - a.x1) * dx + (py - a.y1) * dy;
        if (t < tMin) { tMin = t; ptMin = { x: px, y: py }; }
        if (t > tMax) { tMax = t; ptMax = { x: px, y: py }; }
      }
    }
    result.push({ x1: ptMin.x, y1: ptMin.y, x2: ptMax.x, y2: ptMax.y,
                  angle: a.angle, length: Math.hypot(ptMax.x - ptMin.x, ptMax.y - ptMin.y) });
  }
  return result;
}

// ─── vpype-style line sort (vpype `linesort`) ────────────────────────────────
// Reorders segments to minimise total travel distance — greedy nearest-neighbour.
// Also flips segment direction when the end point is closer than the start.
function geoLineSort(segments) {
  if (segments.length <= 1) return [...segments];
  const used = new Uint8Array(segments.length);
  const result = [segments[0]]; used[0] = 1;
  let curX = segments[0].x2, curY = segments[0].y2;

  for (let step = 1; step < segments.length; step++) {
    let bestI = -1, bestD = Infinity, flip = false;
    for (let i = 0; i < segments.length; i++) {
      if (used[i]) continue;
      const d1 = Math.hypot(segments[i].x1 - curX, segments[i].y1 - curY);
      const d2 = Math.hypot(segments[i].x2 - curX, segments[i].y2 - curY);
      if (d1 < bestD) { bestD = d1; bestI = i; flip = false; }
      if (d2 < bestD) { bestD = d2; bestI = i; flip = true; }
    }
    if (bestI < 0) break;
    used[bestI] = 1;
    const s = segments[bestI];
    const seg = flip
      ? { ...s, x1: s.x2, y1: s.y2, x2: s.x1, y2: s.y1 }
      : s;
    result.push(seg);
    curX = seg.x2; curY = seg.y2;
  }
  return result;
}
