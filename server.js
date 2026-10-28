// Sinema Stüdyosu — konu yazılır, gerisini platform yapar:
// senaryo + karakterler (Claude) → karakter görselleri (fal) → sahne planı (Claude) → sahne kareleri (fal)
// → anlatım + müzik (ElevenLabs) → video klipler (fal) → kurgu (GitHub Actions + ffmpeg) → MP4
// Bağımlılıksız Node 20+ sunucu.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, storage, q } = require('./lib/db');
const settings = require('./lib/settings');
const fal = require('./lib/fal');
const eleven = require('./lib/eleven');
const claude = require('./lib/claude');

const PORT = process.env.PORT || 3000;
const publicBase = () => (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const sleep = ms => new Promise(ok => setTimeout(ok, ms));
const now = () => new Date().toISOString();

const STAGES = ['script', 'chars', 'board', 'frames', 'audio', 'videos', 'edit', 'done'];
const STAGE_NAMES = { script: 'Senaryo ve karakterler', chars: 'Karakter görselleri', board: 'Sahne planı', frames: 'Sahne kareleri', audio: 'Anlatım ve müzik', videos: 'Video klipler', edit: 'Kurgu', done: 'Tamamlandı' };

/* ---------- proje güncelleme kilidi ---------- */
const locks = new Map();
async function mutate(id, fn) {
  const prev = locks.get(id) || Promise.resolve();
  let release; const mine = new Promise(r => release = r);
  locks.set(id, prev.then(() => mine));
  await prev;
  try {
    const p = await db.one('sv_projects', `id=eq.${q(id)}`);
    if (!p) throw new Error('Proje bulunamadı');
    const before = JSON.stringify(p);
    const r = await fn(p);
    if (JSON.stringify(p) !== before) {
      const patch = {}; for (const k of ['title', 'opts', 'stage', 'status', 'progress', 'error', 'auto', 'script', 'characters', 'scenes', 'audio', 'final']) patch[k] = p[k];
      patch.updated_at = now();
      await db.update('sv_projects', `id=eq.${q(id)}`, patch);
    }
    return r === undefined ? p : r;
  } finally { release(); if (locks.get(id) === mine) locks.delete(id); }
}
const setState = (id, patch) => mutate(id, p => { Object.assign(p, patch); });
async function usage(project_id, provider, what, usd, detail) { try { await db.insert('sv_usage', { project_id, provider, what, usd: +usd || 0, detail: detail || null }); } catch (e) { console.error('usage', e.message); } }
async function pool(items, n, fn) { let i = 0; await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } })); }

async function saveRemote(url, p, type) {
  let buf, last;
  for (let i = 0; i < 4 && !buf; i++) {
    try { const r = await fetch(url); if (!r.ok) throw new Error('Dosya indirilemedi: ' + r.status); buf = Buffer.from(await r.arrayBuffer()); }
    catch (e) { last = e; await sleep(1500 * (i + 1)); }
  }
  if (!buf) throw last;
  return storage.upload(p, buf, type);
}
const stamp = () => Date.now().toString(36);

/* ---------- GitHub Actions ---------- */
async function gh(pathname, opts = {}) {
  const s = await settings.all();
  if (!s.github_token) throw new Error('GitHub jetonu girilmemiş (Yönetim paneli → GitHub)');
  const r = await fetch(`https://api.github.com/repos/${s.github_repo}${pathname}`, { ...opts, headers: { Authorization: 'Bearer ' + s.github_token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'sinema-studyo', ...(opts.headers || {}) } });
  return r;
}
async function dispatch(workflow, inputs) {
  const r = await gh(`/actions/workflows/${workflow}/dispatches`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ref: 'main', inputs: { ...inputs, api_base: publicBase() } }) });
  if (r.status !== 204) {
    const t = (await r.text()).slice(0, 200);
    if (r.status === 401) throw new Error('GitHub jetonu geçersiz ya da süresi dolmuş');
    if (r.status === 403 || r.status === 404) throw new Error(`GitHub iş akışı başlatılamadı (${r.status}). Jetonun bu depoda "Actions: Read and write" izni olduğundan emin olun. ${t}`);
    throw new Error('GitHub iş akışı başlatılamadı: ' + r.status + ' ' + t);
  }
}
// Claude istemlerini aboneliğinizle çalışan generate.yml'e gönderir ve sonucu bekler
async function viaActions(projectId, kind, items, onProgress) {
  const model = await settings.get('claude_model');
  const token = crypto.randomBytes(24).toString('hex');
  const task = await db.insert('sv_tasks', { project_id: projectId, kind, items, model, token });
  await dispatch('generate.yml', { task_id: task.id, token });
  const deadline = Date.now() + 40 * 60 * 1000;
  let lastStatus = '';
  while (Date.now() < deadline) {
    await sleep(4000);
    const t = await db.one('sv_tasks', `id=eq.${task.id}&select=status,results,error,progress`);
    if (t.status !== lastStatus && onProgress) { lastStatus = t.status; onProgress(t.status); }
    if (t.status === 'done') { await db.update('sv_tasks', `id=eq.${task.id}`, { consumed: true }); return t.results; }
    if (t.status === 'failed') throw new Error('Claude (GitHub Actions): ' + (t.error || 'bilinmeyen hata'));
    if (t.status === 'queued' && Date.now() - deadline + 40 * 60 * 1000 > 6 * 60 * 1000) throw new Error('GitHub Actions işi 6 dakikada başlamadı. Depoda Actions açık mı, generate.yml var mı kontrol edin.');
  }
  throw new Error('Claude yanıtı 40 dakikada gelmedi');
}
async function askClaude(projectId, kind, system, user, onProgress) {
  const [res] = await viaActions(projectId, kind, [{ system, user }], onProgress);
  if (!res || res.error) throw new Error('Claude: ' + ((res && res.error) || 'yanıt yok'));
  if (res.usage) usage(projectId, 'claude', kind, 0, res.usage);
  try { return claude.extractJson(res.text); } catch (e) { throw new Error('Claude yanıtı okunamadı: ' + e.message); }
}

/* ---------- aşamalar ---------- */
const running = new Set();
function start(id, stage, args) {
  const key = id + ':' + stage;
  if (running.has(key)) return;
  running.add(key);
  (async () => {
    try {
      await setState(id, { stage, status: 'working', error: null, progress: { text: 'Başlıyor…' } });
      await RUN[stage](id, args || {});
      const p = await mutate(id, p => { p.status = 'review'; p.progress = null; });
      if (p.auto && stage !== 'done' && !hasErrors(p, stage)) await advance(id);
    } catch (e) {
      console.error(`[${id}] ${stage}:`, e);
      await setState(id, { status: 'error', error: e.message, progress: null }).catch(() => {});
    } finally { running.delete(key); }
  })();
}
function hasErrors(p, stage) {
  const list = stage === 'chars' ? p.characters : ['frames', 'audio', 'videos'].includes(stage) ? p.scenes : null;
  if (stage === 'audio' && p.audio && p.audio.error) return true;
  return !!(list && list.some(x => x.error));
}
async function advance(id) {
  const p = await db.one('sv_projects', `id=eq.${q(id)}&select=stage`);
  const next = STAGES[STAGES.indexOf(p.stage) + 1];
  if (!next) return;
  if (next === 'done') return setState(id, { stage: 'done', status: 'review' });
  start(id, next);
}
const progress = (id, text, extra) => setState(id, { progress: { text, ...(extra || {}) } }).catch(() => {});

const RUN = {
  async script(id, { feedback }) {
    const p = await db.one('sv_projects', `id=eq.${q(id)}`);
    if (!feedback && p.script) return; // zaten yazılmış; yeniden yazmak için düzeltme isteği gerekir
    const prev = feedback && p.script ? { ...p.script, characters: p.characters } : null;
    const j = await askClaude(id, 'script', claude.SCRIPT_SYSTEM, claude.scriptUser(p, prev, feedback), st => progress(id, st === 'running' ? 'Claude senaryoyu yazıyor…' : 'Claude işi sıraya alındı (GitHub Actions)…'));
    if (!j.title || !Array.isArray(j.characters)) throw new Error('Claude eksik senaryo döndürdü; tekrar deneyin');
    const chars = j.characters.map((c, i) => ({ id: c.id || 'c' + (i + 1), name: c.name, role: c.role, about: c.about, look_en: c.look_en, ref: c.ref !== false }));
    delete j.characters;
    await mutate(id, p => {
      // Önceki karakter görsellerini aynı kimlik ve tarif korunduysa sakla
      const old = Object.fromEntries((p.characters || []).map(c => [c.id, c]));
      p.characters = chars.map(c => old[c.id] && old[c.id].look_en === c.look_en && old[c.id].image ? { ...c, image: old[c.id].image } : c);
      p.script = j; p.title = j.title;
    });
  },

  async chars(id, { only }) {
    const p = await db.one('sv_projects', `id=eq.${q(id)}`);
    const list = (p.characters || []).filter(c => c.ref && (only ? c.id === only : !c.image));
    const par = +(await settings.get('parallel')) || 3;
    let done = 0;
    await progress(id, `Karakter görselleri üretiliyor (0/${list.length})`);
    await pool(list, par, async c => {
      await mutate(id, p => { const x = p.characters.find(x => x.id === c.id); x.status = 'working'; x.error = null; });
      try {
        const look = (p.script && p.script.look) || '';
        const prompt = `Cinematic character reference photo, waist-up, facing camera at a slight three-quarter angle, ${c.look_en}. Period setting: ${(p.script && p.script.era) || ''}. Plain softly blurred period background, soft natural daylight, sharp focus on face, photorealistic, ${look}`;
        const img = await fal.textToImage(prompt, '1:1');
        const saved = await saveRemote(img.url, `${id}/chars/${c.id}-${stamp()}.jpg`, 'image/jpeg');
        usage(id, 'fal', 'karakter', img.usd);
        await mutate(id, p => { const x = p.characters.find(x => x.id === c.id); x.image = saved.url; x.status = 'done'; x.note = img.note || null; });
      } catch (e) {
        await mutate(id, p => { const x = p.characters.find(x => x.id === c.id); x.status = 'error'; x.error = e.message; });
      }
      await progress(id, `Karakter görselleri üretiliyor (${++done}/${list.length})`);
    });
  },

  async board(id, { feedback }) {
    const p = await db.one('sv_projects', `id=eq.${q(id)}`);
    if (!feedback && p.scenes && p.scenes.length) return; // plan var; yeniden yazmak için düzeltme isteği gerekir
    const prev = feedback && p.scenes ? p.scenes.map(s => ({ n: s.n, beat: s.beat, what: s.what, shot: s.shot, image_en: s.image_en, motion_en: s.motion_en, chars: s.chars, sec: s.sec, narration: s.narration, overlay: s.overlay })) : null;
    const j = await askClaude(id, 'board', claude.BOARD_SYSTEM, claude.boardUser(p, prev && { scenes: prev }, feedback), st => progress(id, st === 'running' ? 'Claude sahne planını hazırlıyor…' : 'Claude işi sıraya alındı (GitHub Actions)…'));
    if (!Array.isArray(j.scenes) || !j.scenes.length) throw new Error('Claude sahne listesi döndürmedi; tekrar deneyin');
    const ids = new Set((p.characters || []).map(c => c.id));
    await mutate(id, p => {
      p.scenes = j.scenes.map((s, i) => ({ n: i + 1, beat: s.beat || '', what: s.what || '', shot: s.shot || '', image_en: s.image_en || '', motion_en: s.motion_en || '', chars: (s.chars || []).filter(c => ids.has(c)), sec: +s.sec >= 8 ? 10 : 5, narration: p.opts.narration ? (s.narration || '') : '', overlay: s.overlay || '' }));
    });
  },

  async frames(id, { only }) {
    const p = await db.one('sv_projects', `id=eq.${q(id)}`);
    const list = p.scenes.filter(s => only ? s.n === only : !s.image);
    const charImg = Object.fromEntries((p.characters || []).filter(c => c.image).map(c => [c.id, c.image]));
    const par = +(await settings.get('parallel')) || 3;
    let done = 0;
    await progress(id, `Sahne kareleri üretiliyor (0/${list.length})`);
    await pool(list, par, async s => {
      await mutate(id, p => { const x = p.scenes.find(x => x.n === s.n); x.status = 'working'; x.error = null; });
      try {
        const refs = (s.chars || []).map(c => charImg[c]).filter(Boolean);
        const prompt = `${s.shot ? s.shot + '. ' : ''}${s.image_en} ${(p.script && p.script.look) || ''}`;
        const img = await fal.imageWithRefs(prompt, refs, p.opts.aspect || '1:1');
        const saved = await saveRemote(img.url, `${id}/frames/s${s.n}-${stamp()}.jpg`, 'image/jpeg');
        usage(id, 'fal', 'sahne karesi', img.usd);
        // Kare değişti → eski video geçersiz
        await mutate(id, p => { const x = p.scenes.find(x => x.n === s.n); x.image = saved.url; x.status = 'done'; x.video = null; x.vreq = null; });
      } catch (e) {
        await mutate(id, p => { const x = p.scenes.find(x => x.n === s.n); x.status = 'error'; x.error = e.message; });
      }
      await progress(id, `Sahne kareleri üretiliyor (${++done}/${list.length})`);
    });
  },

  async audio(id, { only, musicOnly }) {
    const p = await db.one('sv_projects', `id=eq.${q(id)}`);
    const s = await settings.all();
    if (p.opts.narration && !musicOnly) {
      const list = p.scenes.filter(x => x.narration && (only ? x.n === only : !x.voice));
      let done = 0;
      await progress(id, `Anlatım seslendiriliyor (0/${list.length})`);
      await pool(list, 3, async sc => {
        await mutate(id, p => { const x = p.scenes.find(x => x.n === sc.n); x.status = 'working'; x.error = null; });
        try {
          const v = await eleven.speak(sc.narration);
          const saved = await storage.upload(`${id}/voice/s${sc.n}-${stamp()}.mp3`, v.buf, 'audio/mpeg');
          usage(id, 'elevenlabs', 'anlatım', 0, { chars: sc.narration.length });
          await mutate(id, p => {
            const x = p.scenes.find(x => x.n === sc.n); x.voice = saved.url; x.voice_sec = +v.seconds.toFixed(2); x.status = 'done';
            // Ses klibe sığmıyorsa sahneyi 10 saniyeye uzat (video henüz üretilmediyse)
            if (x.voice_sec > x.sec - 0.4 && x.sec < 10) { x.sec = 10; x.video = null; x.vreq = null; }
          });
        } catch (e) { await mutate(id, p => { const x = p.scenes.find(x => x.n === sc.n); x.status = 'error'; x.error = e.message; }); }
        await progress(id, `Anlatım seslendiriliyor (${++done}/${list.length})`);
      });
    }
    if (only) return;
    const fresh = await db.one('sv_projects', `id=eq.${q(id)}`);
    if (fresh.audio && (fresh.audio.music || fresh.audio.skipped) && !musicOnly) return;
    if (fresh.audio && fresh.audio.uploaded && musicOnly !== 'force') return;
    const xf = +s.crossfade || 0;
    const total = fresh.scenes.reduce((a, x) => a + fal.videoSeconds(s.video_model, x.sec), 0) - xf * (fresh.scenes.length - 1);
    await progress(id, 'Müzik besteleniyor (ElevenLabs)…');
    try {
      const buf = await eleven.music(fresh.script.music || 'cinematic emotional orchestral score, instrumental', total + 2);
      const saved = await storage.upload(`${id}/music/music-${stamp()}.mp3`, buf, 'audio/mpeg');
      usage(id, 'elevenlabs', 'müzik', 0, { sec: total });
      await mutate(id, p => { p.audio = { music: saved.url, music_sec: Math.round(total + 2), prompt: p.script.music }; });
    } catch (e) { await mutate(id, p => { p.audio = { ...(p.audio || {}), error: e.message }; }); }
  },

  async videos(id, { only }) {
    const p = await db.one('sv_projects', `id=eq.${q(id)}`);
    const s = await settings.all();
    const list = p.scenes.filter(x => x.image && (only ? x.n === only : !x.video));
    const par = +s.parallel || 3;
    let done = 0;
    await progress(id, `Video klipler üretiliyor (0/${list.length}) — her biri birkaç dakika sürebilir`);
    await pool(list, par, async sc => {
      try {
        let handle = !only && sc.vreq;
        if (!handle) {
          handle = await fal.submitVideo(sc.motion_en || 'slow cinematic camera push-in, subtle natural movement', sc.image, sc.sec, p.opts.aspect || '1:1');
          await mutate(id, p => { const x = p.scenes.find(x => x.n === sc.n); x.vreq = handle; x.status = 'working'; x.error = null; });
        } else await mutate(id, p => { const x = p.scenes.find(x => x.n === sc.n); x.status = 'working'; x.error = null; });
        const out = await fal.wait(handle);
        const saved = await saveRemote(fal.pickVideo(out), `${id}/clips/s${sc.n}-${stamp()}.mp4`, 'video/mp4');
        const sec = fal.videoSeconds(handle.model || s.video_model, sc.sec);
        usage(id, 'fal', 'video', sec * (+s.video_price || 0.07), { model: handle.model, sec });
        await mutate(id, p => { const x = p.scenes.find(x => x.n === sc.n); x.video = saved.url; x.video_sec = sec; x.vreq = null; x.status = 'done'; });
      } catch (e) {
        await mutate(id, p => { const x = p.scenes.find(x => x.n === sc.n); x.status = 'error'; x.error = e.message; x.vreq = null; });
      }
      await progress(id, `Video klipler üretiliyor (${++done}/${list.length})`);
    });
  },

  async edit(id) {
    const p = await db.one('sv_projects', `id=eq.${q(id)}`);
    const s = await settings.all();
    const scenes = p.scenes.filter(x => x.video);
    if (!scenes.length) throw new Error('Kurgu için hiç video klip yok');
    const manifest = {
      title: p.title, aspect: p.opts.aspect || '1:1', fps: 24,
      crossfade: +s.crossfade || 0, font: s.title_font || 'serif', music_volume: +s.music_volume || 0.8,
      music: p.audio && p.audio.music || null,
      scenes: scenes.map(x => ({ n: x.n, video: x.video, video_sec: x.video_sec || x.sec, voice: x.voice || null, voice_sec: x.voice_sec || 0, overlay: x.overlay || '' })),
    };
    const token = crypto.randomBytes(24).toString('hex');
    const job = await db.insert('sv_jobs', { project_id: id, token, manifest });
    await dispatch('assemble.yml', { job_id: job.id, token });
    await progress(id, 'Kurgu GitHub Actions\'ta sıraya alındı…');
    const t0 = Date.now();
    while (Date.now() - t0 < 50 * 60 * 1000) {
      await sleep(5000);
      const j = await db.one('sv_jobs', `id=eq.${job.id}&select=status,error,log`);
      if (j.status === 'running') await progress(id, 'Video kurgulanıyor (ffmpeg)… ' + (j.log || ''));
      if (j.status === 'done') return;
      if (j.status === 'failed') throw new Error('Kurgu başarısız: ' + (j.error || ''));
      if (j.status === 'queued' && Date.now() - t0 > 8 * 60 * 1000) throw new Error('Kurgu işi 8 dakikada başlamadı. Depoda assemble.yml var mı, Actions açık mı kontrol edin.');
    }
    throw new Error('Kurgu 50 dakikada bitmedi');
  },
};
RUN.done = async () => {};

// Sunucu yeniden başlarsa yarım kalan işleri sürdür
async function resume() {
  try {
    const rows = await db.select('sv_projects', 'select=id,stage&status=eq.working');
    for (const r of rows) { console.log('Sürdürülüyor:', r.id, r.stage); start(r.id, r.stage); }
  } catch (e) { console.error('resume', e.message); }
}

/* ---------- HTTP yardımcıları ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
function send(res, code, body, type) {
  const isObj = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(code, { 'Content-Type': type || (isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8'), 'Cache-Control': 'no-store' });
  res.end(isObj ? JSON.stringify(body) : body);
}
function readBody(req, limit = 2e6) {
  return new Promise((ok, bad) => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > limit) { bad(new Error('İstek çok büyük')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => ok(Buffer.concat(chunks))); req.on('error', bad);
  });
}
async function readJson(req) { const b = await readBody(req); return b.length ? JSON.parse(b.toString('utf8')) : {}; }
const sessionToken = () => crypto.createHmac('sha256', process.env.SV_SECRET || 'x').update('admin:' + (process.env.ADMIN_PASSWORD || '')).digest('hex');
function authed(req) { const m = (req.headers.cookie || '').match(/(?:^|;\s*)sv=([a-f0-9]+)/); return !!m && m[1] === sessionToken(); }

const routes = [];
const on = (method, pattern, fn, open) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn, open });

/* ---------- giriş ---------- */
on('POST', '/api/login', async (req, res) => {
  const { password } = await readJson(req);
  if (!process.env.ADMIN_PASSWORD || password !== process.env.ADMIN_PASSWORD) { await sleep(800); return send(res, 401, { error: 'Şifre yanlış' }); }
  res.setHeader('Set-Cookie', `sv=${sessionToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 60}${publicBase().startsWith('https') ? '; Secure' : ''}`);
  send(res, 200, { ok: true });
}, true);
on('POST', '/api/logout', async (req, res) => { res.setHeader('Set-Cookie', 'sv=; Path=/; Max-Age=0'); send(res, 200, { ok: true }); }, true);
on('GET', '/api/me', async (req, res) => send(res, 200, { authed: authed(req) }), true);

/* ---------- yönetim paneli ---------- */
on('GET', '/api/settings', async (req, res) => send(res, 200, { fields: await settings.forPanel(), base: publicBase() }));
on('POST', '/api/settings', async (req, res) => { await settings.save(await readJson(req)); send(res, 200, { fields: await settings.forPanel() }); });
on('GET', '/api/voices', async (req, res) => send(res, 200, await eleven.voices()));
on('POST', '/api/test/:what', async (req, res, { what }) => {
  try {
    if (what === 'fal') return send(res, 200, { ok: true, msg: await fal.test() });
    if (what === 'eleven') return send(res, 200, { ok: true, msg: await eleven.test() });
    if (what === 'github') {
      const r = await gh('/actions/workflows');
      if (r.status === 401) throw new Error('Jeton geçersiz');
      if (r.status === 404) throw new Error('Depo bulunamadı ya da jetonun bu depoya erişimi yok');
      if (!r.ok) throw new Error('GitHub ' + r.status);
      const names = ((await r.json()).workflows || []).map(w => path.basename(w.path));
      const miss = ['generate.yml', 'assemble.yml'].filter(n => !names.includes(n));
      if (miss.length) throw new Error('Depoda eksik iş akışı: ' + miss.join(', '));
      return send(res, 200, { ok: true, msg: 'Depo ve iş akışları hazır' });
    }
    if (what === 'claude') {
      const token = crypto.randomBytes(24).toString('hex');
      const task = await db.insert('sv_tasks', { project_id: null, kind: 'test', items: [{ system: 'Kısa yanıt ver.', user: 'Sadece "Merhaba, hazırım." yaz.' }], model: await settings.get('claude_model'), token });
      await dispatch('generate.yml', { task_id: task.id, token });
      return send(res, 200, { ok: true, task: task.id, msg: 'Test işi başlatıldı, 1–3 dakika içinde sonuçlanır…' });
    }
    send(res, 404, { error: 'Bilinmeyen test' });
  } catch (e) { send(res, 200, { ok: false, msg: e.message }); }
});
on('GET', '/api/test/claude/:task', async (req, res, { task }) => {
  const t = await db.one('sv_tasks', `id=eq.${q(task)}&select=status,results,error`);
  if (!t) return send(res, 404, { error: 'yok' });
  if (t.status === 'done') { const r = t.results && t.results[0]; return send(res, 200, { done: true, ok: !(r && r.error), msg: r && (r.error || r.text) }); }
  if (t.status === 'failed') return send(res, 200, { done: true, ok: false, msg: t.error });
  send(res, 200, { done: false, msg: t.status === 'running' ? 'Claude çalışıyor…' : 'GitHub Actions işi bekleniyor…' });
});

/* ---------- projeler ---------- */
on('GET', '/api/projects', async (req, res) => send(res, 200, await db.select('sv_projects', 'select=id,title,topic,stage,status,created_at,updated_at,final,scenes&order=created_at.desc&limit=100').then(r => r.map(p => ({ ...p, thumb: (p.scenes || []).find(s => s.image)?.image || null, scenes: undefined })))));
on('POST', '/api/projects', async (req, res) => {
  const b = await readJson(req);
  if (!b.topic || b.topic.trim().length < 5) return send(res, 400, { error: 'Konu en az birkaç kelime olmalı' });
  const opts = { duration: Math.max(20, Math.min(300, +b.duration || 90)), aspect: ['1:1', '16:9', '9:16'].includes(b.aspect) ? b.aspect : '1:1', tone: (b.tone || '').slice(0, 200), narration: !!b.narration, notes: (b.notes || '').slice(0, 2000) };
  const p = await db.insert('sv_projects', { topic: b.topic.trim().slice(0, 2000), title: b.topic.trim().slice(0, 60), opts, auto: !!b.auto, stage: 'script', status: 'working' });
  start(p.id, 'script');
  send(res, 200, p);
});
on('GET', '/api/projects/:id', async (req, res, { id }) => {
  const p = await db.one('sv_projects', `id=eq.${q(id)}`);
  if (!p) return send(res, 404, { error: 'Proje bulunamadı' });
  const u = await db.select('sv_usage', `select=provider,usd&project_id=eq.${q(id)}`);
  const s = await settings.all();
  const cost = u.reduce((a, x) => a + (+x.usd || 0), 0);
  const videoEst = (p.scenes || []).filter(x => !x.video).reduce((a, x) => a + fal.videoSeconds(s.video_model, x.sec), 0) * (+s.video_price || 0.07);
  send(res, 200, { ...p, stages: STAGES.map(k => ({ k, name: STAGE_NAMES[k] })), cost: +cost.toFixed(2), video_estimate: +videoEst.toFixed(2), video_model: s.video_model, running: [...running].some(k => k.startsWith(id)) });
});
on('DELETE', '/api/projects/:id', async (req, res, { id }) => {
  await db.remove('sv_projects', `id=eq.${q(id)}`);
  send(res, 200, { ok: true });
});
// Kendi müziğini yükle
on('POST', '/api/projects/:id/music', async (req, res, { id }) => {
  const buf = await readBody(req, 30e6);
  const type = req.headers['content-type'] || 'audio/mpeg';
  const ext = /wav/.test(type) ? 'wav' : /ogg/.test(type) ? 'ogg' : /mp4|m4a|aac/.test(type) ? 'm4a' : 'mp3';
  const saved = await storage.upload(`${id}/music/yuklenen-${stamp()}.${ext}`, buf, type);
  await mutate(id, p => { p.audio = { music: saved.url, uploaded: true }; });
  send(res, 200, { ok: true });
});

on('POST', '/api/projects/:id/action', async (req, res, { id }) => {
  const b = await readJson(req);
  const p = await db.one('sv_projects', `id=eq.${q(id)}`);
  if (!p) return send(res, 404, { error: 'Proje bulunamadı' });
  const busy = p.status === 'working';
  const a = b.action;
  if (a === 'auto') { await setState(id, { auto: !!b.value }); return send(res, 200, { ok: true }); }
  if (busy && !['stop'].includes(a)) return send(res, 409, { error: 'Bu aşama hâlâ çalışıyor, bitmesini bekleyin' });
  switch (a) {
    case 'approve': await advance(id); break;
    case 'retry': start(id, p.stage); break; // eksik/hatalı öğeleri tamamlar
    case 'regenerate': // metin aşamalarını düzeltme isteğiyle yeniden yazdır
      if (!['script', 'board'].includes(p.stage)) return send(res, 400, { error: 'Bu aşamada kullanılamaz' });
      start(id, p.stage, { feedback: (b.feedback || 'Daha iyi bir versiyon yaz.').slice(0, 3000) }); break;
    case 'goto': { // önceki bir aşamaya dön (üretilmiş içerik korunur)
      if (!STAGES.includes(b.stage) || STAGES.indexOf(b.stage) > STAGES.indexOf(p.stage)) return send(res, 400, { error: 'Geçersiz aşama' });
      await setState(id, { stage: b.stage, status: 'review', error: null }); break;
    }
    case 'save': await mutate(id, x => { // kullanıcı düzenlemeleri
      if (b.script) x.script = { ...x.script, ...b.script };
      if (b.title) x.title = String(b.title).slice(0, 120);
      if (Array.isArray(b.characters)) x.characters = b.characters.map(c => { const o = (x.characters || []).find(y => y.id === c.id) || {}; return { ...o, ...c, image: c.look_en !== undefined && c.look_en !== o.look_en ? null : (c.image !== undefined ? c.image : o.image) }; });
      if (Array.isArray(b.scenes)) x.scenes = b.scenes.map((s, i) => { const o = (x.scenes || []).find(y => y.n === s.n) || {}; const m = { ...o, ...s, n: i + 1 }; if (s.image_en !== undefined && s.image_en !== o.image_en && o.image) { m.image = null; m.video = null; } if (s.motion_en !== undefined && s.motion_en !== o.motion_en && o.video) m.video = null; if (s.narration !== undefined && s.narration !== o.narration) { m.voice = null; m.voice_sec = 0; } return m; });
      if (b.opts) x.opts = { ...x.opts, ...b.opts };
    }); break;
    case 'redo': { // tek öğeyi yeniden üret
      const map = { char: 'chars', frame: 'frames', voice: 'audio', video: 'videos' };
      const stage = map[b.kind]; if (!stage) return send(res, 400, { error: 'Geçersiz tür' });
      if (b.kind === 'char') await mutate(id, x => { const c = x.characters.find(c => c.id === b.id); if (b.look_en) c.look_en = b.look_en; c.image = null; });
      if (b.kind === 'frame') await mutate(id, x => { const s = x.scenes.find(s => s.n === +b.id); if (b.prompt) s.image_en = b.prompt; s.image = null; s.video = null; });
      if (b.kind === 'video') await mutate(id, x => { const s = x.scenes.find(s => s.n === +b.id); if (b.prompt) s.motion_en = b.prompt; s.video = null; s.vreq = null; });
      if (b.kind === 'voice') await mutate(id, x => { const s = x.scenes.find(s => s.n === +b.id); if (b.prompt !== undefined) s.narration = b.prompt; s.voice = null; });
      start(id, stage, { only: b.kind === 'char' ? b.id : +b.id }); break;
    }
    case 'music': await mutate(id, x => { if (b.prompt) x.script = { ...x.script, music: b.prompt }; x.audio = null; }); start(id, 'audio', { musicOnly: 'force' }); break;
    case 'nomusic': await mutate(id, x => { x.audio = { music: null, skipped: true }; }); break;
    case 'cleanup': { // kurgu bittikten sonra ara dosyaları sil (depolama alanı için)
      const pre = process.env.SV_PREFIX + '/';
      const urls = [...(p.characters || []).map(c => c.image), ...(p.scenes || []).flatMap(s => [s.image, s.video, s.voice]), p.audio && p.audio.music].filter(Boolean);
      const paths = urls.map(u => decodeURIComponent(u.split('/object/public/sinema/')[1] || '')).filter(x => x.startsWith(pre));
      try { await storage.remove(paths); } catch (e) { return send(res, 200, { ok: false, error: e.message }); }
      await mutate(id, x => { x.scenes = x.scenes.map(s => ({ ...s, video: null, voice: null })); x.final = { ...x.final, cleaned: true }; });
      return send(res, 200, { ok: true, removed: paths.length });
    }
    default: return send(res, 400, { error: 'Bilinmeyen işlem' });
  }
  send(res, 200, { ok: true });
});

/* ---------- GitHub Actions işçileri için uçlar (tek kullanımlık jetonla) ---------- */
async function taskFor(id, token) { const t = await db.one('sv_tasks', `id=eq.${q(id)}`); return t && t.token === token ? t : null; }
on('GET', '/api/task/:id', async (req, res, { id }, url) => {
  const t = await taskFor(id, url.searchParams.get('token')); if (!t) return send(res, 403, { error: 'yetkisiz' });
  await db.update('sv_tasks', `id=eq.${q(id)}`, { status: 'running' });
  send(res, 200, { items: t.items, model: t.model });
}, true);
on('POST', '/api/task/:id/progress', async (req, res, { id }, url) => {
  const t = await taskFor(id, url.searchParams.get('token')); if (!t) return send(res, 403, { error: 'yetkisiz' });
  await db.update('sv_tasks', `id=eq.${q(id)}`, { progress: await readJson(req) }); send(res, 200, { ok: true });
}, true);
on('POST', '/api/task/:id/result', async (req, res, { id }, url) => {
  const t = await taskFor(id, url.searchParams.get('token')); if (!t) return send(res, 403, { error: 'yetkisiz' });
  const b = await readJson(req);
  await db.update('sv_tasks', `id=eq.${q(id)}`, b.error ? { status: 'failed', error: String(b.error).slice(0, 2000) } : { status: 'done', results: b.results });
  send(res, 200, { ok: true });
}, true);
async function jobFor(id, token) { const j = await db.one('sv_jobs', `id=eq.${q(id)}`); return j && j.token === token ? j : null; }
on('GET', '/api/job/:id', async (req, res, { id }, url) => {
  const j = await jobFor(id, url.searchParams.get('token')); if (!j) return send(res, 403, { error: 'yetkisiz' });
  await db.update('sv_jobs', `id=eq.${q(id)}`, { status: 'running' });
  send(res, 200, j.manifest);
}, true);
on('POST', '/api/job/:id/log', async (req, res, { id }, url) => {
  const j = await jobFor(id, url.searchParams.get('token')); if (!j) return send(res, 403, { error: 'yetkisiz' });
  const b = await readJson(req); await db.update('sv_jobs', `id=eq.${q(id)}`, { log: String(b.text || '').slice(0, 300) }); send(res, 200, { ok: true });
}, true);
on('POST', '/api/job/:id/upload', async (req, res, { id }, url) => {
  const j = await jobFor(id, url.searchParams.get('token')); if (!j) return send(res, 403, { error: 'yetkisiz' });
  const buf = await readBody(req, 60e6);
  const saved = await storage.upload(`${j.project_id}/final/video-${stamp()}.mp4`, buf, 'video/mp4');
  const sec = +url.searchParams.get('sec') || null;
  await mutate(j.project_id, p => { p.final = { url: saved.url, sec, mb: +(buf.length / 1048576).toFixed(1), at: now() }; p.stage = 'done'; });
  await db.update('sv_jobs', `id=eq.${q(id)}`, { status: 'done' });
  send(res, 200, { ok: true });
}, true);
on('POST', '/api/job/:id/result', async (req, res, { id }, url) => {
  const j = await jobFor(id, url.searchParams.get('token')); if (!j) return send(res, 403, { error: 'yetkisiz' });
  const b = await readJson(req);
  if (b.error) await db.update('sv_jobs', `id=eq.${q(id)}`, { status: 'failed', error: String(b.error).slice(0, 2000) });
  send(res, 200, { ok: true });
}, true);

/* ---------- sunucu ---------- */
const PUB = path.join(__dirname, 'public');
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = url.pathname.match(r.re); if (!m) continue;
        if (!r.open && !authed(req)) return send(res, 401, { error: 'Giriş gerekli' });
        return await r.fn(req, res, m.groups || {}, url);
      }
      return send(res, 404, { error: 'Bulunamadı' });
    }
    if (url.pathname === '/health') return send(res, 200, 'ok');
    let f = path.normalize(path.join(PUB, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(PUB, 'index.html');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(f).pipe(res);
  } catch (e) {
    console.error(req.method, url.pathname, e);
    if (!res.headersSent) send(res, 500, { error: e.message });
  }
}).listen(PORT, () => {
  console.log('Sinema Stüdyosu çalışıyor:', publicBase());
  const miss = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SV_SECRET', 'SV_PREFIX', 'ADMIN_PASSWORD'].filter(k => !process.env[k]);
  if (miss.length) console.error('Eksik ortam değişkenleri:', miss.join(', '));
  else setTimeout(resume, 2000);
});
