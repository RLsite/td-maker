// ══════════════════════════ STEP 1: UPLOAD ══════════════════════════
function triggerUpload(v) { document.getElementById(`input-${v}`).click(); }

function handleUpload(e, v) {
  const file = e.target.files[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  // Save the raw File directly — avoids the fetch(blobUrl) round-trip that can fail silently
  IDB.put(`img-${v}`, file).catch(err => console.error('[TD] IDB save failed for', v, err));
  setImg(v, url, false, true /* skipPersistImg */);
}

function setImg(v, url, isRestore = false, skipPersistImg = false) {
  S.imgs[v] = url;
  const img = new Image();
  img.onload = () => {
    document.getElementById(`preview-${v}`).src = url;
    document.getElementById(`preview-${v}`).style.display = 'block';
    document.getElementById(`placeholder-${v}`).style.display = 'none';
    const del = document.getElementById(`delete-${v}`);
    if (del) del.style.display = 'flex';
    if (!isRestore) _analyzeImg(v, img);
  };
  img.src = url;
  const zone = document.querySelector(`.upload-zone[data-view="${v}"]`);
  if (zone) { zone.style.borderColor = 'var(--teal)'; zone.style.borderStyle = 'solid'; }
  const cropBtn = document.getElementById(`crop-${v}`);
  if (cropBtn) cropBtn.style.display = 'flex';
  const autoCropBtn = document.getElementById(`autocrop-${v}`);
  if (autoCropBtn) autoCropBtn.style.display = 'flex';
  // Don't call persistImg during restore (already in IDB) or when caller handles it directly
  if (!isRestore && !skipPersistImg) persistImg(v, url);
  checkUploads();
  if (!isRestore) persistState();

  // Depth map is triggered on entry to Background Separation (onActivate(2)) — not here,
  // to avoid blocking the upload/crop step with background ONNX inference.
}

function deleteImg(v) {
  S.imgs[v] = null;
  document.getElementById(`preview-${v}`).src = '';
  document.getElementById(`preview-${v}`).style.display = 'none';
  document.getElementById(`placeholder-${v}`).style.display = 'flex';
  const del = document.getElementById(`delete-${v}`);
  if (del) del.style.display = 'none';
  document.getElementById(`input-${v}`).value = '';
  const zone = document.querySelector(`.upload-zone[data-view="${v}"]`);
  zone.style.borderColor = 'var(--border)';
  zone.style.borderStyle = 'dashed';
  const cropBtn2 = document.getElementById(`crop-${v}`);
  if (cropBtn2) cropBtn2.style.display = 'none';
  const autoCropBtn2 = document.getElementById(`autocrop-${v}`);
  if (autoCropBtn2) autoCropBtn2.style.display = 'none';
  persistImg(v, null);
  checkUploads();
}

// Guarantees S.segMasks[view] exists before the contour step needs it.
// If missing, auto-computes the mask from the image using the stored threshold.
// Calls callback() when ready (synchronously if mask already exists).
function _ensureSegMask(view, callback) {
  if (S.segMasks?.[view] || !S.imgs[view]) { callback(); return; }
  const img = new Image();
  img.onload = () => {
    const maxW=900, maxH=700;
    const r = Math.min(maxW/img.width, maxH/img.height, 1);
    const W = Math.round(img.width*r), H = Math.round(img.height*r);
    const tmp = document.createElement('canvas'); tmp.width=W; tmp.height=H;
    const ctx = tmp.getContext('2d'); ctx.drawImage(img,0,0,W,H);
    const src = ctx.getImageData(0,0,W,H).data;
    const t = segThresholds[view] ?? 120;
    const mode = segModes[view] ?? 'dark';
    let mask = new Uint8ClampedArray(W*H);
    for (let i=0; i<W*H; i++) {
      const g = src[i*4]*.299 + src[i*4+1]*.587 + src[i*4+2]*.114;
      mask[i] = (mode==='dark' ? g<t : g>t) ? 255 : 0;
    }
    mask = _removeBorderConnected(mask, W, H);
    if (!S.segMasks) S.segMasks = {};
    S.segMasks[view] = { mask, W, H };
    _updateSegMeta(view, mask, W, H, img.width, img.height);
    if (!S.segMaskImproved?.[view] && typeof _improveSegFromISO === 'function') {
      _improveSegFromISO(view);
    }
    callback();
  };
  img.src = S.imgs[view];
}

// Runs on fresh upload (not session-restore). Extracts natural dimensions and
// computes an Otsu threshold suggestion so step 2 starts with a sensible value.
function _analyzeImg(view, img) {
  S.imgMeta[view] = {
    W: img.naturalWidth,
    H: img.naturalHeight,
    aspect: img.naturalWidth / (img.naturalHeight || 1),
  };
  const SZ = 200;
  const r = Math.min(SZ / img.width, SZ / img.height, 1);
  const tmp = document.createElement('canvas');
  tmp.width = Math.round(img.width * r); tmp.height = Math.round(img.height * r);
  const ctx = tmp.getContext('2d');
  ctx.drawImage(img, 0, 0, tmp.width, tmp.height);
  const data = ctx.getImageData(0, 0, tmp.width, tmp.height).data;
  const n = tmp.width * tmp.height;
  const hist = new Int32Array(256);
  for (let i = 0; i < n; i++) hist[Math.round(data[i*4]*.299 + data[i*4+1]*.587 + data[i*4+2]*.114)]++;
  let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, maxV = 0, thresh = 128;
  for (let i = 0; i < 256; i++) {
    wB += hist[i]; if (!wB) continue;
    const wF = n - wB; if (!wF) break;
    sumB += i * hist[i];
    const sc = wB * wF * ((sumB/wB) - (sum-sumB)/wF) ** 2;
    if (sc > maxV) { maxV = sc; thresh = i; }
  }
  S.imgMeta[view].suggestedThreshold = thresh;
  segThresholds[view] = thresh;
  // Layer 1: raw image intelligence
  ctxWrite(view, 'raw', { W: img.naturalWidth, H: img.naturalHeight,
    aspect: img.naturalWidth / (img.naturalHeight || 1),
    suggestedThreshold: thresh });
}

// Computes silhouette bounding-box + pixel area and stores in S.segMeta[view].
// origW/origH: the original (unscaled) image dimensions — used for correct px→mm conversion.
function _updateSegMeta(view, mask, W, H, origW, origH) {
  let mnX = W, mnY = H, mxX = 0, mxY = 0, area = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (mask[y*W+x]) {
      area++;
      if (x < mnX) mnX = x; if (x > mxX) mxX = x;
      if (y < mnY) mnY = y; if (y > mxY) mxY = y;
    }
  }
  S.segMeta[view] = (mxX > mnX && mxY > mnY)
    ? { bbox: { minX: mnX, minY: mnY, maxX: mxX, maxY: mxY }, area, W, H,
        origW: origW ?? W, origH: origH ?? H }
    : null;
}

function checkUploads() {
  const n = [S.imgs.front, S.imgs.side, S.imgs.top].filter(Boolean).length;
  document.getElementById('upload-status').textContent = n === 3 ? '✓ All 3 images uploaded — ready to continue' : `${n} of 3 images uploaded`;
  document.getElementById('upload-status').style.color = n === 3 ? 'var(--teal-light)' : 'var(--muted)';
  const btn = document.getElementById('step1-next');
  if (!btn) return;
  const ready = n === 3;
  btn.disabled = !ready;
  btn.style.background = ready ? 'var(--orange)' : 'var(--border)';
  btn.style.color = ready ? 'white' : 'var(--muted)';
  btn.style.cursor = ready ? 'pointer' : 'not-allowed';
  if (ready) {
    _quickAnalysis();
  } else {
    const qp = document.getElementById('quick-analysis');
    if (qp) qp.style.display = 'none';
  }
}

// ── Quick Analysis: auto-runs when all 3 images are uploaded ────────────
// Runs Otsu segmentation + ruler detection for each view, computes W×H×D.
function _quickAnalysis() {
  const panel = document.getElementById('quick-analysis');
  if (!panel) return;
  panel.style.display = 'block';
  panel.innerHTML = `<div style="display:flex;align-items:center;gap:10px;color:var(--muted);font-size:13px;">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="animation:spin 1s linear infinite;flex-shrink:0;">
      <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
    </svg>
    Auto-analyzing images…
  </div>`;

  const views = ['front', 'side', 'top'];
  let pending = views.length + 1; // +1 for ISO analysis
  // rulerResults[v] = { periodPx, suggestedMm, ppm, peakCount, confidence }
  const rulerResults = {};

  const finish = () => {
    if (--pending > 0) return;
    S._rulerResults = rulerResults; // keep for re-render after apply
    _showQuickDims(rulerResults);
  };

  // ISO analysis runs in parallel with view analyses
  runIsoFullPipeline(() => finish());

  views.forEach(v => {
    _ensureSegMask(v, () => {
      const url = S.imgs[v];
      if (!url) { finish(); return; }
      const img = new Image();
      img.onload = () => {
        const SZ = 600;
        const sc = Math.min(1, SZ / Math.max(img.width, img.height));
        const W = Math.round(img.width * sc), H = Math.round(img.height * sc);
        const tmp = document.createElement('canvas');
        tmp.width = W; tmp.height = H;
        tmp.getContext('2d').drawImage(img, 0, 0, W, H);
        const src = tmp.getContext('2d').getImageData(0, 0, W, H).data;
        const gray = new Uint8ClampedArray(W * H);
        for (let i = 0; i < W * H; i++) gray[i] = src[i*4]*0.299 + src[i*4+1]*0.587 + src[i*4+2]*0.114;
        const r = detectRulerScale(gray, W, H);
        if (r.confidence > 0 && r.period >= 2) {
          const periodPx = r.period / sc; // period in original image pixels
          const mm = r.suggestedMm;
          const ppm = periodPx / mm;
          rulerResults[v] = { periodPx, suggestedMm: mm, ppm, peakCount: r.peakCount, confidence: r.confidence };
          // Apply immediately with suggested unit — user can correct below
          if (!S.scale) S.scale = {};
          S.scale[v] = ppm;
          if (!measurements[v].length) {
            measurements[v] = [{ px: Math.round(periodPx), mm, ppm }];
            updateScaleAvg();
          }
        }
        finish();
      };
      img.src = url;
    });
  });
}

function _showQuickDims(rulerResults) {
  const panel = document.getElementById('quick-analysis');
  if (!panel) return;

  const model = buildObjectModel();
  const { dims, consistency, issues } = model;
  const hasRuler = Object.values(rulerResults).some(Boolean);

  const fmt = v => v != null ? Math.round(v) + ' mm' : '—';
  function cIcon(c) {
    if (c === null) return '';
    if (c >= 0.90) return `<span style="font-size:10px;color:#10B981;">✓</span>`;
    if (c >= 0.82) return `<span style="font-size:10px;color:#F59E0B;">~</span>`;
    return `<span style="font-size:10px;color:#EF4444;">⚠</span>`;
  }

  // ── Ruler calibration rows ────────────────────────────────────────────────
  const RULER_OPTIONS = [
    [0.5,'0.5 mm'],[1,'1 mm'],[2,'2 mm'],[5,'5 mm'],[10,'10 mm'],
    [25.4,'1 inch'],[50,'50 mm'],[100,'100 mm'],
  ];
  const viewLabel = { front:'Front', side:'Side', top:'Top' };
  const rulerRows = ['front','side','top'].map(v => {
    const r = rulerResults[v];
    if (!r) return `
      <div style="display:flex;align-items:center;gap:8px;padding:4px 0;">
        <span style="font-size:11px;color:var(--border);width:38px;">${viewLabel[v]}</span>
        <span style="font-size:11px;color:var(--border);">No ruler detected</span>
      </div>`;
    const curPpm = S.scale?.[v] ?? r.ppm;
    const opts = RULER_OPTIONS.map(([mm,lbl]) =>
      `<option value="${mm}" ${Math.abs(mm - r.suggestedMm) < 0.01 ? 'selected' : ''}>${lbl}</option>`
    ).join('');
    return `
      <div style="display:flex;align-items:center;gap:8px;padding:4px 0;flex-wrap:wrap;">
        <span style="font-size:11px;font-weight:600;color:var(--subtle);width:38px;">${viewLabel[v]}</span>
        <span style="font-size:11px;color:var(--muted);">${r.peakCount} marks · ${Math.round(r.periodPx)}px/mark →</span>
        <select id="ruler-mm-${v}" style="padding:2px 5px;border-radius:5px;border:1px solid var(--border);background:var(--bg);color:var(--teal-light);font-size:11px;font-weight:600;cursor:pointer;">${opts}</select>
        <button onclick="applyRulerMm('${v}',${r.periodPx})" style="padding:2px 8px;border-radius:5px;border:1px solid var(--teal);background:rgba(13,148,136,.12);color:var(--teal-light);font-size:11px;cursor:pointer;">✓ Apply</button>
        <span id="qs-ppm-${v}" style="font-size:11px;font-family:'Fira Code',monospace;color:var(--muted);">${curPpm.toFixed(1)} px/mm</span>
      </div>`;
  }).join('');

  panel.innerHTML = `
    <div style="margin-bottom:12px;">
      <div style="font-size:11px;font-weight:700;letter-spacing:.07em;color:var(--subtle);text-transform:uppercase;margin-bottom:8px;">
        Ruler Scale Calibration&nbsp;
        ${hasRuler
          ? '<span style="color:#10B981;font-weight:400;">✓ Ruler detected in images</span>'
          : '<span style="color:#F59E0B;font-weight:400;">⚠ No ruler found — set scale in Step 4</span>'}
      </div>
      ${rulerRows}
    </div>
    <div style="display:flex;align-items:flex-start;gap:20px;flex-wrap:wrap;">
      <div>
        <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px;">Object Dimensions</div>
        <div style="display:flex;gap:18px;">
          ${[['H','Height',dims.H,consistency.H],['W','Width',dims.W,consistency.W],['D','Depth',dims.D,consistency.D]].map(([,lbl,val,c]) => `
            <div style="text-align:center;">
              <div style="font-size:10px;color:var(--muted);margin-bottom:2px;">${lbl}</div>
              <div style="font-size:22px;font-weight:700;font-family:'Fira Code',monospace;color:${val?'var(--teal-light)':'var(--border)'};">${fmt(val)}</div>
              <div style="margin-top:2px;">${cIcon(c)}</div>
            </div>
          `).join('')}
        </div>
      </div>
      ${issues.length ? `
        <div style="flex:1;min-width:180px;">
          <div style="font-size:11px;color:#F59E0B;background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.2);border-radius:6px;padding:6px 10px;line-height:1.9;">
            ${issues.map(i=>`⚠ <b>${i.dim}</b> (${i.views}): ${i.a} mm vs ${i.b} mm`).join('<br>')}
          </div>
        </div>` : ''}
    </div>
    ${S.imgs?.iso ? _isoAnalysisBanner(S.isoAnalysis) : ''}`;
}

// Apply a confirmed ruler unit for one view, rebuild model, re-render.
function applyRulerMm(view, periodPx) {
  const mm = +document.getElementById(`ruler-mm-${view}`)?.value;
  if (!mm || !periodPx) return;
  if (!S.scale) S.scale = {};
  S.scale[view] = periodPx / mm;
  measurements[view] = [{ px: Math.round(periodPx), mm, ppm: periodPx / mm }];
  updateScaleAvg();
  // Update the px/mm display inline
  const el = document.getElementById(`qs-ppm-${view}`);
  if (el) el.textContent = (periodPx / mm).toFixed(1) + ' px/mm';
  // Rebuild model + re-run full ISO pipeline with updated scale
  runIsoFullPipeline(() => {
    _showQuickDims(S._rulerResults || {});
  });
  _renderModelBar(document.getElementById('seg-model-bar'));
  persistState();
}

// Drag-drop + init
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.upload-zone').forEach(z => {
    z.addEventListener('dragover', e => { e.preventDefault(); z.style.borderColor = 'var(--teal)'; });
    z.addEventListener('dragleave', () => { if (!S.imgs[z.dataset.view]) z.style.borderColor = 'var(--border)'; });
    z.addEventListener('drop', e => {
      e.preventDefault();
      const f = e.dataTransfer.files[0];
      if (f?.type.startsWith('image/')) handleUpload({ target: { files: [f] } }, z.dataset.view);
    });
  });

  // Auto-collapse sidebar on narrow viewports
  if (window.innerWidth <= 900) {
    const sb = document.getElementById('sidebar');
    if (sb) { sb.style.width='0'; sb.style.padding='0'; sb.dataset.collapsed='1'; }
    const btn = document.getElementById('sidebar-toggle');
    if (btn) btn.style.color = 'var(--teal-light)';
  }

  // Rebuild contour canvas on window resize (debounced)
  let _resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(() => {
      if (S.step === 3) initContour();
      if (S.step === 4) initScale();
    }, 200);
  });

  // ResizeObserver for canvas wrappers (handles sidebar toggle etc.)
  const wrap = document.getElementById('contour-canvas-wrap');
  if (wrap && typeof ResizeObserver !== 'undefined') {
    let _roTimer;
    new ResizeObserver(() => {
      if (S.step !== 3) return;
      clearTimeout(_roTimer);
      _roTimer = setTimeout(initContour, 150);
    }).observe(wrap);
  }
  const scaleWrap = document.getElementById('scale-canvas-wrap');
  if (scaleWrap && typeof ResizeObserver !== 'undefined') {
    let _scaleRoTimer;
    new ResizeObserver(() => {
      if (S.step !== 4) return;
      clearTimeout(_scaleRoTimer);
      _scaleRoTimer = setTimeout(initScale, 150);
    }).observe(scaleWrap);
  }

  buildSidebar();
  // Sync collapsed state with actual initial width (media query may have hidden it)
  const _sb = document.getElementById('sidebar');
  if (_sb && _sb.offsetWidth === 0) _sb.dataset.collapsed = '1';
  restoreSession();

  // Pre-warm Depth-Anything v2 model in background — first-time download ~50 MB,
  // subsequent launches use IndexedDB cache and are near-instant.
  if (typeof preloadDepthModel === 'function') preloadDepthModel();

  // Save state immediately before the page unloads (refresh / tab close)
  window.addEventListener('beforeunload', () => { persistState(); });
});

