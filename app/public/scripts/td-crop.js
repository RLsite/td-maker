// ══════════════════════════ CROP ══════════════════════════
const cropS = { view: null, img: null, scaleX: 1, scaleY: 1 };
let cropR = { x1:0, y1:0, x2:0, y2:0 }; // canvas coords
let cropDrag = null;
// drag modes: 'new'|'move'|'nw'|'ne'|'sw'|'se'|'n'|'s'|'e'|'w'

const HANDLE_R = 8;
const HANDLE_CURSORS = {
  nw:'nw-resize', ne:'ne-resize', sw:'sw-resize', se:'se-resize',
  n:'n-resize', s:'s-resize', e:'e-resize', w:'w-resize',
  move:'move', new:'crosshair'
};

// Active document-level drag listeners (kept so closeCrop can remove them)
let _cropDocMove = null, _cropDocUp = null;

function _removeCropDocListeners() {
  if (_cropDocMove) { document.removeEventListener('mousemove', _cropDocMove); _cropDocMove = null; }
  if (_cropDocUp)   { document.removeEventListener('mouseup',   _cropDocUp);   _cropDocUp   = null; }
}

function cropHandleAt(mx, my) {
  const { x1, y1, x2, y2 } = cropR;
  const mx2 = (x1+x2)/2, my2 = (y1+y2)/2;
  const handles = [
    ['nw',x1,y1],['ne',x2,y1],['sw',x1,y2],['se',x2,y2],
    ['n',mx2,y1],['s',mx2,y2],['w',x1,my2],['e',x2,my2]
  ];
  for (const [name,hx,hy] of handles)
    if (Math.hypot(mx-hx, my-hy) <= HANDLE_R+4) return name;
  if (mx>=x1 && mx<=x2 && my>=y1 && my<=y2) return 'move';
  return 'new';
}

function drawCropOverlay() {
  const c = document.getElementById('crop-canvas');
  if (!c || !cropS.img) return;
  const ctx = c.getContext('2d');
  ctx.drawImage(cropS.img, 0, 0, c.width, c.height);

  const { x1, y1, x2, y2 } = cropR;
  const cw = x2-x1, ch = y2-y1;

  // Darken outside
  ctx.fillStyle = 'rgba(0,0,0,.58)';
  ctx.fillRect(0,0,c.width,c.height);
  // Restore crop area from original
  ctx.drawImage(cropS.img, x1, y1, cw, ch, x1, y1, cw, ch);

  // Border
  ctx.strokeStyle = '#14B8A6'; ctx.lineWidth = 1.5;
  ctx.strokeRect(x1+.5, y1+.5, cw-1, ch-1);

  // Rule of thirds
  ctx.strokeStyle = 'rgba(20,184,166,.35)'; ctx.lineWidth = .8;
  [1/3, 2/3].forEach(f => {
    ctx.beginPath(); ctx.moveTo(x1+cw*f, y1); ctx.lineTo(x1+cw*f, y2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x1, y1+ch*f); ctx.lineTo(x2, y1+ch*f); ctx.stroke();
  });

  // Handles
  const mx2=(x1+x2)/2, my2=(y1+y2)/2;
  [[x1,y1],[x2,y1],[x1,y2],[x2,y2],[mx2,y1],[mx2,y2],[x1,my2],[x2,my2]].forEach(([hx,hy]) => {
    ctx.beginPath(); ctx.arc(hx, hy, HANDLE_R, 0, Math.PI*2);
    ctx.fillStyle='#0D9488'; ctx.fill();
    ctx.strokeStyle='white'; ctx.lineWidth=2; ctx.stroke();
  });

  // Size info
  const iw = Math.round((x2-x1)/cropS.scaleX), ih = Math.round((y2-y1)/cropS.scaleY);
  ctx.font='bold 12px Fira Code, monospace'; ctx.fillStyle='#14B8A6'; ctx.textAlign='center';
  ctx.fillText(`${iw} × ${ih}`, (x1+x2)/2, Math.max(y1-8, 14));
}

// Convert a client-space mouse event to canvas pixel coords
function _cropClientToCanvas(e, c) {
  const rc = c.getBoundingClientRect();
  return {
    mx: (e.clientX - rc.left) * (c.width  / rc.width),
    my: (e.clientY - rc.top)  * (c.height / rc.height)
  };
}

function _cropApplyMove(c, mx, my) {
  if (!cropDrag) return;
  const dx = mx - cropDrag.startX, dy = my - cropDrag.startY;
  const o = cropDrag.orig;
  const CW = c.width, CH = c.height;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  if (cropDrag.mode === 'new') {
    cropR = {
      x1: clamp(Math.min(cropDrag.startX, mx), 0, CW),
      y1: clamp(Math.min(cropDrag.startY, my), 0, CH),
      x2: clamp(Math.max(cropDrag.startX, mx), 0, CW),
      y2: clamp(Math.max(cropDrag.startY, my), 0, CH)
    };
  } else if (cropDrag.mode === 'move') {
    const w = o.x2-o.x1, h = o.y2-o.y1;
    const nx1 = clamp(o.x1+dx, 0, CW-w), ny1 = clamp(o.y1+dy, 0, CH-h);
    cropR = { x1:nx1, y1:ny1, x2:nx1+w, y2:ny1+h };
  } else {
    let {x1,y1,x2,y2} = o;
    if (cropDrag.mode.includes('n')) y1 = clamp(o.y1+dy, 0, o.y2-10);
    if (cropDrag.mode.includes('s')) y2 = clamp(o.y2+dy, o.y1+10, CH);
    if (cropDrag.mode.includes('w')) x1 = clamp(o.x1+dx, 0, o.x2-10);
    if (cropDrag.mode.includes('e')) x2 = clamp(o.x2+dx, o.x1+10, CW);
    cropR = {x1, y1, x2, y2};
  }
  drawCropOverlay();
}

function openCrop(view) {
  cropS.view = view;
  const url = S.imgs[view];
  if (!url) return;
  const modal = document.getElementById('crop-modal');
  modal.style.display = 'flex';

  cropS.img = new Image();
  cropS.img.onload = () => {
    const c = document.getElementById('crop-canvas');
    const maxW = window.innerWidth * 0.9, maxH = window.innerHeight * 0.72;
    const r = Math.min(maxW/cropS.img.naturalWidth, maxH/cropS.img.naturalHeight, 1);
    c.width  = Math.round(cropS.img.naturalWidth  * r);
    c.height = Math.round(cropS.img.naturalHeight * r);
    cropS.scaleX = r; cropS.scaleY = r;

    // Default: full image
    cropR = { x1:0, y1:0, x2:c.width, y2:c.height };
    drawCropOverlay();
    attachCropEvents(c);
  };
  cropS.img.src = url;
}

function attachCropEvents(c) {
  // Clean up any leftover document listeners from a previous drag
  _removeCropDocListeners();

  c.onmousedown = (e) => {
    const { mx, my } = _cropClientToCanvas(e, c);
    const mode = cropHandleAt(mx, my);
    cropDrag = { mode, startX:mx, startY:my, orig:{...cropR} };
    c.style.cursor = HANDLE_CURSORS[mode] || 'crosshair';
    e.preventDefault();

    // Track drag on document — drag continues even when mouse leaves the canvas
    document.addEventListener('mousemove', _cropDocMove = (e2) => {
      const { mx: mx2, my: my2 } = _cropClientToCanvas(e2, c);
      _cropApplyMove(c, mx2, my2);
    });
    document.addEventListener('mouseup', _cropDocUp = () => {
      cropDrag = null;
      _removeCropDocListeners();
      // Restore cursor based on current mouse position (best effort)
      c.style.cursor = 'crosshair';
    });
  };

  // Hover cursor (only when not dragging — drag is handled by document listener)
  c.onmousemove = (e) => {
    if (cropDrag) return;
    const { mx, my } = _cropClientToCanvas(e, c);
    c.style.cursor = HANDLE_CURSORS[cropHandleAt(mx, my)] || 'crosshair';
  };

  c.onmouseleave = () => { if (!cropDrag) c.style.cursor = 'crosshair'; };

  // Touch support
  c.ontouchstart = (e) => {
    const t = e.touches[0];
    c.onmousedown({ clientX:t.clientX, clientY:t.clientY, preventDefault:() => e.preventDefault() });
  };
  c.ontouchmove = (e) => {
    const t = e.touches[0];
    if (cropDrag) {
      const { mx, my } = _cropClientToCanvas({ clientX:t.clientX, clientY:t.clientY }, c);
      _cropApplyMove(c, mx, my);
    }
    e.preventDefault();
  };
  c.ontouchend = () => { cropDrag = null; _removeCropDocListeners(); };
}

function resetCropRect() {
  const c = document.getElementById('crop-canvas');
  if (!c) return;
  cropR = { x1:0, y1:0, x2:c.width, y2:c.height };
  drawCropOverlay();
}

function applyCrop() {
  const { x1, y1, x2, y2 } = cropR;
  if ((x2-x1) < 4 || (y2-y1) < 4) return;
  // Convert canvas coords → image coords
  const ix = Math.round(x1 / cropS.scaleX), iy = Math.round(y1 / cropS.scaleY);
  const iw = Math.round((x2-x1) / cropS.scaleX), ih = Math.round((y2-y1) / cropS.scaleY);
  const out = document.createElement('canvas');
  out.width = iw; out.height = ih;
  out.getContext('2d').drawImage(cropS.img, ix, iy, iw, ih, 0, 0, iw, ih);
  out.toBlob(blob => {
    setImg(cropS.view, URL.createObjectURL(blob));
    closeCrop();
  }, 'image/jpeg', 0.95);
}

function closeCrop() {
  document.getElementById('crop-modal').style.display = 'none';
  const c = document.getElementById('crop-canvas');
  if (c) { c.onmousedown=c.onmousemove=c.onmouseleave=c.ontouchstart=c.ontouchmove=c.ontouchend=null; }
  cropDrag = null;
  _removeCropDocListeners();
}

// ── Sub-mask extraction (used when image is cropped to preserve existing data) ─
function _extractSubMask(maskData, box, imgW, imgH) {
  const { mask, W, H } = maskData;
  const mx0 = Math.round(box.x / imgW * W);
  const my0 = Math.round(box.y / imgH * H);
  const mw  = Math.max(1, Math.round(box.w / imgW * W));
  const mh  = Math.max(1, Math.round(box.h / imgH * H));
  const newMask = new Uint8ClampedArray(mw * mh);
  for (let y = 0; y < mh; y++)
    for (let x = 0; x < mw; x++) {
      const sy = my0 + y, sx = mx0 + x;
      if (sy >= 0 && sy < H && sx >= 0 && sx < W)
        newMask[y * mw + x] = mask[sy * W + sx];
    }
  return { mask: newMask, W: mw, H: mh };
}

// Crop one view and transform all dependent data into the new coordinate space.
// Called automatically after scale confirmation (Step 4→5). Safe to call multiple times —
// skips if the detected box is already 95%+ of the image (ruler already removed).
function autoCropPreserveData(view) {
  const url = S.imgs[view];
  if (!url) return;
  const img = new Image();
  img.onload = () => {
    const imgW = img.naturalWidth, imgH = img.naturalHeight;
    const box = _detectCropBox(img);
    if (!box || box.w < 10 || box.h < 10) return;
    if (box.w > imgW * 0.95 && box.h > imgH * 0.95) return; // already clean

    // Transform segmentation masks
    if (S.segMasks?.[view])        S.segMasks[view]        = _extractSubMask(S.segMasks[view],        box, imgW, imgH);
    if (S.segMaskImproved?.[view]) S.segMaskImproved[view] = _extractSubMask(S.segMaskImproved[view], box, imgW, imgH);

    // Transform contour points (polys + holes) from polyCanvasSize coordinates
    const pcs = S.polyCanvasSize?.[view];
    if (pcs && pcs.w > 0 && pcs.h > 0) {
      const sx = pcs.w / imgW, sy = pcs.h / imgH;
      const dx = box.x * sx, dy = box.y * sy;
      const nw = Math.round(box.w * sx), nh = Math.round(box.h * sy);
      const shift = pts => pts.map(p => ({ x: p.x - dx, y: p.y - dy }));
      if (S.polys?.[view]?.pts?.length) S.polys[view].pts = shift(S.polys[view].pts);
      if (S.holes?.[view])              S.holes[view]      = S.holes[view].map(h => shift(h));
      S.polyCanvasSize[view] = { w: nw, h: nh };
    }

    // Depth map is keyed to old URL — delete so it regenerates from the new image
    if (S.depthMaps?.[view]) delete S.depthMaps[view];

    // Crop and save image
    const out = document.createElement('canvas');
    out.width = box.w; out.height = box.h;
    out.getContext('2d').drawImage(img, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
    out.toBlob(blob => setImg(view, URL.createObjectURL(blob)), 'image/jpeg', 0.95);
  };
  img.src = url;
}

// ── Auto-crop: detect object bounding box from image ─────────────────────────
// Uses Otsu threshold + _safeRemoveBorderConnected (removes ruler/border blobs).
// Returns { x, y, w, h } in image pixels, or null if detection fails.
function _detectCropBox(img) {
  const maxW = 600, maxH = 500;
  const r = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight, 1);
  const W = Math.round(img.naturalWidth * r), H = Math.round(img.naturalHeight * r);
  const tmp = document.createElement('canvas');
  tmp.width = W; tmp.height = H;
  const ctx = tmp.getContext('2d');
  ctx.drawImage(img, 0, 0, W, H);
  const src = ctx.getImageData(0, 0, W, H).data;

  // Grayscale
  const gray = new Uint8ClampedArray(W * H);
  for (let i = 0; i < W * H; i++)
    gray[i] = src[i*4] * 0.299 + src[i*4+1] * 0.587 + src[i*4+2] * 0.114;

  // Otsu threshold
  const hist = new Int32Array(256);
  for (let i = 0; i < W * H; i++) hist[gray[i]]++;
  let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, maxV = 0, t = 128;
  for (let i = 0; i < 256; i++) {
    wB += hist[i]; if (!wB) continue;
    const wF = W * H - wB; if (!wF) break;
    sumB += i * hist[i];
    const v = wB * wF * ((sumB / wB) - (sum - sumB) / wF) ** 2;
    if (v > maxV) { maxV = v; t = i; }
  }

  // Try dark object on light background (most common for photos on white/grey bg)
  let mask = new Uint8ClampedArray(W * H);
  for (let i = 0; i < W * H; i++) mask[i] = gray[i] < t ? 255 : 0;
  mask = _safeRemoveBorderConnected(mask, W, H);

  // If result is tiny, try light object on dark background
  let cnt = 0; for (let i = 0; i < mask.length; i++) if (mask[i]) cnt++;
  if (cnt < W * H * 0.02) {
    let maskL = new Uint8ClampedArray(W * H);
    for (let i = 0; i < W * H; i++) maskL[i] = gray[i] > t ? 255 : 0;
    maskL = _safeRemoveBorderConnected(maskL, W, H);
    let cntL = 0; for (let i = 0; i < maskL.length; i++) if (maskL[i]) cntL++;
    if (cntL > cnt) mask = maskL;
  }

  // Bounding box of detected object
  let x0 = W, y0 = H, x1 = 0, y1 = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!mask[y * W + x]) continue;
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (x1 <= x0 || y1 <= y0) return null;

  // Add 5% padding
  const padX = Math.max(4, Math.round((x1 - x0) * 0.05));
  const padY = Math.max(4, Math.round((y1 - y0) * 0.05));
  x0 = Math.max(0, x0 - padX); y0 = Math.max(0, y0 - padY);
  x1 = Math.min(W - 1, x1 + padX); y1 = Math.min(H - 1, y1 + padY);

  // Scale back to original image coords
  return {
    x: Math.round(x0 / r), y: Math.round(y0 / r),
    w: Math.round((x1 - x0) / r), h: Math.round((y1 - y0) / r),
  };
}

// Called from the "✦ Auto" button on the upload card — applies auto-crop immediately
function autoCropView(view) {
  const url = S.imgs[view];
  if (!url) return;
  const img = new Image();
  img.onload = () => {
    const box = _detectCropBox(img);
    if (!box || box.w < 10 || box.h < 10) {
      return alert('Auto Crop: could not detect object — try manual crop');
    }
    const out = document.createElement('canvas');
    out.width = box.w; out.height = box.h;
    out.getContext('2d').drawImage(img, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
    out.toBlob(blob => setImg(view, URL.createObjectURL(blob)), 'image/jpeg', 0.95);
  };
  img.src = url;
}

// Called from the "✦ Auto Detect" button inside the crop modal — sets the crop region
// without applying, so the user can review and adjust before clicking "Crop ✓"
function _autoCropDetect() {
  if (!cropS.img) return;
  const box = _detectCropBox(cropS.img);
  if (!box || box.w < 10 || box.h < 10) {
    alert('Auto Detect: could not locate object — draw crop area manually');
    return;
  }
  // Convert image coords → canvas coords
  cropR = {
    x1: Math.round(box.x * cropS.scaleX),
    y1: Math.round(box.y * cropS.scaleY),
    x2: Math.round((box.x + box.w) * cropS.scaleX),
    y2: Math.round((box.y + box.h) * cropS.scaleY),
  };
  drawCropOverlay();
}
