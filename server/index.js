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
function unpersistFile(f) { if (!bucket || !IS_DEPLOYMENT) return; bucket.delete(rel(f)).catch(() => {}); }
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
  if (IS_DEPLOYMENT) { for (const d of [THEMES, JOBS]) fs.rmSync(d, { recursive: true, force: true }); fs.rmSync(SETTINGS_FILE, { force: true }); fs.rmSync(path.join(DATA, 'lab-refs.json'), { force: true }); fs.rmSync(path.join(DATA, 'builder.json'), { force: true }); fs.rmSync(path.join(DATA, 'refs'), { recursive: true, force: true }); fs.mkdirSync(path.join(DATA, 'refs'), { recursive: true }); for (const d of [THEMES, JOBS]) fs.mkdirSync(d, { recursive: true }); }
  let n = 0;
  for (const o of r.value) {
    if (!o.name || o.name.endsWith('/') || !/^(themes|jobs|refs)\/|^(settings|lab-refs|builder|users|sessions)\.json$/.test(o.name)) continue; // skip folders and anything that isn't ours
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
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || ''; const STRIPE_BASE = process.env.STRIPE_BASE || 'https://api.stripe.com';
const BUILD = String(Date.now()); // changes on every restart/deploy; iPads reload themselves when they see a new one
const PAY_TTL = 15 * 60000; // an unpaid sketch waits this long for its payment, then quietly expires

// ---------- settings ----------
const SETTINGS_FILE = path.join(DATA, 'settings.json');
const DEFAULT_SETTINGS = { model: 'gpt-image-2-2026-04-21', quality: 'medium', size: '1024x1536', moderation: 'low', bots: 1, concurrency: 2, textModel: 'gpt-4.1-mini', foundations: [{ id: 'normal', name: 'Normal', text: '' }, { id: 'bighead', name: 'Big head', text: '' }], safetyFoundation: 'AGE SAFETY — APPLIES TO EVERY PERSON IN EVERY THEME. Never assume someone is an adult because of makeup, clothing, pose, body shape or hairstyle; when a subject could plausibly be under 18, use the age-safe treatment. Anyone who appears under 18 is drawn in cheerful, wholesome, fully covering, age-appropriate clothing and poses: costumes may be playful, adventurous or fantasy-themed, but never risqué fashion, lingerie or corset styling, exposed undergarments, cleavage-focused cuts, suggestive poses or expressions, adult-party motifs, alcohol, smoking or intimate contact. Keep their actual youthful features; never age them up. For adults who are clearly 18+, a theme MAY be as bold as pin-up, burlesque or boudoir: sultry, flirtatious, cheeky, risqué — but always non-explicit: no nudity, no visible underwear as underwear, intimate areas fully covered by opaque fabric, no sexual acts. Adult boldness is only ever a theme direction, never a default. When adults and minors appear together, apply each person\'s rules separately and keep the whole composition non-sexual; if a theme\'s adult styling conflicts with a minor, replace the styling with an age-safe costume, not an older face. These rules never override the drawing rules below.', eventMode: 'family', testModels: ['gpt-image-2-2026-04-21'], autoRun: true, pauseBetween: true, eventName: 'Sketchy Robotics', cameraZoom: 1.6, staffing: 'manned', remote: { enabled: false, code: '' }, presets: [], pay: { enabled: false, sizes: [{ id: '4x6', label: '4 × 6 in', price: 500, enabled: true }, { id: '5x7', label: '5 × 7 in', price: 800, enabled: true }, { id: '8x10', label: '8 × 10 in', price: 1200, enabled: true }, { id: '8.5x11', label: '8.5 × 11 in', price: 1500, enabled: true }] } }; // pay.sizes[].price is in cents
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
  t.hasThumb = fs.existsSync(path.join(dir, 'thumb.png')); t.variantModels = t.variantModels || {}; t.rating = t.rating === 'adult' ? 'adult' : 'family'; t.proportions = t.proportions === 'bighead' ? 'bighead' : 'normal';
  return t;
}
function listThemes() { return fs.readdirSync(THEMES).filter(s => !s.startsWith('_')).map(readTheme).filter(Boolean).sort((a, b) => (a.order || 0) - (b.order || 0) || a.name.localeCompare(b.name)); }
function writeTheme(slug, t) {
  const dir = path.join(THEMES, slug); fs.mkdirSync(path.join(dir, 'prompts'), { recursive: true });
  const vm = {}; for (const v of VARIANTS) { const x = t.variantModels && t.variantModels[v]; if (x && (x.model || x.quality)) vm[v] = { model: x.model || '', quality: x.quality || '' }; }
  fs.writeFileSync(path.join(dir, 'theme.json'), JSON.stringify({ name: t.name, enabled: t.enabled !== false, order: t.order || 0, model: t.model || '', quality: t.quality || '', moderation: t.moderation || '', rating: t.rating === 'adult' ? 'adult' : 'family', proportions: t.proportions === 'bighead' ? 'bighead' : 'normal', variantModels: vm, thumbFrom: t.thumbFrom || '' }, null, 2)); persist(path.join(dir, 'theme.json')); // model/quality: blank = use Settings; variantModels: per-combination overrides
  if (t.prompts) for (const v of VARIANTS) if (v in t.prompts) { const f = path.join(dir, 'prompts', v + '.txt'); fs.writeFileSync(f, String(t.prompts[v] || '')); persist(f); }
}


// ---------- jobs ----------
// data/jobs/<id>/job.json, photo.jpg, art.png
const jobs = new Map(); let seq = 0;
function loadState() {
  if (!listThemes().length) writeTheme('evil-clown', { name: 'Evil Clown', enabled: true, order: 1, prompts: {} });
  for (const id of fs.readdirSync(JOBS)) { try { jobs.set(id, JSON.parse(fs.readFileSync(path.join(JOBS, id, 'job.json'), 'utf8'))); } catch (_) { } }
  for (const j of jobs.values()) if (j.status === 'processing') { if (j.lab) { j.status = 'failed'; j.error = 'server restarted while generating — run it again'; } else j.status = 'pending'; } // server restarted mid-call
  seq = Math.max(0, ...[...jobs.values()].map(j => j.number || 0));
}
function saveJob(j) { fs.mkdirSync(path.join(JOBS, j.id), { recursive: true }); const f = path.join(JOBS, j.id, 'job.json'); fs.writeFileSync(f, JSON.stringify(j, null, 2)); jobs.set(j.id, j); if (!j.test || j.lab) persist(f); }
function publicJob(j) { const { id, number, status, theme, themeName, proportions, variant, createdAt, readyAt, doneAt, error, attempts, position, drawSeconds, strokes, widthMm, preset, names, bot, pay, pad } = j; return { id, number, status, theme, themeName, proportions, variant, createdAt, readyAt, doneAt, error, attempts, position, drawSeconds, strokes, widthMm, preset, names, bot, pad, pay: pay ? { size: pay.size, label: pay.label, amount: pay.amount, paidAt: pay.paidAt, method: pay.method } : null }; }
// ---------- payments (Stripe Checkout: the iPad shows a QR, the guest pays on their own phone) ----------
function cleanPay(p) { const sizes = Array.isArray(p.sizes) ? p.sizes : []; return { enabled: !!p.enabled, sizes: sizes.map(z => ({ id: String(z.id || '').replace(/[^0-9a-z.x]/gi, '').slice(0, 12), label: String(z.label || z.id || '').slice(0, 30), price: Math.max(0, Math.round(+z.price || 0)), enabled: z.enabled !== false })).filter(z => z.id) }; }
const paySizes = () => ((getSettings().pay || {}).sizes || []).filter(z => z.enabled && z.price > 0);
const payOn = () => !!(getSettings().pay || {}).enabled && paySizes().length > 0;
const money = c => '$' + (c / 100).toFixed(2);
function form(obj, prefix, out) { out = out || new URLSearchParams(); for (const [k, v] of Object.entries(obj)) { const key = prefix ? `${prefix}[${k}]` : k; if (v && typeof v === 'object') form(v, key, out); else if (v !== undefined && v !== null) out.append(key, String(v)); } return out; }
async function stripe(method, p, params) { // tiny Stripe client: form-encoded over fetch, no SDK to install
  if (!STRIPE_KEY) throw new Error('Stripe is not connected — add STRIPE_SECRET_KEY in Replit Secrets');
  const r = await fetch(STRIPE_BASE + p, { method, headers: Object.assign({ authorization: 'Basic ' + Buffer.from(STRIPE_KEY + ':').toString('base64') }, method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), body: method === 'POST' ? form(params || {}).toString() : undefined });
  const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error((d.error && d.error.message) || `Stripe ${r.status}`); return d;
}
function markPaid(j, method, amount) { if (j.status !== 'unpaid') return; j.pay = Object.assign(j.pay || {}, { paidAt: Date.now(), method, amount: amount != null ? amount : (j.pay && j.pay.amount) || 0 }); j.status = 'pending'; saveJob(j); pump(); }
async function checkPaid(j) { // ask Stripe whether this sketch's checkout was paid (also what the webhook triggers)
  if (j.status !== 'unpaid' || !j.pay || !j.pay.sessionId) return false; if (Date.now() - (j.pay.checkedAt || 0) < 2500) return false; j.pay.checkedAt = Date.now();
  try { const ses = await stripe('GET', '/v1/checkout/sessions/' + j.pay.sessionId); if (ses.payment_status === 'paid') { markPaid(j, 'card', ses.amount_total); return true; } } catch (e) { console.error('stripe check', j.number, e.message); }
  return false;
}
setInterval(() => { for (const j of jobs.values()) if (j.status === 'unpaid' && Date.now() - j.createdAt > PAY_TTL) { j.status = 'expired'; saveJob(j); if (j.pay && j.pay.sessionId) stripe('POST', `/v1/checkout/sessions/${j.pay.sessionId}/expire`).catch(() => {}); } }, 60000);
const cleanName = v => String(v || '').replace(/[^\p{L}\p{N} .,'&-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 24); // letters the plotter font has
function sortedJobs() { return [...jobs.values()].sort((a, b) => (a.priority || 0) - (b.priority || 0) || a.createdAt - b.createdAt); }
function queuePosition(id) { let n = 0; for (const j of sortedJobs()) { if (['pending', 'processing', 'ready', 'drawing'].includes(j.status)) { n++; if (j.id === id) return n; } } return null; }

// ---------- robots (one Plotter Studio tab per arm) ----------
const bots = new Map(); // bot number -> { bot, connected, status, jobId, number, progress, seen }
const botCount = () => Math.max(1, Math.min(8, +getSettings().bots || 1));
const liveBots = () => [...bots.values()].filter(b => Date.now() - b.seen < 30000 && b.connected && b.bot <= botCount());
function botLoad(n) { let c = 0; for (const j of jobs.values()) if (j.bot === n && (j.status === 'ready' || j.status === 'drawing')) c++; return c; }
/** when a sketch becomes ready: hand it to the live robot with the least waiting; none live → unassigned (first tab to claim takes it) */
function assignBot(job) { if (botCount() <= 1) { job.bot = 1; return; } if (job.wantBot && job.wantBot <= botCount()) { job.bot = job.wantBot; return; } const live = liveBots(); /* an iPad pinned to a robot (/?bot=2) keeps its guests at that robot */ if (!live.length) { job.bot = null; return; } live.sort((a, b) => botLoad(a.bot) - botLoad(b.bot) || a.bot - b.bot); job.bot = live[0].bot; }
const botStale = n => { const b = bots.get(n); return !b || Date.now() - b.seen > 60000 || !b.connected; };

// ---------- OpenAI ----------
/** Settings ← theme override ← this combination's override ← an explicit pick (Lab) */
function effectiveSettings(theme, variant, override) {
  const pick = o => { const r = {}; for (const k of ['model', 'quality', 'moderation']) if (o && o[k]) r[k] = o[k]; return r; };
  const byRating = theme.moderation ? {} : { moderation: theme.rating === 'adult' ? 'low' : 'auto' }; // family themes get the stricter filter unless the theme says otherwise
  return Object.assign(getSettings(), byRating, pick(theme), pick(theme.variantModels && theme.variantModels[variant]), override || {});
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
  for (let i = 0; i < 3 && (res.status === 429 || res.status >= 500); i++) { const wait = res.status === 429 ? 8000 * (i + 1) : 3000 * (i + 1); job.note = `${res.status === 429 ? 'rate limited' : 'server ' + res.status} — retrying in ${wait / 1000}s`; await new Promise(r => setTimeout(r, wait)); ({ res, body } = await call(form)); }
  job.note = null;
  // a model that doesn't know a parameter says so ("does not support the 'moderation' parameter"); drop it and try again, up to 3 times
  for (let i = 0; i < 3 && !res.ok && body.error; i++) {
    const m = (body.error.message || '').match(/(?:does not support|not supported|unknown|unsupported|unrecognized)[^']*'([a-z_]+)'|'([a-z_]+)'[^.]*(?:is not supported|not supported|unknown)/i); const bad = m && (m[1] || m[2]);
    if (!bad || !form.has(bad) || bad === 'model' || bad === 'prompt' || bad === 'image') break;
    form.delete(bad); job.droppedParam = (job.droppedParam ? job.droppedParam + ', ' : '') + bad; ({ res, body } = await call(form));
  }
  if (!res.ok) throw new Error('OpenAI ' + res.status + ': ' + (body.error && body.error.message || JSON.stringify(body)).slice(0, 300));
  job.used.moderationSent = form.has('moderation') ? form.get('moderation') : 'not accepted by this model';
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
    generateArt(next).then(() => { next.status = 'ready'; next.readyAt = Date.now(); next.error = null; assignBot(next); })
      .catch(e => { next.status = next.attempts >= 2 ? 'failed' : 'pending'; next.error = String(e.message || e) + (e.cause ? ' (' + (e.cause.code || e.cause.message) + ')' : ''); console.error('job', next.number, next.error); })
      .finally(() => { saveJob(next); running--; setTimeout(pump, next.status === 'pending' ? 5000 : 50); });
  }
}
setInterval(pump, 3000); pump();
// a job claimed by the operator page but never finished (page closed, laptop slept) goes back to ready after 15 min
setInterval(() => { for (const j of jobs.values()) if (j.status === 'drawing' && Date.now() - (j.drawStartedAt || 0) > 15 * 60000) { j.status = 'ready'; saveJob(j); } }, 60000);

// ---------- app ----------
const app = express();
app.post('/api/stripe/webhook', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => { // optional speed-up: Stripe tells us a checkout completed; we confirm by asking Stripe, so the body is never trusted
  try { const ev = JSON.parse(req.body.toString('utf8')); const id = ev.data && ev.data.object && (ev.data.object.client_reference_id || (ev.data.object.metadata || {}).job); const j = id && jobs.get(id); if (j) { if (j.pay) j.pay.checkedAt = 0; checkPaid(j); } } catch (_) {}
  res.json({ received: true });
});
app.use(express.json({ limit: '2mb' }));
app.disable('x-powered-by');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
// ---------- users: the admin (ADMIN_PASSWORD secret) plus operator accounts the admin creates; sessions are random tokens ----------
const USERS_FILE = path.join(DATA, 'users.json'), SESS_FILE = path.join(DATA, 'sessions.json');
const loadUsers = () => { try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch (_) { return []; } };
const saveUsers = u => { fs.writeFileSync(USERS_FILE, JSON.stringify(u, null, 2)); persist(USERS_FILE); };
const sessions = new Map(); const loadSess = () => { try { for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(SESS_FILE, 'utf8')))) if (!sessions.has(k)) sessions.set(k, v); } catch (_) {} }; loadSess();
const saveSessions = () => { fs.writeFileSync(SESS_FILE, JSON.stringify(Object.fromEntries(sessions))); persist(SESS_FILE); };
const hashPw = (pw, salt) => { salt = salt || crypto.randomBytes(8).toString('hex'); return salt + ':' + crypto.scryptSync(String(pw), salt, 32).toString('hex'); };
const checkPw = (pw, h) => { try { const salt = h.split(':')[0]; return crypto.timingSafeEqual(Buffer.from(hashPw(pw, salt)), Buffer.from(h)); } catch (_) { return false; } };
const SESSION_DAYS = 30;
function whoIs(req) { // -> { name, role: 'admin'|'operator' } or null
  const t = req.get('x-admin-token') || req.query.token || ''; if (!t) return null; if (!sessions.size) loadSess(); // (restored from the bucket after startup on a fresh deploy)
  if (t === ADMIN_PASSWORD) return { name: 'admin', role: 'admin' };
  const se = sessions.get(t); if (!se) return null; if (Date.now() - se.at > SESSION_DAYS * 86400000) { sessions.delete(t); saveSessions(); return null; }
  if (se.role === 'admin') return { name: se.name, role: 'admin' };
  const u = loadUsers().find(u => u.id === se.userId); if (!u || u.enabled === false) return null; return { name: u.name, role: u.role === 'admin' ? 'admin' : 'operator' };
}
const adminAuth = (req, res, next) => { const w = whoIs(req); if (w && w.role === 'admin') { req.user = w; return next(); } res.status(w ? 403 : 401).json({ error: w ? 'admin only' : 'please sign in' }); };
const opAuth = (req, res, next) => { const w = whoIs(req); if (w) { req.user = w; return next(); } res.status(401).json({ error: 'please sign in' }); };
const STUDIO_AUTH = process.env.OPEN_STUDIO !== '1'; // tests run the Studio endpoints without a login
const studioAuth = (req, res, next) => STUDIO_AUTH ? opAuth(req, res, next) : next();
function newSession(se) { const t = crypto.randomBytes(24).toString('hex'); sessions.set(t, Object.assign({ at: Date.now() }, se)); saveSessions(); return t; }

// static pages
app.use('/studio', express.static(path.join(ROOT, 'public', 'studio')));
app.use('/admin', express.static(path.join(ROOT, 'public', 'admin')));
app.use('/start', express.static(path.join(ROOT, 'public', 'start'))); // operator start page: sign in once, open everything
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
// operator start page: a QR for the guest page itself, so an operator can point an iPad's camera at the laptop screen
app.get('/api/start/guest-qr.svg', async (req, res) => {
  const base = (req.get('x-forwarded-proto') || req.protocol) + '://' + req.get('host');
  try { const svg = await require('qrcode').toString(`${base}/`, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }); res.setHeader('content-type', 'image/svg+xml'); res.send(svg); } catch (e) { res.status(500).end(); }
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
app.get('/api/themes', (req, res) => res.json({ themes: listThemes().filter(t => t.enabled && t.rating === (getSettings().eventMode === 'adult' ? 'adult' : 'family')).map(t => ({ slug: t.slug, name: t.name, hasThumb: t.hasThumb, variants: VARIANTS.filter(v => t.prompts[v].trim()) })), variants: VARIANT_LABELS, event: getSettings().eventName, cameraZoom: getSettings().cameraZoom, build: BUILD, pay: payOn() ? { sizes: paySizes().map(z => ({ id: z.id, label: z.label, price: z.price, text: money(z.price) })) } : null, bots: botCount() }));
app.get('/api/themes/:slug/thumb', (req, res) => { const f = path.join(THEMES, slugify(req.params.slug), 'thumb.png'); if (fs.existsSync(f)) res.sendFile(f); else res.status(404).end(); });
// ---------- remote submissions: one standing link/QR per event; guests pick a theme and send a photo from anywhere ----------
const newCode = () => crypto.randomBytes(4).toString('hex').slice(0, 6);
const remoteOn = code => { const r = getSettings().remote || {}; return !!(r.enabled && r.code && code && r.code === String(code).toLowerCase()); };
const remoteHits = new Map(); // ip -> [timestamps] — a shared link must not be able to flood the queue
function remoteAllowed(ip) { const now = Date.now(); const a = (remoteHits.get(ip) || []).filter(t => now - t < 3600000); remoteHits.set(ip, a); if (a.length >= 6) return false; a.push(now); return true; }
app.get('/go/:code', (req, res) => res.sendFile(path.join(ROOT, 'public', 'remote', 'index.html')));
app.get('/api/remote/:code', (req, res) => { if (!remoteOn(req.params.code)) return res.status(404).json({ ok: false }); const s = getSettings();
  res.json({ ok: true, event: s.eventName, variants: VARIANT_LABELS, variantOrder: VARIANTS, pay: payOn() ? { sizes: paySizes().map(z => ({ id: z.id, label: z.label, price: z.price, text: money(z.price) })) } : null,
    themes: listThemes().filter(t => t.enabled && (t.rating === 'adult' ? s.eventMode === 'adult' : s.eventMode !== 'adult')).map(t => ({ slug: t.slug, name: t.name, hasThumb: t.hasThumb, variants: VARIANTS.filter(v => t.prompts[v].trim()) })) }); });
app.get('/api/remote/:code/thumb/:slug', async (req, res) => { if (!remoteOn(req.params.code)) return res.status(404).end(); const f = path.join(THEMES, slugify(req.params.slug), 'thumb.png'); if (await ensureLocal(f)) res.sendFile(f); else res.status(404).end(); });
app.post('/api/remote/:code/jobs', upload.single('photo'), (req, res, next) => { if (!remoteOn(req.params.code)) return res.status(404).json({ error: 'This link is not active right now.' }); const ip = req.get('x-forwarded-for') || req.ip; if (!remoteAllowed(String(ip).split(',')[0].trim())) return res.status(429).json({ error: 'That is a lot of sketches from one phone — please try again in a little while.' }); req.body.pad = 'Remote'; req.body.bot = ''; req.body.name1 = req.body.name2 = req.body.petName = ''; req.remote = req.params.code; next(); }, createJob);
app.get('/api/admin/remote/qr.svg', adminAuth, async (req, res) => { const r = getSettings().remote || {}; if (!r.code) return res.status(404).end(); const base = (req.get('x-forwarded-proto') || req.protocol) + '://' + req.get('host'); try { const svg = await require('qrcode').toString(`${base}/go/${r.code}`, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' }); res.setHeader('content-type', 'image/svg+xml'); res.setHeader('cache-control', 'no-store'); res.send(svg); } catch (e) { res.status(500).end(); } });
app.post('/api/admin/remote/code', adminAuth, (req, res) => { const s = getSettings(); s.remote = Object.assign({ enabled: false }, s.remote, { code: newCode() }); saveSettings(s); res.json(s.remote); });

app.post('/api/jobs', upload.single('photo'), createJob);
async function createJob(req, res) {
  try {
    const theme = readTheme(slugify(req.body.theme || '')); if (!theme || !theme.enabled) return res.status(400).json({ error: 'unknown theme' });
    const variant = String(req.body.variant || ''); if (!VARIANTS.includes(variant)) return res.status(400).json({ error: 'unknown variant' });
    if (!theme.prompts[variant].trim()) return res.status(400).json({ error: 'That option is not set up yet for this theme' });
    if (!req.file) return res.status(400).json({ error: 'no photo' });
    const id = crypto.randomBytes(6).toString('hex');
    const names = { a: cleanName(req.body.name1), b: cleanName(req.body.name2), pet: cleanName(req.body.petName) }; if (!names.a && !names.b && !names.pet) delete names.a;
    const job = { id, number: ++seq, status: 'pending', theme: theme.slug, themeName: theme.name, proportions: theme.proportions === 'bighead' ? 'bighead' : 'normal', variant, createdAt: Date.now(), attempts: 0, guestName: String(req.body.name || '').slice(0, 60), pad: String(req.body.pad || '').replace(/[^\w -]/g, '').slice(0, 16) || null, wantBot: Math.max(0, Math.min(8, +req.body.bot || 0)) || null, names: (names.a || names.b || names.pet) ? names : null, priority: 0 };
    if (payOn()) { job.status = 'unpaid'; job.pay = { size: null, label: null, amount: null, sessionId: null, url: null, paidAt: null, method: null }; } // waits on the pay screen until Stripe says it's paid
    fs.mkdirSync(path.join(JOBS, id), { recursive: true });
    // EXIF-rotate, limit size, save as jpg
    await sharp(req.file.buffer).rotate().resize(1536, 1536, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 92 }).toFile(path.join(JOBS, id, 'photo.jpg'));
    if (req.remote) job.remote = req.remote; persist(path.join(JOBS, id, 'photo.jpg')); saveJob(job); pump();
    res.json(Object.assign(publicJob(job), { position: queuePosition(id) }));
  } catch (e) { res.status(500).json({ error: e.message }); }
}
app.get('/api/jobs/:id', async (req, res) => { const j = jobs.get(req.params.id); if (!j) return res.status(404).json({ error: 'not found' }); await checkPaid(j); const pw = unmanned() && paperWait.get(j.bot || 1); res.json(Object.assign(publicJob(j), { position: queuePosition(j.id), unmanned: unmanned(), paper: pw ? { since: pw.since, number: pw.number, mine: pw.number === j.number } : null })); });
app.post('/api/jobs/:id/pay', async (req, res) => { // guest picked a size: open a Stripe Checkout for it and hand back the link (shown as a QR)
  const j = jobs.get(req.params.id); if (!j) return res.status(404).json({ error: 'not found' }); if (j.status !== 'unpaid') return res.json(Object.assign(publicJob(j), { position: queuePosition(j.id) }));
  const z = paySizes().find(z => z.id === String(req.body.size || '')); if (!z) return res.status(400).json({ error: 'pick a size' });
  const base = (req.get('x-forwarded-proto') || req.protocol) + '://' + req.get('host');
  try {
    if (j.pay.sessionId && j.pay.size !== z.id) stripe('POST', `/v1/checkout/sessions/${j.pay.sessionId}/expire`).catch(() => {});
    if (!j.pay.sessionId || j.pay.size !== z.id) {
      const ses = await stripe('POST', '/v1/checkout/sessions', { mode: 'payment', line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: z.price, product_data: { name: `${getSettings().eventName || 'Sketchy Robotics'} — ${z.label} robot sketch` } } }],
        success_url: j.remote ? `${base}/go/${j.remote}?job=${j.id}&paid=1` : `${base}/paid?ok=1`, cancel_url: j.remote ? `${base}/go/${j.remote}?job=${j.id}` : `${base}/paid?cancel=1`, expires_at: Math.floor(Date.now() / 1000) + 31 * 60, metadata: { job: j.id, number: j.number, size: z.id }, client_reference_id: j.id });
      j.pay = Object.assign(j.pay, { size: z.id, label: z.label, amount: z.price, sessionId: ses.id, url: ses.url }); saveJob(j);
    }
    res.json({ ok: true, url: j.pay.url, amount: j.pay.amount, size: z.id, label: z.label });
  } catch (e) { res.status(502).json({ error: e.message }); }
});
app.post('/api/jobs/:id/cancel', (req, res) => { const j = jobs.get(req.params.id); if (j && j.status === 'unpaid') { j.status = 'expired'; saveJob(j); if (j.pay && j.pay.sessionId) stripe('POST', `/v1/checkout/sessions/${j.pay.sessionId}/expire`).catch(() => {}); } res.json({ ok: true }); }); // guest walked away before paying
app.get('/api/jobs/:id/pay/qr.svg', async (req, res) => { const j = jobs.get(req.params.id); if (!j || !j.pay || !j.pay.url) return res.status(404).end(); try { const svg = await require('qrcode').toString(j.pay.url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }); res.setHeader('content-type', 'image/svg+xml'); res.setHeader('cache-control', 'no-store'); res.send(svg); } catch (e) { res.status(500).end(); } });
app.get('/paid', (req, res) => res.sendFile(path.join(ROOT, 'public', 'paid', 'index.html')));
app.get('/api/admin/stripe', adminAuth, async (req, res) => { // is Stripe connected, and to which account
  if (!STRIPE_KEY) return res.json({ configured: false });
  try { const a = await stripe('GET', '/v1/account'); res.json({ configured: true, mode: STRIPE_KEY.startsWith('sk_test') ? 'test' : 'live', name: (a.business_profile && a.business_profile.name) || a.settings && a.settings.dashboard && a.settings.dashboard.display_name || a.email || a.id, email: a.email || '' }); }
  catch (e) { res.json({ configured: true, mode: STRIPE_KEY.startsWith('sk_test') ? 'test' : 'live', error: e.message }); }
});
app.get('/api/jobs/:id/art', async (req, res) => { const f = path.join(JOBS, req.params.id, req.query.thumb ? 'art-thumb.png' : 'art.png'); if (!(await ensureLocal(f))) return res.status(404).end();
  if (req.query.download) { const j = jobs.get(req.params.id) || {}; res.setHeader('content-disposition', `attachment; filename="sketch-${String(j.number || 0).padStart(3, '0')}-${slugify(j.themeName || 'theme')}.png"`); } res.sendFile(f); });

// ----- operator (studio) — unauthenticated on purpose: it only reads art and reports progress; the laptop is yours -----
app.get('/api/queue', studioAuth, (req, res) => { res.json({ settings: getSettings(), bots: botList(), jobs: sortedJobs().filter(j => !j.test && !['done', 'skipped', 'archived', 'unpaid', 'expired'].includes(j.status)).map(publicJob), done: sortedJobs().filter(j => j.status === 'done').slice(-10).map(publicJob) }); });
// Unmanned events: after each drawing the robot waits until a guest taps "paper is in" on the iPad (nobody is there to swap the sheet)
const paperWait = new Map(); // bot -> { since, number }
const unmanned = () => getSettings().staffing === 'unmanned';
app.post('/api/bots/:n/paper', (req, res) => { paperWait.delete(Math.max(1, +req.params.n || 1)); res.json({ ok: true }); });
app.post('/api/queue/claim', studioAuth, (req, res) => { // next ready -> drawing. Mine first, then unassigned, then jobs whose robot has gone quiet
  const bot = Math.max(1, +(req.body && req.body.bot) || 1); if (unmanned() && paperWait.has(bot)) return res.json({ job: null, wait: 'paper', since: paperWait.get(bot).since, number: paperWait.get(bot).number }); if (!unmanned()) paperWait.delete(bot); const ready = sortedJobs().filter(j => j.status === 'ready');
  const j = ready.find(j => j.bot === bot) || ready.find(j => !j.bot || j.bot > botCount()) || ready.find(j => botStale(j.bot)); if (!j) return res.json({ job: null });
  j.status = 'drawing'; j.bot = bot; j.drawStartedAt = Date.now(); if (req.user) j.operator = req.user.name; saveJob(j); res.json({ job: publicJob(j) });
});
app.post('/api/bots/heartbeat', studioAuth, (req, res) => { const b = req.body || {}; const n = Math.max(1, Math.min(8, +b.bot || 1)); bots.set(n, { bot: n, connected: !!b.connected, status: String(b.status || '').slice(0, 80), jobId: b.jobId || null, number: b.number || null, progress: +b.progress || 0, seen: Date.now() }); res.json({ ok: true, bots: botList() }); });
function botList() { const n = botCount(); const out = []; for (let i = 1; i <= n; i++) { const b = bots.get(i); out.push(b && Date.now() - b.seen < 30000 ? Object.assign({ live: true, waiting: botLoad(i) }, b) : { bot: i, live: false, connected: false, status: 'no Studio tab open', waiting: botLoad(i) }); } return out; }
app.get('/api/bots', (req, res) => res.json({ bots: botList(), count: botCount() }));
app.post('/api/queue/claim-id/:id', studioAuth, (req, res) => { const j = jobs.get(req.params.id); if (!j) return res.status(404).end(); j.status = 'drawing'; j.drawStartedAt = j.drawStartedAt || Date.now(); saveJob(j); res.json({ job: publicJob(j) }); }); // resume after a reload
app.post('/api/jobs/:id/status', studioAuth, (req, res) => { const j = jobs.get(req.params.id); if (!j) return res.status(404).end(); const st = String(req.body.status); if (!['done', 'ready', 'skipped', 'failed'].includes(st)) return res.status(400).end(); j.status = st; if (st === 'done') { j.doneAt = Date.now(); if (unmanned() && !j.test) paperWait.set(j.bot || 1, { since: Date.now(), number: j.number }); } if (req.body.error) j.error = String(req.body.error); else if (st === 'done') j.error = null;
  for (const k of ['drawSeconds', 'strokes', 'widthMm']) if (req.body[k] != null && isFinite(+req.body[k])) j[k] = Math.round(+req.body[k] * 10) / 10; if (req.body.preset) j.preset = String(req.body.preset).slice(0, 60); // draw-time log
  saveJob(j); res.json(publicJob(j)); });

// ----- admin -----
app.post('/api/admin/login', (req, res) => { // admin: the ADMIN_PASSWORD secret (name optional); operators: name + their own password
  const name = String(req.body.name || '').trim(), pw = String(req.body.password || '');
  if ((!name || name.toLowerCase() === 'admin') && pw && pw === ADMIN_PASSWORD) return res.json({ ok: true, token: newSession({ name: 'admin', role: 'admin' }), name: 'admin', role: 'admin' });
  const u = loadUsers().find(u => u.name.toLowerCase() === name.toLowerCase()); if (!u || u.enabled === false || !checkPw(pw, u.hash)) return res.status(401).json({ error: 'wrong name or password' });
  u.lastLogin = Date.now(); saveUsers(loadUsers().map(x => x.id === u.id ? u : x));
  res.json({ ok: true, token: newSession({ userId: u.id, name: u.name, role: u.role }), name: u.name, role: u.role === 'admin' ? 'admin' : 'operator' });
});
app.post('/api/logout', (req, res) => { const t = req.get('x-admin-token') || ''; if (sessions.delete(t)) saveSessions(); res.json({ ok: true }); });
app.get('/api/me', opAuth, (req, res) => res.json(req.user));
const safeUser = u => ({ id: u.id, name: u.name, role: u.role, enabled: u.enabled !== false, createdAt: u.createdAt, lastLogin: u.lastLogin || null });
app.get('/api/admin/users', adminAuth, (req, res) => res.json({ users: loadUsers().map(safeUser) }));
app.post('/api/admin/users', adminAuth, (req, res) => { const name = String(req.body.name || '').trim().slice(0, 30), pw = String(req.body.password || ''); if (!name || name.toLowerCase() === 'admin') return res.status(400).json({ error: 'name required' }); if (pw.length < 4) return res.status(400).json({ error: 'password must be at least 4 characters' });
  const users = loadUsers(); if (users.some(u => u.name.toLowerCase() === name.toLowerCase())) return res.status(400).json({ error: 'that name is taken' });
  const u = { id: crypto.randomBytes(4).toString('hex'), name, role: req.body.role === 'admin' ? 'admin' : 'operator', hash: hashPw(pw), enabled: true, createdAt: Date.now() }; users.push(u); saveUsers(users); res.json({ ok: true, user: safeUser(u) }); });
app.post('/api/admin/users/:id', adminAuth, (req, res) => { const users = loadUsers(); const u = users.find(u => u.id === req.params.id); if (!u) return res.status(404).end();
  if ('enabled' in req.body) u.enabled = !!req.body.enabled; if (req.body.role) u.role = req.body.role === 'admin' ? 'admin' : 'operator'; if (req.body.password) { if (String(req.body.password).length < 4) return res.status(400).json({ error: 'password must be at least 4 characters' }); u.hash = hashPw(req.body.password); }
  saveUsers(users); if (u.enabled === false || req.body.password) { for (const [t, se] of sessions) if (se.userId === u.id) sessions.delete(t); saveSessions(); } res.json({ ok: true, user: safeUser(u) }); });
app.delete('/api/admin/users/:id', adminAuth, (req, res) => { saveUsers(loadUsers().filter(u => u.id !== req.params.id)); for (const [t, se] of sessions) if (se.userId === req.params.id) sessions.delete(t); saveSessions(); res.json({ ok: true }); });
app.get('/api/admin/state', opAuth, (req, res) => { const s = getSettings(); const jobsOut = sortedJobs().filter(j => !j.test).slice(-200).map(j => Object.assign(publicJob(j), { guestName: j.guestName, priority: j.priority, operator: j.operator || null }));
  if (req.user.role !== 'admin') return res.json({ me: req.user, settings: { bots: s.bots, pay: s.pay, staffing: s.staffing, eventName: s.eventName, eventMode: s.eventMode }, themes: listThemes().map(t => ({ slug: t.slug, name: t.name })), variants: VARIANT_LABELS, variantOrder: VARIANTS, jobs: jobsOut, hasKey: !!OPENAI_KEY, durable: !!bucket, readOnly: !!bucket && !IS_DEPLOYMENT });
  res.json({ me: req.user, settings: s, themes: listThemes(), variants: VARIANT_LABELS, variantOrder: VARIANTS, jobs: jobsOut, hasKey: !!OPENAI_KEY, durable: !!bucket, readOnly: !!bucket && !IS_DEPLOYMENT }); });
app.post('/api/admin/settings', adminAuth, (req, res) => { const body = req.body || {}; const allowed = ['model', 'quality', 'size', 'moderation', 'concurrency', 'eventName', 'cameraZoom', 'bots', 'textModel', 'foundations', 'safetyFoundation', 'eventMode', 'testModels', 'pay', 'presets', 'staffing', 'remote']; const s = getSettings(); if (body.remote) body.remote = { enabled: !!body.remote.enabled, code: String(body.remote.code || '').replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 12) || newCode() }; if (body.staffing) body.staffing = body.staffing === 'unmanned' ? 'unmanned' : 'manned'; for (const k of allowed) if (k in body) s[k] = body[k]; if (body.pay) s.pay = cleanPay(body.pay); saveSettings(s); res.json(Object.assign({ ok: true, durable: !!bucket && IS_DEPLOYMENT }, s)); });
const PRESET_KEYS = ['eventName', 'eventMode', 'bots', 'concurrency', 'pay', 'staffing']; // what an event preset remembers
app.post('/api/admin/presets', adminAuth, (req, res) => { // save the current settings (or the body's) as a named event type
  const s = getSettings(); const name = String(req.body.name || '').trim().slice(0, 40); if (!name) return res.status(400).json({ error: 'name required' });
  const src = Object.assign({}, s, req.body.settings || {}); const pr = { id: req.body.id || crypto.randomBytes(4).toString('hex'), name }; for (const k of PRESET_KEYS) pr[k] = src[k]; pr.pay = cleanPay(pr.pay || {});
  s.presets = (s.presets || []).filter(x => x.id !== pr.id && x.name !== name).concat(pr); saveSettings(s); res.json({ ok: true, presets: s.presets });
});
app.post('/api/admin/presets/:id/apply', adminAuth, (req, res) => { const s = getSettings(); const pr = (s.presets || []).find(x => x.id === req.params.id); if (!pr) return res.status(404).end(); for (const k of PRESET_KEYS) if (k in pr) s[k] = pr[k]; saveSettings(s); res.json(Object.assign({ ok: true }, s)); });
app.delete('/api/admin/presets/:id', adminAuth, (req, res) => { const s = getSettings(); s.presets = (s.presets || []).filter(x => x.id !== req.params.id); saveSettings(s); res.json({ ok: true, presets: s.presets }); });
app.post('/api/admin/themes', adminAuth, (req, res) => { const name = String(req.body.name || '').trim(); if (!name) return res.status(400).json({ error: 'name required' }); let slug = slugify(name); if (readTheme(slug)) slug += '-' + Date.now().toString(36); writeTheme(slug, { name, enabled: true, order: listThemes().length + 1, prompts: {} }); res.json(readTheme(slug)); });
app.put('/api/admin/themes/:slug', adminAuth, (req, res) => { const t = readTheme(slugify(req.params.slug)); if (!t) return res.status(404).end(); writeTheme(t.slug, Object.assign(t, req.body, { prompts: Object.assign(t.prompts, req.body.prompts || {}), variantModels: Object.assign(t.variantModels, req.body.variantModels || {}) })); res.json(readTheme(t.slug)); });
app.delete('/api/admin/themes/:slug', adminAuth, (req, res) => { const d = path.join(THEMES, slugify(req.params.slug)); if (fs.existsSync(d)) { fs.rmSync(d, { recursive: true }); unpersist(d); } res.json({ ok: true }); });
app.post('/api/admin/themes/:slug/thumb', adminAuth, upload.single('thumb'), async (req, res) => { const t = readTheme(slugify(req.params.slug)); if (!t || !req.file) return res.status(400).end(); if (t.thumbFrom) { t.thumbFrom = ''; writeTheme(t.slug, t); } await sharp(req.file.buffer).rotate().resize(700, 700, { fit: 'inside', withoutEnlargement: true }).png().toFile(path.join(THEMES, t.slug, 'thumb.png')); persist(path.join(THEMES, t.slug, 'thumb.png')); res.json({ ok: true }); });
let modelCache = null; // { models, at } — the key's image models, refetched after an hour
app.get('/api/admin/models', adminAuth, async (req, res) => {
  try {
    if (!modelCache || Date.now() - modelCache.at > 3600e3) {
      const r = await fetch(OPENAI_BASE + '/v1/models', { headers: { Authorization: 'Bearer ' + OPENAI_KEY } }); const j = await r.json(); if (!r.ok) throw new Error(j.error && j.error.message || r.status);
      const ids = (j.data || []).map(m => m.id); modelCache = { models: ids.filter(id => /image/i.test(id)).sort(), text: ids.filter(id => /^(gpt-4|gpt-5|o[1-9]|chatgpt-4)/.test(id) && !/image|audio|realtime|tts|transcribe|search|embedding|moderation/.test(id)).sort(), at: Date.now() };
    }
    res.json({ models: modelCache.models, text: modelCache.text }); } catch (e) { res.status(500).json({ error: e.message }); }
});
// ----- AI prompt writer: a non-negotiable foundation (verbatim) + a theme section written by a text model from the operator's description -----
async function chat(model, system, user, maxTokens) {
  const body = { model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }; if (!/^o[1-9]|^gpt-5/.test(model)) body.temperature = 0.8;
  const r = await fetch(OPENAI_BASE + '/v1/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer ' + OPENAI_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('OpenAI ' + r.status + ': ' + (j.error && j.error.message || '').slice(0, 300)); return ((j.choices || [])[0] || {}).message?.content?.trim() || '';
}
const WRITER_SYSTEM = `You write prompts for an AI image-editing model that turns a guest's selfie into black-and-white line art which a pen plotter then draws on paper at an event.
You are given a FOUNDATION: fixed, non-negotiable instructions that will be placed verbatim at the top of the final prompt. Do NOT repeat, paraphrase, weaken or contradict anything in it.
Your job is to write only the THEME SECTION that follows it: the costume/outfit, props, hair/accessory treatment, pose and positioning, expression, body details and setting for the requested combination of people, based on the operator's description. Match the foundation's tone and level of detail. Be concrete and visual (what is worn, held, where things are), avoid vague adjectives, keep it to one tightly written paragraph or a short list of sentences, and never mention text, logos, watermarks, colours or shading (the output must stay clean line art). Respect the combination exactly: for two people say who is on the LEFT and who is on the RIGHT; for person + pet describe the pet's treatment too.
Output ONLY the theme section text, no heading, no preamble, no quotes.
AUDIENCE RULES: when the audience is FAMILY, everything must be wholesome and suitable for children: fully clothed, no innuendo, no weapons pointed at people, no gore, no alcohol or drugs. When the audience is ADULT, go as bold as a general-audience image service will render: pin-up, burlesque, boudoir and rock-and-roll excess — sultry gaze, confident sexy poses, lingerie-styled or corset costumes, fishnets, heels, suggestive props and attitude — while keeping intimate areas opaquely covered and showing no sexual acts, because anything past that is refused by the service and the guest gets nothing. Adults only; never apply adult styling to anyone who could be under 18.
When asked to DIAL BACK a prompt, keep the theme and the costume idea but move one clear step tamer: more fabric, less skin, suggestion instead of display, a cooler pose — the smallest change likely to make the image service accept it.`;
app.post('/api/admin/writer', adminAuth, async (req, res) => {
  try {
    if (!OPENAI_KEY) throw new Error('OPENAI_API_KEY is not set'); const st = getSettings(); const model = String(req.body.model || st.textModel || 'gpt-4.1-mini');
    const fid = String(req.body.foundation || ''); const f = (st.foundations || []).find(x => x.id === fid) || { name: 'none', text: '' };
    const desc = String(req.body.description || '').trim(); if (!desc) return res.status(400).json({ error: 'describe the theme first' });
    const variants = (Array.isArray(req.body.variants) ? req.body.variants : [req.body.variant]).filter(v => VARIANTS.includes(v)); if (!variants.length) return res.status(400).json({ error: 'pick a combination' });
    const themeName = String(req.body.themeName || '').trim(); const extra = String(req.body.extra || '').trim(); const rating = req.body.rating === 'adult' ? 'adult' : 'family';
    const head = [st.safetyFoundation, f.text].map(x => (x || '').trim()).filter(Boolean).join('\n\n'); // safety rules first, then the foundation — both verbatim
    const results = await Promise.all(variants.map(async v => {
      const user = `FOUNDATION (already in the prompt, do not repeat):\n${head || '(none)'}\n\nAUDIENCE: ${rating.toUpperCase()}\nTHEME NAME: ${themeName || '(untitled)'}\nCOMBINATION: ${VARIANT_LABELS[v]}\nOPERATOR'S DESCRIPTION OF THE THEME: ${desc}${extra ? '\nEXTRA RULES FOR THIS THEME: ' + extra : ''}\n\nWrite the theme section now.`;
      try { const part = await chat(model, WRITER_SYSTEM, user, 900); return { variant: v, label: VARIANT_LABELS[v], part, prompt: (head ? head + '\n\n' : '') + part }; } catch (e) { return { variant: v, label: VARIANT_LABELS[v], error: e.message }; } }));
    res.json({ ok: true, model, foundation: f.name, results });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
    else if (req.body.refId) photo = await refBuffer(String(req.body.refId)); // a face from the Lab's library
    if (!photo) return res.status(400).json({ error: 'add a reference photo' });
    const batch = 'lab-' + Date.now().toString(36); const photoHash = crypto.createHash('sha1').update(photo).digest('hex').slice(0, 16);
    const results = models.map(model => {
      const id = 'lab-' + crypto.randomBytes(4).toString('hex');
      const job = { id, number: 0, status: 'processing', theme: theme.slug, themeName: theme.name, variant, createdAt: Date.now(), attempts: 1, test: true, lab: true, batch, photoHash, labPrompt: prompt, labModel: model };
      fs.mkdirSync(path.join(JOBS, id), { recursive: true }); fs.writeFileSync(path.join(JOBS, id, 'photo.jpg'), photo); persist(path.join(JOBS, id, 'photo.jpg'));
      const override = { model, prompt }; for (const k of ['quality', 'moderation']) if (req.body[k]) override[k] = String(req.body[k]); labEnqueue(job, override); return labJob(job);
    });
    res.json({ batch, results, async: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
const thumbSources = () => { const m = {}; for (const t of listThemes()) if (t.thumbFrom) m[t.thumbFrom] = t.slug; return m; };
function labJob(j, ts) { ts = ts || thumbSources(); return { id: j.id, isThumb: ts[j.id] || null, batch: j.batch, note: j.note || null, startedAt: j.startedAt || null, photoHash: j.photoHash || j.batch, theme: j.theme, themeName: j.themeName, variant: j.variant, createdAt: j.createdAt, status: j.status, error: j.error, seconds: j.seconds, prompt: j.labPrompt, model: j.labModel, used: j.used, droppedParam: j.droppedParam, art: j.status === 'test' ? `/api/jobs/${j.id}/art` : null, photo: `/api/jobs/${j.id}/photo`, applied: j.applied || null }; }
const LAB_REFS = path.join(DATA, 'lab-refs.json'); // { hidden: [photoHash] } — reference photos removed from the Lab's strip (results keep their photo)
const labRefs = () => { try { return JSON.parse(fs.readFileSync(LAB_REFS, 'utf8')); } catch (_) { return { hidden: [] }; } };
app.get('/api/admin/lab', adminAuth, (req, res) => { // newest first; up to 200 per theme, and a result that is a theme's thumbnail is always listed
  const ts = thumbSources(); const per = {}; const out = [];
  for (const j of [...jobs.values()].filter(j => j.lab).sort((a, b) => b.createdAt - a.createdAt)) { const k = j.theme || ''; per[k] = (per[k] || 0) + 1; if (per[k] <= 200 || ts[j.id]) out.push(labJob(j, ts)); }
  res.json({ results: out, hiddenRefs: labRefs().hidden }); });
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
  theme.thumbFrom = j.id; writeTheme(theme.slug, theme); // this result is now the tile picture: marked in the Lab and protected from "clear"
  res.json({ ok: true, theme: theme.slug });
});
// ----- reference-face library (shared by the Lab and the Theme Builder) -----
const REFS = path.join(DATA, 'refs'); fs.mkdirSync(REFS, { recursive: true });
const listRefs = () => { try { return fs.readdirSync(REFS).filter(f => f.endsWith('.jpg')).map(f => { const st = fs.statSync(path.join(REFS, f)); return { id: f.slice(0, -4), at: st.mtimeMs }; }).sort((a, b) => b.at - a.at); } catch (_) { return []; } };
async function refBuffer(id) { if (!/^[a-f0-9]{16}$/.test(id)) return null; const f = path.join(REFS, id + '.jpg'); return (await ensureLocal(f)) ? fs.readFileSync(f) : null; }
app.get('/api/admin/refs', adminAuth, (req, res) => res.json({ refs: listRefs() }));
app.post('/api/admin/refs', adminAuth, upload.single('photo'), async (req, res) => { try { if (!req.file) throw new Error('no file received'); fs.mkdirSync(REFS, { recursive: true }); const buf = await sharp(req.file.buffer).rotate().resize(1536, 1536, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 92 }).toBuffer(); const id = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16); const f = path.join(REFS, id + '.jpg'); if (!fs.existsSync(f)) { fs.writeFileSync(f, buf); persist(f); } res.json({ id }); } catch (e) { console.error('ref upload', e.message); res.status(400).json({ error: 'could not save the photo: ' + e.message }); } });
app.get('/api/admin/refs/:id', adminAuth, async (req, res) => { const b = await refBuffer(req.params.id); if (!b) return res.status(404).end(); res.setHeader('content-type', 'image/jpeg'); res.send(b); });
app.delete('/api/admin/refs/:id', adminAuth, (req, res) => { const f = path.join(REFS, req.params.id + '.jpg'); if (/^[a-f0-9]{16}$/.test(req.params.id)) { fs.rmSync(f, { force: true }); if (bucket && IS_DEPLOYMENT) bucket.delete(rel(f)).catch(() => {}); } res.json({ ok: true }); });

// ----- Theme Builder: one draft at a time, saved as it goes -----
const BUILDER = path.join(DATA, 'builder.json');
const getDraft = () => { try { return JSON.parse(fs.readFileSync(BUILDER, 'utf8')); } catch (_) { return { name: '', desc: '', extra: '', audience: 'family', proportions: 'normal', refs: {}, prompts: {}, picks: {}, thumb: null }; } };
const saveDraft = d => { fs.writeFileSync(BUILDER, JSON.stringify(d)); persist(BUILDER); };
const flavorsOf = d => { const out = []; for (const a of (d.audience === 'both' ? ['family', 'adult'] : [d.audience === 'adult' ? 'adult' : 'family'])) for (const p of (d.proportions === 'both' ? ['normal', 'bighead'] : [d.proportions === 'bighead' ? 'bighead' : 'normal'])) out.push(a + '-' + p); return out; };
const flavorName = (base, fl) => base + (fl.endsWith('bighead') ? ' (Big head)' : '') + (fl.startsWith('adult') ? ' 18+' : '');
app.get('/api/admin/builder', adminAuth, (req, res) => { const d = getDraft(); res.json(Object.assign({ flavors: flavorsOf(d), tests: [...jobs.values()].filter(j => j.lab && j.builder).sort((a, b) => b.createdAt - a.createdAt).map(labJob) }, d)); });
app.put('/api/admin/builder', adminAuth, (req, res) => { const d = Object.assign(getDraft(), req.body || {}); saveDraft(d); res.json({ ok: true, flavors: flavorsOf(d) }); });
app.delete('/api/admin/builder', adminAuth, (req, res) => { fs.rmSync(BUILDER, { force: true }); if (bucket && IS_DEPLOYMENT) bucket.delete(rel(BUILDER)).catch(() => {}); for (const j of [...jobs.values()]) if (j.lab && j.builder) { jobs.delete(j.id); fs.rmSync(path.join(JOBS, j.id), { recursive: true, force: true }); unpersist(path.join(JOBS, j.id)); } res.json({ ok: true }); });
app.post('/api/admin/builder/write', adminAuth, async (req, res) => { // prompts for every flavour × combination (or just the ones asked for)
  try { const d = getDraft(); const st = getSettings(); const model = String(req.body.model || st.textModel || 'gpt-4.1-mini'); const flavors = (req.body.flavors && req.body.flavors.length ? req.body.flavors : flavorsOf(d)).filter(f => flavorsOf(d).includes(f)); const variants = (req.body.variants && req.body.variants.length ? req.body.variants : VARIANTS).filter(v => VARIANTS.includes(v));
    if (!d.desc || !d.desc.trim()) return res.status(400).json({ error: 'describe the theme first' });
    const jobsList = []; for (const fl of flavors) for (const v of variants) jobsList.push({ fl, v });
    const results = await Promise.all(jobsList.map(async ({ fl, v }) => { const [rating, prop] = fl.split('-'); const f = (st.foundations || []).find(x => x.id === prop) || { text: '' }; const head = [st.safetyFoundation, f.text].map(x => (x || '').trim()).filter(Boolean).join('\n\n');
      const user = `FOUNDATION (already in the prompt, do not repeat):\n${head || '(none)'}\n\nAUDIENCE: ${rating.toUpperCase()}\nPROPORTIONS: ${prop === 'bighead' ? 'big-head caricature' : 'normal'}\nTHEME NAME: ${d.name || '(untitled)'}\nCOMBINATION: ${VARIANT_LABELS[v]}\nOPERATOR'S DESCRIPTION OF THE THEME: ${d.desc}${d.extra ? '\nEXTRA RULES FOR THIS THEME: ' + d.extra : ''}\n\nWrite the theme section now.`;
      try { const part = await chat(model, WRITER_SYSTEM, user, 900); return { fl, v, prompt: (head ? head + '\n\n' : '') + part }; } catch (e) { return { fl, v, error: e.message }; } }));
    const d2 = getDraft(); d2.prompts = d2.prompts || {}; for (const r of results) if (!r.error) { d2.prompts[r.fl] = d2.prompts[r.fl] || {}; d2.prompts[r.fl][r.v] = r.prompt; } saveDraft(d2);
    res.json({ ok: true, model, results, prompts: d2.prompts });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/builder/test', adminAuth, async (req, res) => { // generate test images for one flavour: every combination that has a reference × the test models
  try { const d = getDraft(); const st = getSettings(); const fl = String(req.body.flavor || flavorsOf(d)[0]); const models = (Array.isArray(req.body.models) && req.body.models.length ? req.body.models : (st.testModels || [st.model])).filter(Boolean).slice(0, 6);
    const variants = (req.body.variants && req.body.variants.length ? req.body.variants : VARIANTS).filter(v => VARIANTS.includes(v) && d.refs && d.refs[v] && d.prompts && d.prompts[fl] && d.prompts[fl][v]);
    if (!variants.length) return res.status(400).json({ error: 'no combination has both a reference photo and a prompt yet' });
    // the test rides on the Lab machinery; we need a theme context for generateArt → a hidden scratch theme named after the draft
    const scratchSlug = '_builder'; if (!readTheme(scratchSlug)) writeTheme(scratchSlug, { name: 'Theme Builder (scratch)', enabled: false, order: 999, prompts: {} });
    const batch = 'lab-' + Date.now().toString(36); const [rating] = fl.split('-');
    const runs = []; for (const v of variants) { const photo = await refBuffer(d.refs[v]); if (!photo) continue; for (const model of models) runs.push({ v, model, photo }); }
    const results = await Promise.all(runs.map(async ({ v, model, photo }) => { const id = 'lab-' + crypto.randomBytes(4).toString('hex'); const prompt = d.prompts[fl][v];
      const job = { id, number: 0, status: 'processing', theme: scratchSlug, themeName: d.name || 'draft', variant: v, createdAt: Date.now(), attempts: 1, test: true, lab: true, builder: true, flavor: fl, batch, photoHash: d.refs[v], labPrompt: prompt, labModel: model };
      fs.mkdirSync(path.join(JOBS, id), { recursive: true }); fs.writeFileSync(path.join(JOBS, id, 'photo.jpg'), photo); persist(path.join(JOBS, id, 'photo.jpg')); jobs.set(id, job); const t0 = Date.now();
      const override = { model, prompt, moderation: 'low' }; if (req.body.quality) override.quality = String(req.body.quality); // Builder always tests at the loosest setting the API offers
      try { await generateArt(job, override); job.status = 'test'; job.readyAt = Date.now(); } catch (e) { job.status = 'failed'; job.error = String(e.message || e); }
      job.seconds = Math.round((Date.now() - t0) / 1000); saveJob(job); return Object.assign(labJob(job), { flavor: fl }); }));
    res.json({ ok: true, results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/builder/check', adminAuth, async (req, res) => { // cheap pass/refuse check: one model, low quality, one image per combination of one flavour
  try { const d = getDraft(); const st = getSettings(); const fl = String(req.body.flavor || flavorsOf(d)[0]); const [rating] = fl.split('-'); const model = String(req.body.model || (st.testModels || [])[0] || st.model);
    const variants = (req.body.variants && req.body.variants.length ? req.body.variants : VARIANTS).filter(v => VARIANTS.includes(v) && d.prompts && d.prompts[fl] && d.prompts[fl][v]);
    if (!variants.length) return res.status(400).json({ error: 'no prompts to check' });
    const scratchSlug = '_builder'; if (!readTheme(scratchSlug)) writeTheme(scratchSlug, { name: 'Theme Builder (scratch)', enabled: false, order: 999, prompts: {} });
    // a stand-in face when the slot has no reference: any library face, else any lab photo
    let fallback = null; const lib = listRefs(); if (lib.length) fallback = await refBuffer(lib[0].id);
    const results = await Promise.all(variants.map(async v => { const photo = (d.refs && d.refs[v] ? await refBuffer(d.refs[v]) : null) || fallback; if (!photo) return { v, label: VARIANT_LABELS[v], error: 'add at least one face to the library first' };
      const id = 'lab-' + crypto.randomBytes(4).toString('hex'); const job = { id, number: 0, status: 'processing', theme: scratchSlug, themeName: d.name || 'draft', variant: v, createdAt: Date.now(), attempts: 1, test: true, lab: true, builder: true, check: true, flavor: fl, labPrompt: d.prompts[fl][v], labModel: model };
      fs.mkdirSync(path.join(JOBS, id), { recursive: true }); fs.writeFileSync(path.join(JOBS, id, 'photo.jpg'), photo); jobs.set(id, job); const t0 = Date.now();
      try { await generateArt(job, { model, prompt: d.prompts[fl][v], quality: 'low', moderation: 'low' }); job.status = 'test'; job.readyAt = Date.now(); } catch (e) { job.status = 'failed'; job.error = String(e.message || e); }
      job.seconds = Math.round((Date.now() - t0) / 1000); saveJob(job); const refused = job.status === 'failed' && /safety|moderation|policy|rejected|not allowed|content/i.test(job.error || '');
      return { v, label: VARIANT_LABELS[v], ok: job.status === 'test', refused, error: job.error, art: job.status === 'test' ? `/api/jobs/${id}/art` : null, seconds: job.seconds }; }));
    const d2 = getDraft(); d2.checks = d2.checks || {}; d2.checks[fl] = Object.assign(d2.checks[fl] || {}, Object.fromEntries(results.map(r => [r.v, { ok: !!r.ok, refused: !!r.refused, error: r.error || null, art: r.art || null, at: Date.now() }]))); saveDraft(d2);
    res.json({ ok: true, model, results, checks: d2.checks });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/builder/dialback', adminAuth, async (req, res) => { // rewrite one prompt a step tamer, keeping foundation + safety verbatim
  try { const d = getDraft(); const st = getSettings(); const fl = String(req.body.flavor || ''); const v = String(req.body.variant || ''); const cur = d.prompts && d.prompts[fl] && d.prompts[fl][v]; if (!cur) return res.status(400).json({ error: 'no prompt' });
    const [rating, prop] = fl.split('-'); const f = (st.foundations || []).find(x => x.id === prop) || { text: '' }; const head = [st.safetyFoundation, f.text].map(x => (x || '').trim()).filter(Boolean).join('\n\n');
    const themePart = head && cur.startsWith(head) ? cur.slice(head.length).trim() : cur; const model = String(req.body.model || st.textModel || 'gpt-4.1-mini');
    const user = `FOUNDATION (already in the prompt, do not repeat):\n${head || '(none)'}\n\nAUDIENCE: ${rating.toUpperCase()}\nCOMBINATION: ${VARIANT_LABELS[v]}\nTHE IMAGE SERVICE REFUSED THIS THEME SECTION${req.body.reason ? ' (' + String(req.body.reason).slice(0, 200) + ')' : ''}:\n${themePart}\n\nDIAL BACK one step and output only the revised theme section.`;
    const part = await chat(model, WRITER_SYSTEM, user, 900); const next = (head ? head + '\n\n' : '') + part; d.prompts[fl][v] = next; d.checks = d.checks || {}; if (d.checks[fl]) delete d.checks[fl][v]; saveDraft(d);
    res.json({ ok: true, prompt: next });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/builder/publish', adminAuth, async (req, res) => { // one flavour → a new theme or an existing one
  try { const d = getDraft(); const fl = String(req.body.flavor || flavorsOf(d)[0]); const [rating, prop] = fl.split('-'); const prompts = (d.prompts && d.prompts[fl]) || {}; if (!Object.keys(prompts).length) return res.status(400).json({ error: 'no prompts written for this variant yet' });
    const picks = (d.picks && d.picks[fl]) || {}; let slug = req.body.target && req.body.target !== 'new' ? slugify(req.body.target) : null; let existing = slug ? readTheme(slug) : null; if (slug && !existing) return res.status(400).json({ error: 'target theme not found' });
    const name = String(req.body.name || flavorName(d.name || 'Theme', fl)).trim();
    if (!existing) { slug = slugify(name); if (readTheme(slug)) slug += '-' + Date.now().toString(36); }
    const base = existing || { name, enabled: false, order: listThemes().length + 1, prompts: {}, variantModels: {} };
    const th = Object.assign({}, base, { name: existing ? existing.name : name, rating: rating === 'adult' ? 'adult' : 'family', proportions: prop, prompts: Object.assign({}, base.prompts, prompts), variantModels: Object.assign({}, base.variantModels || {}) });
    for (const v of VARIANTS) if (picks[v] && picks[v].model) th.variantModels[v] = { model: picks[v].model, quality: picks[v].quality || '' };
    writeTheme(slug, th);
    const thumbJob = d.thumb && d.thumb[fl] ? jobs.get(d.thumb[fl]) : null; if (thumbJob) { const art = path.join(JOBS, thumbJob.id, 'art.png'); if (await ensureLocal(art)) { await sharp(art).resize(700, 700, { fit: 'inside', withoutEnlargement: true }).png().toFile(path.join(THEMES, slug, 'thumb.png')); persist(path.join(THEMES, slug, 'thumb.png')); } }
    res.json({ ok: true, slug, name: readTheme(slug).name, isNew: !existing });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// lab generations run in the background a few at a time; the page polls /api/admin/lab for live status
const labQueue = []; let labRunning = 0; const LAB_PARALLEL = 3;
function labPump() { while (labRunning < LAB_PARALLEL && labQueue.length) { const { job, override } = labQueue.shift(); labRunning++; job.startedAt = Date.now(); job.note = 'sent to OpenAI'; saveJob(job);
  generateArt(job, override).then(() => { job.status = 'test'; job.readyAt = Date.now(); }).catch(e => { job.status = 'failed'; job.error = String(e.message || e); }).finally(() => { job.seconds = Math.round((Date.now() - job.startedAt) / 1000); job.note = null; saveJob(job); labRunning--; labPump(); }); } }
function labEnqueue(job, override) { job.status = 'processing'; job.note = `waiting (${labQueue.length} ahead)`; jobs.set(job.id, job); saveJob(job); labQueue.push({ job, override }); labPump(); }
// ----- Lab: test every prompt a theme already has, one reference face per combination, across the ticked models -----
app.post('/api/admin/lab/theme-test', adminAuth, async (req, res) => {
  try { const theme = readTheme(slugify(req.body.theme || '')); if (!theme) return res.status(400).json({ error: 'pick a theme' }); const st = getSettings();
    const models = (Array.isArray(req.body.models) && req.body.models.length ? req.body.models : (st.testModels || [st.model])).filter(Boolean).slice(0, 6); const refs = req.body.refs || {};
    const variants = VARIANTS.filter(v => theme.prompts[v] && theme.prompts[v].trim() && refs[v]); if (!variants.length) return res.status(400).json({ error: 'no combination has both a saved prompt and a reference face' });
    const batch = 'lab-' + Date.now().toString(36); const runs = [];
    for (const v of variants) { const photo = await refBuffer(refs[v]); if (!photo) continue; for (const model of models) runs.push({ v, model, photo }); }
    const results = runs.map(({ v, model, photo }) => { const id = 'lab-' + crypto.randomBytes(4).toString('hex');
      const job = { id, number: 0, status: 'processing', theme: theme.slug, themeName: theme.name, variant: v, createdAt: Date.now(), attempts: 1, test: true, lab: true, batch, photoHash: refs[v], labPrompt: theme.prompts[v], labModel: model };
      fs.mkdirSync(path.join(JOBS, id), { recursive: true }); fs.writeFileSync(path.join(JOBS, id, 'photo.jpg'), photo); persist(path.join(JOBS, id, 'photo.jpg'));
      const override = { model, moderation: 'low' }; if (req.body.quality) override.quality = String(req.body.quality); labEnqueue(job, override); return labJob(job); });
    res.json({ ok: true, batch, results, async: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/lab-clear', adminAuth, (req, res) => { // wipe lab results: all, one theme, or everything except results in use
  const scope = String(req.body.scope || 'all'); const theme = req.body.theme ? slugify(req.body.theme) : null; let n = 0;
  const ts = thumbSources();
  for (const j of [...jobs.values()]) { if (!j.lab) continue; if (scope === 'theme' && j.theme !== theme) continue; if (req.body.keepApplied && j.applied) continue; if (ts[j.id]) continue; // thumbnails are only removed one at a time
    jobs.delete(j.id); fs.rmSync(path.join(JOBS, j.id), { recursive: true, force: true }); unpersist(path.join(JOBS, j.id)); n++; }
  res.json({ ok: true, n });
});
app.delete('/api/admin/lab/:id', adminAuth, (req, res) => { const j = jobs.get(req.params.id); if (j && j.lab) { const slug = thumbSources()[j.id]; if (slug) { const t = readTheme(slug); if (t) { fs.rmSync(path.join(THEMES, slug, 'thumb.png'), { force: true }); unpersistFile(path.join(THEMES, slug, 'thumb.png')); t.thumbFrom = ''; writeTheme(slug, t); } } // deleting the thumbnail result removes the tile picture too
    jobs.delete(j.id); fs.rmSync(path.join(JOBS, j.id), { recursive: true, force: true }); unpersist(path.join(JOBS, j.id)); } res.json({ ok: true }); });
app.post('/api/admin/jobs/:id', opAuth, (req, res) => { // actions: retry, front, skip, requeue (draw again)
  const j = jobs.get(req.params.id); if (!j) return res.status(404).end();
  const a = req.body.action; if (req.user && ['paid', 'requeue', 'skip', 'archive', 'delete'].includes(a)) j.lastBy = req.user.name;
  if (a === 'retry') { j.status = 'pending'; j.attempts = 0; j.error = null; }
  else if (a === 'front') { j.priority = -Date.now(); }
  else if (a === 'skip') { j.status = 'skipped'; }
  else if (a === 'archive') { j.status = 'archived'; } // out of every list, photo + art kept
  else if (a === 'paid') { const z = paySizes().find(z => z.id === req.body.size) || (j.pay && j.pay.size && { id: j.pay.size, label: j.pay.label, price: j.pay.amount }); if (j.status === 'expired') j.status = 'unpaid'; if (!j.pay) j.pay = {}; if (z) Object.assign(j.pay, { size: z.id, label: z.label, amount: z.price }); if (j.pay.sessionId) { stripe('POST', `/v1/checkout/sessions/${j.pay.sessionId}/expire`).catch(() => {}); j.pay.sessionId = null; j.pay.url = null; } markPaid(j, String(req.body.method || 'cash').slice(0, 12), z ? z.price : 0); return res.json(publicJob(j)); }
  else if (a === 'assign') { j.bot = Math.max(0, Math.min(8, +req.body.bot || 0)) || null; } // move a sketch to another robot (0 = whichever is free)
  else if (a === 'requeue') { j.status = (j.readyAt || fs.existsSync(path.join(JOBS, j.id, 'art.png'))) ? 'ready' : 'pending'; if (j.status === 'ready') assignBot(j); }
  else if (a === 'delete') { jobs.delete(j.id); fs.rmSync(path.join(JOBS, j.id), { recursive: true, force: true }); unpersist(path.join(JOBS, j.id)); return res.json({ ok: true }); }
  saveJob(j); pump(); res.json(publicJob(j));
});
app.post('/api/admin/jobs-bulk', opAuth, (req, res) => { // { ids: [...], action: 'archive' | 'delete' | 'requeue' | 'skip' }
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [], a = req.body.action; let n = 0;
  for (const id of ids) { const j = jobs.get(id); if (!j) continue; n++;
    if (a === 'delete') { jobs.delete(j.id); fs.rmSync(path.join(JOBS, j.id), { recursive: true, force: true }); unpersist(path.join(JOBS, j.id)); continue; }
    if (a === 'archive') j.status = 'archived'; else if (a === 'skip') j.status = 'skipped'; else if (a === 'requeue') j.status = (j.readyAt || fs.existsSync(path.join(JOBS, j.id, 'art.png'))) ? 'ready' : 'pending';
    saveJob(j); }
  pump(); res.json({ ok: true, n });
});
app.get('/api/admin/drawlog.csv', opAuth, (req, res) => { // every drawing that finished, oldest first, in the admin's local time
  const tz = String(req.query.tz || 'America/Los_Angeles'); let fmtD, fmtT;
  try { fmtD = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }); fmtT = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true }); }
  catch (_) { fmtD = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: '2-digit', day: '2-digit' }); fmtT = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true }); }
  const mmss = sec => sec ? `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}` : '';
  const rows = []; let total = 0, measured = 0, timed = 0, revenue = 0, paidN = 0;
  for (const j of sortedJobs().filter(j => j.doneAt && !j.test)) {
    // draw_seconds is the arm's measured time (logged since the draw-time feature); older rows fall back to claim→done, which includes conversion/preview
    const sec = j.drawSeconds || (j.drawStartedAt && j.doneAt > j.drawStartedAt ? Math.round((j.doneAt - j.drawStartedAt) / 10) / 100 : 0); const src = j.drawSeconds ? 'measured' : sec ? 'claim-to-done' : '';
    if (sec) { total += sec; timed++; if (j.drawSeconds) measured++; } const pay = j.pay || {}; if (pay.paidAt && pay.amount) { revenue += pay.amount; paidN++; }
    rows.push([j.number, j.themeName, VARIANT_LABELS[j.variant] || j.variant, fmtD.format(j.createdAt), fmtT.format(j.createdAt), fmtD.format(j.doneAt), fmtT.format(j.doneAt), j.widthMm ? (j.widthMm / 25.4).toFixed(2) : '', j.strokes || '', sec || '', mmss(sec), src, j.preset || '', j.status, pay.label || pay.size || '', pay.amount ? (pay.amount / 100).toFixed(2) : '', pay.method || '', j.operator || '']);
  }
  const esc = v => /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
  const lines = ['number,theme,variant,photo_date,photo_time,drawn_date,drawn_time,width_in,strokes,draw_seconds,draw_mm_ss,time_source,speed_preset,status,size,paid_usd,paid_by,operator', ...rows.map(r => r.map(esc).join(','))];
  lines.push('', `TOTAL,${rows.length} drawings,,,,,,,,${Math.round(total * 10) / 10},${mmss(total)},${timed} timed (${measured} measured),,,,${(revenue / 100).toFixed(2)},${paidN} paid,`);
  if (timed) lines.push(`AVERAGE,,,,,,,,,${Math.round(total / timed * 10) / 10},${mmss(total / timed)},per timed drawing,,`);
  res.setHeader('content-type', 'text/csv'); res.setHeader('content-disposition', 'attachment; filename="sketchy-draw-log.csv"');
  res.send(lines.join('\n'));
});
// ----- theme import / export (zip: one folder per theme, one prompt file per combination) -----
const VARIANT_FILES = { '1-male': ['single-male', '1-male', 'male', 'man'], '1-female': ['single-female', '1-female', 'female', 'woman'], '2-male-male': ['two-males', '2-male-male', 'male-male', 'two-men'], '2-female-female': ['two-females', '2-female-female', 'female-female', 'two-women'], '2-male-female': ['male-left-female-right', '2-male-female', 'male-female'], '2-female-male': ['female-left-male-right', '2-female-male', 'female-male'], 'pet-male': ['male-pet', 'pet-male', 'man-pet'], 'pet-female': ['female-pet', 'pet-female', 'woman-pet'] };
const normName = n => String(n).toLowerCase().replace(/\.(md|markdown|txt)$/, '').replace(/[\s_\-]+/g, '');
const variantFor = name => { const k = normName(name); for (const v of VARIANTS) if (VARIANT_FILES[v].some(a => a.replace(/-/g, '') === k)) return v; return null; };
function parseZipThemes(buf, targetName) { // -> [{ name, prompts:{v:text}, thumb:Buffer|null, settings:{...}, unknown:[names] }]; targetName: every file goes to that one theme, folder names ignored
  const AdmZip = require('adm-zip'); const zip = new AdmZip(buf); const themes = new Map();
  for (const e of zip.getEntries()) { if (e.isDirectory) continue; const parts = e.entryName.split('/').filter(p => p && p !== '.'); if (parts.some(p => p.startsWith('__MACOSX') || p.startsWith('.'))) continue;
    const file = parts[parts.length - 1]; let theme = targetName || (parts.length >= 2 ? parts[parts.length - 2] : null); if (!theme) continue; // files must sit in a theme folder (unless importing into a chosen theme)
    const t = themes.get(theme) || { name: theme, prompts: {}, thumb: null, settings: {}, unknown: [] }; themes.set(theme, t);
    const low = file.toLowerCase();
    if (/^thumbnail\.(png|jpe?g|webp)$/.test(low)) { t.thumb = e.getData(); continue; }
    if (low === 'theme.txt' || low === 'theme.md') { for (const line of e.getData().toString('utf8').split(/\r?\n/)) { const m = line.match(/^\s*([\w.\-]+)\s*:\s*(.+?)\s*$/); if (m) t.settings[m[1].toLowerCase()] = m[2]; } continue; }
    if (!/\.(md|markdown|txt)$/i.test(low)) { t.unknown.push(file); continue; }
    const v = variantFor(file); if (!v) { t.unknown.push(file); continue; } t.prompts[v] = e.getData().toString('utf8').replace(/^\uFEFF/, '').trim(); }
  return [...themes.values()];
}
app.post('/api/admin/themes/import', adminAuth, upload.single('zip'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'no zip' }); const preview = req.query.preview === '1'; const replaceAll = req.query.mode === 'replace'; // replace: boxes with no file in the zip are cleared
    const target = req.query.target ? readTheme(slugify(req.query.target)) : null; if (req.query.target && !target) return res.status(400).json({ error: 'target theme not found' });
    const found = parseZipThemes(req.file.buffer, target ? target.name : null); if (!found.length) return res.status(400).json({ error: target ? 'No prompt files found in the zip.' : 'No theme folders found. Each theme must be a folder containing its prompt files.' });
    const report = [];
    for (const t of found) {
      let existing = listThemes().find(x => x.name.toLowerCase() === t.name.toLowerCase()); const slug = existing ? existing.slug : slugify(t.name);
      const replaced = existing ? Object.keys(t.prompts).filter(v => existing.prompts[v] && existing.prompts[v].trim() && existing.prompts[v].trim() !== t.prompts[v]) : [];
      const cleared = existing && replaceAll ? VARIANTS.filter(v => !(v in t.prompts) && existing.prompts[v] && existing.prompts[v].trim()) : [];
      report.push({ name: t.name, slug, isNew: !existing, prompts: Object.keys(t.prompts).length, replaced: replaced.map(v => VARIANT_LABELS[v]), cleared: cleared.map(v => VARIANT_LABELS[v]), empty: Object.keys(t.prompts).filter(v => !t.prompts[v]).map(v => VARIANT_LABELS[v]), thumb: !!t.thumb, settings: Object.keys(t.settings), unknown: t.unknown });
      if (preview) continue;
      const base = existing || { name: t.name, enabled: false, order: listThemes().length + 1, prompts: {}, variantModels: {} };
      const st = t.settings; const yes = v => /^(yes|true|on|1)$/i.test(v); 
      const startPrompts = replaceAll ? {} : base.prompts; const th = Object.assign({}, base, { name: existing ? existing.name : t.name, prompts: Object.assign({}, startPrompts, t.prompts), variantModels: Object.assign({}, base.variantModels || {}) });
      if (replaceAll) for (const v of VARIANTS) if (!(v in th.prompts)) th.prompts[v] = '';
      if (st.rating != null) th.rating = /adult|18/.test(st.rating) ? 'adult' : 'family'; if (st.proportions != null) th.proportions = /big/.test(st.proportions) ? 'bighead' : 'normal';
      if (st.model != null) th.model = st.model; if (st.quality != null) th.quality = st.quality; if (st.moderation != null) th.moderation = st.moderation; if (st.order != null && isFinite(+st.order)) th.order = +st.order; if (st.enabled != null) th.enabled = yes(st.enabled);
      for (const k of Object.keys(st)) { const m = k.match(/^(.+)\.(model|quality)$/); if (!m) continue; const v = variantFor(m[1]); if (!v) continue; th.variantModels[v] = Object.assign({}, th.variantModels[v] || {}, { [m[2]]: st[k] }); }
      writeTheme(slug, th);
      if (t.thumb) { try { await sharp(t.thumb).rotate().resize(700, 700, { fit: 'inside', withoutEnlargement: true }).png().toFile(path.join(THEMES, slug, 'thumb.png')); persist(path.join(THEMES, slug, 'thumb.png')); } catch (e) { report[report.length - 1].thumbError = e.message; } }
    }
    res.json({ ok: true, preview, themes: report });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/admin/themes/export', adminAuth, async (req, res) => { // ?slug=rockstar or all
  const AdmZip = require('adm-zip'); const zip = new AdmZip(); const which = req.query.slug ? listThemes().filter(t => t.slug === req.query.slug) : listThemes();
  for (const t of which) { const dir = t.name.replace(/[\\/:*?"<>|]/g, '-');
    for (const v of VARIANTS) if (t.prompts[v] && t.prompts[v].trim()) zip.addFile(`${dir}/${VARIANT_FILES[v][0]}.md`, Buffer.from(t.prompts[v], 'utf8'));
    const lines = [`enabled: ${t.enabled ? 'yes' : 'no'}`, `order: ${t.order || 0}`, `rating: ${t.rating === 'adult' ? 'adult' : 'family'}`, `proportions: ${t.proportions === 'bighead' ? 'bighead' : 'normal'}`]; if (t.model) lines.push('model: ' + t.model); if (t.quality) lines.push('quality: ' + t.quality); if (t.moderation) lines.push('moderation: ' + t.moderation);
    for (const v of VARIANTS) { const vm = t.variantModels[v] || {}; if (vm.model) lines.push(`${VARIANT_FILES[v][0]}.model: ${vm.model}`); if (vm.quality) lines.push(`${VARIANT_FILES[v][0]}.quality: ${vm.quality}`); }
    zip.addFile(`${dir}/theme.txt`, Buffer.from(lines.join('\n') + '\n', 'utf8'));
    const th = path.join(THEMES, t.slug, 'thumb.png'); if (await ensureLocal(th)) zip.addFile(`${dir}/thumbnail.png`, fs.readFileSync(th)); }
  res.setHeader('content-type', 'application/zip'); res.setHeader('content-disposition', `attachment; filename="${req.query.slug ? which[0] ? which[0].name.replace(/[^\w.-]+/g, '-') : 'theme' : 'sketchy-themes'}.zip"`); res.send(zip.toBuffer());
});
app.get('/api/admin/jobs-zip', opAuth, async (req, res) => { // full-size line art (+ photos) for the chosen jobs, as a zip
  const AdmZip = require('adm-zip'); const zip = new AdmZip(); const ids = String(req.query.ids || '').split(',').filter(Boolean); const withPhotos = req.query.photos === '1'; let n = 0;
  for (const id of ids) { const j = jobs.get(id); if (!j) continue; const base = `sketch-${String(j.number).padStart(3, '0')}-${slugify(j.themeName || 'theme')}`;
    const art = path.join(JOBS, j.id, 'art.png'); if (await ensureLocal(art)) { zip.addFile(`${base}.png`, fs.readFileSync(art)); n++; }
    if (withPhotos) { const ph = path.join(JOBS, j.id, 'photo.jpg'); if (await ensureLocal(ph)) zip.addFile(`${base}-photo.jpg`, fs.readFileSync(ph)); } }
  if (!n) return res.status(404).json({ error: 'none of those have line art yet' });
  res.setHeader('content-type', 'application/zip'); res.setHeader('content-disposition', `attachment; filename="sketchy-line-art-${new Date().toISOString().slice(0, 10)}.zip"`); res.send(zip.toBuffer());
});
app.get('/api/jobs/:id/photo', adminAuth, async (req, res) => { const f = path.join(JOBS, req.params.id, 'photo.jpg'); if (await ensureLocal(f)) res.sendFile(f); else res.status(404).end(); });

restoreFromBucket().catch(e => console.log('storage restore failed:', e.message)).then(() => { loadState(); app.listen(PORT, '0.0.0.0', () => console.log(`Sketchy Robotics server on :${PORT}  data=${DATA}  key=${OPENAI_KEY ? 'set' : 'MISSING'}`)); });
