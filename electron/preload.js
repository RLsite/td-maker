'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Exposes window.tdCompute to the renderer (the Astro web content).
// All existing JS code checks  window.tdCompute?.isElectron  before calling;
// if undefined (running in plain browser) it falls back to the current JS implementation.
contextBridge.exposeInMainWorld('tdCompute', {
  isElectron: true,

  // Segment Anything Model — receives a canvas/image as base64, returns mask PNG (base64)
  // { mask_png_b64: string, area: number } | { error: string }
  runSAM: (imageB64, mimeType) =>
    ipcRenderer.invoke('compute-sam', { imageB64, mimeType }),

  // Depth-Anything v2 — returns depth map PNG (base64, grayscale 16-bit → normalized 8-bit)
  // { depth_png_b64: string } | { error: string }
  runDepth: (imageB64, mimeType) =>
    ipcRenderer.invoke('compute-depth', { imageB64, mimeType }),

  // GrabCut refinement — rect = { x, y, w, h } in image pixels
  // { mask_png_b64: string } | { error: string }
  runGrabCut: (imageB64, rect, mimeType) =>
    ipcRenderer.invoke('compute-grabcut', { imageB64, rect, mimeType }),

  // 3D mesh generation — returns { stl_b64, voxel_count, face_count } | { error }
  runMesh: (meshData) =>
    ipcRenderer.invoke('compute-mesh', { meshData }),

  // Rectify: correct camera rotation and report perspective distortion
  // params: { image: base64, ruler_orientation: 'h'|'v'|'auto', apply: bool }
  // returns: { image_b64, rotation_deg, ruler_pt1, ruler_pt2, perspective_score, confidence, new_size }
  runRectify: (params) =>
    ipcRenderer.invoke('compute-rectify', { paramsJson: JSON.stringify(params) }),

  // Native file-open dialog — returns file path string or null
  openImageDialog: () =>
    ipcRenderer.invoke('open-image-dialog'),
});
