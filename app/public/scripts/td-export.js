// ══════════════════════════ STEP 10: EXPORT ══════════════════════════
function exportDXF() {
  const lines = [];
  const h = (...s) => lines.push(...s.map(String));
  const PW = 420, PH = 297; // A3mm
  const M = 15, GAP = 18;

  // Collect mm data
  const vmm = {};
  ['front','side','top'].forEach(v => {
    const poly = S.polys[v], ppm = S.scale[v];
    if (!ppm || !poly.pts.length) { vmm[v] = null; return; }
    const xs = poly.pts.map(p => p.x/ppm), ys = poly.pts.map(p => p.y/ppm);
    vmm[v] = { xs, ys, w: Math.max(...xs)-Math.min(...xs), h: Math.max(...ys)-Math.min(...ys),
               minX: Math.min(...xs), minY: Math.min(...ys) };
  });

  const fW = vmm.front?.w||80, fH = vmm.front?.h||60;
  const sW = vmm.side?.w||40;
  const tH = vmm.top?.h||40;
  const drawScale = parseFloat(document.getElementById('draw-scale')?.value ?? 1);
  const sc = Math.min(
    (PW - 2*M - GAP*2 - 50) / ((fW + GAP + sW) * drawScale),
    (PH - 2*M - GAP*2 - 30 - 52) / ((tH + GAP + fH) * drawScale)
  );

  const fWp = fW*sc, fHp = fH*sc, sWp = sW*sc, tHp = tH*sc;
  const frontX = M+12, frontY = M+10+tHp+GAP*sc;
  const sideX = frontX + fWp + GAP*sc, sideY = frontY;
  const topX = frontX, topY = M+10;

  h('0','SECTION','2','HEADER',
    '9','$ACADVER','1','AC1009',
    '9','$INSUNITS','70','4',
    '9','$EXTMIN','10','0.0','20','0.0','30','0.0',
    '9','$EXTMAX','10',PW,'20',PH,'30','0.0',
    '0','ENDSEC');
  h('0','SECTION','2','TABLES','0','TABLE','2','LAYER','70','6');
  [['BORDER',7],['OUTLINE',7],['CENTER',3],['DIMS',2],['HIDDEN',1],['CNC',1]].forEach(([n,c]) =>
    h('0','LAYER','2',n,'70','0','62',c,'6',n==='HIDDEN'?'DASHED':n==='CNC'?'DASHDOT':'CONTINUOUS'));
  h('0','ENDTAB','0','ENDSEC','0','SECTION','2','ENTITIES');

  const fy = y => PH - y;
  const line = (lay, x1, y1, x2, y2) => h('0','LINE','8',lay,
    '10',x1.toFixed(3),'20',fy(y1).toFixed(3),'30','0.0',
    '11',x2.toFixed(3),'21',fy(y2).toFixed(3),'31','0.0');
  const txt = (lay, s, x, y, ht=3) => h('0','TEXT','8',lay,
    '10',x.toFixed(3),'20',fy(y).toFixed(3),'30','0.0',
    '40',ht,'1',s,'72','1','73','2',
    '11',x.toFixed(3),'21',fy(y).toFixed(3),'31','0.0');

  // Border
  line('BORDER',M,M,PW-M,M); line('BORDER',PW-M,M,PW-M,PH-M);
  line('BORDER',PW-M,PH-M,M,PH-M); line('BORDER',M,PH-M,M,M);

  // Draw each view
  const drawViewDXF = (v, bx, by, bw, bh, label) => {
    const vd = vmm[v];
    txt('DIMS', label, bx+bw/2, by+bh+5, 2.5);
    if (!vd) return;
    const { xs, ys, minX, minY } = vd;
    const scx = bw/(vd.w||1), scy = bh/(vd.h||1), scl = Math.min(scx, scy);
    const ox = bx + (bw - vd.w*scl)/2, oy = by + (bh - vd.h*scl)/2;
    const px = x => ox + (x-minX)*scl, py = y => oy + (y-minY)*scl;
    const n = xs.length;
    for (let i=0; i<n; i++) {
      const ni = (i+1)%n;
      line('OUTLINE', px(xs[i]), py(ys[i]), px(xs[ni]), py(ys[ni]));
    }
    // Holes as HIDDEN layer
    const viewHolesD = S.holes?.[v];
    if (viewHolesD) viewHolesD.forEach(hole => {
      const ppm = S.scale[v] ?? 1;
      const hn = hole.length;
      for (let i=0; i<hn; i++) {
        const ni=(i+1)%hn;
        const hx1 = ox + (hole[i].x/ppm  - minX)*scl;
        const hy1 = oy + (hole[i].y/ppm  - minY)*scl;
        const hx2 = ox + (hole[ni].x/ppm - minX)*scl;
        const hy2 = oy + (hole[ni].y/ppm - minY)*scl;
        line('HIDDEN', hx1, hy1, hx2, hy2);
      }
    });
    // CNC offset path (dashdot layer) — optional machining allowance
    const cncMm = parseFloat(document.getElementById('cnc-offset')?.value ?? 0);
    if (cncMm !== 0 && typeof geoOffsetPolygon === 'function') {
      const ppmV = S.scale[v] ?? 1;
      const ptsMm = poly.pts.map(p => ({ x: p.x/ppmV, y: p.y/ppmV }));
      const offsetMm = geoOffsetPolygon(ptsMm, cncMm);
      const on = offsetMm.length;
      for (let i = 0; i < on; i++) {
        const ni = (i+1)%on;
        line('CNC', ox+(offsetMm[i].x-minX)*scl, oy+(offsetMm[i].y-minY)*scl,
                     ox+(offsetMm[ni].x-minX)*scl, oy+(offsetMm[ni].y-minY)*scl);
      }
    }
    // Symmetry / center lines
    // If symmetry was detected, place the axis at the actual symmetry position.
    // Otherwise fall back to geometric center.
    const sym = S.symmetry?.[v];
    const ppmV = S.scale[v] ?? 1;
    let symX, symY;
    if (sym?.dir === 'v') {
      // Symmetry axis x in mask pixels → mm → DXF units
      symX = ox + (sym.axis / ppmV - minX) * scl;
      symY = oy + vd.h * scl / 2;
    } else if (sym?.dir === 'h') {
      symX = ox + vd.w * scl / 2;
      symY = oy + (sym.axis / ppmV - minY) * scl;
    } else {
      symX = ox + vd.w * scl / 2;
      symY = oy + vd.h * scl / 2;
    }

    // Vertical centerline
    line('CENTER', symX, by - 6, symX, by + bh + 6);
    // Horizontal centerline
    line('CENTER', bx - 6, symY, bx + bw + 6, symY);

    // Symmetry mark symbol (⊣⊢) — two short perpendicular ticks at each end of the axis
    if (sym) {
      const T = 2.5; // tick half-length in drawing units
      if (sym.dir === 'v') {
        // Ticks at top and bottom of vertical axis
        line('CENTER', symX - T, by - 6,     symX + T, by - 6);
        line('CENTER', symX - T, by + bh + 6, symX + T, by + bh + 6);
      } else {
        // Ticks at left and right of horizontal axis
        line('CENTER', bx - 6,     symY - T, bx - 6,     symY + T);
        line('CENTER', bx + bw + 6, symY - T, bx + bw + 6, symY + T);
      }
    }
  };

  drawViewDXF('front', frontX, frontY, fWp, fHp, 'FRONT');
  drawViewDXF('side',  sideX,  sideY,  sWp, fHp, 'SIDE');
  drawViewDXF('top',   topX,   topY,   fWp, tHp, 'TOP');

  // Dimension lines
  const partName = document.getElementById('part-name')?.value ?? 'Part';
  const TB_X = PW-M-128, TB_Y = PH-M-52;
  line('BORDER',TB_X,TB_Y,PW-M,TB_Y); line('BORDER',TB_X,TB_Y,TB_X,PH-M);
  txt('DIMS', partName, TB_X+(PW-M-TB_X)/2, PH-M-40, 4);
  txt('DIMS', `1:${drawScale}`, TB_X+10, PH-M-22, 3);
  txt('DIMS', new Date().toLocaleDateString('en-GB'), TB_X+10, PH-M-10, 2.5);
  txt('DIMS', 'TD Maker', TB_X+80, PH-M-10, 2.5);

  h('0','ENDSEC','0','EOF');

  const blob = new Blob([lines.join('\n')], { type: 'application/dxf' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `td-drawing-${Date.now()}.dxf`;
  a.click();
}

function exportSVG() {
  const views = ['front','side','top'];
  const svgParts = views.map(v => {
    const poly = S.polys[v];
    if (!poly.pts.length) return '';
    const ppm = S.scale[v] ?? 1;

    // Use Bezier path from vectorization step if available, else polygon fallback
    let d = typeof getVecSvgPath === 'function' ? getVecSvgPath(v) : null;
    if (!d) {
      // Polygon fallback
      const ptStr = poly.pts.map(p => `${(p.x/ppm).toFixed(2)},${(p.y/ppm).toFixed(2)}`).join(' ');
      d = `M ${ptStr.replace(/ /g, ' L ')} Z`;
    }

    // Holes (always as polygon — holes rarely need bezier precision)
    const viewHoles = S.holes?.[v];
    if (viewHoles) viewHoles.forEach(hole => {
      if (hole.length < 3) return;
      const hStr = hole.map(p => `${(p.x/ppm).toFixed(2)},${(p.y/ppm).toFixed(2)}`).join(' ');
      d += ` M ${hStr.replace(/ /g, ' L ')} Z`;
    });
    return `<g id="${v}"><path d="${d}" fill="rgba(13,148,136,0.08)" fill-rule="evenodd" stroke="#0D9488" stroke-width="0.5"/></g>`;
  });
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 297 210" width="297mm" height="210mm">
  <rect width="297" height="210" fill="white"/>
  <text x="10" y="8" font-size="4" fill="#666">TD Maker Export — ${new Date().toLocaleDateString('he-IL')}</text>
  ${svgParts.join('\n  ')}
</svg>`;
  const blob = new Blob([svg], { type: 'image/svg+xml' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = `td-drawing-${Date.now()}.svg`; a.click();
}

function exportPrint() {
  const c = document.getElementById('layout-canvas');
  if (!c) return;
  const url = c.toDataURL('image/png', 0.95);
  const w = window.open('', '_blank');
  w.document.write(`<!DOCTYPE html><html><head><title>TD Drawing</title>
    <style>@page{size:A4 landscape;margin:0}body{margin:0}img{width:100%;height:100vh;object-fit:contain}@media print{button{display:none}}</style>
    </head><body><button onclick="window.print()" style="position:fixed;top:10px;right:10px;z-index:9;padding:8px 18px;cursor:pointer;">Print</button>
    <img src="${url}"/></body></html>`);
  w.document.close();
}

function exportPNG() {
  const c = document.getElementById('layout-canvas');
  if (!c) return;
  const a = document.createElement('a');
  a.href = c.toDataURL('image/png', 0.95);
  a.download = `td-drawing-${Date.now()}.png`; a.click();
}
