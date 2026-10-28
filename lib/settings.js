// Yönetim panelinden girilen ayarlar (sv_settings tablosu). Ortam değişkeni varsa varsayılan olarak kullanılır.
const { db } = require('./db');

// secret: true → panelde maskeli gösterilir
const FIELDS = [
  // Bağlantılar
  { k: 'github_token', label: 'GitHub erişim jetonu', secret: true, group: 'github', env: 'GITHUB_TOKEN',
    help: 'github.com/settings/personal-access-tokens/new → Repository access: sinema-studyo → Permissions: Actions = Read and write. Claude adımları ve kurgu bu jetonla başlatılır.' },
  { k: 'github_repo', label: 'GitHub deposu', group: 'github', def: 'onurcoskun616/sinema-studyo', env: 'GITHUB_REPO' },
  { k: 'claude_model', label: 'Claude modeli', group: 'claude', def: 'claude-opus-5-5', options: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
    help: 'Senaryo, karakter ve sahne planını yazar. Aboneliğinizle GitHub Actions üzerinde çalışır (depo sırrı: CLAUDE_CODE_OAUTH_TOKEN).' },
  { k: 'fal_key', label: 'fal.ai API anahtarı', secret: true, group: 'fal', env: 'FAL_KEY', help: 'fal.ai/dashboard/keys — görsel ve video üretimi.' },
  { k: 'image_model', label: 'Görsel modeli (metinden)', group: 'fal', def: 'fal-ai/nano-banana-2',
    options: ['fal-ai/nano-banana-2', 'fal-ai/nano-banana', 'fal-ai/flux/dev', 'fal-ai/flux-pro/v1.1-ultra'] },
  { k: 'edit_model', label: 'Görsel modeli (karakter referanslı)', group: 'fal', def: 'fal-ai/nano-banana-2/edit',
    options: ['fal-ai/nano-banana-2/edit', 'fal-ai/nano-banana/edit', 'fal-ai/nano-banana-pro/edit'],
    help: 'Sahnelerde karakterlerin her seferinde aynı görünmesi için referans görselleri kullanır.' },
  { k: 'image_resolution', label: 'Görsel çözünürlüğü', group: 'fal', def: '1K', options: ['1K', '2K'] },
  { k: 'video_model', label: 'Video modeli', group: 'fal', def: 'fal-ai/kling-video/v2.5-turbo/pro/image-to-video',
    options: [
      'fal-ai/kling-video/v2.5-turbo/pro/image-to-video',
      'fal-ai/kling-video/v3/pro/image-to-video',
      'fal-ai/veo3.1/fast/image-to-video',
      'fal-ai/veo3.1/image-to-video',
      'fal-ai/minimax/hailuo-2.3/standard/image-to-video',
      'fal-ai/bytedance/seedance/v1.5/pro/image-to-video',
    ],
    help: 'Kling 2.5 Turbo ≈ 0,07 $/sn (ekonomik) · Kling 3 ≈ 0,11 $/sn · Veo 3.1 Fast ≈ 0,10 $/sn · Veo 3.1 ≈ 0,20 $/sn. Fiyatlar fal.ai tarafından değişebilir.' },
  { k: 'video_price', label: 'Video saniye fiyatı ($, tahmin için)', group: 'fal', def: '0.07' },
  { k: 'parallel', label: 'Aynı anda üretilecek sahne', group: 'fal', def: '3', options: ['1', '2', '3', '4', '6'] },
  { k: 'eleven_key', label: 'ElevenLabs API anahtarı', secret: true, group: 'eleven', env: 'ELEVENLABS_API_KEY', help: 'elevenlabs.io → Profile → API Keys. Seslendirme ve müzik.' },
  { k: 'eleven_voice', label: 'Anlatıcı sesi', group: 'eleven', env: 'ELEVENLABS_VOICE_ID', help: 'Anahtarı kaydedip "Sesleri getir" ile listeden seçin.' },
  { k: 'eleven_tts_model', label: 'Seslendirme modeli', group: 'eleven', def: 'eleven_multilingual_v2', options: ['eleven_multilingual_v2', 'eleven_v3', 'eleven_turbo_v2_5'] },
  { k: 'eleven_music_model', label: 'Müzik modeli', group: 'eleven', def: 'music_v1', options: ['music_v1', 'music_v2', 'music_v2_5'] },
  { k: 'title_font', label: 'Başlık yazı tipi', group: 'kurgu', def: 'serif', options: ['serif', 'sans', 'mono'] },
  { k: 'crossfade', label: 'Sahne geçişi (saniye)', group: 'kurgu', def: '0.4', options: ['0', '0.25', '0.4', '0.6', '1'] },
  { k: 'music_volume', label: 'Müzik seviyesi', group: 'kurgu', def: '0.8', options: ['0.3', '0.5', '0.8', '1'], help: 'Anlatım varsa müzik konuşma sırasında otomatik kısılır.' },
];
const BY = Object.fromEntries(FIELDS.map(f => [f.k, f]));

let cache = null, cacheAt = 0;
async function all() {
  if (cache && Date.now() - cacheAt < 10000) return cache;
  const rows = await db.select('sv_settings', 'select=k,v');
  const m = Object.fromEntries(rows.map(r => [r.k, r.v]));
  const out = {};
  for (const f of FIELDS) out[f.k] = (m[f.k] != null && m[f.k] !== '') ? m[f.k] : (f.env && process.env[f.env]) || f.def || '';
  cache = out; cacheAt = Date.now();
  return out;
}
async function get(k) { return (await all())[k]; }
async function save(patch) {
  const rows = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!BY[k]) continue;
    if (BY[k].secret && (v === '' || v == null || /^•+/.test(v))) continue; // maskeli değer geri geldi → değiştirme
    rows.push({ k, v: String(v).trim(), updated_at: new Date().toISOString() });
  }
  if (rows.length) await db.upsert('sv_settings', rows);
  cache = null;
}
async function forPanel() {
  const s = await all();
  return FIELDS.map(f => ({ ...f, env: undefined, value: f.secret ? (s[f.k] ? '••••••••' + s[f.k].slice(-4) : '') : s[f.k], set: !!s[f.k] }));
}
module.exports = { all, get, save, forPanel, FIELDS };
