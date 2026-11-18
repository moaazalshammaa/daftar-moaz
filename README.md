# Ejad Mini Market

تطبيق ويب للمحل: امسح الباركود أو اكتب اسم المنتج فيظهر السعر.
الرابط: https://ejad-mini-market.coffee-menu.workers.dev

- **📷 مسح**: افتح الكاميرا وقرّب الباركود ← الاسم والسعر فوراً مع صوت. منتج غير مسجّل؟ يظهر زر لإضافته.
- **🔍 بحث**: بالاسم أو جزء منه (يتجاهل التشكيل والفرق بين أ/إ/آ وة/ه وى/ي).
- **📦 المنتجات**: إضافة/تعديل/حذف، استيراد وتصدير Excel (CSV) و JSON. تحتاج دخول المدير.
- **ماسح يدوي (USB/Bluetooth)**: يشتغل مباشرة بخانة «اكتب الباركود».

## البنية

| الجزء | التقنية |
|---|---|
| الخادم | Cloudflare Worker — `src/worker.js` |
| قاعدة البيانات | Cloudflare D1 (SQLite) — `ejad-mini-market-db`، الجداول في `migrations/` |
| الدخول | كلمة سر المدير سرّ (Secret) على Cloudflare، تُفحص على الخادم. الجلسة كوكي HttpOnly موقّعة (أسبوع). ٥ محاولات خاطئة ← حظر ربع ساعة |
| الواجهة | `public/` — PWA بدون إطار عمل، خط ثمانية |
| قارئ الباركود | `public/scanner.js` + `public/scanner-worker.js` (zxing-cpp WebAssembly بخيط منفصل) |

**الكل يقدر يقرأ** (مسح وبحث). **المدير فقط** يضيف ويعدّل ويحذف.
الجهاز يحتفظ بنسخة من المنتجات حتى يكون البحث فوري ويشتغل لو النت ضعيف، ويتحدّث تلقائياً من الخادم.

### لماذا الماسح خفيف على الموبايل
- يقرأ فقط المنطقة داخل الإطار ويصغّرها (مش الصورة الكاملة).
- التحليل بخيط منفصل (Web Worker) فالواجهة ما بتعلق.
- إطار واحد بالمرة، حد أقصى ~٧ مرات بالثانية، ويتوقف بعد كل قراءة وعند الخروج من الشاشة.
- على Android يستخدم قارئ الجهاز المدمج (`BarcodeDetector`)، وعلى iPhone محرك WebAssembly.
- تركيز تلقائي مستمر للكاميرا.

## الإعداد (مرة وحدة)

```bash
npm install
npx wrangler secret put ADMIN_PASSWORD     # كلمة سر المدير
```

## التطوير المحلي

```bash
echo "ADMIN_PASSWORD=<كلمة-سر-للتجربة>" > .dev.vars
npm run db:migrate:local
npm run dev            # http://localhost:8787
```

## التشغيل على حساب Cloudflare جديد (نقل المشروع)

بتحتاج: حساب Cloudflare فيه الدومين، و Node.js 20 أو أحدث.

```bash
git clone https://github.com/moaazalshammaa/daftar-moaz.git ejad-mini-market
cd ejad-mini-market
npm install
npx wrangler login
```

**١. قاعدة البيانات**

```bash
npx wrangler d1 create ejad-mini-market-db
```

انسخ `database_id` اللي بيطلع وحطه بـ `wrangler.jsonc` مكان القديم.

- **مع نقل البيانات القديمة:** ملف `ejad-data.sql` بيوصلك بشكل خاص (مو على GitHub، لأن فيه حسابات الموظفين وديونهم). فيه الجداول والبيانات وسجل الـ migrations، فـ **لا تشغّل** `db:migrate:remote` قبله:

  ```bash
  npx wrangler d1 execute ejad-mini-market-db --remote --file=ejad-data.sql
  ```

- **تشغيل جديد بدون بيانات:** `npm run db:migrate:remote`

**٢. كلمة سر المدير**

```bash
npx wrangler secret put ADMIN_PASSWORD
```

**٣. النشر والدومين**

ضيف الدومين بـ `wrangler.jsonc` (مثال `mine.ejad.net`، والدومين لازم يكون على نفس حساب Cloudflare):

```jsonc
"routes": [{ "pattern": "mine.ejad.net", "custom_domain": true }],
```

```bash
npm run deploy
```

Cloudflare بيعمل سجل الـ DNS وشهادة https لحاله. ما في رابط أو دومين مكتوب بالكود، فبيشتغل على أي دومين.

**٤. فحص**

- افتح الرابط ← البحث بيطلّع المنتجات.
- `/admin` ← ادخل بكلمة سر المدير ← بيبينوا الموظفين والديون.
- الموظفين بيدخلوا بنفس أسمائهم وكلمات سرهم القديمة، بس لازم يفتحوا الرابط الجديد ويسجلوا دخول من جديد (ويرجعوا يضيفوه عالشاشة الرئيسية).

## النشر

```bash
npm run db:migrate:remote   # فقط إذا أضفت ملف migration جديد
npm run deploy
```

عند تعديل ملفات الواجهة غيّر رقم `CACHE` في `public/sw.js` حتى يأخذ الموبايل النسخة الجديدة.
لتغيير كلمة السر: أعد تشغيل `wrangler secret put ADMIN_PASSWORD` — كل الجلسات القديمة تنلغي تلقائياً.

## الخط (ثمانية)

خط **ثمانية Sans** في `public/fonts`. الترخيص يسمح بتضمينه في مواقع وتطبيقات الويب كجزء من المنتج، ولا يسمح بإتاحة ملفات الخط للتحميل بشكل مستقل.
