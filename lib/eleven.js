// ElevenLabs: anlatım (zaman damgalı TTS) ve müzik
const settings = require('./settings');
const API = 'https://api.elevenlabs.io';

async function key() {
  const k = await settings.get('eleven_key');
  if (!k) throw new Error('ElevenLabs anahtarı girilmemiş (Yönetim paneli → ElevenLabs)');
  return k;
}
async function fail(r, what) {
  const t = await r.text().catch(() => '');
  let m = t; try { const j = JSON.parse(t); m = (j.detail && (j.detail.message || j.detail.status || JSON.stringify(j.detail))) || t; } catch { }
  if (r.status === 401) m = 'anahtar geçersiz ya da bu işlem için izni yok. ' + m;
  if (/quota|credits/i.test(m)) m = 'ElevenLabs kredisi yetersiz. ' + m;
  return new Error(`ElevenLabs ${what}: ${String(m).slice(0, 300)}`);
}

// → { buf, seconds }
async function speak(text, voiceOverride) {
  const s = await settings.all();
  const voice = voiceOverride || s.eleven_voice;
  if (!voice) throw new Error('Anlatıcı sesi seçilmemiş (Yönetim paneli → ElevenLabs → Sesleri getir)');
  const r = await fetch(`${API}/v1/text-to-speech/${voice}/with-timestamps?output_format=mp3_44100_128`, {
    method: 'POST', headers: { 'xi-api-key': await key(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model_id: s.eleven_tts_model, language_code: s.eleven_tts_model === 'eleven_multilingual_v2' ? undefined : 'tr', voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.2 } }),
  });
  if (!r.ok) throw await fail(r, 'seslendirme');
  const j = await r.json();
  const ends = (j.alignment && j.alignment.character_end_times_seconds) || [];
  return { buf: Buffer.from(j.audio_base64, 'base64'), seconds: ends.length ? ends[ends.length - 1] : text.length / 14 };
}

async function music(prompt, seconds) {
  const s = await settings.all();
  const r = await fetch(`${API}/v1/music?output_format=mp3_44100_128`, {
    method: 'POST', headers: { 'xi-api-key': await key(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, music_length_ms: Math.max(10000, Math.min(300000, Math.round(seconds * 1000))), force_instrumental: true, model_id: s.eleven_music_model }),
  });
  if (!r.ok) throw await fail(r, 'müzik');
  return Buffer.from(await r.arrayBuffer());
}

async function voices() {
  const r = await fetch(`${API}/v1/voices`, { headers: { 'xi-api-key': await key() } });
  if (!r.ok) throw await fail(r, 'ses listesi');
  const j = await r.json();
  return (j.voices || []).map(v => ({ id: v.voice_id, name: v.name, labels: v.labels || {}, preview: v.preview_url }));
}
async function test() { const v = await voices(); return `Bağlandı, ${v.length} ses bulundu`; }

module.exports = { speak, music, voices, test };
