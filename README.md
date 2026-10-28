# Sinema Stüdyosu

Konu yazılır; platform gerisini sırayla yapar ve her aşamada onayınızı ister (isterseniz tam otomatik):

| # | Aşama | Kim yapar |
| --- | --- | --- |
| 1 | Senaryo ve karakterler | Claude (aboneliğinizle, GitHub Actions) |
| 2 | Karakter referans görselleri | fal.ai (Nano Banana 2) |
| 3 | Sahne planı (çekim listesi) | Claude |
| 4 | Sahne ilk kareleri (karakter referanslı) | fal.ai (Nano Banana 2 Edit) |
| 5 | Anlatım ve müzik | ElevenLabs (TTS + Music) |
| 6 | Video klipler | fal.ai (Kling / Veo / Hailuo / Seedance — panelden seçilir) |
| 7 | Kurgu: geçişler, ekran yazıları, ses karışımı | GitHub Actions + ffmpeg |
| 8 | MP4 teslim | Supabase Storage |

Her öğe (karakter, kare, ses, klip) tek tek düzeltilip yeniden üretilebilir; önceki aşamaya dönüldüğünde yalnızca değişen kısımlar yeniden üretilir.

## Bileşenler

- `server.js` — bağımlılıksız Node 20+ sunucu (API, aşama yöneticisi, arayüz).
- `lib/` — Supabase, ayarlar, fal.ai, ElevenLabs, Claude istemleri.
- `public/` — arayüz ve **Yönetim paneli** (API anahtarları, model seçimleri, bağlantı testleri).
- `worker/generate.mjs` + `.github/workflows/generate.yml` — Claude adımları (`CLAUDE_CODE_OAUTH_TOKEN` depo sırrı).
- `worker/assemble.mjs` + `.github/workflows/assemble.yml` — ffmpeg kurgusu.
- Supabase: `egitim-video` projesi içinde ayrı tablolar (`sv_settings`, `sv_projects`, `sv_tasks`, `sv_jobs`, `sv_usage`) ve `sinema` depolama kovası. Tablolar RLS ile korunur; her istek `x-sv-secret` başlığı taşır.

## Render ortam değişkenleri

| Değişken | Açıklama |
| --- | --- |
| `ADMIN_PASSWORD` | Giriş şifresi |
| `SUPABASE_URL` | `https://vymygihoivdfliunmbdo.supabase.co` |
| `SUPABASE_ANON_KEY` | Supabase anon (publishable) anahtarı |
| `SV_SECRET` | Veritabanı erişim sırrı (sv_private.config ile aynı) |
| `SV_PREFIX` | Depolama klasörü öneki |

Diğer tüm anahtarlar (GitHub, fal.ai, ElevenLabs) uygulama içindeki Yönetim panelinden girilir.

## GitHub sırrı

`CLAUDE_CODE_OAUTH_TOKEN` — bilgisayarınızda `claude setup-token` ile üretilir; Settings → Secrets and variables → Actions'a eklenir.

## Yerel kurgu denemesi

```
LOCAL_MANIFEST=manifest.json OUT=cikti.mp4 node worker/assemble.mjs
```
