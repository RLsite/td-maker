'use strict';
const { app, BrowserWindow, ipcMain, dialog, protocol, net, Menu } = require('electron');
const path = require('path');
const os   = require('os');
const fs   = require('fs');
const { spawn } = require('child_process');

// ── Custom protocol: td:// serves files from app/dist/ ────────────────────────
// This avoids file:// absolute-path issues with Astro's built assets.
protocol.registerSchemesAsPrivileged([
  { scheme: 'td', privileges: { secure: true, standard: true, stream: true, supportFetchAPI: true } },
]);

function getDistPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'dist')
    : path.join(__dirname, '..', 'app', 'dist');
}

// ── Window ─────────────────────────────────────────────────────────────────────
function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    title: 'TD Maker',
    backgroundColor: '#0F172A',
    show: false,
  });

  win.once('ready-to-show', () => win.show());

  // Dev with live server: ELECTRON_DEV=1 loads from localhost:4321
  if (!app.isPackaged && process.env.ELECTRON_DEV === '1') {
    win.loadURL('http://localhost:4321');
  } else {
    win.loadURL('td://app/index.html');
  }

  // F12 → DevTools in dev mode
  if (!app.isPackaged) {
    win.webContents.on('before-input-event', (_e, input) => {
      if (input.key === 'F12') win.webContents.toggleDevTools();
    });
  }

  return win;
}

// ── App lifecycle ──────────────────────────────────────────────────────────────
// ── Application menu ──────────────────────────────────────────────────────────
function buildMenu() {
  const isDev = !app.isPackaged;
  const template = [
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' }, { role: 'togglefullscreen' },
        ...(isDev ? [{ type: 'separator' }, { role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }] : []),
      ],
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }],
    },
    {
      label: 'Help',
      submenu: [{
        label: 'About TD Maker',
        click: () => dialog.showMessageBox({
          type: 'info', title: 'TD Maker',
          message: 'TD Maker\n\nכלי למדידת גדלי עצמים מתמונות',
          buttons: ['OK'],
        }),
      }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  buildMenu();
  // Register td:// → serve files from dist directory
  protocol.handle('td', (request) => {
    const url = new URL(request.url);
    // url.pathname e.g. "/index.html" or "/_astro/index.js"
    let filePath = url.pathname;
    if (filePath === '/' || filePath === '') filePath = '/index.html';
    const fullPath = path.join(getDistPath(), filePath);
    return net.fetch(`file://${fullPath}`);
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ── Python compute sidecar ────────────────────────────────────────────────────
function getComputeExe() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'td_compute.exe');
  }
  // Dev: look for the exe next to the .py file
  return path.join(__dirname, '..', 'compute', 'td_compute.exe');
}

function runCompute(command, args) {
  return new Promise((resolve, reject) => {
    const exe = getComputeExe();
    const proc = spawn(exe, [command, ...args], {
      windowsHide: true,
      encoding: 'utf8',
    });
    let stdout = '', stderr = '';
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(stderr.slice(0, 500) || `exit ${code}`));
      try { resolve(JSON.parse(stdout)); }
      catch (e) { reject(new Error('JSON parse failed: ' + stdout.slice(0, 200))); }
    });
    proc.on('error', (e) => reject(new Error(`Cannot start td_compute.exe: ${e.message}`)));
  });
}

// SAM segmentation: receives base64 image, returns mask as base64 PNG
ipcMain.handle('compute-sam', async (_e, { imageB64, mimeType }) => {
  return runCompute('sam', [imageB64, mimeType || 'image/jpeg']);
});

// Depth estimation: receives base64 image, returns depth map as base64 PNG
ipcMain.handle('compute-depth', async (_e, { imageB64, mimeType }) => {
  return runCompute('depth', [imageB64, mimeType || 'image/jpeg']);
});

// GrabCut: receives base64 image + hint rect, returns refined mask
ipcMain.handle('compute-grabcut', async (_e, { imageB64, rect, mimeType }) => {
  return runCompute('grabcut', [imageB64, JSON.stringify(rect), mimeType || 'image/jpeg']);
});

// 3D mesh generation: receives multi-view contour data (JSON), returns STL (base64)
// Writes JSON to a temp file to avoid Windows command-line length limits.
ipcMain.handle('compute-mesh', async (_e, { meshData }) => {
  const tmp = path.join(os.tmpdir(), `td_mesh_${Date.now()}_${Math.random().toString(36).slice(2)}.json`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(meshData), 'utf8');
    return await runCompute('mesh', [`@${tmp}`]);
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
});

// Rectify: detect/correct camera rotation and report perspective distortion
ipcMain.handle('compute-rectify', async (_e, { paramsJson }) => {
  const tmp = path.join(os.tmpdir(), `td_rect_${Date.now()}_${Math.random().toString(36).slice(2)}.json`);
  try {
    fs.writeFileSync(tmp, paramsJson, 'utf8');
    return await runCompute('rectify', [`@${tmp}`]);
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
});

// Native file-open dialog (alternative to <input type="file">)
ipcMain.handle('open-image-dialog', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Open Image',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'tiff'] }],
  });
  return result.canceled ? null : result.filePaths[0];
});
