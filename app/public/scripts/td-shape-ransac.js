// ══════════════════════════ SHAPE DESCRIPTORS ══════════════════════════════
// Hu Moments (Hu 1962), Ellipse Fit, Convex Hull, Euler Number, Radial Signature
// Reference: Szeliski Ch.14, Prince Ch.3, Hu IEEE Trans. 1962

// ── Andrew's Monotone Chain convex hull O(n log n) ─────────────────────
function convexHullAndrews(points) {
  if (points.length < 3) return [...points];
  const pts = [...points].sort((a,b)=>a.x!==b.x?a.x-b.x:a.y-b.y);
  const cross=(O,A,B)=>(A.x-O.x)*(B.y-O.y)-(A.y-O.y)*(B.x-O.x);
  const lower=[], upper=[];
  for (const p of pts) {
    while (lower.length>=2&&cross(lower[lower.length-2],lower[lower.length-1],p)<=0) lower.pop();
    lower.push(p);
  }
  for (let i=pts.length-1;i>=0;i--) {
    const p=pts[i];
    while (upper.length>=2&&cross(upper[upper.length-2],upper[upper.length-1],p)<=0) upper.pop();
    upper.push(p);
  }
  upper.pop(); lower.pop();
  return [...lower,...upper];
}

// ── Polygon area (shoelace / Green's theorem) ──────────────────────────
function _polyArea(pts) {
  let a=0;
  for (let i=0;i<pts.length;i++) {
    const j=(i+1)%pts.length;
    a+=pts[i].x*pts[j].y-pts[j].x*pts[i].y;
  }
  return Math.abs(a)/2;
}

// ── Polygon perimeter ──────────────────────────────────────────────────
function _polyPerim(pts) {
  let p=0;
  for (let i=0;i<pts.length;i++) {
    const j=(i+1)%pts.length;
    p+=Math.sqrt((pts[j].x-pts[i].x)**2+(pts[j].y-pts[i].y)**2);
  }
  return p;
}

// ── Ray–segment intersection: returns t>=0 or null ────────────────────
function _raySegT(ox,oy,dx,dy,x1,y1,x2,y2) {
  const ex=x2-x1, ey=y2-y1;
  const det=dx*ey-dy*ex;
  if (Math.abs(det)<1e-10) return null;
  const t=((x1-ox)*ey-(y1-oy)*ex)/det;
  const s=((x1-ox)*dy-(y1-oy)*dx)/det;
  return (t>=0&&s>=0&&s<=1)?t:null;
}

// ── Radial signature r(θ): ray cast to polygon boundary ───────────────
function computeRadialSig(pts, n=180) {
  let cx=0, cy=0;
  pts.forEach(p=>{cx+=p.x; cy+=p.y;});
  cx/=pts.length; cy/=pts.length;
  const sig=new Float32Array(n);
  for (let i=0;i<n;i++) {
    const angle=2*Math.PI*i/n;
    const dx=Math.cos(angle), dy=Math.sin(angle);
    let maxT=0;
    for (let j=0;j<pts.length;j++) {
      const k=(j+1)%pts.length;
      const t=_raySegT(cx,cy,dx,dy,pts[j].x,pts[j].y,pts[k].x,pts[k].y);
      if (t!==null&&t>maxT) maxT=t;
    }
    sig[i]=maxT;
  }
  return {sig, cx, cy};
}

// ── Draw radial signature r(θ) as a small polar + line plot ───────────
function drawRadialSig(canvas, sig) {
  const W=canvas.width, H=canvas.height;
  const ctx=canvas.getContext('2d');
  ctx.clearRect(0,0,W,H);
  ctx.fillStyle='#0F172A'; ctx.fillRect(0,0,W,H);

  const n=sig.length;
  const maxR=Math.max(...sig)||1;

  // Line chart of r(θ)
  ctx.beginPath();
  ctx.strokeStyle='#A78BFA'; ctx.lineWidth=1.5;
  for (let i=0;i<n;i++) {
    const x=i*W/n, y=H-1-(sig[i]/maxR)*(H-4);
    i===0?ctx.moveTo(x,y):ctx.lineTo(x,y);
  }
  ctx.stroke();

  // Axes
  ctx.strokeStyle='rgba(255,255,255,.15)'; ctx.lineWidth=0.5; ctx.setLineDash([2,2]);
  ctx.beginPath(); ctx.moveTo(0,H/2); ctx.lineTo(W,H/2); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle='rgba(167,139,250,.5)';
  ctx.font='9px Fira Code,monospace';
  ctx.fillText('r(θ)',3,10);
  ctx.fillText('0°',2,H-2); ctx.fillText('360°',W-22,H-2);
}

// ── Rasterize polygon to binary mask ──────────────────────────────────
function _rasterizePoly(pts, SIZE=192) {
  const tmp=document.createElement('canvas');
  tmp.width=tmp.height=SIZE;
  const ctx=tmp.getContext('2d');
  let mnX=Infinity,mnY=Infinity,mxX=-Infinity,mxY=-Infinity;
  pts.forEach(p=>{mnX=Math.min(mnX,p.x);mxX=Math.max(mxX,p.x);mnY=Math.min(mnY,p.y);mxY=Math.max(mxY,p.y);});
  const pad=8, sw=mxX-mnX||1, sh=mxY-mnY||1;
  const s=Math.min((SIZE-2*pad)/sw,(SIZE-2*pad)/sh);
  const tx=x=>pad+(x-mnX)*s, ty=y=>pad+(y-mnY)*s;
  ctx.fillStyle='white'; ctx.fillRect(0,0,SIZE,SIZE);
  ctx.fillStyle='black';
  ctx.beginPath(); ctx.moveTo(tx(pts[0].x),ty(pts[0].y));
  pts.forEach(p=>ctx.lineTo(tx(p.x),ty(p.y)));
  ctx.closePath(); ctx.fill();
  const d=ctx.getImageData(0,0,SIZE,SIZE).data;
  const mask=new Uint8Array(SIZE*SIZE);
  for (let i=0;i<SIZE*SIZE;i++) mask[i]=d[i*4]<128?1:0;
  return {mask,SIZE,s};
}

// ── Main shape descriptor computation ─────────────────────────────────
function computeShapeDescriptors() {
  const view=vecView;
  const poly=S.polys?.[view];
  if (!poly?.closed||poly.pts.length<5) { alert('No closed contour in this view'); return; }
  const pts=poly.pts;

  // Rasterize → raw moments
  const {mask,SIZE,s:rScale}=_rasterizePoly(pts,192);
  let m00=0,m10=0,m01=0,m20=0,m02=0,m11=0;
  let m30=0,m21=0,m12=0,m03=0;
  for (let y=0;y<SIZE;y++) for (let x=0;x<SIZE;x++) {
    const f=mask[y*SIZE+x]; if(!f) continue;
    m00+=f; m10+=x; m01+=y;
    m20+=x*x; m02+=y*y; m11+=x*y;
    m30+=x*x*x; m21+=x*x*y; m12+=x*y*y; m03+=y*y*y;
  }
  const cx=m10/m00, cy=m01/m00;

  // Central moments μ_pq
  const mu20=m20-m10*m10/m00, mu02=m02-m01*m01/m00, mu11=m11-m10*m01/m00;
  const mu30=m30-3*cx*m20+2*cx*cx*m10;
  const mu12=m12-2*cy*m11-cx*m02+2*cy*cy*m10;
  const mu21=m21-2*cx*m11-cy*m20+2*cx*cx*m01;
  const mu03=m03-3*cy*m02+2*cy*cy*m01;

  // Scale-normalized η_pq
  const A=m00;
  const n20=mu20/(A*A),n02=mu02/(A*A),n11=mu11/(A*A);
  const n30=mu30/Math.pow(A,2.5),n03=mu03/Math.pow(A,2.5);
  const n21=mu21/Math.pow(A,2.5),n12=mu12/Math.pow(A,2.5);

  // Hu's 7 invariant moments (Hu 1962)
  const hu=[
    n20+n02,
    (n20-n02)**2+4*n11**2,
    (n30-3*n12)**2+(3*n21-n03)**2,
    (n30+n12)**2+(n21+n03)**2,
    (n30-3*n12)*(n30+n12)*((n30+n12)**2-3*(n21+n03)**2)+(3*n21-n03)*(n21+n03)*(3*(n30+n12)**2-(n21+n03)**2),
    (n20-n02)*((n30+n12)**2-(n21+n03)**2)+4*n11*(n30+n12)*(n21+n03),
    (3*n21-n03)*(n30+n12)*((n30+n12)**2-3*(n21+n03)**2)-(n30-3*n12)*(n21+n03)*(3*(n30+n12)**2-(n21+n03)**2)
  ];

  // Ellipse fit from covariance matrix (Szeliski §7.1.3)
  const vxx=mu20/m00, vyy=mu02/m00, vxy=mu11/m00;
  const orientRad=0.5*Math.atan2(2*vxy,vxx-vyy);
  const disc=Math.sqrt(Math.max(0,((vxx-vyy)/2)**2+vxy**2));
  const lam1=(vxx+vyy)/2+disc, lam2=Math.max(0,(vxx+vyy)/2-disc);
  const semiA=2*Math.sqrt(lam1), semiB=2*Math.sqrt(lam2);
  const ecc=Math.sqrt(Math.max(0,1-(semiB/Math.max(semiA,1e-6))**2));
  const elongation=semiA/Math.max(semiB,1e-6);

  // Geometric features from polygon vertices
  const polyArea=_polyArea(pts);
  const polyPerim=_polyPerim(pts);
  const circularity=4*Math.PI*polyArea/(polyPerim*polyPerim);

  // Convex hull (Andrew's monotone chain)
  const hull=convexHullAndrews(pts);
  const hullArea=_polyArea(hull);
  const hullPerim=_polyPerim(hull);
  const solidity=polyArea/Math.max(hullArea,1);
  const convexity=hullPerim/Math.max(polyPerim,1);

  // Euler number χ = 1 - holes
  const holes=(S.holes?.[view]?.length)||0;
  const euler=1-holes;

  // Radial signature r(θ)
  const {sig:radSig}=computeRadialSig(pts,180);

  // Display
  _displayShapeDesc({hu, ecc, elongation, orientRad, circularity, solidity, convexity,
    euler, holes, polyArea, polyPerim, hullArea, radSig});
}

function _displayShapeDesc({hu,ecc,elongation,orientRad,circularity,solidity,convexity,euler,holes,polyArea,polyPerim,hullArea,radSig}) {
  const el=document.getElementById('shape-desc');
  if (!el) return;
  const ppm=S.scale[vecView];
  const srcW=S.polyCanvasSize?.[vecView]?.w??1;
  const c=document.getElementById('vec-canvas');
  const dScale=c?c.width/srcW:1;

  const fmtPx=(px)=>ppm?`${(px/dScale/ppm).toFixed(1)} mm`:`${Math.round(px/dScale)} px`;
  const fmtPx2=(px2)=>ppm?`${(px2/dScale/dScale/(ppm*ppm)).toFixed(1)} mm²`:`${Math.round(px2/(dScale*dScale))} px²`;

  // Log-scale Hu for display (standard in literature)
  const huStr=hu.map((v,i)=>{
    const lv=v===0?0:-Math.sign(v)*Math.log10(Math.abs(v)||1e-30);
    return `<span style="color:var(--text);font-weight:600;">φ${i+1}</span><span style="color:#A78BFA;">${lv.toFixed(2)}</span>`;
  }).join(' ');

  el.innerHTML=`
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px 8px;margin-bottom:8px;">
      ${[
        ['Area',      fmtPx2(polyArea)],
        ['Perimeter', fmtPx(polyPerim)],
        ['Circularity', circularity.toFixed(3)],
        ['Solidity',  solidity.toFixed(3)],
        ['Convexity', convexity.toFixed(3)],
        ['Eccentr.',  ecc.toFixed(3)],
        ['Elongation',elongation.toFixed(2)],
        ['Angle',     `${(orientRad*180/Math.PI).toFixed(1)}°`],
        ['χ Euler',   `${euler} (${holes} holes)`],
        ['Hull',      fmtPx2(hullArea)],
      ].map(([k,v])=>`
        <div style="display:flex;justify-content:space-between;padding:2px 0;border-bottom:1px solid var(--border);">
          <span style="color:var(--muted);font-size:10px;">${k}</span>
          <span style="color:var(--text);font-size:10px;font-family:'Fira Code',monospace;">${v}</span>
        </div>`).join('')}
    </div>
    <div style="font-size:10px;color:var(--muted);margin-bottom:4px;">Hu moments (log scale, rotation/scale invariant):</div>
    <div style="font-size:10px;font-family:'Fira Code',monospace;display:flex;flex-wrap:wrap;gap:4px;">${huStr}</div>`;

  const sigCanvas=document.getElementById('radial-sig-canvas');
  if (sigCanvas) { sigCanvas.style.display='block'; drawRadialSig(sigCanvas,radSig); }
}

// ══════════════════════════ RANSAC SHAPE FITTING ══════════════════════════
// Fischler & Bolles 1981 — Szeliski Ch.6
// Used in vectorization to robustly fit lines and circles to contour segments

function ransacFitLine(pts, thr=2.5, iters=80) {
  if (pts.length<2) return null;
  let best={n:0,a:0,b:0,c:0};
  for (let it=0; it<iters; it++) {
    const i1=Math.floor(Math.random()*pts.length);
    let i2=i1; while (i2===i1) i2=Math.floor(Math.random()*pts.length);
    const [p1,p2]=[pts[i1],pts[i2]];
    const dx=p2.x-p1.x, dy=p2.y-p1.y, len=Math.sqrt(dx*dx+dy*dy);
    if (len<1) continue;
    const a=dy/len, b=-dx/len, c=-(a*p1.x+b*p1.y);
    const n=pts.filter(p=>Math.abs(a*p.x+b*p.y+c)<thr).length;
    if (n>best.n) best={n,a,b,c};
  }
  return best.n/pts.length >= 0.75 ? best : null;
}

function ransacFitCircle(pts, thr=3, iters=150) {
  if (pts.length<3) return null;
  let best={n:0,cx:0,cy:0,r:0};
  for (let it=0; it<iters; it++) {
    const idxs=new Set(); while(idxs.size<3) idxs.add(Math.floor(Math.random()*pts.length));
    const [p1,p2,p3]=[...idxs].map(i=>pts[i]);
    const ax=p2.x-p1.x, ay=p2.y-p1.y, bx=p3.x-p1.x, by=p3.y-p1.y;
    const D=2*(ax*by-ay*bx); if (Math.abs(D)<1e-10) continue;
    const ux=(by*(ax*ax+ay*ay)-ay*(bx*bx+by*by))/D;
    const uy=(ax*(bx*bx+by*by)-bx*(ax*ax+ay*ay))/D;
    const cx=p1.x+ux, cy=p1.y+uy, r=Math.sqrt(ux*ux+uy*uy);
    if (r<4||r>Math.max(cC?.width??999,cC?.height??999)) continue;
    const n=pts.filter(p=>Math.abs(Math.sqrt((p.x-cx)**2+(p.y-cy)**2)-r)<thr).length;
    if (n>best.n) best={n,cx,cy,r};
  }
  return best.n/pts.length >= 0.65 ? best : null;

}