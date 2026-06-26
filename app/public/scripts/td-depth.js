// ══════════════════════════ DEPTH ESTIMATION ══════════════════════════
// Depth-Anything v2 (Small) via @xenova/transformers (WebAssembly ONNX).
// Model is downloaded once from HuggingFace and cached in IndexedDB (~50 MB).
// Output: S.depthMaps[v] = { data: Float32Array(W*H), W, H }
//   data[i] is in [0, 1] — 1.0 = closest pixel, 0.0 = farthest pixel.
//
// Integration points:
//   _improveSegFromISO   — Source E: remove sure-background (depth < 0.2)
//   _snapToEdges         — depth gradient blended with color gradient for cleaner snap

let _depthPipe       = null;  // cached pipeline instance
let _depthPipeReady  = false; // true after first successful load
let _depthPipeLoading = false;

// ── Module loader — dynamic import (no <script> tag needed) ─────────────────
// @huggingface/transformers v3 ships a proper ES module on jsDelivr.
// Dynamic import() works in all modern browsers without a bundler.
let _tfModule = null;

async function _loadTFModule() {
  if (_tfModule) return _tfModule;

  // Try CDN URLs in order until one succeeds.
  // 1. @huggingface/transformers v3 — official ESM build via jsDelivr (no path = uses package.json "module" field)
  // 2. @xenova/transformers v2 — older but well-tested
  // 3. esm.sh shim — converts any npm package to ESM
  const URLS = [
    'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3',
    'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3/dist/transformers.js',
    'https://esm.sh/@huggingface/transformers@3',
    'https://esm.sh/@xenova/transformers@2',
  ];

  let lastErr;
  for (const url of URLS) {
    try {
      console.log('[depth] trying import:', url);
      _tfModule = await import(url);
      if (_tfModule?.pipeline) {
        console.log('[depth] loaded from:', url);
        return _tfModule;
      }
      // Some CDN bundles wrap exports differently
      _tfModule = _tfModule?.default ?? _tfModule;
      if (_tfModule?.pipeline) {
        console.log('[depth] loaded (default) from:', url);
        return _tfModule;
      }
      throw new Error('pipeline function not found in module');
    } catch (e) {
      console.warn('[depth] import failed:', url, e.message);
      lastErr = e;
      _tfModule = null;
    }
  }
  throw new Error(`Could not load Transformers.js — ${lastErr?.message}`);
}

// ── Pre-warm model in background (called once on app start) ──────────────────
async function preloadDepthModel() {
  if (_depthPipe || _depthPipeLoading) return;
  _depthPipeLoading = true;
  _setDepthStatus(null, 'loading', '⏳ Loading depth model…');
  try {
    const { pipeline, env } = await _loadTFModule();
    env.allowRemoteModels = true;
    env.allowLocalModels  = false;
    _depthPipe = await pipeline('depth-estimation', 'onnx-community/depth-anything-v2-small', {
      progress_callback: info => {
        if (info.status === 'progress' && info.total) {
          const pct = Math.round(info.loaded / info.total * 100);
          _setDepthStatus(null, 'loading', `⏳ Depth model… ${pct}%`);
        }
      }
    });
    _depthPipeReady = true;
    _setDepthStatus(null, 'ready', '✓ Depth model ready');
  } catch (err) {
    _depthPipeLoading = false;
    _depthPipe = null;
    _setDepthStatus(null, 'error', `⚠ ${err.message}`);
  }
  _depthPipeLoading = false;
}

// ── Ensure model loaded — multiple concurrent callers collapse into one ───────
async function _ensureDepthModel() {
  if (_depthPipe) return _depthPipe;
  if (_depthPipeLoading) {
    while (_depthPipeLoading) await new Promise(r => setTimeout(r, 150));
    if (!_depthPipe) throw new Error('Model failed to load');
    return _depthPipe;
  }
  await preloadDepthModel();
  if (!_depthPipe) throw new Error('Model failed to load');
  return _depthPipe;
}

// ── Run depth inference for one view ─────────────────────────────────────────
async function computeDepthMap(view) {
  const url = S.imgs[view];
  if (!url) return;

  // Skip if already computed for this image (url is stable per view)
  if (S.depthMaps?.[view]?._srcUrl === url) return;

  _setDepthStatus(null, 'loading', '⏳ Depth estimation…');
  showProcessing('Running depth estimation…');

  try {
    const pipe = await _ensureDepthModel();

    // Run inference.
    // v3 output: result.predicted_depth is a Tensor { data: Float32Array, dims: [1, H, W] }
    // v2 output: result.depth is a RawImage { data, width, height }
    const result = await pipe(url);
    let data, width, height;
    if (result.predicted_depth) {
      // v3 format — Tensor with dims [1, H, W]
      const t = result.predicted_depth;
      data   = t.data;
      height = t.dims[t.dims.length - 2];
      width  = t.dims[t.dims.length - 1];
    } else {
      // v2 format — RawImage
      ({ data, width, height } = result.depth);
    }

    // Normalize disparity to [0,1] — Depth-Anything outputs relative disparity (higher = closer)
    let dMin = Infinity, dMax = -Infinity;
    for (let i = 0; i < data.length; i++) {
      if (data[i] < dMin) dMin = data[i];
      if (data[i] > dMax) dMax = data[i];
    }
    const range = dMax - dMin || 1;
    const norm = new Float32Array(data.length);
    for (let i = 0; i < data.length; i++) norm[i] = (data[i] - dMin) / range;

    if (!S.depthMaps) S.depthMaps = {};
    S.depthMaps[view] = { data: norm, W: width, H: height, _srcUrl: url };

    _setDepthStatus(null, 'done', `✓ Depth — ${view}`);
    hideProcessing();

    // Show depth overlay in the Computed panel
    _showDepthPreview(view);

    // Re-run improved segmentation to incorporate depth as Source E
    if (S.segMasks?.[view]) _improveSegFromISO(view);

  } catch (err) {
    console.error('[depth]', err);
    _setDepthStatus(null, 'error', `⚠ Depth: ${err.message}`);
    hideProcessing();
  }
}

function _showDepthPreview(_view) { /* depth preview removed — seg-computed canvas no longer exists */ }

// ── Status helper ─────────────────────────────────────────────────────────────
function _setDepthStatus(el, type, msg) {
  if (!el) el = document.getElementById('depth-status');
  if (!el) return;
  const c = { loading: '#94a3b8', done: '#2dd4bf', ready: '#10B981', error: '#EF4444' };
  el.textContent = msg;
  el.style.color = c[type] || '#94a3b8';
}

// ── Exported helpers (used by other modules) ──────────────────────────────────

// Returns a binary Uint8ClampedArray at targetW×targetH:
// 255 = sure-background pixel.
//
// Strategy: build a depth histogram, find the foreground peak (tallest bin in
// the top-50% depth range = closest objects), then mark pixels that are more
// than `margin` below that peak as sure-background.
// Falls back to a fixed threshold if the histogram has no clear peak.
function depthSureBackground(view, targetW, targetH, bgThresh = 0.2) {
  const dm = S.depthMaps?.[view];
  if (!dm) return null;

  // Build 64-bin histogram of depth values
  const BINS = 64;
  const hist = new Int32Array(BINS);
  for (let i = 0; i < dm.data.length; i++)
    hist[Math.min(BINS - 1, Math.floor(dm.data[i] * BINS))]++;

  // Find tallest bin in top half (depth > 0.5 = close objects = foreground)
  let peakBin = -1, peakVal = 0;
  for (let b = Math.floor(BINS * 0.5); b < BINS; b++) {
    if (hist[b] > peakVal) { peakVal = hist[b]; peakBin = b; }
  }

  // Separator: midpoint between peak and zero, but at least bgThresh
  let cutoff = bgThresh;
  if (peakBin > 0 && peakVal > dm.data.length * 0.02) {
    // peak covers ≥2% of pixels — use it. Cutoff = half of peak depth.
    cutoff = Math.max(bgThresh, (peakBin / BINS) * 0.5);
  }

  const out = new Uint8ClampedArray(targetW * targetH);
  for (let y = 0; y < targetH; y++) {
    for (let x = 0; x < targetW; x++) {
      const sx = Math.round(x * dm.W / targetW);
      const sy = Math.round(y * dm.H / targetH);
      const d  = dm.data[Math.min(sy, dm.H-1) * dm.W + Math.min(sx, dm.W-1)];
      if (d < cutoff) out[y * targetW + x] = 255;
    }
  }
  return out;
}

// Returns binary mask where pixels are sure-foreground (close to camera).
// Uses the same histogram peak as depthSureBackground but inverts the logic.
// Pixels within 0.20 depth-units of the foreground peak are marked 255.
function depthSureForeground(view, targetW, targetH) {
  const dm = S.depthMaps?.[view];
  if (!dm) return null;

  const BINS = 64;
  const hist = new Int32Array(BINS);
  for (let i = 0; i < dm.data.length; i++)
    hist[Math.min(BINS-1, Math.floor(dm.data[i] * BINS))]++;

  let peakBin = -1, peakVal = 0;
  for (let b = Math.floor(BINS * 0.5); b < BINS; b++) {
    if (hist[b] > peakVal) { peakVal = hist[b]; peakBin = b; }
  }
  if (peakBin < 0 || peakVal < dm.data.length * 0.02) return null;

  const peakDepth = (peakBin + 0.5) / BINS;
  const fgThresh  = peakDepth - 0.20; // within 0.20 depth-units of foreground peak

  const out = new Uint8ClampedArray(targetW * targetH);
  for (let y = 0; y < targetH; y++) {
    for (let x = 0; x < targetW; x++) {
      const sx = Math.round(x * dm.W / targetW);
      const sy = Math.round(y * dm.H / targetH);
      const d  = dm.data[Math.min(sy, dm.H-1) * dm.W + Math.min(sx, dm.W-1)];
      if (d >= fgThresh) out[y * targetW + x] = 255;
    }
  }
  return out;
}

// Returns gradient magnitude at targetW×targetH from the depth map.
// Used in _snapToEdges to complement color gradient.
// Output[i] is in [0, 255] — higher = sharper depth discontinuity.
function depthGradient(view, targetW, targetH) {
  const dm = S.depthMaps?.[view];
  if (!dm) return null;
  const out = new Float32Array(targetW * targetH);
  for (let y = 1; y < targetH-1; y++) {
    for (let x = 1; x < targetW-1; x++) {
      const sx  = x * dm.W / targetW,  sy  = y * dm.H / targetH;
      const sxi = Math.round(sx),       syi = Math.round(sy);
      const get = (xx, yy) => {
        const cx = Math.max(0, Math.min(dm.W-1, xx));
        const cy = Math.max(0, Math.min(dm.H-1, yy));
        return dm.data[cy * dm.W + cx];
      };
      const gx = get(sxi+1, syi) - get(sxi-1, syi);
      const gy = get(sxi, syi+1) - get(sxi, syi-1);
      out[y * targetW + x] = Math.sqrt(gx*gx + gy*gy) * 255;
    }
  }
  return out;
}
