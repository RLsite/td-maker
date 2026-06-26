"""
TD Maker — Python compute sidecar.

Called by Electron main process via spawn():
  td_compute.exe <command> <arg1> [arg2 ...]

Output: single JSON line to stdout.
Errors: exit code 1, error message to stderr.

Commands:
  sam     <image_b64> [mime_type]   → { mask_png_b64, area }
  depth   <image_b64> [mime_type]   → { depth_png_b64 }
  grabcut <image_b64> <rect_json> [mime_type] → { mask_png_b64 }
  mesh    <data_json_or_@filepath>  → { stl_b64, voxel_count, face_count }
"""
import sys
import json
import base64
import io


# ── Helpers ───────────────────────────────────────────────────────────────────

def b64_to_pil(b64_str: str):
    from PIL import Image
    data = base64.b64decode(b64_str)
    return Image.open(io.BytesIO(data)).convert('RGB')


def pil_to_b64_png(img) -> str:
    buf = io.BytesIO()
    img.save(buf, format='PNG')
    return base64.b64encode(buf.getvalue()).decode()


def mask_arr_to_b64(arr) -> str:
    import numpy as np
    from PIL import Image
    if arr.dtype != 'uint8':
        arr = (arr * 255).astype('uint8')
    return pil_to_b64_png(Image.fromarray(arr))


# ── Commands ──────────────────────────────────────────────────────────────────

def cmd_sam(image_b64: str, _mime: str = 'image/jpeg') -> dict:
    """
    Run Segment Anything Model (SAM ViT-B) on the image.
    Returns the largest foreground mask as a base64 PNG.
    Model checkpoint: compute/models/sam_vit_b_01ec64.pth
    """
    import numpy as np
    from PIL import Image
    from segment_anything import sam_model_registry, SamAutomaticMaskGenerator
    from pathlib import Path

    model_path = Path(__file__).parent / 'models' / 'sam_vit_b_01ec64.pth'
    if not model_path.exists():
        return {'error': f'SAM model not found at {model_path}. Download from Meta and place in compute/models/'}

    sam = sam_model_registry['vit_b'](checkpoint=str(model_path))
    sam.eval()

    img_pil = b64_to_pil(image_b64)
    img_np = np.array(img_pil)

    generator = SamAutomaticMaskGenerator(
        sam,
        points_per_side=32,
        pred_iou_thresh=0.88,
        stability_score_thresh=0.92,
    )
    masks = generator.generate(img_np)

    if not masks:
        return {'error': 'SAM: no masks found'}

    best = max(masks, key=lambda m: m['area'])
    mask_b64 = mask_arr_to_b64(best['segmentation'].astype('uint8'))
    return {'mask_png_b64': mask_b64, 'area': int(best['area'])}


def cmd_depth(image_b64: str, _mime: str = 'image/jpeg') -> dict:
    """
    Run Depth-Anything v2 Small on the image.
    Returns a normalized depth map (grayscale PNG, 8-bit).
    Model: depth-anything/Depth-Anything-V2-Small-hf (downloaded on first run via HF cache)
    """
    import numpy as np
    from PIL import Image
    from transformers import pipeline

    pipe = pipeline(
        task='depth-estimation',
        model='depth-anything/Depth-Anything-V2-Small-hf',
        device='cpu',
    )
    img_pil = b64_to_pil(image_b64)
    result = pipe(img_pil)
    depth_pil = result['depth']  # PIL Image, mode 'I' (32-bit int) or 'L'

    # Normalize to 0-255
    depth_arr = np.array(depth_pil).astype(float)
    lo, hi = depth_arr.min(), depth_arr.max()
    if hi > lo:
        depth_arr = (depth_arr - lo) / (hi - lo) * 255
    depth_8 = depth_arr.astype('uint8')

    return {'depth_png_b64': mask_arr_to_b64(depth_8)}


def cmd_grabcut(image_b64: str, rect_json: str, _mime: str = 'image/jpeg') -> dict:
    """
    Run OpenCV GrabCut with a hint rectangle.
    rect_json: '{"x": 10, "y": 20, "w": 300, "h": 400}'
    Returns refined foreground mask as base64 PNG.
    """
    import numpy as np
    import cv2
    from PIL import Image

    img_pil = b64_to_pil(image_b64)
    img_bgr = cv2.cvtColor(np.array(img_pil), cv2.COLOR_RGB2BGR)

    rect_d = json.loads(rect_json)
    rect = (int(rect_d['x']), int(rect_d['y']), int(rect_d['w']), int(rect_d['h']))

    mask = np.zeros(img_bgr.shape[:2], np.uint8)
    bgd_model = np.zeros((1, 65), np.float64)
    fgd_model = np.zeros((1, 65), np.float64)
    cv2.grabCut(img_bgr, mask, rect, bgd_model, fgd_model, 5, cv2.GC_INIT_WITH_RECT)

    # GrabCut labels: 0=BGD, 1=FGD, 2=PR_BGD, 3=PR_FGD
    fg_mask = np.where((mask == cv2.GC_FGD) | (mask == cv2.GC_PR_FGD), 255, 0).astype('uint8')
    return {'mask_png_b64': mask_arr_to_b64(fg_mask)}


# ── Mesh helpers ──────────────────────────────────────────────────────────────

def _poly_envelope(poly, query_vals):
    """
    Upper/lower y-envelope of a closed polygon at positions along its first axis.
    poly: (N,2) float array — column 0 = scan axis, column 1 = height.
    query_vals: 1-D array of positions along scan axis.
    Returns (y_max, y_min), each shape (len(query_vals),).
    """
    import numpy as np
    q     = np.asarray(query_vals, dtype=float)
    y_max = np.full(len(q), -np.inf)
    y_min = np.full(len(q),  np.inf)
    n = len(poly)
    for i in range(n):
        ax, ay = poly[i]
        bx, by = poly[(i + 1) % n]
        if ax == bx:
            continue
        t    = (q - ax) / (bx - ax)
        mask = (t >= 0) & (t <= 1)
        y_at = ay + t * (by - ay)
        y_max = np.where(mask, np.maximum(y_max, y_at), y_max)
        y_min = np.where(mask, np.minimum(y_min, y_at), y_min)
    # Forward-fill any gaps
    last_max = last_min = 0.0
    for qi in range(len(q)):
        if y_max[qi] != -np.inf:
            last_max = y_max[qi]
        else:
            y_max[qi] = last_max
        if y_min[qi] != np.inf:
            last_min = y_min[qi]
        else:
            y_min[qi] = last_min
    return y_max, y_min


def _pip_vectorized(poly, px, py):
    """
    Ray-casting point-in-polygon.  poly: (N,2).  px, py: 1-D numpy arrays.
    Returns bool array shape (len(px),).
    """
    import numpy as np
    px     = np.asarray(px, dtype=float)
    py     = np.asarray(py, dtype=float)
    n      = len(poly)
    inside = np.zeros(len(px), dtype=bool)
    for i in range(n):
        ax, ay = poly[i]
        bx, by = poly[(i + 1) % n]
        cross  = (ay > py) != (by > py)
        with np.errstate(divide='ignore', invalid='ignore'):
            xi = np.where(cross, (bx - ax) * (py - ay) / (by - ay + 1e-12) + ax, np.inf)
        inside ^= cross & (px < xi)
    return inside


def _footprint_mask(poly, xs, zs):
    """
    Returns bool (nx, nz): True where (xs[ix], zs[iz]) is inside poly.
    poly[:,0] = x, poly[:,1] = z.
    """
    import numpy as np
    xx, zz = np.meshgrid(xs, zs, indexing='ij')
    return _pip_vectorized(poly, xx.ravel(), zz.ravel()).reshape(len(xs), len(zs))


def _carve_iso(voxels, xs, ys, zs, iso_poly, az_deg, el_deg, img_w, img_h):
    """
    Carve voxels whose isometric projection falls outside iso_poly (image pixels).
    """
    import numpy as np
    azR = az_deg * np.pi / 180
    elR = el_deg * np.pi / 180
    cosA, sinA = np.cos(azR), np.sin(azR)
    cosE, sinE = np.cos(elR), np.sin(elR)

    obj_cx = xs[-1] / 2 if len(xs) > 1 else 0
    obj_cy = ys[-1] / 2 if len(ys) > 1 else 0
    obj_cz = zs[-1] / 2 if len(zs) > 1 else 0

    # Determine projection scale from bounding-box corners
    cxv = np.array([0, xs[-1], 0, xs[-1], 0, xs[-1], 0, xs[-1]]) - obj_cx
    cyv = np.array([0, 0, ys[-1], ys[-1], 0, 0, ys[-1], ys[-1]]) - obj_cy
    czv = np.array([0, 0, 0, 0, zs[-1], zs[-1], zs[-1], zs[-1]]) - obj_cz
    c_rx = cxv * cosA + czv * sinA
    c_rz = -cxv * sinA + czv * cosA
    c_ry = cyv * cosE - c_rz * sinE
    rx_min, rx_max = c_rx.min(), c_rx.max()
    ry_min, ry_max = c_ry.min(), c_ry.max()
    sc  = min(img_w * 0.85 / max(rx_max - rx_min, 1),
              img_h * 0.85 / max(ry_max - ry_min, 1))
    icx = img_w / 2 - (rx_min + rx_max) / 2 * sc
    icy = img_h / 2 + (ry_min + ry_max) / 2 * sc

    # Project all voxel centers (vectorised)
    xv = xs[:, np.newaxis, np.newaxis] - obj_cx
    yv = ys[np.newaxis, :, np.newaxis] - obj_cy
    zv = zs[np.newaxis, np.newaxis, :] - obj_cz
    rx  =  xv * cosA + zv * sinA
    rz  = -xv * sinA + zv * cosA
    ry  =  yv * cosE - rz * sinE
    sx  = (icx + rx * sc).ravel()
    sy  = (icy - ry * sc).ravel()

    occupied = voxels.ravel()
    in_iso   = np.zeros(len(sx), dtype=bool)
    occ_idx  = np.where(occupied)[0]
    if len(occ_idx):
        in_iso[occ_idx] = _pip_vectorized(iso_poly, sx[occ_idx], sy[occ_idx])
    return in_iso.reshape(voxels.shape)


def _mesh_to_binary_stl(verts, faces):
    """Pack (verts, faces) into a binary STL byte string."""
    import numpy as np, struct
    buf = bytearray(80)
    buf += struct.pack('<I', len(faces))
    for face in faces:
        v0, v1, v2 = verts[face[0]], verts[face[1]], verts[face[2]]
        n  = np.cross(v1 - v0, v2 - v0)
        nl = np.linalg.norm(n)
        if nl > 0:
            n /= nl
        buf += struct.pack('<fff', *n)
        buf += struct.pack('<fff', *v0)
        buf += struct.pack('<fff', *v1)
        buf += struct.pack('<fff', *v2)
        buf += b'\x00\x00'
    return bytes(buf)


def _voxels_to_cube_stl(voxels, R):
    """Fallback STL: emit two triangles per exposed voxel face."""
    import numpy as np, struct
    nx, ny, nz = voxels.shape
    tris = []
    DIRS = [
        (( 1, 0, 0), [(1,0,0),(1,1,0),(1,1,1),(1,0,1)]),
        ((-1, 0, 0), [(0,0,1),(0,1,1),(0,1,0),(0,0,0)]),
        (( 0, 1, 0), [(0,1,0),(0,1,1),(1,1,1),(1,1,0)]),
        (( 0,-1, 0), [(0,0,1),(0,0,0),(1,0,0),(1,0,1)]),
        (( 0, 0, 1), [(0,0,1),(1,0,1),(1,1,1),(0,1,1)]),
        (( 0, 0,-1), [(1,0,0),(0,0,0),(0,1,0),(1,1,0)]),
    ]
    for ix in range(nx):
        for iy in range(ny):
            for iz in range(nz):
                if not voxels[ix, iy, iz]:
                    continue
                for (dx, dy, dz), corners in DIRS:
                    nx2, ny2, nz2 = ix + dx, iy + dy, iz + dz
                    if 0 <= nx2 < nx and 0 <= ny2 < ny and 0 <= nz2 < nz and voxels[nx2, ny2, nz2]:
                        continue
                    p = [np.array([(ix+ox)*R, (iy+oy)*R, (iz+oz)*R]) for ox, oy, oz in corners]
                    nv = np.array([dx, dy, dz], dtype=float)
                    tris.append((nv, p[0], p[1], p[2]))
                    tris.append((nv, p[0], p[2], p[3]))
    buf = bytearray(80)
    buf += struct.pack('<I', len(tris))
    for (nv, v0, v1, v2) in tris:
        buf += struct.pack('<fff', *nv)
        buf += struct.pack('<fff', *v0)
        buf += struct.pack('<fff', *v1)
        buf += struct.pack('<fff', *v2)
        buf += b'\x00\x00'
    return bytes(buf)


def _voxels_to_stl(voxels, R):
    """Surface mesh via marching cubes (scikit-image); cube faces as fallback."""
    import numpy as np
    try:
        from skimage.measure import marching_cubes
        padded = np.pad(voxels.astype(np.float32), 1, constant_values=0)
        verts, faces, _, _ = marching_cubes(padded, level=0.5, spacing=(R, R, R))
        verts -= R          # compensate for 1-voxel padding
        return _mesh_to_binary_stl(verts, faces)
    except Exception:
        return _voxels_to_cube_stl(voxels, R)


# ── Mesh command ───────────────────────────────────────────────────────────────

def cmd_mesh(data_arg: str) -> dict:
    """
    Build a 3D mesh from multi-view contours and return a binary STL (base64).

    data_arg: JSON string -or- '@<filepath>' to read JSON from a file.

    JSON schema:
      front: [{x, y}, ...]   world-space mm — x=width, y=height (y↑=up)
      side:  [{z, y}, ...]   z=depth (0=front), y=height
      top:   [{x, z}, ...]   x=width, z=depth
      iso:   [{x, y}, ...]   ISO silhouette in image pixels (optional)
      dims:  {W, H, D}       bounding box in mm
      iso_az, iso_el         ISO camera angles (degrees)
      iso_img_w, iso_img_h   ISO image size (pixels)
      resolution             mm per voxel (default 2.0)

    Returns: {stl_b64, voxel_count, face_count}
    """
    import numpy as np

    if data_arg.startswith('@'):
        with open(data_arg[1:], 'r', encoding='utf-8') as fh:
            data = json.load(fh)
    else:
        data = json.loads(data_arg)

    R     = float(data.get('resolution', 2.0))
    dims  = data.get('dims', {})
    W_mm  = float(dims.get('W', 100))
    H_mm  = float(dims.get('H',  80))
    D_mm  = float(dims.get('D',  60))

    def _parse(key, cols):
        raw = data.get(key)
        if not raw:
            return None
        return np.array([[p[c] for c in cols] for p in raw], dtype=float)

    front = _parse('front', ('x', 'y'))
    side  = _parse('side',  ('z', 'y'))
    top   = _parse('top',   ('x', 'z'))
    iso   = _parse('iso',   ('x', 'y'))

    # Grid
    xs = np.arange(0, W_mm + R / 2, R)
    ys = np.arange(0, H_mm + R / 2, R)
    zs = np.arange(0, D_mm + R / 2, R)
    nx, ny, nz = len(xs), len(ys), len(zs)

    # Step 1 — height profiles
    if front is not None:
        fy_top, fy_bot = _poly_envelope(front, xs)
    else:
        fy_top, fy_bot = np.full(nx, H_mm), np.zeros(nx)

    if side is not None:
        sy_top, sy_bot = _poly_envelope(side, zs)
    else:
        sy_top, sy_bot = np.full(nz, H_mm), np.zeros(nz)

    # Step 2 — footprint from top contour
    footprint = _footprint_mask(top, xs, zs) if top is not None else np.ones((nx, nz), dtype=bool)

    # Step 3 — voxel grid (fully vectorised)
    y_top_2d = np.minimum(fy_top[:, np.newaxis], sy_top[np.newaxis, :])   # (nx, nz)
    y_bot_2d = np.maximum(fy_bot[:, np.newaxis], sy_bot[np.newaxis, :])
    valid    = footprint & (y_top_2d > y_bot_2d)

    ys_row   = ys[np.newaxis, :, np.newaxis]     # (1, ny, 1)
    y_top_3d = y_top_2d[:, np.newaxis, :]         # (nx, 1, nz)
    y_bot_3d = y_bot_2d[:, np.newaxis, :]
    valid_3d = valid[:, np.newaxis, :]

    voxels = valid_3d & (ys_row >= y_bot_3d) & (ys_row <= y_top_3d)

    # Step 4 — ISO carving (optional)
    if iso is not None and len(iso) >= 3:
        voxels = _carve_iso(
            voxels, xs, ys, zs, iso,
            float(data.get('iso_az',    315)),
            float(data.get('iso_el',     22)),
            float(data.get('iso_img_w', 640)),
            float(data.get('iso_img_h', 480)),
        )

    # Step 5 — surface mesh → binary STL
    stl_bytes = _voxels_to_stl(voxels, R)
    return {
        'stl_b64':     base64.b64encode(stl_bytes).decode(),
        'voxel_count': int(np.sum(voxels)),
        'face_count':  (len(stl_bytes) - 84) // 50,
    }


def cmd_rectify(params_json_or_file: str) -> dict:
    """
    Detect and correct camera rotation from a photo with a ruler.

    Accepts JSON directly or '@filepath' for large payloads.
    params JSON: {
      "image": "<base64>",
      "ruler_orientation": "h" | "v" | "auto",  // expected ruler direction
      "apply": true                               // false → analyse only
    }

    Returns: {
      "image_b64": "<corrected base64 PNG>",
      "rotation_deg": float,        // correction applied (+ = CCW)
      "ruler_pt1": [x, y],          // detected ruler start (corrected coords)
      "ruler_pt2": [x, y],          // detected ruler end
      "perspective_score": float,   // 0..1  (>0.4 = notable distortion)
      "confidence": float,          // 0..1  ruler detection confidence
      "new_size": [W, H]
    }
    """
    import numpy as np
    import cv2
    from PIL import Image

    # ── load params ────────────────────────────────────────────────────────────
    if params_json_or_file.startswith('@'):
        with open(params_json_or_file[1:], 'r', encoding='utf-8') as fh:
            params = json.load(fh)
    else:
        params = json.loads(params_json_or_file)

    img_pil   = b64_to_pil(params['image'])
    img_np    = np.array(img_pil)
    H, W      = img_np.shape[:2]
    orientation = params.get('ruler_orientation', 'auto')  # 'h' | 'v' | 'auto'
    do_apply  = params.get('apply', True)

    # ── edge detection ─────────────────────────────────────────────────────────
    gray  = cv2.cvtColor(img_np, cv2.COLOR_RGB2GRAY)
    blur  = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(blur, 40, 120, apertureSize=3)

    # ── Hough line detection ───────────────────────────────────────────────────
    min_len = max(W, H) // 5
    lines   = cv2.HoughLinesP(edges, 1, np.pi / 360, threshold=50,
                               minLineLength=min_len, maxLineGap=20)

    ruler_pt1   = [W * 0.2, H * 0.5]
    ruler_pt2   = [W * 0.8, H * 0.5]
    correction  = 0.0
    confidence  = 0.0

    if lines is not None:
        # Separate horizontal (|angle| < 45°) and vertical lines
        h_lines, v_lines = [], []
        for seg in lines:
            x1, y1, x2, y2 = seg[0]
            a = np.degrees(np.arctan2(y2 - y1, x2 - x1))
            length = np.hypot(x2 - x1, y2 - y1)
            if abs(a) < 45:
                h_lines.append((a, length, x1, y1, x2, y2))
            else:
                v_lines.append((a, length, x1, y1, x2, y2))

        # Pick the set that matches the expected orientation
        use_h = True
        if orientation == 'h':
            use_h = True
        elif orientation == 'v':
            use_h = False
        else:  # auto: pick the set with more total length
            h_len = sum(l for _, l, *_ in h_lines)
            v_len = sum(l for _, l, *_ in v_lines)
            use_h = (h_len >= v_len)

        target_lines = h_lines if use_h else v_lines
        if target_lines:
            # Weight by line length → weighted-average angle
            total_len = sum(l for _, l, *_ in target_lines)
            w_angle   = sum(a * l for a, l, *_ in target_lines) / total_len

            if use_h:
                correction = -w_angle          # rotate so dominant H line → 0°
            else:
                # Dominant vertical should be ±90°; pick sign closest to actual
                target_a = 90.0 if w_angle > 0 else -90.0
                correction = target_a - w_angle

            # Normalize to [-45, 45]
            while correction >  45: correction -= 90
            while correction < -45: correction += 90

            # Confidence: proportion of total line length in chosen set
            all_len = sum(l for _, l, *_ in h_lines) + sum(l for _, l, *_ in v_lines)
            chosen_len = total_len
            confidence = float(chosen_len / all_len) if all_len > 0 else 0.5

            # Best single line (longest) → ruler endpoints
            best = max(target_lines, key=lambda t: t[1])
            _, _, bx1, by1, bx2, by2 = best
            ruler_pt1 = [float(bx1), float(by1)]
            ruler_pt2 = [float(bx2), float(by2)]

    # ── apply rotation ─────────────────────────────────────────────────────────
    center = (W / 2.0, H / 2.0)
    M = cv2.getRotationMatrix2D(center, correction, 1.0)

    cos_c = abs(np.cos(np.radians(correction)))
    sin_c = abs(np.sin(np.radians(correction)))
    new_W = int(H * sin_c + W * cos_c)
    new_H = int(H * cos_c + W * sin_c)
    M[0, 2] += (new_W - W) / 2.0
    M[1, 2] += (new_H - H) / 2.0

    if do_apply and abs(correction) > 0.3:
        img_corr = cv2.warpAffine(img_np, M, (new_W, new_H),
                                   flags=cv2.INTER_LINEAR,
                                   borderMode=cv2.BORDER_REPLICATE)
        def _tx(pt):
            p = np.array([pt[0], pt[1], 1.0])
            return [float((M @ p)[0]), float((M @ p)[1])]
        ruler_pt1 = _tx(ruler_pt1)
        ruler_pt2 = _tx(ruler_pt2)
    else:
        img_corr = img_np
        new_W, new_H = W, H
        correction = 0.0

    # ── perspective distortion score ───────────────────────────────────────────
    # Re-run Hough on corrected image; check spread of near-vertical line angles.
    gray2  = cv2.cvtColor(img_corr, cv2.COLOR_RGB2GRAY)
    edges2 = cv2.Canny(cv2.GaussianBlur(gray2, (5, 5), 0), 40, 120)
    lines2 = cv2.HoughLinesP(edges2, 1, np.pi / 180, threshold=50,
                              minLineLength=max(new_W, new_H) // 6, maxLineGap=15)
    persp_score = 0.0
    if lines2 is not None:
        v_angles = [np.degrees(np.arctan2(s[0][3]-s[0][1], s[0][2]-s[0][0]))
                    for s in lines2
                    if abs(abs(np.degrees(np.arctan2(s[0][3]-s[0][1], s[0][2]-s[0][0]))) - 90) < 30]
        if len(v_angles) >= 3:
            std_v = float(np.std(v_angles))
            persp_score = min(1.0, max(0.0, (std_v - 2.0) / 8.0))

    img_out = Image.fromarray(img_corr)
    return {
        'image_b64':        pil_to_b64_png(img_out),
        'rotation_deg':     float(correction),
        'ruler_pt1':        ruler_pt1,
        'ruler_pt2':        ruler_pt2,
        'perspective_score': persp_score,
        'confidence':       confidence,
        'new_size':         [new_W, new_H],
    }


# ── Entry point ───────────────────────────────────────────────────────────────

COMMANDS = {
    'sam':     (cmd_sam,     2),   # image_b64, [mime]
    'depth':   (cmd_depth,   2),   # image_b64, [mime]
    'grabcut': (cmd_grabcut, 3),   # image_b64, rect_json, [mime]
    'mesh':    (cmd_mesh,    1),   # data_json or @filepath
    'rectify': (cmd_rectify, 1),   # params_json or @filepath
}


def main():
    if len(sys.argv) < 3:
        sys.stderr.write('Usage: td_compute <command> <args...>\n')
        sys.exit(1)

    command = sys.argv[1]
    args = sys.argv[2:]

    if command not in COMMANDS:
        sys.stderr.write(f'Unknown command: {command}\n')
        sys.exit(1)

    fn, _min_args = COMMANDS[command]
    try:
        result = fn(*args)
        print(json.dumps(result))
    except Exception as exc:
        import traceback
        sys.stderr.write(traceback.format_exc())
        print(json.dumps({'error': str(exc)}))
        sys.exit(1)


if __name__ == '__main__':
    main()
