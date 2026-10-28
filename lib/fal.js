// fal.ai kuyruk API'si: görsel (metinden / referanslı) ve görselden video.
const settings = require('./settings');
const sleep = ms => new Promise(ok => setTimeout(ok, ms));

async function key() {
  const k = await settings.get('fal_key');
  if (!k) throw new Error('fal.ai anahtarı girilmemiş (Yönetim paneli → fal.ai)');
  return k;
}
function explain(status, body) {
  const d = body && (body.detail || body.error || body.message);
  let msg = typeof d === 'string' ? d : d ? JSON.stringify(d).slice(0, 400) : 'HTTP ' + status;
  if (status === 401 || status === 403) return 'fal.ai anahtarı geçersiz. ' + msg;
  if (status === 402 || /balance|credit|exhausted|locked/i.test(msg)) return 'fal.ai bakiyesi yetersiz; fal.ai hesabına kredi yükleyin. ' + msg;
  if (status === 404) return 'fal.ai modeli bulunamadı (model adını panelden kontrol edin). ' + msg;
  if (/content|safety|policy|nsfw|flagged/i.test(msg)) return 'İçerik filtresine takıldı; sahne tarifini değiştirip tekrar deneyin. ' + msg;
  return 'fal.ai: ' + msg;
}

// Kuyruğa gönder → { status_url, response_url, model }
async function submit(model, input) {
  const r = await fetch(`https://queue.fal.run/${model}`, { method: 'POST', headers: { Authorization: 'Key ' + await key(), 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(explain(r.status, j)); e.status = r.status; throw e; }
  return { status_url: j.status_url, response_url: j.response_url, request_id: j.request_id, model };
}
// Sonucu bekle (sunucu yeniden başlasa bile handle ile kaldığı yerden sürer)
async function wait(handle, { timeoutMs = 20 * 60 * 1000, onTick } = {}) {
  const t0 = Date.now(); const k = await key();
  while (Date.now() - t0 < timeoutMs) {
    const r = await fetch(handle.status_url, { headers: { Authorization: 'Key ' + k } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok && r.status !== 202) throw new Error(explain(r.status, j));
    if (j.status === 'COMPLETED') {
      const rr = await fetch(handle.response_url, { headers: { Authorization: 'Key ' + k } });
      const out = await rr.json().catch(() => ({}));
      if (!rr.ok) throw new Error(explain(rr.status, out));
      if (out.detail && !out.images && !out.video) throw new Error(explain(422, out));
      return out;
    }
    if (onTick) onTick(j);
    await sleep(j.status === 'IN_QUEUE' ? 5000 : 4000);
  }
  throw new Error('fal.ai yanıtı zaman aşımına uğradı');
}
async function run(model, input, opts) { return wait(await submit(model, input), opts); }

const NEG = 'no text, no captions, no letters, no watermark, no logo, no subtitles';
const FLUX_SIZE = { '16:9': 'landscape_16_9', '9:16': 'portrait_16_9', '1:1': 'square_hd', '4:5': 'portrait_4_3' };

function imageInput(model, prompt, aspect, res) {
  if (/flux/.test(model)) return { prompt: `${prompt}. ${NEG}`, image_size: FLUX_SIZE[aspect] || 'square_hd', num_images: 1, output_format: 'jpeg', enable_safety_checker: true, ...(/ultra/.test(model) ? { aspect_ratio: aspect, raw: false } : {}) };
  return { prompt: `${prompt}. ${NEG}`, aspect_ratio: aspect, num_images: 1, output_format: 'jpeg', resolution: res || '1K' };
}
function pickImage(out) {
  const img = out.images && out.images[0];
  if (!img || !img.url) throw new Error('fal.ai görsel döndürmedi' + (out.description ? ': ' + String(out.description).slice(0, 200) : ''));
  return img.url;
}

// Metinden görsel. Model bulunamazsa FLUX dev ile yeniden dener.
async function textToImage(prompt, aspect) {
  const s = await settings.all();
  try { return { url: pickImage(await run(s.image_model, imageInput(s.image_model, prompt, aspect, s.image_resolution))), usd: 0.08 }; }
  catch (e) {
    if (!/bulunamadı|422|Unprocessable/i.test(e.message) || s.image_model === 'fal-ai/flux/dev') throw e;
    return { url: pickImage(await run('fal-ai/flux/dev', imageInput('fal-ai/flux/dev', prompt, aspect))), usd: 0.03, note: 'yedek model: flux/dev' };
  }
}
// Referans görsellerle (karakter tutarlılığı) görsel
async function imageWithRefs(prompt, refUrls, aspect) {
  if (!refUrls.length) return textToImage(prompt, aspect);
  const s = await settings.all();
  const p = `${prompt}. Use the reference image(s) only for the identity, face, hair and costume of the character(s); create a completely new cinematic photograph with new composition, pose and setting as described. Photorealistic film still.`;
  const out = await run(s.edit_model, { ...imageInput(s.edit_model, p, aspect, s.image_resolution), image_urls: refUrls.slice(0, 6) });
  return { url: pickImage(out), usd: 0.08 };
}

// Görselden video girdisi — modele göre parametre uyarlaması
function videoInput(model, prompt, imageUrl, seconds, aspect) {
  const p = `${prompt}. Cinematic, realistic motion, stable faces, no text.`;
  if (/veo/.test(model)) {
    const d = seconds <= 4 ? '4s' : seconds <= 6 ? '6s' : '8s';
    return { prompt: p, image_url: imageUrl, duration: d, aspect_ratio: aspect === '9:16' ? '9:16' : aspect === '16:9' ? '16:9' : 'auto', resolution: '720p', generate_audio: false };
  }
  if (/kling-video\/v3|kling\/v4/.test(model)) return { prompt: p, image_url: imageUrl, duration: String(Math.max(3, Math.min(15, Math.round(seconds)))), generate_audio: false, negative_prompt: 'blur, distort, low quality, text, watermark' };
  if (/kling/.test(model)) return { prompt: p, image_url: imageUrl, duration: seconds > 7 ? '10' : '5', negative_prompt: 'blur, distort, low quality, text, watermark', cfg_scale: 0.5 };
  if (/hailuo|minimax/.test(model)) return { prompt: p, image_url: imageUrl, duration: seconds > 8 ? '10' : '6', prompt_optimizer: false };
  if (/seedance/.test(model)) return { prompt: p, image_url: imageUrl, duration: String(Math.max(4, Math.min(12, Math.round(seconds)))), resolution: '720p', generate_audio: false };
  return { prompt: p, image_url: imageUrl, duration: String(Math.round(seconds)) };
}
// Modelin gerçekte üreteceği süre (maliyet ve kurgu için)
function videoSeconds(model, seconds) {
  if (/veo/.test(model)) return seconds <= 4 ? 4 : seconds <= 6 ? 6 : 8;
  if (/kling-video\/v3|kling\/v4/.test(model)) return Math.max(3, Math.min(15, Math.round(seconds)));
  if (/kling/.test(model)) return seconds > 7 ? 10 : 5;
  if (/hailuo|minimax/.test(model)) return seconds > 8 ? 10 : 6;
  if (/seedance/.test(model)) return Math.max(4, Math.min(12, Math.round(seconds)));
  return Math.round(seconds);
}
async function submitVideo(prompt, imageUrl, seconds, aspect) {
  const s = await settings.all();
  return submit(s.video_model, videoInput(s.video_model, prompt, imageUrl, seconds, aspect));
}
function pickVideo(out) {
  const v = out.video || (out.videos && out.videos[0]);
  if (!v || !v.url) throw new Error('fal.ai video döndürmedi');
  return v.url;
}

async function test() {
  const k = await key();
  // Var olmayan bir isteğin durumunu sor: geçerli anahtar 404/400, geçersiz anahtar 401/403 döner
  const r = await fetch('https://queue.fal.run/fal-ai/flux/requests/00000000-0000-0000-0000-000000000000/status', { headers: { Authorization: 'Key ' + k } });
  if (r.status === 401 || r.status === 403) throw new Error('Anahtar geçersiz (HTTP ' + r.status + ')');
  return 'Anahtar kabul edildi';
}

module.exports = { textToImage, imageWithRefs, submitVideo, wait, pickVideo, videoSeconds, test };
