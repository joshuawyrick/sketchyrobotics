const { PNG } = require('pngjs'); const fs = require('fs');
const Planner = require('../js/planner.js'); const IT = require('../js/imagetrace.js');
const png = PNG.sync.read(fs.readFileSync('test/clown.png')); const widthMm = 152;
const UP = +(process.env.UP || 1); const W2 = png.width * UP, H2 = png.height * UP; const d2 = new Uint8ClampedArray(W2 * H2 * 4);
for (let y = 0; y < H2; y++) for (let x = 0; x < W2; x++) { // bilinear upscale
  const sx = x / UP, sy = y / UP, x0 = Math.min(png.width - 1, Math.floor(sx)), y0 = Math.min(png.height - 1, Math.floor(sy)), x1 = Math.min(png.width - 1, x0 + 1), y1 = Math.min(png.height - 1, y0 + 1), fx = sx - x0, fy = sy - y0;
  for (let c = 0; c < 3; c++) { const v = png.data[(y0 * png.width + x0) * 4 + c] * (1 - fx) * (1 - fy) + png.data[(y0 * png.width + x1) * 4 + c] * fx * (1 - fy) + png.data[(y1 * png.width + x0) * 4 + c] * (1 - fx) * fy + png.data[(y1 * png.width + x1) * 4 + c] * fx * fy; d2[(y * W2 + x) * 4 + c] = v; } d2[(y * W2 + x) * 4 + 3] = 255; }
const img = { width: W2, height: H2, data: d2 };
const c = { imgThr: 187, imgSpeck: 9, imgSmooth: +(process.argv[2] || 5), imgPrune: +(process.argv[3] || 3), optJoin: 0.6, optSeg: +(process.argv[4] || 1.5), optTurn: +(process.argv[5] || 5), optSimp: +(process.argv[6] || 0.1), optMin: 1.0 };
const t = IT.trace(img, { mode: 'ink', threshold: c.imgThr, blur: false, minBlobPx: c.imgSpeck * UP * UP, prunePx: c.imgPrune * UP, dotMaxPx: process.env.DOTS === '0' ? 0 : Math.max(8, Math.round(img.width * 0.02)), thickPx: process.env.THICK ? +process.env.THICK : 0, penPx: +(process.env.PENPX || 3) });
const mmPerPx = widthMm / img.width;
const strokes = t.polylines.map(p => (p.dot ? p : Planner.smooth(p, p.fill ? 2 : c.imgSmooth * UP)).map(q => ({ x: q.x * mmPerPx, y: -q.y * mmPerPx })));
const plan = Planner.plan(strokes, { joinMm: c.optJoin, simplifyMm: c.optSimp, minStrokeMm: c.optMin, maxSegMm: c.optSeg, maxTurnDeg: c.optTurn, optimize: false, start: { x: 0, y: 0 } });
// render the eye region: x 30-70%, y 14-34% at 12 px per mm, pen 0.5 mm wide
const S = 12, x0 = widthMm * 0.30, x1 = widthMm * 0.70, y0 = -(img.height * mmPerPx) * 0.34, y1 = -(img.height * mmPerPx) * 0.14;
const W = Math.ceil((x1 - x0) * S), H = Math.ceil((y1 - y0) * S); const out = new PNG({ width: W, height: H }); out.data.fill(255);
const dot = (x, y) => { const cx = (x - x0) * S, cy = (y1 - y) * S; for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) { if (dx * dx + dy * dy > 9) continue; const px = Math.round(cx + dx), py = Math.round(cy + dy); if (px >= 0 && py >= 0 && px < W && py < H) { const i = (py * W + px) * 4; out.data[i] = out.data[i + 1] = out.data[i + 2] = 20; } } };
let n = 0; for (const s of plan.strokes) for (let i = 1; i < s.length; i++) { const a = s[i - 1], b = s[i], L = Math.hypot(b.x - a.x, b.y - a.y), k = Math.ceil(L * S) + 1; for (let j = 0; j <= k; j++) dot(a.x + (b.x - a.x) * j / k, a.y + (b.y - a.y) * j / k); n++; }
fs.writeFileSync(process.argv[7] || 'test/eyes-plan.png', PNG.sync.write(out)); console.log('segments in whole drawing', n, 'strokes', plan.strokes.length);
