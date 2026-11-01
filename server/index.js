/* Sketchy Robotics — event server
   Serves: /            guest iPad app
           /admin       theme + queue management (password)
           /studio      Plotter Studio (operator, Chrome + USB)
   API:    see routes below. All state lives in DATA_DIR (themes, jobs, uploads) so it survives restarts.
*/
const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const THEMES = path.join(DATA, 'themes');
const JOBS = path.join(DATA, 'jobs');
for (const d of [DATA, THEMES, JOBS]) fs.mkdirSync(d, { recursive: true });

// ---------- durable storage mirror (Replit Object Storage) ----------
// Autoscale deployments lose the local disk on every redeploy. If a bucket is available we mirror every file
// we write into it and restore from it at startup, so themes/prompts/photos/art survive. Local disk stays the
// working copy, so nothing else in the server needs to know.
let bucket = null;
// Replit sets REPLIT_DEPLOYMENT=1 only in the published app. In the dev workspace we still READ the bucket
// (so the Agent can test with real themes) but never write to it, so testing can't disturb the live data.
const IS_DEPLOYMENT = process.env.REPLIT_DEPLOYMENT === '1' || process.env.STORAGE_WRITE === '1';
const BUCKET_ID = process.env.OBJECT_STORAGE_BUCKET || process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID || process.env.DEFAULT_OBJECT_STORAGE_BUCKET || process.env.REPLIT_OBJECT_STORAGE_BUCKET || '';
try { if (BUCKET_ID || process.env.REPL_ID) { const { Client } = require(process.env.OBJECT_STORAGE_MODULE || '@replit/object-storage'); bucket = new Client(BUCKET_ID ? { bucketId: BUCKET_ID } : undefined); } } catch (e) { console.log('object storage not available:', e.message); bucket = null; }
const rel = f => path.relative(DATA, f).split(path.sep).join('/');
function persist(file) { if (!bucket || !IS_DEPLOYMENT) return; const key = rel(file); fs.promises.readFile(file).then(buf => bucket.uploadFromBytes(key, buf)).then(r => { if (r && !r.ok) console.error('storage upload failed', key, r.error && r.error.message); }).catch(e => console.error('storage upload', key, e.message)); }
function unpersist(prefix) { if (!bucket || !IS_DEPLOYMENT) return; bucket.list().then(r => { if (!r.ok) return; for (const o of r.value) if (o.name.startsWith(rel(prefix) + '/')) bucket.delete(o.name).catch(() => {}); }).catch(() => {}); }
const toBuf = d => Array.isArray(d.value) ? Buffer.concat(d.value.map(x => Buffer.isBuffer(x) ? x : Buffer.from(x))) : Buffer.from(d.value); // real SDK returns [Buffer]
async function download(key, dest) { let d; try { d = await bucket.downloadAsBytes(key); } catch (e) { return false; } if (!d.ok) return false; fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, toBuf(d)); return true; }
/** photos/art are fetched from the bucket the first time they're needed (keeps startup fast) */
async function ensureLocal(file) { if (fs.existsSync(file)) return true; if (!bucket) return false; return download(rel(file), file); }
async function restoreFromBucket() {
  if (!bucket) { console.log('storage: local disk only (no Replit bucket)'); return; }
  const r = await bucket.list().catch(e => ({ ok: false, error: e }));
  if (!r.ok) { console.log('storage: bucket unreachable, local disk only:', r.error && r.error.message, BUCKET_ID ? '' : '— set Secret OBJECT_STORAGE_BUCKET to your App Storage bucket name (e.g. repl-default-bucket-...)'); bucket = null; return; }
  // The bucket is the source of truth. The published app's disk starts as a stale snapshot of the workspace (and is wiped on every
  // redeploy anyway), so in deployment we throw the snapshot away and rebuild from the bucket: small files now, photos/art on demand.
  if (IS_DEPLOYMENT) { for (const d of [THEMES, JOBS]) fs.rmSync(d, { recursive: true, force: true }); fs.rmSync(SETTINGS_FILE, { force: true }); fs.rmSync(path.join(DATA, 'lab-refs.json'), { force: true }); for (const d of [THEMES, JOBS]) fs.mkdirSync(d, { recursive: true }); }
  let n = 0;
  for (const o of r.value) {
    if (!o.name || o.name.endsWith('/') || !/^(themes|jobs)\/|^(settings|lab-refs)\.json$/.test(o.name)) continue; // skip folders and anything that isn't ours
    const dest = path.join(DATA, o.name);
    if (IS_DEPLOYMENT && /\/(photo\.jpg|art\.png|art-thumb\.png)$/.test(o.name)) continue; // big files: fetched when first requested
    if (await download(o.name, dest)) n++;
  }
  console.log(`storage: Replit bucket connected (${BUCKET_ID || 'default'}), restored ${n} file(s)` + (IS_DEPLOYMENT ? '' : ' — dev workspace: read-only, nothing here is written back to the bucket'));
}

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'sketchy';
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_BASE = process.env.OPENAI_BASE || 'https://api.openai.com';

// ---------- settings ----------
const SETTINGS_FILE = path.join(DATA, 'settings.json');
const DEFAULT_SETTINGS = { model: 'gpt-image-2-2026-04-21', quality: 'medium', size: '1024x1536', moderation: 'low', concurrency: 2, autoRun: true, pauseBetween: true, eventName: 'Sketchy Robotics', cameraZoom: 1.6 };
function getSettings() { try { return Object.assign({}, DEFAULT_SETTINGS, JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))); } catch (_) { return Object.assign({}, DEFAULT_SETTINGS); } }
function saveSettings(s) { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2)); persist(SETTINGS_FILE); }

// ---------- themes ----------
// data/themes/<slug>/theme.json { name, enabled, order }, thumb.png, prompts/<variant>.txt
const VARIANTS = ['1-male', '1-female', '2-male-male', '2-female-female', '2-male-female', '2-female-male', 'pet-male', 'pet-female'];
const VARIANT_LABELS = { '1-male': 'Single male', '1-female': 'Single female', '2-male-male': 'Two males', '2-female-female': 'Two females', '2-male-female': 'Male (left) + female (right)', '2-female-male': 'Female (left) + male (right)', 'pet-male': 'Male + pet', 'pet-female': 'Female + pet' };
function slugify(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'theme'; }
function readTheme(slug) {
  const dir = path.join(THEMES, slug); if (!fs.existsSync(path.join(dir, 'theme.json'))) return null;
  const t = JSON.parse(fs.readFileSync(path.join(dir, 'theme.json'), 'utf8')); t.slug = slug;
  t.prompts = {}; for (const v of VARIANTS) { const f = path.join(dir, 'prompts', v + '.txt'); t.prompts[v] = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''; }
  t.hasThumb = fs.existsSync(path.join(dir, 'thumb.png')); t.variantModels = t.variantModels || {};
  return t;
}
function listThemes() { return fs.readdirSync(THEMES).map(readTheme).filter(Boolean).sort((a, b) => (a.order || 0) - (b.order || 0) || a.name.localeCompare(b.name)); }
function writeTheme(slug, t) {
  const dir = path.join(THEMES, slug); fs.mkdirSync(path.join(dir, 'prompts'), { recursive: true });
  const vm = {}; for (const v of VARIANTS) { const x = t.variantModels && t.variantModels[v]; if (x && (x.model || x.quality)) vm[v] = { model: x.model || '', quality: x.quality || '' }; }
  fs.writeFileSync(path.join(dir, 'theme.json'), JSON.stringify({ name: t.name, enabled: t.enabled !== false, order: t.order || 0, model: t.model || '', quality: t.quality || '', moderation: t.moderation || '', variantModels: vm }, null, 2)); persist(path.join(dir, 'theme.json')); // model/quality: blank = use Settings; variantModels: per-combination overrides
  if (t.prompts) for (const v of VARIANTS) if (v in t.prompts) { const f = path.join(dir, 'prompts', v + '.txt'); fs.writeFileSync(f, String(t.prompts[v] || '')); persist(f); }
}


// ---------- jobs ----------
// data/jobs/<id>/job.json, photo.jpg, art.png
const jobs = new Map(); let seq = 0;
function loadState() {
  if (!listThemes().length) writeTheme('evil-clown', { name: 'Evil Clown', enabled: true, order: 1, prompts: {} });
  for (const id of fs.readdirSync(JOBS)) { try { jobs.set(id, JSON.parse(fs.readFileSync(path.join(JOBS, id, 'job.json'), 'utf8'))); } catch (_) { } }
  for (const j of jobs.values()) if (j.status === 'processing') { j.status = 'pending'; } // server restarted mid-call
  seq = Math.max(0, ...[...jobs.values()].map(j => j.number || 0));
}
function saveJob(j) { fs.mkdirSync(path.join(JOBS, j.id), { recursive: true }); const f = path.join(JOBS, j.id, 'job.json'); fs.writeFileSync(f, JSON.stringify(j, null, 2)); jobs.set(j.id, j); if (!j.test || j.lab) persist(f); }
function publicJob(j) { const { id, number, status, theme, themeName, variant, createdAt, readyAt, doneAt, error, attempts, position, drawSeconds, strokes, widthMm, preset, names } = j; return { id, number, status, theme, themeName, variant, createdAt, readyAt, doneAt, error, attempts, position, drawSeconds, strokes, widthMm, preset, names }; }
const cleanName = v => String(v || '').replace(/[^\p{L}\p{N} .,'&-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 24); // letters the plotter font has
function sortedJobs() { return [...jobs.values()].sort((a, b) => (a.priority || 0) - (b.priority || 0) || a.createdAt - b.createdAt); }
function queuePosition(id) { let n = 0; for (const j of sortedJobs()) { if (['pending', 'processing', 'ready', 'drawing'].includes(j.status)) { n++; if (j.id === id) return n; } } return null; }

// ---------- OpenAI ----------
/** Settings ← theme override ← this combination's override ← an explicit pick (Lab) */
function effectiveSettings(theme, variant, override) {
  const pick = o => { const r = {}; for (const k of ['model', 'quality', 'moderation']) if (o && o[k]) r[k] = o[k]; return r; };
  return Object.assign(getSettings(), pick(theme), pick(theme.variantModels && theme.variantModels[variant]), override || {});
}
async function generateArt(job, override) {
  const theme = readTheme(job.theme); if (!theme) throw new Error('theme missing');
  const s = effectiveSettings(theme, job.variant, override);
  const prompt = (override && override.prompt != null ? String(override.prompt) : (theme.prompts[job.variant] || '')).trim(); if (!prompt) throw new Error(`no prompt saved for ${theme.name} / ${VARIANT_LABELS[job.variant]}`);
  job.used = { model: s.model, quality: s.quality, size: s.size, moderation: s.moderation };
  if (!OPENAI_KEY) throw new Error('OPENAI_API_KEY is not set in Secrets');
  const photoFile = path.join(JOBS, job.id, 'photo.jpg'); if (!(await ensureLocal(photoFile))) throw new Error('photo missing'); const photo = fs.readFileSync(photoFile);
  const form = new FormData();
  form.append('model', s.model); form.append('prompt', prompt); form.append('n', '1');
  if (s.size) form.append('size', s.size); if (s.quality) form.append('quality', s.quality);
  if (s.moderation) form.append('moderation', s.moderation); // 'low' = less restrictive filter (still refuses the worst)
  form.append('output_format', 'png');
  form.append('image', new Blob([photo], { type: 'image/jpeg' }), 'photo.jpg');
  const call = async (f) => { const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 180000);
    try { const r = await fetch(OPENAI_BASE + '/v1/images/edits', { method: 'POST', headers: { Authorization: 'Bearer ' + OPENAI_KEY }, body: f, signal: ctrl.signal }); return { res: r, body: await r.json().catch(() => ({})) }; } finally { clearTimeout(t); } };
  let { res, body } = await call(form);
  // a model that doesn't know a parameter says so ("does not support the 'moderation' parameter"); drop it and try again, up to 3 times
  for (let i = 0; i < 3 && !res.ok && body.error; i++) {
    const m = (body.error.message || '').match(/(?:does not support|not supported|unknown|unsupported|unrecognized)[^']*'([a-z_]+)'|'([a-z_]+)'[^.]*(?:is not supported|not supported|unknown)/i); const bad = m && (m[1] || m[2]);
    if (!bad || !form.has(bad) || bad === 'model' || bad === 'prompt' || bad === 'image') break;
    form.delete(bad); job.droppedParam = (job.droppedParam ? job.droppedParam + ', ' : '') + bad; ({ res, body } = await call(form));
  }
  if (!res.ok) throw new Error('OpenAI ' + res.status + ': ' + (body.error && body.error.message || JSON.stringify(body)).slice(0, 300));
  const b64 = body.data && body.data[0] && body.data[0].b64_json; if (!b64) throw new Error('OpenAI returned no image');
  // normalise: flatten onto white, make sure it's a clean PNG the tracer likes
  const png = await sharp(Buffer.from(b64, 'base64')).flatten({ background: '#ffffff' }).png().toBuffer();
  fs.writeFileSync(path.join(JOBS, job.id, 'art.png'), png);
  await sharp(png).resize(400, 400, { fit: 'inside' }).png().toFile(path.join(JOBS, job.id, 'art-thumb.png'));
  if (!job.test || job.lab) { persist(path.join(JOBS, job.id, 'art.png')); persist(path.join(JOBS, job.id, 'art-thumb.png')); }
}
let running = 0;
async function pump() {
  const s = getSettings();
  while (running < (s.concurrency || 1)) {
    const next = sortedJobs().find(j => j.status === 'pending'); if (!next) return;
    next.status = 'processing'; next.attempts = (next.attempts || 0) + 1; next.startedAt = Date.now(); saveJob(next); running++;
    generateArt(next).then(() => { next.status = 'ready'; next.readyAt = Date.now(); next.error = null; })
      .catch(e => { next.status = next.attempts >= 2 ? 'failed' : 'pending'; next.error = String(e.message || e) + (e.cause ? ' (' + (e.cause.code || e.cause.message) + ')' : ''); console.error('job', next.number, next.error); })
      .finally(() => { saveJob(next); running--; setTimeout(pump, next.status === 'pending' ? 5000 : 50); });
  }
}
setInterval(pump, 3000); pump();
// a job claimed by the operator page but never finished (page closed, laptop slept) goes back to ready after 15 min
setInterval(() => { for (const j of jobs.values()) if (j.status === 'drawing' && Date.now() - (j.drawStartedAt || 0) > 15 * 60000) { j.status = 'ready'; saveJob(j); } }, 60000);

// ---------- app ----------
const app = express();
app.use(express.json({ limit: '2mb' }));
app.disable('x-powered-by');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const adminAuth = (req, res, next) => { const t = req.get('x-admin-token') || req.query.token; if (t === ADMIN_PASSWORD) return next(); res.status(401).json({ error: 'bad password' }); };

// static pages
app.use('/studio', express.static(path.join(ROOT, 'public', 'studio')));
app.use('/admin', express.static(path.join(ROOT, 'public', 'admin')));
app.use('/', express.static(path.join(ROOT, 'public', 'guest')));
app.get('/p/:code', (req, res) => res.sendFile(path.join(ROOT, 'public', 'phone', 'index.html'))); // guest's own phone: scanned from the iPad's QR

// ----- phone hand-off: the iPad mints a short code tied to the theme/variant the guest picked; the phone uploads a photo to it -----
const phoneCodes = new Map(); // code -> { theme, themeName, variant, createdAt, photo: Buffer|null }
const PHONE_TTL = 10 * 60000;
setInterval(() => { for (const [c, v] of phoneCodes) if (Date.now() - v.createdAt > PHONE_TTL) phoneCodes.delete(c); }, 60000);
app.post('/api/phone/code', (req, res) => {
  const theme = readTheme(slugify(req.body.theme || '')); const variant = String(req.body.variant || '');
  if (!theme || !VARIANTS.includes(variant)) return res.status(400).json({ error: 'pick a style first' });
  let code; do { code = Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[crypto.randomInt(32)]).join(''); } while (phoneCodes.has(code));
  phoneCodes.set(code, { theme: theme.slug, themeName: theme.name, variant, createdAt: Date.now(), photo: null });
  const base = (req.get('x-forwarded-proto') || req.protocol) + '://' + req.get('host');
  res.json({ code, url: `${base}/p/${code}`, expiresInSec: PHONE_TTL / 1000 });
});
app.get('/api/phone/:code/qr.svg', async (req, res) => {
  const v = phoneCodes.get(req.params.code); if (!v) return res.status(404).end();
  const base = (req.get('x-forwarded-proto') || req.protocol) + '://' + req.get('host');
  try { const svg = await require('qrcode').toString(`${base}/p/${req.params.code}`, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }); res.setHeader('content-type', 'image/svg+xml'); res.setHeader('cache-control', 'no-store'); res.send(svg); } catch (e) { res.status(500).end(); }
});
app.get('/api/phone/:code', (req, res) => { // both the phone (to show what was picked) and the iPad (polling for the photo) read this
  const v = phoneCodes.get(req.params.code); if (!v) return res.json({ ok: false, expired: true });
  res.json({ ok: true, themeName: v.themeName, variant: VARIANT_LABELS[v.variant] || v.variant, hasPhoto: !!v.photo, event: getSettings().eventName });
});
app.post('/api/phone/:code/photo', upload.single('photo'), async (req, res) => {
  const v = phoneCodes.get(req.params.code); if (!v) return res.status(410).json({ error: 'This code has expired — ask for a new QR code on the iPad.' });
  if (!req.file) return res.status(400).json({ error: 'no photo' });
  try { v.photo = await sharp(req.file.buffer).rotate().resize(1536, 1536, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 92 }).toBuffer(); v.photoAt = Date.now(); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: 'That file is not a photo we can read.' }); }
});
app.get('/api/phone/:code/photo', (req, res) => { const v = phoneCodes.get(req.params.code); if (!v || !v.photo) return res.status(404).end(); res.setHeader('content-type', 'image/jpeg'); res.setHeader('cache-control', 'no-store'); res.send(v.photo); });

// ----- public (guest) -----
app.get('/api/themes', (req, res) => res.json({ themes: listThemes().filter(t => t.enabled).map(t => ({ slug: t.slug, name: t.name, hasThumb: t.hasThumb, variants: VARIANTS.filter(v => t.prompts[v].trim()) })), variants: VARIANT_LABELS, event: getSettings().eventName, cameraZoom: getSettings().cameraZoom }));
app.get('/api/themes/:slug/thumb', (req, res) => { const f = path.join(THEMES, slugify(req.params.slug), 'thumb.png'); if (fs.existsSync(f)) res.sendFile(f); else res.status(404).end(); });
app.post('/api/jobs', upload.single('photo'), async (req, res) => {
  try {
    const theme = readTheme(slugify(req.body.theme || '')); if (!theme || !theme.enabled) return res.status(400).json({ error: 'unknown theme' });
    const variant = String(req.body.variant || ''); if (!VARIANTS.includes(variant)) return res.status(400).json({ error: 'unknown variant' });
    if (!theme.prompts[variant].trim()) return res.status(400).json({ error: 'That option is not set up yet for this theme' });
    if (!req.file) return res.status(400).json({ error: 'no photo' });
    const id = crypto.randomBytes(6).toString('hex');
    const names = { a: cleanName(req.body.name1), b: cleanName(req.body.name2), pet: cleanName(req.body.petName) }; if (!names.a && !names.b && !names.pet) delete names.a;
    const job = { id, number: ++seq, status: 'pending', theme: theme.slug, themeName: theme.name, variant, createdAt: Date.now(), attempts: 0, guestName: String(req.body.name || '').slice(0, 60), names: (names.a || names.b || names.pet) ? names : null, priority: 0 };
    fs.mkdirSync(path.join(JOBS, id), { recursive: true });
    // EXIF-rotate, limit size, save as jpg
    await sharp(req.file.buffer).rotate().resize(1536, 1536, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 92 }).toFile(path.join(JOBS, id, 'photo.jpg'));
    persist(path.join(JOBS, id, 'photo.jpg')); saveJob(job); pump();
    res.json(Object.assign(publicJob(job), { position: queuePosition(id) }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/jobs/:id', (req, res) => { const j = jobs.get(req.params.id); if (!j) return res.status(404).json({ error: 'not found' }); res.json(Object.assign(publicJob(j), { position: queuePosition(j.id) })); });
app.get('/api/jobs/:id/art', async (req, res) => { const f = path.join(JOBS, req.params.id, req.query.thumb ? 'art-thumb.png' : 'art.png'); if (await ensureLocal(f)) res.sendFile(f); else res.status(404).end(); });

// ----- operator (studio) — unauthenticated on purpose: it only reads art and reports progress; the laptop is yours -----
app.get('/api/queue', (req, res) => { res.json({ settings: getSettings(), jobs: sortedJobs().filter(j => !j.test && !['done', 'skipped', 'archived'].includes(j.status)).map(publicJob), done: sortedJobs().filter(j => j.status === 'done').slice(-10).map(publicJob) }); });
app.post('/api/queue/claim', (req, res) => { // next ready -> drawing
  const j = sortedJobs().find(j => j.status === 'ready'); if (!j) return res.json({ job: null });
  j.status = 'drawing'; j.drawStartedAt = Date.now(); saveJob(j); res.json({ job: publicJob(j) });
});
app.post('/api/queue/claim-id/:id', (req, res) => { const j = jobs.get(req.params.id); if (!j) return res.status(404).end(); j.status = 'drawing'; j.drawStartedAt = j.drawStartedAt || Date.now(); saveJob(j); res.json({ job: publicJob(j) }); }); // resume after a reload
app.post('/api/jobs/:id/status', (req, res) => { const j = jobs.get(req.params.id); if (!j) return res.status(404).end(); const st = String(req.body.status); if (!['done', 'ready', 'skipped', 'failed'].includes(st)) return res.status(400).end(); j.status = st; if (st === 'done') j.doneAt = Date.now(); if (req.body.error) j.error = String(req.body.error); else if (st === 'done') j.error = null;
  for (const k of ['drawSeconds', 'strokes', 'widthMm']) if (req.body[k] != null && isFinite(+req.body[k])) j[k] = Math.round(+req.body[k] * 10) / 10; if (req.body.preset) j.preset = String(req.body.preset).slice(0, 60); // draw-time log
  saveJob(j); res.json(publicJob(j)); });

// ----- admin -----
app.post('/api/admin/login', (req, res) => { if ((req.body.password || '') === ADMIN_PASSWORD) res.json({ ok: true, token: ADMIN_PASSWORD }); else res.status(401).json({ error: 'wrong password' }); });
app.get('/api/admin/state', adminAuth, (req, res) => res.json({ settings: getSettings(), themes: listThemes(), variants: VARIANT_LABELS, variantOrder: VARIANTS, jobs: sortedJobs().filter(j => !j.test).slice(-200).map(j => Object.assign(publicJob(j), { guestName: j.guestName, priority: j.priority })), hasKey: !!OPENAI_KEY, durable: !!bucket, readOnly: !!bucket && !IS_DEPLOYMENT }));
app.post('/api/admin/settings', adminAuth, (req, res) => { const body = req.body || {}; const allowed = ['model', 'quality', 'size', 'moderation', 'concurrency', 'eventName', 'cameraZoom']; const s = getSettings(); for (const k of allowed) if (k in body) s[k] = body[k]; saveSettings(s); res.json(Object.assign({ ok: true, durable: !!bucket && IS_DEPLOYMENT }, s)); });
app.post('/api/admin/themes', adminAuth, (req, res) => { const name = String(req.body.name || '').trim(); if (!name) return res.status(400).json({ error: 'name required' }); let slug = slugify(name); if (readTheme(slug)) slug += '-' + Date.now().toString(36); writeTheme(slug, { name, enabled: true, order: listThemes().length + 1, prompts: {} }); res.json(readTheme(slug)); });
app.put('/api/admin/themes/:slug', adminAuth, (req, res) => { const t = readTheme(slugify(req.params.slug)); if (!t) return res.status(404).end(); writeTheme(t.slug, Object.assign(t, req.body, { prompts: Object.assign(t.prompts, req.body.prompts || {}), variantModels: Object.assign(t.variantModels, req.body.variantModels || {}) })); res.json(readTheme(t.slug)); });
app.delete('/api/admin/themes/:slug', adminAuth, (req, res) => { const d = path.join(THEMES, slugify(req.params.slug)); if (fs.existsSync(d)) { fs.rmSync(d, { recursive: true }); unpersist(d); } res.json({ ok: true }); });
app.post('/api/admin/themes/:slug/thumb', adminAuth, upload.single('thumb'), async (req, res) => { const t = readTheme(slugify(req.params.slug)); if (!t || !req.file) return res.status(400).end(); await sharp(req.file.buffer).rotate().resize(700, 700, { fit: 'inside', withoutEnlargement: true }).png().toFile(path.join(THEMES, t.slug, 'thumb.png')); persist(path.join(THEMES, t.slug, 'thumb.png')); res.json({ ok: true }); });
let modelCache = null; // { models, at } — the key's image models, refetched after an hour
app.get('/api/admin/models', adminAuth, async (req, res) => {
  try {
    if (!modelCache || Date.now() - modelCache.at > 3600e3) {
      const r = await fetch(OPENAI_BASE + '/v1/models', { headers: { Authorization: 'Bearer ' + OPENAI_KEY } }); const j = await r.json(); if (!r.ok) throw new Error(j.error && j.error.message || r.status);
      modelCache = { models: (j.data || []).map(m => m.id).filter(id => /image/i.test(id)).sort(), at: Date.now() };
    }
    res.json({ models: modelCache.models }); } catch (e) { res.status(500).json({ error: e.message }); }
});
// ----- Prompt Lab: one reference photo, one prompt, several models at once; a result can be applied to a theme/combination -----
app.post('/api/admin/lab', adminAuth, upload.single('photo'), async (req, res) => {
  try {
    const theme = readTheme(slugify(req.body.theme || '')); if (!theme) return res.status(400).json({ error: 'pick a theme' });
    const variant = String(req.body.variant || ''); if (!VARIANTS.includes(variant)) return res.status(400).json({ error: 'pick a combination' });
    const prompt = String(req.body.prompt || '').trim(); if (!prompt) return res.status(400).json({ error: 'write a prompt first' });
    let models = []; try { models = JSON.parse(req.body.models || '[]'); } catch (_) { } models = models.filter(m => typeof m === 'string' && m).slice(0, 12); if (!models.length) return res.status(400).json({ error: 'tick at least one model' });
    // reference photo: a fresh upload, or reuse the photo of an earlier lab job
    let photo; if (req.file) photo = await sharp(req.file.buffer).rotate().resize(1536, 1536, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 92 }).toBuffer();
    else if (req.body.refJob && jobs.has(req.body.refJob)) { const f = path.join(JOBS, req.body.refJob, 'photo.jpg'); if (await ensureLocal(f)) photo = fs.readFileSync(f); }
    if (!photo) return res.status(400).json({ error: 'add a reference photo' });
    const batch = 'lab-' + Date.now().toString(36); const photoHash = crypto.createHash('sha1').update(photo).digest('hex').slice(0, 16);
    const runs = models.map(async model => {
      const id = 'lab-' + crypto.randomBytes(4).toString('hex');
      const job = { id, number: 0, status: 'processing', theme: theme.slug, themeName: theme.name, variant, createdAt: Date.now(), attempts: 1, test: true, lab: true, batch, photoHash, labPrompt: prompt, labModel: model };
      fs.mkdirSync(path.join(JOBS, id), { recursive: true }); fs.writeFileSync(path.join(JOBS, id, 'photo.jpg'), photo); if (true) persist(path.join(JOBS, id, 'photo.jpg'));
      jobs.set(id, job); const t0 = Date.now();
      const override = { model, prompt }; for (const k of ['quality', 'moderation']) if (req.body[k]) override[k] = String(req.body[k]);
      try { await generateArt(job, override); job.status = 'test'; job.readyAt = Date.now(); } catch (e) { job.status = 'failed'; job.error = String(e.message || e); }
      job.seconds = Math.round((Date.now() - t0) / 1000); saveJob(job); return labJob(job);
    });
    res.json({ batch, results: await Promise.all(runs) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
function labJob(j) { return { id: j.id, batch: j.batch, photoHash: j.photoHash || j.batch, theme: j.theme, themeName: j.themeName, variant: j.variant, createdAt: j.createdAt, status: j.status, error: j.error, seconds: j.seconds, prompt: j.labPrompt, model: j.labModel, used: j.used, droppedParam: j.droppedParam, art: j.status === 'test' ? `/api/jobs/${j.id}/art` : null, photo: `/api/jobs/${j.id}/photo`, applied: j.applied || null }; }
const LAB_REFS = path.join(DATA, 'lab-refs.json'); // { hidden: [photoHash] } — reference photos removed from the Lab's strip (results keep their photo)
const labRefs = () => { try { return JSON.parse(fs.readFileSync(LAB_REFS, 'utf8')); } catch (_) { return { hidden: [] }; } };
app.get('/api/admin/lab', adminAuth, (req, res) => res.json({ results: [...jobs.values()].filter(j => j.lab).sort((a, b) => b.createdAt - a.createdAt).slice(0, 80).map(labJob), hiddenRefs: labRefs().hidden }));
app.post('/api/admin/lab/refs/hide', adminAuth, (req, res) => { const r = labRefs(); const h = String(req.body.hash || ''); if (h && !r.hidden.includes(h)) r.hidden.push(h); fs.writeFileSync(LAB_REFS, JSON.stringify(r)); persist(LAB_REFS); res.json({ ok: true }); });
app.post('/api/admin/lab/:id/apply', adminAuth, (req, res) => { // make this result the master prompt + model for a theme/combination
  const j = jobs.get(req.params.id); if (!j || !j.lab) return res.status(404).end();
  const theme = readTheme(slugify(req.body.theme || j.theme)); const variant = String(req.body.variant || j.variant); if (!theme || !VARIANTS.includes(variant)) return res.status(400).json({ error: 'bad target' });
  theme.prompts[variant] = j.labPrompt; theme.variantModels[variant] = { model: (j.used && j.used.model) || j.labModel, quality: (j.used && j.used.quality) || '' };
  writeTheme(theme.slug, theme); j.applied = { theme: theme.slug, variant, at: Date.now() }; saveJob(j);
  res.json({ ok: true, theme: readTheme(theme.slug) });
});
app.post('/api/admin/lab/:id/thumb', adminAuth, async (req, res) => { // use this result's line art as the theme's tile picture
  const j = jobs.get(req.params.id); if (!j || !j.lab) return res.status(404).end();
  const theme = readTheme(slugify(req.body.theme || j.theme)); if (!theme) return res.status(400).json({ error: 'bad theme' });
  const art = path.join(JOBS, j.id, 'art.png'); if (!(await ensureLocal(art))) return res.status(404).json({ error: 'no image for this result' });
  await sharp(art).resize(700, 700, { fit: 'inside', withoutEnlargement: true }).png().toFile(path.join(THEMES, theme.slug, 'thumb.png')); persist(path.join(THEMES, theme.slug, 'thumb.png'));
  res.json({ ok: true, theme: theme.slug });
});
app.delete('/api/admin/lab/:id', adminAuth, (req, res) => { const j = jobs.get(req.params.id); if (j && j.lab) { jobs.delete(j.id); fs.rmSync(path.join(JOBS, j.id), { recursive: true, force: true }); unpersist(path.join(JOBS, j.id)); } res.json({ ok: true }); });
app.post('/api/admin/jobs/:id', adminAuth, (req, res) => { // actions: retry, front, skip, requeue (draw again)
  const j = jobs.get(req.params.id); if (!j) return res.status(404).end();
  const a = req.body.action;
  if (a === 'retry') { j.status = 'pending'; j.attempts = 0; j.error = null; }
  else if (a === 'front') { j.priority = -Date.now(); }
  else if (a === 'skip') { j.status = 'skipped'; }
  else if (a === 'archive') { j.status = 'archived'; } // out of every list, photo + art kept
  else if (a === 'requeue') { j.status = (j.readyAt || fs.existsSync(path.join(JOBS, j.id, 'art.png'))) ? 'ready' : 'pending'; }
  else if (a === 'delete') { jobs.delete(j.id); fs.rmSync(path.join(JOBS, j.id), { recursive: true, force: true }); unpersist(path.join(JOBS, j.id)); return res.json({ ok: true }); }
  saveJob(j); pump(); res.json(publicJob(j));
});
app.post('/api/admin/jobs-bulk', adminAuth, (req, res) => { // { ids: [...], action: 'archive' | 'delete' | 'requeue' | 'skip' }
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [], a = req.body.action; let n = 0;
  for (const id of ids) { const j = jobs.get(id); if (!j) continue; n++;
    if (a === 'delete') { jobs.delete(j.id); fs.rmSync(path.join(JOBS, j.id), { recursive: true, force: true }); unpersist(path.join(JOBS, j.id)); continue; }
    if (a === 'archive') j.status = 'archived'; else if (a === 'skip') j.status = 'skipped'; else if (a === 'requeue') j.status = (j.readyAt || fs.existsSync(path.join(JOBS, j.id, 'art.png'))) ? 'ready' : 'pending';
    saveJob(j); }
  pump(); res.json({ ok: true, n });
});
app.get('/api/admin/drawlog.csv', adminAuth, (req, res) => { // every drawing that finished, oldest first, in the admin's local time
  const tz = String(req.query.tz || 'America/Los_Angeles'); let fmtD, fmtT;
  try { fmtD = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }); fmtT = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true }); }
  catch (_) { fmtD = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: '2-digit', day: '2-digit' }); fmtT = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true }); }
  const mmss = sec => sec ? `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}` : '';
  const rows = []; let total = 0, measured = 0, timed = 0;
  for (const j of sortedJobs().filter(j => j.doneAt && !j.test)) {
    // draw_seconds is the arm's measured time (logged since the draw-time feature); older rows fall back to claim→done, which includes conversion/preview
    const sec = j.drawSeconds || (j.drawStartedAt && j.doneAt > j.drawStartedAt ? Math.round((j.doneAt - j.drawStartedAt) / 10) / 100 : 0); const src = j.drawSeconds ? 'measured' : sec ? 'claim-to-done' : '';
    if (sec) { total += sec; timed++; if (j.drawSeconds) measured++; }
    rows.push([j.number, j.themeName, VARIANT_LABELS[j.variant] || j.variant, fmtD.format(j.createdAt), fmtT.format(j.createdAt), fmtD.format(j.doneAt), fmtT.format(j.doneAt), j.widthMm ? (j.widthMm / 25.4).toFixed(2) : '', j.strokes || '', sec || '', mmss(sec), src, j.preset || '', j.status]);
  }
  const esc = v => /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
  const lines = ['number,theme,variant,photo_date,photo_time,drawn_date,drawn_time,width_in,strokes,draw_seconds,draw_mm_ss,time_source,speed_preset,status', ...rows.map(r => r.map(esc).join(','))];
  lines.push('', `TOTAL,${rows.length} drawings,,,,,,,,${Math.round(total * 10) / 10},${mmss(total)},${timed} timed (${measured} measured),,`);
  if (timed) lines.push(`AVERAGE,,,,,,,,,${Math.round(total / timed * 10) / 10},${mmss(total / timed)},per timed drawing,,`);
  res.setHeader('content-type', 'text/csv'); res.setHeader('content-disposition', 'attachment; filename="sketchy-draw-log.csv"');
  res.send(lines.join('\n'));
});
app.get('/api/jobs/:id/photo', adminAuth, async (req, res) => { const f = path.join(JOBS, req.params.id, 'photo.jpg'); if (await ensureLocal(f)) res.sendFile(f); else res.status(404).end(); });

restoreFromBucket().catch(e => console.log('storage restore failed:', e.message)).then(() => { loadState(); app.listen(PORT, '0.0.0.0', () => console.log(`Sketchy Robotics server on :${PORT}  data=${DATA}  key=${OPENAI_KEY ? 'set' : 'MISSING'}`)); });
