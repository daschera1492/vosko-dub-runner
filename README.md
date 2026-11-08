# vosko-dub-runner

رانر گیت‌هاب برای دوبلهٔ خودکار ویدیو با [vosko.ai](https://vosko.ai)؛ بدون مرورگر، فقط API.

ورودی: **یک لینک مستقیم ویدیو/صدا** + **زبان مبدأ** + **زبان مقصد**.
خروجی پیش‌فرض: **یک فایل MP3 واحد** که از چسباندن تکه‌های دوبله ساخته می‌شود و به‌صورت asset در **Releases همین مخزن** منتشر می‌شود.
اگر `output_mode=video` انتخاب شود، همان صدا روی ویدیوی اصلی سوار می‌شود.

## چطور کار می‌کند

1. **زبان‌ها زنده خوانده می‌شوند** — `scripts/languages.mjs` صفحهٔ ساخت پروژهٔ vosko.ai را می‌خواند،
   دو آرایهٔ زبان را از باندل Nuxt بیرون می‌کشد (لیست مبدأ شامل `Auto Detect` و لیست مقصد)
   و `data/languages.json` و منوی کشویی `.github/workflows/dub.yml` را می‌سازد.
   گردش‌کار `Sync languages` روزانه این کار را می‌کند؛ هنگام هر دوبله هم لیست دوباره گرفته و
   انتخاب کاربر با آن تطبیق داده می‌شود.
2. **تقسیم هوشمند** — اگر فایل بلندتر از سقف ۵۸ ثانیه باشد، Whisper کلمه‌به‌کلمه زمان‌بندی می‌دهد،
   برش‌ها وسط سکوت (فاصلهٔ ≥ ۳۰۰ms) و هرگز وسط جمله زده می‌شود، و هیچ تکه‌ای از ۵۸ ثانیه
   (سقف سایت: ۶۰ ثانیه) بیشتر نمی‌شود. اگر Whisper نبود، `silencedetect` جای آن را می‌گیرد.
   دنبالهٔ کمتر از ۳ ثانیه به تکهٔ قبل چسبانده می‌شود.
3. **یک اکانت تازه برای هر تکه** — رانر از پلاگین `vosko-dub-bridge` روی وردپرس ایمیل یکتا
   (نام انسانی دوقسمتی، مثل `sara-ahmadi@masezahedi.com`) می‌گیرد، کد ورود را از همان پلاگین
   می‌خواند، لاگین می‌کند و هدیهٔ ۲۰۰ کردیتی ثبت‌نام را می‌گیرد. هیچ اکانتی بین تکه‌ها بازاستفاده نمی‌شود.
4. **دوبله و دانلود** — تکه آپلود می‌شود، ترجمه/دوبله شروع می‌شود، تا آماده‌شدن پول می‌شود و
   MP3 دوبله از `editable_chunk_info.chunks[].translated_audio_url` دانلود می‌شود.
5. **مونتاژ و انتشار** — هر تکهٔ دوبله به طول دقیق بازهٔ خودش «پد» می‌شود تا صدا با تایم‌لاین ویدیو هم‌تراز بماند،
   سپس تکه‌های MP3 با ffmpeg به هم می‌چسبند و فایل نهایی با `gh release create`
   در Releases همین مخزن منتشر می‌شود. پیش‌فرض **فقط صدا** است؛ اگر `output_mode=video` باشد،
   صدا روی ویدیوی اصلی (بدون رمزگذاری مجدد تصویر) سوار می‌شود.
6. **قابل ادامه** — `state.json` در پوشهٔ کار، تکه‌های تمام‌شده را نگه می‌دارد؛ اجرای دوباره
   آن‌ها را دوباره دوبله نمی‌کند. برای هر تکه حداکثر دو اکانت امتحان می‌شود.

## اجرا (GitHub Actions)

`Actions → Vosko dub → Run workflow`:

| ورودی | توضیح |
|---|---|
| `video_url` | لینک مستقیم فایل (mp4/mkv/mov/wav/mp3/…) |
| `source_lang` | از لیست زندهٔ سایت (پیش‌فرض `Auto Detect`) |
| `target_lang` | از لیست زندهٔ سایت (مثلاً `Persian (Farsi)`) |
| `chunk_seconds` | طول نرم هر تکه: ۳۰ / ۴۰ / ۵۲ (سقف واقعی ۵۸) |
| `whisper_model` | `tiny` / `base` / `small` برای زمان‌بندی کلمات |
| `output_mode` | `audio` = یک MP3 واحد (پیش‌فرض) / `video` = صدا روی ویدیوی اصلی |
| `parallel_chunks` | چند تکه هم‌زمان دوبله شود: `1` امن‌ترین (پیش‌فرض) / `2`–`3` سریع‌تر |
| `queue_group` | اختیاری؛ اجراهایی که مقدار یکسان دارند پشت هم می‌مانند. خالی = اجراها **هم‌زمان** اجرا می‌شوند |
| `publish_release` | انتشار خروجی به‌صورت Release (پیش‌فرض بله) |

### Secretها

| نام | مقدار |
|---|---|
| `VDB_BASE_URL` | `https://aiwithmase.ir/wp-json/vosko-dub/v1` |
| `VDB_KEY` | کلید سرویس رانر از صفحهٔ «Vosko Dub» وردپرس (`vdb_…`) |
| `GH_PAT` | فقط برای گردش‌کار `Sync languages` لازم است: توکن با scope `workflow` (چون `GITHUB_TOKEN` اجازهٔ تغییر فایل‌های `.github/workflows` را ندارد) |

`GH_TOKEN` برای انتشار Release از `${{ github.token }}` استفاده می‌کند و `permissions: contents: write` دارد.

### اجرای هم‌زمان

هر اجرا اکانت‌ها، پوشهٔ کار و تگ Release مستقل دارد، پس به‌طور پیش‌فرض چند اجرا **موازی** اجرا می‌شوند
(گروه concurrency هر اجرا یکتاست). برای محدودکردن عمدی، به چند اجرا یک `queue_group` یکسان بدهید.
توصیه: به‌خاطر محدودیت نرخ سایت و ورودهای هم‌زمان، هم‌زمان بیشتر از ۲–۳ اجرا نزنید.

## اجرای محلی

```bash
export VDB_KEY=vdb_…
export VDB_BASE_URL=https://aiwithmase.ir/wp-json/vosko-dub/v1
export INPUT_URL=https://example.com/clip.mp4
export SOURCE_LANG="Auto Detect"
export TARGET_LANG="Persian (Farsi)"
export PUBLISH_RELEASE=false
node scripts/run.mjs
```

پیش‌نیاز: Node 22، `ffmpeg`/`ffprobe`، و برای فایل‌های بلندتر از ۵۸ ثانیه `openai-whisper` در پایتون.

## ساختار

```
scripts/run.mjs            ارکستراتور
scripts/languages.mjs      استخراج زندهٔ لیست زبان‌ها + رندر ورک‌فلو
scripts/lib/bridge.mjs     کلاینت REST پلاگین (run/identity/OTP)
scripts/lib/vosko.mjs      کلاینت API وُسکو (لاگین، کردیت، آپلود OSS، ترجمه، دانلود)
scripts/lib/media.mjs      برش/چسباندن/ریمکس با ffmpeg
scripts/lib/whisper_words.py  زمان‌بندی کلمه‌ها با Whisper
ci/dub.template.yml        قالب ورک‌فلوی دوبله (منوها با __…__ جایگزین می‌شوند)
```

## پلاگین وردپرس

این رانر به پلاگین [`vosko-dub-bridge`](../vosko-dub-bridge) وابسته است. پلاگین باید فعال باشد،
کلید `dhk_…` با مجوز `worker` برای DuckMail Hub داشته باشد و یک کلید سرویس `vdb_…` برای رانر صادر کرده باشد.
سلامت: `GET https://aiwithmase.ir/wp-json/vosko-dub/v1/health` → `{"ok":true,...}`.
