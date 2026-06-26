# TD Maker — Night Work Queue
> Work window: 02:00–06:00 AM only.
> Pick the next `[ ]` item, implement, test, mark `[x]`.

---

## 🌙 NIGHT SESSION — START HERE

- [ ] **בדיקת BUG** — Run `npm run dev` in `app/`, open browser, load an elephant project, step through all 10 panels. For each panel: record any console errors, visual regressions, or broken interactions. File new bugs in the 🔴 section below.

- [ ] **המשך עבודה על הכלי TD** — After bug testing, pick the top unchecked item from 🔴 BUG FIXES, implement + test, mark `[x]`. Then move to 🟡 FEATURES.

---

## 🔴 BUG FIXES

- [x] **Computed silhouette לא הגיוני — 3 שורש-בעיות**

  **באג A — depth preview שובר את canvas הגדלים (קריטי)**
  - `_showDepthPreview` (td-depth.js:163) מגדיר `segComp.width = dm.W` — רזולוציית depth map (~518px).
  - `_improveSegFromISO` (td-segmentation.js:345) בודק `segComp.width === oW` (רזולוציית המסכה ~400px) — הבדיקה נכשלת, ה-Computed לא מצויר לעולם.
  - הtimeout של 3 שניות ב-`_showDepthPreview` מנסה לתקן אבל גם הוא נכשל מאותה סיבה.
  - **תיקון:** ב-`_improveSegFromISO` לפני הציור — תמיד לאפס `segComp.width = oW; segComp.height = oH` במקום לבדוק שהם תואמים.

  **באג B — morphCloseDisk r=8 הורס פיצ'רים דקים**
  - לתמונות עם score < 4 — radius=8 = dilation 8px + erosion 8px = כל פיצ'ר דק מ-16px נמחק (חדק, רגל).
  - **תיקון:** להוריד ל-r=4 max. במקום closeR לפי score, להשתמש בגודל bbox: `closeR = Math.max(2, Math.round(Math.min(oW,oH) * 0.012))`.

  **באג C — runIsoFullPipeline על כל הזזת slider (race condition)**
  - כל שינוי threshold → `applyThreshold()` → `runIsoFullPipeline()` — pipeline חדש רץ async.
  - מספר pipelines במקביל מחליפים את `S.isoData`, `S.isoFaceMasks` זה את זה.
  - **תיקון:** debounce ב-`applyThreshold` — לא להריץ ISO pipeline אם אחד כבר רץ. רק pipeline אחד פעיל בו-זמנית.

- [x] **Auto-detect contour failure on Side view — root cause fixed**
  - **Root cause:** `_removeBorderConnected` removed the elephant when it was border-connected (common in tight side-view crops), leaving only the ruler as the dominant blob.
  - **Fix:** Added `_safeRemoveBorderConnected` that reverts if >60% of the mask is removed (elephant itself was border-connected). Applied to PATH A, PATH B (checkerboard, otsu, canny).
  - **Also fixed:** PATH B canny mode was not calling `_removeBorderConnected` at all — added guarded call.

- [x] **Snap radius bleeds onto ruler** — `_safeRemoveBorderConnected` ensures ruler is removed before snap when ruler is small/border-connected; elephant is preserved. snapR=2 still applies for fine-tuning.

- [x] **segMaskImproved not computed for unvisited views** — `_ensureSegMask` in `td-upload.js` now calls `_improveSegFromISO(view)` after building the basic mask if `segMaskImproved` is missing.

- [x] **Contour selector overlay z-index** — Added `z-index:10; pointer-events:auto` to `#contour-select-overlay` in `index.astro`.

- [x] **vtab-badge stab-badge-{v} not updated on first load** — Added `_updateContourSegBadges()` call to `onActivate(2)` in `td-core.js`.

---

## 🟡 FEATURES — SYMMETRY

- [x] **Symmetry indicator in Contour Drawing** — `td-gmm.js:160` shows `⟺ Sym 92%` / `⇳ Sym 87%` badge in contour info bar (already done in prior session).

- [x] **Symmetry indicator in Background Separation** — `td-segmentation.js:463` shows per-view teal badge below region scores (already done).

- [x] **PNG export — symmetry axis** — `td-export.js:98` uses detected symmetry axis (already done).

- [x] **Symmetry: use the better half, not OR** — `applyMaskSymmetry` now counts boundary transitions per half; the half with fewer transitions (cleaner boundary) is mirrored onto the noisier half instead of ORing both.

---

## 🟡 FEATURES — CONTOUR

- [x] **Auto-detect: PATH B on no-mask views** — Added `_safeRemoveBorderConnected` to canny mode in PATH B. All three PATH B modes (checkerboard, otsu, canny) now use the safe guarded version.

- [x] **Contour selector: highlight active contour number in toolbar** — Added `#active-contour-badge` span next to the Hole button in Row 3. Shows "Hole 1", "Hole 2", etc. when a hole is active; hidden when editing outer contour. Updated by `_updateContourSelector()`.

- [x] **Contour resample after symmetry** — Added cap: after `_removeCollinear`, if `simplified.length > S.contourTargetPts ?? 300`, resample back to that limit. `_applyContourTargetPts` also runs afterward for user-set targets.

- [x] **Depth gradient adaptive blend in `_snapToEdges`** — Normalized both color and depth gradients to [0,1] before blending. Adaptive weight: 90% depth where color is weak, 10% depth where color is strong. File: `td-image-proc.js` → `_snapToEdges`.

- [x] **5 contour quality improvements** — All implemented:
  1. **Cross-view bbox constraint** (`td-segmentation.js` `_improveSegFromISO`) — clips mask using objectModel consensus dims when cross-view consistency >0.85 and mask is >12% too wide/tall
  2. **Snake + depth energy** (`td-active-contour.js` `computeEdgeEnergy`) — blends depth gradient: `mag[i] = max(color, depth_normalized)` so depth discontinuities attract the snake even where color is flat
  3. **Sub-pixel snapping** (`td-image-proc.js` `_snapToEdges`) — precomputes Sobel gxF/gyF fields, bilinear `bilSample()`, searches with 0.5px steps instead of 1px integer steps
  4. **ISO→ortho contour** — added to Homography TODO (requires projective warp, too complex for inline)
  5. **Depth foreground expansion** (`td-depth.js` `depthSureForeground`, `td-image-proc.js` `morphDilateDisk`, `td-segmentation.js`) — close-to-camera pixels within 4px of existing mask boundary are added to mask

---

## 🟢 IMPROVEMENTS — UI / DESIGN

- [x] **Background Separation: margin-bottom on seg-tabs-row** — Changed from `16px` to `12px` in `index.astro`.

- [x] **Scale: Auto Detect button** — Unified style with contour button (`padding:4px 14px; border-radius:7px; font-size:13px`) in `index.astro`.

- [x] **Contour info bar wraps on narrow window** — Added `overflow:hidden; text-overflow:ellipsis; white-space:nowrap` to `#contour-info` in `index.astro`.

---

## 🔵 TECH DEBT

- [x] **`_forcePathB` still referenced but never set** — Removed dead code from `refineContour()` in `td-image-proc.js`.

- [x] **`_updateContourSelector` called from context menu** — `addHole()` already calls `_updateContourSelector()` — the "Add Hole" button in the context menu routes through `addHole()`, so this is already covered.

- [x] **Memory: save `S.symmetry` to `persistState`** — Added `symmetry` to `st` object in `persistState()` and restored in `restoreSession()` in `td-core.js`.

---

## 🟡 FEATURES — HOMOGRAPHY

- [x] **Cal Background: replace bbox-align with real Homography** — `computeHomography4pt` (DLT, 8×8 Gaussian elimination) + `applyH` already implemented in `td-cal-background.js:95`. Used by `runCalBgSubtract` for full projective warp + scale extraction.

- [ ] **ISO Face → Ortho: replace bbox-scale with Homography warp** — In `_improveSegFromISO` (td-segmentation.js), the ISO face mask is mapped to orthographic space using simple bbox scaling — this is a Similarity transform which distorts curved shapes. Replace with a Projective Homography from the 4 bbox corners of the ISO face to the 4 bbox corners of the ortho object. This correctly handles perspective foreshortening. Relevant function: `_improveSegFromISO` → Source C block (currently removed, would be re-added correctly).

- [ ] **Perspective correction for non-orthographic photos** — If the user photographed the object at a slight angle (not perfectly 90°), the contour is perspective-distorted. After the user places 4 known-rectangular corners on the image (e.g. a tabletop or a known-rectangular face), compute the homography H from image-pts → metric-pts and warp the image before contour extraction. Would need a new UI step (click 4 corners) → `cv2.warpPerspective` equivalent in JS. File: new `td-homography.js`.

---

## 🟡 FEATURES — NEW

- [ ] **Verify `_safeRemoveBorderConnected` threshold on real images** — Threshold is now `_SAFE_BORDER_SURVIVAL = 0.40` constant in `td-image-proc.js:183`. Added `console.debug('[borderRM] survival=X%')` to every call — open DevTools, load a side-view, check survival rate. If ruler survives: lower to 0.20. If elephant removed: raise to 0.50.

- [ ] **`detectMaskSymmetry` threshold tuning** — `THRESH = 0.78` at `td-image-proc.js:1728`. Added `console.debug('[symmetry] bestV=X bestH=X thresh=0.78')` — open DevTools on elephant front/side/top views and check the logged scores. If top/side wrongly show symmetric: raise to 0.82. If front is missed: lower to 0.75.

- [x] **Adaptive depth blend: verify dg scale** — Fixed: `_snapToEdges` now uses 3×3 Sobel precomputed field (bilinear, sub-pixel 0.5px steps). Sobel divided by 4 on precompute so values stay in [-255,255]; NORM=130000 is now mathematically correct for both color and depth paths.

---

## ✅ DONE (recent session)

- [x] **3D Mesh export (STL)** — `cmd_mesh` in `td_compute.py`: height-table from front/side profiles, footprint from top contour, ISO carving (optional), surface extraction via marching cubes (scikit-image) with cube-face fallback. JavaScript: `exportSTL()` in `td-hull.js` converts canvas-space contours → world-space mm → calls Python via `window.tdCompute.runMesh()` → downloads `.stl`. Button added to Visual Hull step toolbar.
- [x] **Bug fixes — Contour Drawing auto-detect pipeline** — Cross-view checks moved before `S.polys` assignment (were dead code); `_fixContourHolePenetration` moved to end of snake; snake stale-view guard; Gauss-Seidel update order; `persistState()` called before snake `setTimeout`.
- [x] **Hull tilt** — vertical drag updates `hull.el`; stored in `hull.drag.el`.
- [x] **ptToUV coordinate fix** — `ppmX = ppm * srcW / origW_px` used throughout `renderVisualHull`.

- [x] **PATH A auto-detect bug** — added `_removeBorderConnected` + second `_removeSmallBlobs` after `morphCloseDisk` in `_contourFromSegMask`; reduced disk radius 8→4. Root cause: ruler is border-connected; PATH B already removed it, PATH A didn't.
- [x] **`_clearComputed()` view guard** — early-return calls in `_improveSegFromISO` now check `if (view === S.segView)` before clearing canvas
- [x] **Symmetry badge in Contour info bar** — `⟺ Sym 92%` / `⇳ Sym 87%` in teal when detected
- [x] **Symmetry badge in Background Separation** — per-view teal badge below region scores
- [x] **Symmetry axis in Layout/PNG export** — `td-layout.js` uses detected axis (teal dashed + tick marks) not geometric centre
- [x] **"🕳 Add Hole Here" in context menu** — right-click closed contour → octagon hole created at click → `_updateContourSelector()` called
- [x] Fixed Computed silhouette showing wrong view's data (display guard `view !== S.segView`)
- [x] `_sealBorderConcavities` skipped for high-quality views (score ≥ 6)
- [x] Multi-source voting for low-quality views (score < 4): raw + improved + ISO + other views
- [x] Snap radius reduced to 2 for mask-based contour (ruler stealing fix)
- [x] `detectMaskSymmetry` + `applyMaskSymmetry` + `applyContourSymmetry` implemented
- [x] Symmetry axis in DXF export (CENTER layer, tick marks at ends)
- [x] Contour selector overlay (Outer / Hole 1 / Hole 2…)
- [x] Unified `.view-tab` CSS class across all steps
- [x] vtab-badge completion indicators (Seg ✓, Contour ✓, Scale ✓)
- [x] Computed silhouette as default canvas background in Contour Drawing
- [x] Photo toggle (📷) to switch back to original image
- [x] Auto-detect always uses silhouette mask when available (removed `_forcePathB` bypass)
- [x] `_improveSegFromISO` runs for all views with masks (not just current view)
- [x] Padding `40px` unified across all 10 panels
