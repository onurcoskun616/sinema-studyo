// Supabase REST (PostgREST + Storage) — bağımlılıksız istemci.
// Tablolara erişim RLS ile korunur: her istek x-sv-secret başlığını taşır.
// Dosyalar herkese açık 'sinema' kovasında, tahmin edilemeyen SV_PREFIX klasörü altında durur.
const BASE = () => (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const KEY = () => process.env.SUPABASE_ANON_KEY;
const BUCKET = 'sinema';

function headers(extra = {}) {
  const h = { apikey: KEY(), 'x-sv-secret': process.env.SV_SECRET, ...extra };
  if ((KEY() || '').startsWith('eyJ')) h.Authorization = 'Bearer ' + KEY();
  return h;
}
async function req(path, opts = {}) {
  const r = await fetch(BASE() + path, { ...opts, headers: headers(opts.headers) });
  const text = await r.text();
  if (!r.ok) throw new Error(`Veritabanı ${r.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}
const q = encodeURIComponent;
const json = { 'Content-Type': 'application/json', Prefer: 'return=representation' };
const db = {
  select: (t, query = '') => req(`/rest/v1/${t}?${query}`),
  one: async (t, query) => (await req(`/rest/v1/${t}?${query}&limit=1`))[0] || null,
  insert: async (t, row) => (await req(`/rest/v1/${t}`, { method: 'POST', body: JSON.stringify(row), headers: json }))[0],
  upsert: (t, rows) => req(`/rest/v1/${t}`, { method: 'POST', body: JSON.stringify(rows), headers: { ...json, Prefer: 'resolution=merge-duplicates,return=representation' } }),
  update: async (t, query, patch) => (await req(`/rest/v1/${t}?${query}`, { method: 'PATCH', body: JSON.stringify(patch), headers: json }))[0],
  remove: (t, query) => req(`/rest/v1/${t}?${query}`, { method: 'DELETE' }),
};

const storage = {
  path: p => `${process.env.SV_PREFIX}/${p}`,
  publicUrl: full => `${BASE()}/storage/v1/object/public/${BUCKET}/${full.split('/').map(encodeURIComponent).join('/')}`,
  // p: prefiks olmadan yol. Dönüş: { path (tam), url (herkese açık) }
  async upload(p, buf, type) {
    const full = storage.path(p);
    const r = await fetch(`${BASE()}/storage/v1/object/${BUCKET}/${full}`, { method: 'POST', body: buf, headers: headers({ 'Content-Type': type }) });
    if (!r.ok) throw new Error(`Depolama ${r.status}: ${(await r.text()).slice(0, 300)}`);
    return { path: full, url: storage.publicUrl(full) };
  },
  async remove(paths) {
    if (!paths.length) return;
    const r = await fetch(`${BASE()}/storage/v1/object/${BUCKET}`, { method: 'DELETE', body: JSON.stringify({ prefixes: paths }), headers: headers({ 'Content-Type': 'application/json' }) });
    if (!r.ok) throw new Error(`Depolama silme ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r.json();
  },
};

module.exports = { db, storage, q };
