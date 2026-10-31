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
const BUCKET_ID = process.env.OBJECT_STORAGE_BUCKET || process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID || process.env.DEFAULT_OBJECT_STORAGE_BUCKET || process.env.REPLIT_OBJECT_STORAGE_BUCKET || '';
try { if (BUCKET_ID || process.env.REPL_ID) { const { Client } = require(process.env.OBJECT_STORAGE_MODULE || '@replit/object-storage'); bucket = new Client(BUCKET_ID ? { bucketId: BUCKET_ID } : undefined); } } catch (e) { console.log('object storage not available:', e.message); bucket = null; }
const rel = f => path.relative(DATA, f).split(path.sep).join('/');
function persist(file) { if (!bucket) return; const key = rel(file); fs.promises.readFile(file).then(buf => bucket.uploadFromBytes(key, buf)).then(r => { if (r && !r.ok) console.error('storage upload failed', key, r.error && r.error.message); }).catch(e => console.error('storage upload', key, e.message)); }
function unpersist(prefix) { if (!bucket) return; bucket.list().then(r => { if (!r.ok) return; for (const o of r.value) if (o.name.startsWith(rel(prefix) + '/')) bucket.delete(o.name).catch(() => {}); }).catch(() => {}); }
async function restoreFromBucket() {
  if (!bucket) { console.log('storage: local disk only (no Replit bucket)'); return; }
  const r = await bucket.list().catch(e => ({ ok: false, error: e }));
  if (!r.ok) { console.log('storage: bucket unreachable, local disk only:', r.error && r.error.message, BUCKET_ID ? '' : '— set Secret OBJECT_STORAGE_BUCKET to your App Storage bucket name (e.g. repl-default-bucket-...)'); bucket = null; return; }
  let n = 0;
  for (const o of r.value) {
    if (!o.name || o.name.endsWith('/') || !/^(themes|jobs)\/|^settings\.json$/.test(o.name)) continue; // skip folders and anything that isn't ours
    const dest = path.join(DATA, o.name); if (fs.existsSync(dest)) continue;
    let d; try { d = await bucket.downloadAsBytes(o.name); } catch (e) { continue; } if (!d.ok) continue;
    const buf = Array.isArray(d.value) ? Buffer.concat(d.value.map(x => Buffer.isBuffer(x) ? x : Buffer.from(x))) : Buffer.from(d.value); // real SDK returns [Buffer]
    fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, buf); n++;
  }
  console.log(`storage: Replit bucket connected (${BUCKET_ID || 'default'}), restored ${n} file(s)`);
}

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'sketchy';
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_BASE = process.env.OPENAI_BASE || 'https://api.openai.com';

// ---------- settings ----------
const SETTINGS_FILE = path.join(DATA, 'settings.json');
const DEFAULT_SETTINGS = { model: 'chatgpt-image-latest', quality: 'medium', size: '1024x1536', inputFidelity: '', concurrency: 2, autoRun: true, pauseBetween: true, eventName: 'Sketchy Robotics', cameraZoom: 1.6 };
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
  t.hasThumb = fs.existsSync(path.join(dir, 'thumb.png'));
  return t;
}
function listThemes() { return fs.readdirSync(THEMES).map(readTheme).filter(Boolean).sort((a, b) => (a.order || 0) - (b.order || 0) || a.name.localeCompare(b.name)); }
function writeTheme(slug, t) {
  const dir = path.join(THEMES, slug); fs.mkdirSync(path.join(dir, 'prompts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'theme.json'), JSON.stringify({ name: t.name, enabled: t.enabled !== false, order: t.order || 0 }, null, 2)); persist(path.join(dir, 'theme.json'));
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
function saveJob(j) { fs.mkdirSync(path.join(JOBS, j.id), { recursive: true }); const f = path.join(JOBS, j.id, 'job.json'); fs.writeFileSync(f, JSON.stringify(j, null, 2)); jobs.set(j.id, j); if (!j.test) persist(f); }
function publicJob(j) { const { id, number, status, theme, themeName, variant, createdAt, readyAt, error, attempts, position } = j; return { id, number, status, theme, themeName, variant, createdAt, readyAt, error, attempts, position }; }
function sortedJobs() { return [...jobs.values()].sort((a, b) => (a.priority || 0) - (b.priority || 0) || a.createdAt - b.createdAt); }
function queuePosition(id) { let n = 0; for (const j of sortedJobs()) { if (['pending', 'processing', 'ready', 'drawing'].includes(j.status)) { n++; if (j.id === id) return n; } } return null; }

// ---------- OpenAI ----------
async function generateArt(job, override) {
  const s = Object.assign(getSettings(), override || {});
  const theme = readTheme(job.theme); if (!theme) throw new Error('theme missing');
  const prompt = (theme.prompts[job.variant] || '').trim(); if (!prompt) throw new Error(`no prompt saved for ${theme.name} / ${VARIANT_LABELS[job.variant]}`);
  if (!OPENAI_KEY) throw new Error('OPENAI_API_KEY is not set in Secrets');
  const photo = fs.readFileSync(path.join(JOBS, job.id, 'photo.jpg'));
  const form = new FormData();
  form.append('model', s.model); form.append('prompt', prompt); form.append('n', '1');
  if (s.size) form.append('size', s.size); if (s.quality) form.append('quality', s.quality);
  if (s.inputFidelity) form.append('input_fidelity', s.inputFidelity);
  form.append('output_format', 'png');
  form.append('image', new Blob([photo], { type: 'image/jpeg' }), 'photo.jpg');
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 180000);
  let res;
  try { res = await fetch(OPENAI_BASE + '/v1/images/edits', { method: 'POST', headers: { Authorization: 'Bearer ' + OPENAI_KEY }, body: form, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('OpenAI ' + res.status + ': ' + (body.error && body.error.message || JSON.stringify(body)).slice(0, 300));
  const b64 = body.data && body.data[0] && body.data[0].b64_json; if (!b64) throw new Error('OpenAI returned no image');
  // normalise: flatten onto white, make sure it's a clean PNG the tracer likes
  const png = await sharp(Buffer.from(b64, 'base64')).flatten({ background: '#ffffff' }).png().toBuffer();
  fs.writeFileSync(path.join(JOBS, job.id, 'art.png'), png);
  await sharp(png).resize(400, 400, { fit: 'inside' }).png().toFile(path.join(JOBS, job.id, 'art-thumb.png'));
  if (!job.test) { persist(path.join(JOBS, job.id, 'art.png')); persist(path.join(JOBS, job.id, 'art-thumb.png')); }
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
    const job = { id, number: ++seq, status: 'pending', theme: theme.slug, themeName: theme.name, variant, createdAt: Date.now(), attempts: 0, guestName: String(req.body.name || '').slice(0, 60), priority: 0 };
    fs.mkdirSync(path.join(JOBS, id), { recursive: true });
    // EXIF-rotate, limit size, save as jpg
    await sharp(req.file.buffer).rotate().resize(1536, 1536, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 92 }).toFile(path.join(JOBS, id, 'photo.jpg'));
    persist(path.join(JOBS, id, 'photo.jpg')); saveJob(job); pump();
    res.json(Object.assign(publicJob(job), { position: queuePosition(id) }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/jobs/:id', (req, res) => { const j = jobs.get(req.params.id); if (!j) return res.status(404).json({ error: 'not found' }); res.json(Object.assign(publicJob(j), { position: queuePosition(j.id) })); });
app.get('/api/jobs/:id/art', (req, res) => { const f = path.join(JOBS, req.params.id, req.query.thumb ? 'art-thumb.png' : 'art.png'); if (fs.existsSync(f)) res.sendFile(f); else res.status(404).end(); });

// ----- operator (studio) — unauthenticated on purpose: it only reads art and reports progress; the laptop is yours -----
app.get('/api/queue', (req, res) => { res.json({ settings: getSettings(), jobs: sortedJobs().filter(j => j.status !== 'done' && j.status !== 'skipped').map(publicJob), done: sortedJobs().filter(j => j.status === 'done').slice(-10).map(publicJob) }); });
app.post('/api/queue/claim', (req, res) => { // next ready -> drawing
  const j = sortedJobs().find(j => j.status === 'ready'); if (!j) return res.json({ job: null });
  j.status = 'drawing'; j.drawStartedAt = Date.now(); saveJob(j); res.json({ job: publicJob(j) });
});
app.post('/api/jobs/:id/status', (req, res) => { const j = jobs.get(req.params.id); if (!j) return res.status(404).end(); const st = String(req.body.status); if (!['done', 'ready', 'skipped', 'failed'].includes(st)) return res.status(400).end(); j.status = st; if (st === 'done') j.doneAt = Date.now(); if (req.body.error) j.error = String(req.body.error); saveJob(j); res.json(publicJob(j)); });

// ----- admin -----
app.post('/api/admin/login', (req, res) => { if ((req.body.password || '') === ADMIN_PASSWORD) res.json({ ok: true, token: ADMIN_PASSWORD }); else res.status(401).json({ error: 'wrong password' }); });
app.get('/api/admin/state', adminAuth, (req, res) => res.json({ settings: getSettings(), themes: listThemes(), variants: VARIANT_LABELS, variantOrder: VARIANTS, jobs: sortedJobs().slice(-200).map(j => Object.assign(publicJob(j), { guestName: j.guestName, priority: j.priority })), hasKey: !!OPENAI_KEY, durable: !!bucket }));
app.post('/api/admin/settings', adminAuth, (req, res) => { const s = Object.assign(getSettings(), req.body || {}); saveSettings(s); res.json(s); });
app.post('/api/admin/themes', adminAuth, (req, res) => { const name = String(req.body.name || '').trim(); if (!name) return res.status(400).json({ error: 'name required' }); let slug = slugify(name); if (readTheme(slug)) slug += '-' + Date.now().toString(36); writeTheme(slug, { name, enabled: true, order: listThemes().length + 1, prompts: {} }); res.json(readTheme(slug)); });
app.put('/api/admin/themes/:slug', adminAuth, (req, res) => { const t = readTheme(slugify(req.params.slug)); if (!t) return res.status(404).end(); writeTheme(t.slug, Object.assign(t, req.body, { prompts: Object.assign(t.prompts, req.body.prompts || {}) })); res.json(readTheme(t.slug)); });
app.delete('/api/admin/themes/:slug', adminAuth, (req, res) => { const d = path.join(THEMES, slugify(req.params.slug)); if (fs.existsSync(d)) { fs.rmSync(d, { recursive: true }); unpersist(d); } res.json({ ok: true }); });
app.post('/api/admin/themes/:slug/thumb', adminAuth, upload.single('thumb'), async (req, res) => { const t = readTheme(slugify(req.params.slug)); if (!t || !req.file) return res.status(400).end(); await sharp(req.file.buffer).rotate().resize(700, 700, { fit: 'inside', withoutEnlargement: true }).png().toFile(path.join(THEMES, t.slug, 'thumb.png')); persist(path.join(THEMES, t.slug, 'thumb.png')); res.json({ ok: true }); });
app.get('/api/admin/models', adminAuth, async (req, res) => {
  try { const r = await fetch(OPENAI_BASE + '/v1/models', { headers: { Authorization: 'Bearer ' + OPENAI_KEY } }); const j = await r.json(); if (!r.ok) throw new Error(j.error && j.error.message || r.status);
    res.json({ models: (j.data || []).map(m => m.id).filter(id => /image/i.test(id)).sort() }); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/test', adminAuth, upload.single('photo'), async (req, res) => { // run a prompt against a photo without queueing for the arm
  try {
    const id = 'test-' + crypto.randomBytes(4).toString('hex');
    const job = { id, number: 0, status: 'processing', theme: slugify(req.body.theme), variant: req.body.variant, createdAt: Date.now(), attempts: 1, test: true };
    fs.mkdirSync(path.join(JOBS, id), { recursive: true });
    await sharp(req.file.buffer).rotate().resize(1536, 1536, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 92 }).toFile(path.join(JOBS, id, 'photo.jpg'));
    const override = {}; for (const k of ['model', 'quality', 'size', 'inputFidelity']) if (req.body[k]) override[k] = String(req.body[k]);
    jobs.set(id, job); const t0 = Date.now(); await generateArt(job, override); job.status = 'test'; job.override = override; saveJob(job);
    res.json({ id, art: `/api/jobs/${id}/art`, used: Object.assign({ model: getSettings().model, quality: getSettings().quality, size: getSettings().size, inputFidelity: getSettings().inputFidelity }, override), seconds: Math.round((Date.now() - t0) / 1000) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/jobs/:id', adminAuth, (req, res) => { // actions: retry, front, skip, requeue (draw again)
  const j = jobs.get(req.params.id); if (!j) return res.status(404).end();
  const a = req.body.action;
  if (a === 'retry') { j.status = 'pending'; j.attempts = 0; j.error = null; }
  else if (a === 'front') { j.priority = -Date.now(); }
  else if (a === 'skip') { j.status = 'skipped'; }
  else if (a === 'requeue') { j.status = fs.existsSync(path.join(JOBS, j.id, 'art.png')) ? 'ready' : 'pending'; }
  else if (a === 'delete') { jobs.delete(j.id); fs.rmSync(path.join(JOBS, j.id), { recursive: true, force: true }); unpersist(path.join(JOBS, j.id)); return res.json({ ok: true }); }
  saveJob(j); pump(); res.json(publicJob(j));
});
app.get('/api/jobs/:id/photo', adminAuth, (req, res) => { const f = path.join(JOBS, req.params.id, 'photo.jpg'); if (fs.existsSync(f)) res.sendFile(f); else res.status(404).end(); });

restoreFromBucket().catch(e => console.log('storage restore failed:', e.message)).then(() => { loadState(); app.listen(PORT, '0.0.0.0', () => console.log(`Sketchy Robotics server on :${PORT}  data=${DATA}  key=${OPENAI_KEY ? 'set' : 'MISSING'}`)); });
