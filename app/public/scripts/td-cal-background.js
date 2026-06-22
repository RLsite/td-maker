// ══════════════════════════ CALIBRATION BACKGROUND SUBTRACTION ══════════════
// Hartley & Zisserman Ch.4 — DLT Homography for planar background subtraction
// The calibration sheet is a KNOWN reference pattern (grid 10×10mm squares).
// User marks 4 corners of the grid in the photo → compute homography →
// warp the known pattern to match photo perspective → subtract → object mask.
//
// Calibration sheet grid bounds (in mm, matching calibration.html constants):
const CAL_GR = { X:24, Y:20, W:181, H:150 }; // grid top-left, size in mm
// 4 corners (mm): UL, UR, DR, DL
const CAL_CORNERS_MM = [
  {x: CAL_GR.X,           y: CAL_GR.Y},
  {x: CAL_GR.X+CAL_GR.W, y: CAL_GR.Y},
  {x: CAL_GR.X+CAL_GR.W, y: CAL_GR.Y+CAL_GR.H},
  {x: CAL_GR.X,           y: CAL_GR.Y+CAL_GR.H},
];

let calBgCorners = [];   // pixel coords clicked by user (canvas pixels)
let calBgActive  = false;

function startCalBgMode() {
  calBgCorners = [];
  calBgActive  = true;
  const bar = document.getElementById('cal-bg-bar');
  if (bar) bar.style.display='flex';
  _updateCalBgMsg();
  // Add click listener to seg-src canvas
  const c = document.getElementById('seg-src');
  if (c) { c.style.cursor='crosshair'; c.addEventListener('click', _calBgClick); }
}

function calBgCancel() {
  calBgActive = false;
  calBgCorners = [];
  const bar = document.getElementById('cal-bg-bar');
  if (bar) bar.style.display='none';
  const c = document.getElementById('seg-src');
  if (c) { c.style.cursor='default'; c.removeEventListener('click', _calBgClick); }
  _drawCalBgOverlay();
}

const _CORNER_LABELS = ['UL ↖','UR ↗','DR ↘','DL ↙'];

function _updateCalBgMsg() {
  const el = document.getElementById('cal-bg-msg');
  if (!el) return;
  const n = calBgCorners.length;
  if (n < 4) el.textContent = `Click corner ${n+1}/4: ${_CORNER_LABELS[n]}`;
  else el.textContent = 'Computing background subtraction…';
}

function _calBgClick(e) {
  if (!calBgActive) return;
  const c = document.getElementById('seg-src');
  const rc = c.getBoundingClientRect();
  // Convert screen coords to canvas pixel coords
  const px = (e.clientX - rc.left) * (c.width / rc.width);
  const py = (e.clientY - rc.top)  * (c.height / rc.height);
  calBgCorners.push({x:px, y:py});
  _drawCalBgOverlay();
  _updateCalBgMsg();
  if (calBgCorners.length === 4) {
    c.removeEventListener('click', _calBgClick);
    setTimeout(() => runCalBgSubtract(), 50);
  }
}

function _drawCalBgOverlay() {
  const ov = document.getElementById('seg-cal-overlay');
  if (!ov) return;
  const src = document.getElementById('seg-src');
  ov.width = src.width; ov.height = src.height;
  const ctx = ov.getContext('2d');
  ctx.clearRect(0,0,ov.width,ov.height);
  if (!calBgCorners.length) return;
  // Draw corner dots + connecting polygon
  calBgCorners.forEach((p,i) => {
    ctx.beginPath(); ctx.arc(p.x, p.y, 7, 0, Math.PI*2);
    ctx.fillStyle='#FCD34D'; ctx.fill();
    ctx.strokeStyle='#92400E'; ctx.lineWidth=1.5; ctx.stroke();
    ctx.fillStyle='#1e1b12'; ctx.font='bold 11px sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText(i+1, p.x, p.y);
  });
  if (calBgCorners.length >= 2) {
    ctx.beginPath(); ctx.moveTo(calBgCorners[0].x, calBgCorners[0].y);
    for (let i=1; i<calBgCorners.length; i++) ctx.lineTo(calBgCorners[i].x, calBgCorners[i].y);
    if (calBgCorners.length === 4) ctx.closePath();
    ctx.strokeStyle='rgba(252,211,77,.7)'; ctx.lineWidth=1.5; ctx.setLineDash([4,3]); ctx.stroke(); ctx.setLineDash([]);
  }
}

// ── DLT Homography (Hartley & Zisserman §4.1) ─────────────────────────
// Computes 3×3 homography H such that dst_i ≈ H · src_i (homogeneous)
// Requires exactly 4 point correspondences.
// Sets h[8]=1 and solves 8×8 linear system via Gaussian elimination.
function computeHomography4pt(src, dst) {
  // Build 8×8 matrix A and RHS b (8 equations, h[8]=1 fixed)
  const A = [], b = [];
  for (let i=0;i<4;i++) {
    const {x, y} = src[i], {x:xp, y:yp} = dst[i];
    A.push([-x,-y,-1, 0, 0, 0, xp*x, xp*y]); b.push(-xp);
    A.push([ 0, 0, 0,-x,-y,-1, yp*x, yp*y]); b.push(-yp);
  }
  // Gaussian elimination with partial pivoting
  const n=8;
  const M = A.map((row,i) => [...row, b[i]]);
  for (let col=0;col<n;col++) {
    // Find pivot
    let maxR=col;
    for (let r=col+1;r<n;r++) if (Math.abs(M[r][col])>Math.abs(M[maxR][col])) maxR=r;
    [M[col],M[maxR]]=[M[maxR],M[col]];
    const piv=M[col][col]; if (Math.abs(piv)<1e-12) continue;
    for (let r=0;r<n;r++) {
      if (r===col) continue;
      const f=M[r][col]/piv;
      for (let c=col;c<=n;c++) M[r][c]-=f*M[col][c];
    }
    for (let c=col;c<=n;c++) M[col][c]/=piv;
  }
  const h = M.map(row=>row[n]);
  h.push(1); // h[8]=1
  return h; // [h00,h01,h02, h10,h11,h12, h20,h21,1]
}

// Apply homography H to point (x,y), returns {x,y}
function applyH(H, x, y) {
  const w = H[6]*x + H[7]*y + H[8];
  return { x: (H[0]*x + H[1]*y + H[2]) / w,
           y: (H[3]*x + H[4]*y + H[5]) / w };
}

// ── Render calibration sheet grid to offscreen canvas ─────────────────
// Returns an ImageData with the expected background pattern in mm coordinates
// rendered at SCALE px/mm.
function renderCalibrationBg(W_mm, H_mm, scale=2) {
  const W = Math.round(W_mm*scale), H = Math.round(H_mm*scale);
  const tmp = document.createElement('canvas'); tmp.width=W; tmp.height=H;
  const ctx = tmp.getContext('2d');

  // White background
  ctx.fillStyle='#ffffff'; ctx.fillRect(0,0,W,H);

  // Checkerboard grid (alternating light-gray squares 10×10mm)
  const G = CAL_GR, S=scale;
  for (let row=0; row<Math.ceil(G.H/10); row++) {
    for (let col=0; col<Math.ceil(G.W/10); col++) {
      if ((row+col)%2===0) {
        ctx.fillStyle='#ebebeb';
        ctx.fillRect((G.X+col*10)*S, (G.Y+row*10)*S, 10*S, 10*S);
      }
    }
  }
  // Grid lines (1mm resolution major grid every 10mm)
  ctx.strokeStyle='#cccccc'; ctx.lineWidth=0.4;
  for (let mm=0; mm<=G.W; mm++) {
    const isMaj=mm%10===0, is5=mm%5===0;
    ctx.strokeStyle=isMaj?'#999':is5?'#bbb':'#ddd';
    ctx.lineWidth=isMaj?0.7:0.3;
    ctx.beginPath();
    ctx.moveTo((G.X+mm)*S, G.Y*S); ctx.lineTo((G.X+mm)*S, (G.Y+G.H)*S); ctx.stroke();
  }
  for (let mm=0; mm<=G.H; mm++) {
    const isMaj=mm%10===0, is5=mm%5===0;
    ctx.strokeStyle=isMaj?'#999':is5?'#bbb':'#ddd';
    ctx.lineWidth=isMaj?0.7:0.3;
    ctx.beginPath();
    ctx.moveTo(G.X*S, (G.Y+mm)*S); ctx.lineTo((G.X+G.W)*S, (G.Y+mm)*S); ctx.stroke();
  }

  return { imgData: ctx.getImageData(0,0,W,H), W, H, scale };
}

// ── Main: run calibration background subtraction ──────────────────────
function runCalBgSubtract() {
  if (!S.segImgData || calBgCorners.length < 4) return;
  const PW = segOut.width, PH = segOut.height;

  // The user clicked on the seg-src canvas which has the same resolution as segImgData
  const SW = segSrc.width, SH = segSrc.height;
  const scX = PW/SW, scY = PH/SH; // src canvas to pixel space scale
  // Scale corner clicks to full resolution
  const dstPts = calBgCorners.map(p=>({x:p.x*scX, y:p.y*scY}));

  // Source (calibration mm) — 4 corners of the grid in mm
  // Need to map mm to the rendered calibration image pixels at scale=2
  const CAL_SCALE = 2; // px per mm in our rendered reference
  const srcPts = CAL_CORNERS_MM.map(p=>({x:p.x*CAL_SCALE, y:p.y*CAL_SCALE}));

  // Homography: rendered_cal_pixels → photo_pixels
  const H = computeHomography4pt(srcPts, dstPts);
  // Inverse: photo_pixels → rendered_cal_pixels
  const H_inv = computeHomography4pt(dstPts, srcPts);

  // Render calibration background at CAL_SCALE px/mm
  const {imgData: calImgData, W: CW, H: CH} = renderCalibrationBg(210, 297, CAL_SCALE);
  const calGray = new Uint8ClampedArray(CW*CH);
  for (let i=0;i<CW*CH;i++)
    calGray[i]=calImgData.data[i*4]*.299+calImgData.data[i*4+1]*.587+calImgData.data[i*4+2]*.114;

  // Photo grayscale
  const pSrc = S.segImgData.data;
  const photoGray = new Uint8ClampedArray(PW*PH);
  for (let i=0;i<PW*PH;i++)
    photoGray[i]=pSrc[i*4]*.299+pSrc[i*4+1]*.587+pSrc[i*4+2]*.114;

  // For each photo pixel: sample warped calibration background → compute diff
  const THRESH = 30; // difference threshold (0-255)
  const out = segCtxO.createImageData(PW, PH);

  for (let py=0; py<PH; py++) for (let px=0; px<PW; px++) {
    // Map photo pixel → calibration canvas pixel
    const {x:cx, y:cy} = applyH(H_inv, px, py);
    const cxi=Math.round(cx), cyi=Math.round(cy);

    let bgVal;
    if (cxi>=0 && cxi<CW && cyi>=0 && cyi<CH) {
      bgVal = calGray[cyi*CW+cxi];
    } else {
      bgVal = 255; // outside cal sheet = assume white bg
    }

    const diff = Math.abs(photoGray[py*PW+px] - bgVal);
    const v = diff > THRESH ? 255 : 0;
    const i = (py*PW+px)*4;
    out.data[i]=out.data[i+1]=out.data[i+2]=v; out.data[i+3]=255;
  }
  segCtxO.putImageData(out, 0, 0);

  // Save as segmentation mask for this view
  if (!S.segMasks) S.segMasks = {};
  const mask = new Uint8ClampedArray(PW*PH);
  for (let i=0;i<PW*PH;i++) mask[i]=out.data[i*4]>128?255:0;
  S.segMasks[S.segView]={mask,W:PW,H:PH};
  _updateSegMeta(S.segView, mask, PW, PH);
  _updateContourSegBadges();

  // Also extract scale from homography: pixels per mm
  // Distance between TL and TR in photo / CAL_GR.W mm
  const d=Math.sqrt((dstPts[1].x-dstPts[0].x)**2+(dstPts[1].y-dstPts[0].y)**2);
  const ppm=d/CAL_GR.W;
  if (ppm>0.1) {
    if (!S.scale) S.scale={};
    S.scale[S.segView]=ppm;
    console.log(`Calibration: ${ppm.toFixed(2)} px/mm`);
  }

  calBgCancel();

}