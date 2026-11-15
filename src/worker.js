// خادم Ejad Mini Market — Cloudflare Worker + قاعدة بيانات D1
// المسارات العامة: قراءة المنتجات والبحث بالباركود.
// المسارات المحمية (تحتاج دخول المدير): إضافة / تعديل / حذف / استيراد / الإعدادات.

import { barcodeVariants, cleanName, normBarcode, normText, parsePrice } from '../public/lib/text.js';

const SESSION_COOKIE = 'ejad_session';
const SESSION_TTL = 7 * 24 * 3600; // أسبوع
const MAX_FAILURES = 5;
const FAILURE_WINDOW = 15 * 60 * 1000;
const MAX_IMPORT = 5000;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
});

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    // صفحة إدارة المنتجات: نفس التطبيق، بيفتح على تبويب المنتجات
    if (url.pathname === '/product' || url.pathname === '/product/') return env.ASSETS.fetch(new Request(new URL('/', url), req));
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    try {
      return await route(req, env, url);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: 'خطأ في الخادم' }, 500);
    }
  },
};

async function route(req, env, url) {
  const p = url.pathname;
  const m = req.method;

  // حماية من الطلبات القادمة من مواقع أخرى (CSRF)
  if (m !== 'GET' && m !== 'HEAD') {
    const origin = req.headers.get('origin');
    if (origin && origin !== url.origin) throw new HttpError(403, 'طلب غير مسموح');
  }

  // ---- عام ----
  if (p === '/api/products' && m === 'GET') return listProducts(env);
  let match = p.match(/^\/api\/products\/barcode\/([^/]+)$/);
  if (match && m === 'GET') return byBarcode(env, decodeURIComponent(match[1]));
  if (p === '/api/me' && m === 'GET') return json({ admin: await isAdmin(req, env), configured: !!env.ADMIN_PASSWORD });
  if (p === '/api/login' && m === 'POST') return login(req, env);
  if (p === '/api/logout' && m === 'POST') return json({ ok: true }, 200, { 'set-cookie': sessionCookie('', 0) });

  // ---- حسابات الموظفين ----
  if (p === '/api/auth/register' && m === 'POST') return register(req, env);
  if (p === '/api/auth/login' && m === 'POST') return userLogin(req, env);
  if (p === '/api/auth/logout' && m === 'POST') return userLogout(req, env);
  if (p.startsWith('/api/account')) {
    const user = await currentUser(req, env);
    if (!user) throw new HttpError(401, 'سجّل دخولك لحسابك');
    if (p === '/api/account' && m === 'GET') return accountView(env, user);
    if (p === '/api/account/purchase' && m === 'POST') return purchase(req, env, user);
    if (p === '/api/account/payment' && m === 'POST') return payment(req, env, user);
    if (p === '/api/account/password' && m === 'PUT') return changePassword(req, env, user);
    match = p.match(/^\/api\/account\/entries\/([\w-]{1,64})$/);
    if (match && m === 'DELETE') return undoEntry(env, user, match[1]);
    throw new HttpError(404, 'غير موجود');
  }

  // ---- للمدير فقط ----
  if (!(await isAdmin(req, env))) throw new HttpError(401, 'يلزم تسجيل دخول المدير');
  if (p === '/api/admin/summary' && m === 'GET') return adminSummary(env, url);
  match = p.match(/^\/api\/admin\/days\/(\d{4}-\d{2}-\d{2})$/);
  if (match && m === 'GET') return adminDay(env, match[1]);
  match = p.match(/^\/api\/admin\/days\/(\d{4}-\d{2}-\d{2})\/count$/);
  if (match && m === 'PUT') return saveCount(req, env, match[1]);
  if (match && m === 'DELETE') return clearCount(env, match[1]);
  if (p === '/api/admin/users' && m === 'POST') {
    const id = await createUser(env, await readBody(req));
    return json({ ok: true, id }, 201);
  }
  match = p.match(/^\/api\/admin\/users\/([\w-]{1,64})$/);
  if (match && m === 'GET') return adminUser(env, match[1]);
  if (match && m === 'PATCH') return adminPatchUser(req, env, match[1]);
  match = p.match(/^\/api\/admin\/users\/([\w-]{1,64})\/entries$/);
  if (match && m === 'POST') return adminAddEntry(req, env, match[1]);
  match = p.match(/^\/api\/admin\/entries\/([\w-]{1,64})$/);
  if (match && m === 'DELETE') return adminVoid(env, match[1]);
  if (p === '/api/products' && m === 'POST') return createProduct(req, env);
  match = p.match(/^\/api\/products\/([\w-]{1,64})$/);
  if (match && m === 'PUT') return updateProduct(req, env, match[1]);
  if (match && m === 'DELETE') return deleteProduct(env, match[1]);
  if (p === '/api/import' && m === 'POST') return importProducts(req, env);
  if (p === '/api/settings' && m === 'PUT') return saveSettings(req, env);
  throw new HttpError(404, 'غير موجود');
}

// ================= المنتجات =================
const COLS = 'id, name, barcode, price, updated_at AS updatedAt';

async function getSettings(env) {
  const { results } = await env.DB.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(results.map((r) => [r.key, r.value]));
}

async function listProducts(env) {
  const [{ results }, settings] = await Promise.all([
    env.DB.prepare(`SELECT ${COLS} FROM products ORDER BY name`).all(),
    getSettings(env),
  ]);
  return json({ products: results, settings });
}

async function byBarcode(env, code) {
  const vs = barcodeVariants(code);
  if (!vs.length) throw new HttpError(400, 'باركود غير صالح');
  const row = await env.DB.prepare(`SELECT ${COLS} FROM products WHERE barcode IN (${vs.map(() => '?').join(',')})`)
    .bind(...vs).first();
  if (!row) throw new HttpError(404, 'منتج غير مسجّل');
  return json(row);
}

async function readBody(req) {
  try { return await req.json(); } catch { throw new HttpError(400, 'بيانات غير صالحة'); }
}

function validateProduct(b) {
  const name = cleanName(b?.name).slice(0, 200);
  const barcode = normBarcode(b?.barcode).slice(0, 64) || null;
  const price = parsePrice(b?.price);
  if (!name) throw new HttpError(400, 'اكتب اسم المنتج');
  if (Number.isNaN(price) || price > 1e12) throw new HttpError(400, 'السعر غير صحيح');
  if (barcode && !/^[\x21-\x7E]+$/.test(barcode)) throw new HttpError(400, 'الباركود غير صالح');
  return { name, barcode, price };
}

async function barcodeOwner(env, barcode, exceptId) {
  const vs = barcodeVariants(barcode);
  if (!vs.length) return null;
  return env.DB.prepare(`SELECT id, name FROM products WHERE barcode IN (${vs.map(() => '?').join(',')}) AND id != ?`)
    .bind(...vs, exceptId ?? '').first();
}

async function createProduct(req, env) {
  const p = validateProduct(await readBody(req));
  const dup = await barcodeOwner(env, p.barcode);
  if (dup) throw new HttpError(409, `الباركود مستخدم لـ «${dup.name}»`);
  const id = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare('INSERT INTO products (id, name, name_norm, barcode, price, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, p.name, normText(p.name), p.barcode, p.price, now, now).run();
  return json({ id, ...p, updatedAt: now }, 201);
}

async function updateProduct(req, env, id) {
  const p = validateProduct(await readBody(req));
  const dup = await barcodeOwner(env, p.barcode, id);
  if (dup) throw new HttpError(409, `الباركود مستخدم لـ «${dup.name}»`);
  const now = Date.now();
  const res = await env.DB.prepare('UPDATE products SET name = ?, name_norm = ?, barcode = ?, price = ?, updated_at = ? WHERE id = ?')
    .bind(p.name, normText(p.name), p.barcode, p.price, now, id).run();
  if (!res.meta.changes) throw new HttpError(404, 'المنتج غير موجود');
  return json({ id, ...p, updatedAt: now });
}

async function deleteProduct(env, id) {
  const res = await env.DB.prepare('DELETE FROM products WHERE id = ?').bind(id).run();
  if (!res.meta.changes) throw new HttpError(404, 'المنتج غير موجود');
  return json({ ok: true });
}

// استيراد جماعي: يحدّث المنتج إذا الباركود موجود، وإلا يضيفه
async function importProducts(req, env) {
  const body = await readBody(req);
  const items = Array.isArray(body?.items) ? body.items : [];
  if (items.length > MAX_IMPORT) throw new HttpError(400, `الحد الأقصى ${MAX_IMPORT} منتج بالمرة`);

  const { results } = await env.DB.prepare('SELECT id, barcode FROM products WHERE barcode IS NOT NULL').all();
  const byCode = new Map(results.map((r) => [r.barcode, r.id]));
  const now = Date.now();
  const stmts = [];
  let added = 0, updated = 0, skipped = 0;

  for (const raw of items) {
    let p;
    try { p = validateProduct(raw); } catch { skipped++; continue; }
    const existingId = p.barcode && barcodeVariants(p.barcode).map((v) => byCode.get(v)).find(Boolean);
    if (existingId) {
      stmts.push(env.DB.prepare('UPDATE products SET name = ?, name_norm = ?, price = ?, updated_at = ? WHERE id = ?')
        .bind(p.name, normText(p.name), p.price, now, existingId));
      updated++;
    } else {
      const id = crypto.randomUUID();
      stmts.push(env.DB.prepare('INSERT INTO products (id, name, name_norm, barcode, price, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(id, p.name, normText(p.name), p.barcode, p.price, now, now));
      if (p.barcode) byCode.set(p.barcode, id); // تكرار نفس الباركود داخل الملف يصير تحديث
      added++;
    }
  }
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
  return json({ added, updated, skipped });
}

async function saveSettings(req, env) {
  const b = await readBody(req);
  const out = {};
  if (b?.currency !== undefined) out.currency = String(b.currency ?? '').trim().slice(0, 20);
  if (b?.timezone !== undefined) {
    const tz = String(b.timezone).trim();
    try { new Intl.DateTimeFormat('en', { timeZone: tz }); } catch { throw new HttpError(400, 'المنطقة الزمنية غير صحيحة'); }
    out.timezone = tz;
  }
  const stmts = Object.entries(out).map(([k, v]) => env.DB
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(k, v));
  if (stmts.length) await env.DB.batch(stmts);
  return json(out);
}

// ================= الدخول =================
const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function safeEqual(a, b) {
  const [ha, hb] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

// مفتاح التوقيع مشتق من كلمة السر: تغيير كلمة السر يلغي كل الجلسات القديمة
async function sign(env, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode(`ejad-mini-market:${env.ADMIN_PASSWORD}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

function sessionCookie(value, maxAge) {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

async function isAdmin(req, env) {
  if (!env.ADMIN_PASSWORD) return false;
  const cookie = req.headers.get('cookie') ?? '';
  const token = cookie.split(/;\s*/).find((c) => c.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
  if (!token) return false;
  const [exp, sig] = token.split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return safeEqual(sig, await sign(env, `session:${exp}`));
}

async function login(req, env) {
  if (!env.ADMIN_PASSWORD) throw new HttpError(503, 'لم يتم تعيين كلمة سر المدير بعد');
  const ip = req.headers.get('cf-connecting-ip') ?? 'local';
  const now = Date.now();
  const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM login_failures WHERE ip = ? AND at > ?')
    .bind(ip, now - FAILURE_WINDOW).first();
  if (n >= MAX_FAILURES) throw new HttpError(429, 'محاولات كثيرة — جرّب بعد ربع ساعة');

  const body = await readBody(req);
  if (!(await safeEqual(String(body?.password ?? ''), env.ADMIN_PASSWORD))) {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO login_failures (ip, at) VALUES (?, ?)').bind(ip, now),
      env.DB.prepare('DELETE FROM login_failures WHERE at < ?').bind(now - FAILURE_WINDOW),
    ]);
    throw new HttpError(401, 'كلمة السر غير صحيحة');
  }
  await env.DB.prepare('DELETE FROM login_failures WHERE ip = ?').bind(ip).run();
  const exp = now + SESSION_TTL * 1000;
  const token = `${exp}.${await sign(env, `session:${exp}`)}`;
  return json({ ok: true }, 200, { 'set-cookie': sessionCookie(token, SESSION_TTL) });
}

// ================= حسابات الموظفين =================
// كل موظف له اسم مستخدم وكلمة سر، ويشوف حسابه فقط. المدير يشوف الكل من /admin.
const USER_COOKIE = 'ejad_user';
const USER_TTL = 90 * 24 * 3600; // ٣ شهور
const PBKDF2_ITER = 100000;      // الحد الأقصى المسموح على Cloudflare
const UNDO_WINDOW = 15 * 60 * 1000;
const MAX_AMOUNT = 1e7;

const round2 = (n) => Math.round(n * 100) / 100;
const fromHex = (s) => new Uint8Array(s.match(/../g).map((h) => parseInt(h, 16)));
const sha256 = async (s) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));

async function pbkdf2(password, salt) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITER }, key, 256));
}
async function newPasswordHash(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { pass_hash: await pbkdf2(password, salt), salt: hex(salt) };
}

// حد للمحاولات (تخمين كلمات السر / تسجيل حسابات كثيرة)
async function limited(env, key, max = MAX_FAILURES) {
  const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM login_failures WHERE ip = ? AND at > ?')
    .bind(key, Date.now() - FAILURE_WINDOW).first();
  if (n >= max) throw new HttpError(429, 'محاولات كثيرة — جرّب بعد ربع ساعة');
}
const strike = (env, key) => env.DB.batch([
  env.DB.prepare('INSERT INTO login_failures (ip, at) VALUES (?, ?)').bind(key, Date.now()),
  env.DB.prepare('DELETE FROM login_failures WHERE at < ?').bind(Date.now() - FAILURE_WINDOW),
]);

const cookieOf = (req, name) => (req.headers.get('cookie') ?? '').split(/;\s*/)
  .find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1);
const userCookie = (value, maxAge) => `${USER_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;

function cleanUsername(s) {
  const u = toLatin(String(s ?? '')).trim().toLowerCase();
  if (!/^[a-z0-9_.-]{3,30}$/.test(u)) throw new HttpError(400, 'اسم المستخدم: ٣ أحرف أو أكثر، إنجليزي وأرقام فقط');
  return u;
}
const toLatin = (s) => s.replace(/[٠-٩]/g, (d) => d.charCodeAt(0) - 0x660).replace(/[۰-۹]/g, (d) => d.charCodeAt(0) - 0x6f0);
function checkPassword(pw) {
  pw = String(pw ?? '');
  if (pw.length < 6 || pw.length > 200) throw new HttpError(400, 'كلمة السر ٦ أحرف على الأقل');
  return pw;
}
function parseAmount(v) {
  const n = parsePrice(v);
  if (Number.isNaN(n) || n <= 0 || n > MAX_AMOUNT) throw new HttpError(400, 'المبلغ غير صحيح');
  return round2(n);
}

async function startSession(env, userId) {
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO user_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
      .bind(await sha256(token), userId, now + USER_TTL * 1000),
    env.DB.prepare('DELETE FROM user_sessions WHERE expires_at < ?').bind(now),
  ]);
  return userCookie(token, USER_TTL);
}

async function currentUser(req, env) {
  const token = cookieOf(req, USER_COOKIE);
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  return env.DB.prepare(`SELECT u.id, u.username, u.display_name AS displayName FROM user_sessions s
    JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`)
    .bind(await sha256(token), Date.now()).first();
}

// إنشاء حساب موظف (من التسجيل أو من المدير)
async function createUser(env, b) {
  const username = cleanUsername(b?.username);
  const password = checkPassword(b?.password);
  if (await env.DB.prepare('SELECT 1 FROM users WHERE username = ?').bind(username).first()) {
    throw new HttpError(409, 'اسم المستخدم محجوز، اختر غيره');
  }
  const id = crypto.randomUUID();
  const h = await newPasswordHash(password);
  await env.DB.prepare('INSERT INTO users (id, username, display_name, pass_hash, salt, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, username, username, h.pass_hash, h.salt, Date.now()).run();
  return id;
}

async function register(req, env) {
  const ip = req.headers.get('cf-connecting-ip') ?? 'local';
  await limited(env, `reg:${ip}`, 10);
  const b = await readBody(req);
  const id = await createUser(env, b);
  await strike(env, `reg:${ip}`); // نعدّ التسجيلات من نفس الجهاز
  return json({ ok: true }, 201, { 'set-cookie': await startSession(env, id) });
}

async function userLogin(req, env) {
  const ip = req.headers.get('cf-connecting-ip') ?? 'local';
  await limited(env, `user:${ip}`);
  const b = await readBody(req);
  const username = toLatin(String(b?.username ?? '')).trim().toLowerCase();
  const password = String(b?.password ?? '');
  const u = await env.DB.prepare('SELECT id, pass_hash, salt, active FROM users WHERE username = ?').bind(username).first();
  // نحسب الهاش حتى لو المستخدم مش موجود — ما بدنا نكشف وجوده من سرعة الرد
  const hash = await pbkdf2(password, u ? fromHex(u.salt) : new Uint8Array(16));
  if (!u || !(await safeEqual(hash, u.pass_hash))) {
    await strike(env, `user:${ip}`);
    throw new HttpError(401, 'اسم المستخدم أو كلمة السر غير صحيحة');
  }
  if (!u.active) throw new HttpError(403, 'الحساب موقوف — راجع المدير');
  return json({ ok: true }, 200, { 'set-cookie': await startSession(env, u.id) });
}

async function userLogout(req, env) {
  const token = cookieOf(req, USER_COOKIE);
  if (token) await env.DB.prepare('DELETE FROM user_sessions WHERE token_hash = ?').bind(await sha256(token)).run();
  return json({ ok: true }, 200, { 'set-cookie': userCookie('', 0) });
}

async function changePassword(req, env, user) {
  const b = await readBody(req);
  const u = await env.DB.prepare('SELECT pass_hash, salt FROM users WHERE id = ?').bind(user.id).first();
  if (!(await safeEqual(await pbkdf2(String(b?.current ?? ''), fromHex(u.salt)), u.pass_hash))) {
    throw new HttpError(400, 'كلمة السر الحالية غير صحيحة');
  }
  const h = await newPasswordHash(checkPassword(b?.next));
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET pass_hash = ?, salt = ? WHERE id = ?').bind(h.pass_hash, h.salt, user.id),
    env.DB.prepare('DELETE FROM user_sessions WHERE user_id = ?').bind(user.id), // نطلع من كل الأجهزة
  ]);
  return json({ ok: true }, 200, { 'set-cookie': await startSession(env, user.id) });
}

// ---- اليوم حسب توقيت المحل ----
async function shopTz(env) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'timezone'").first();
  return row?.value || 'Asia/Riyadh';
}
const dayOf = (ms, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);

// ---- الحركات ----
const ENTRY_COLS = `e.id, e.day, e.created_at AS createdAt, e.total, e.paid, e.in_box AS inBox,
  e.by_admin AS byAdmin, e.note, e.voided_at AS voidedAt`;

async function withItems(env, entries) {
  if (!entries.length) return entries;
  const ids = entries.map((e) => e.id);
  const items = [];
  for (let i = 0; i < ids.length; i += 90) { // حد المتغيرات بـ D1
    const chunk = ids.slice(i, i + 90);
    const { results } = await env.DB.prepare(`SELECT entry_id, name, price, qty FROM entry_items WHERE entry_id IN (${chunk.map(() => '?').join(',')})`)
      .bind(...chunk).all();
    items.push(...results);
  }
  const by = new Map(entries.map((e) => [e.id, (e.items = [], e)]));
  for (const it of items) by.get(it.entry_id)?.items.push({ name: it.name, price: it.price, qty: it.qty });
  return entries;
}

const balanceOf = async (env, userId) => round2((await env.DB.prepare(
  'SELECT COALESCE(SUM(total - paid), 0) AS b FROM entries WHERE user_id = ? AND voided_at IS NULL').bind(userId).first()).b);

async function accountView(env, user) {
  const [balance, { results }] = await Promise.all([
    balanceOf(env, user.id),
    env.DB.prepare(`SELECT ${ENTRY_COLS} FROM entries e WHERE e.user_id = ? ORDER BY e.created_at DESC LIMIT 60`).bind(user.id).all(),
  ]);
  return json({ user, balance, entries: await withItems(env, results), undoWindow: UNDO_WINDOW });
}

const validId = (id) => (typeof id === 'string' && /^[\w-]{8,64}$/.test(id) ? id : crypto.randomUUID());

async function insertEntry(env, e, items = []) {
  // الـ id بيجي من الجهاز: لو انضغط الزر مرتين أو انعاد الطلب ما تنسجل الحركة مرتين
  const exists = await env.DB.prepare('SELECT user_id FROM entries WHERE id = ?').bind(e.id).first();
  if (exists) {
    if (exists.user_id !== e.userId) throw new HttpError(409, 'تعارض بالحركة');
    return false;
  }
  await env.DB.batch([
    env.DB.prepare('INSERT INTO entries (id, user_id, day, created_at, total, paid, in_box, by_admin, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(e.id, e.userId, e.day, e.createdAt, e.total, e.paid, e.inBox ? 1 : 0, e.byAdmin ? 1 : 0, e.note ?? null),
    ...items.map((it) => env.DB.prepare('INSERT INTO entry_items (entry_id, product_id, name, price, qty) VALUES (?, ?, ?, ?, ?)')
      .bind(e.id, it.id, it.name, it.price, it.qty)),
  ]);
  return true;
}

async function purchase(req, env, user) {
  const b = await readBody(req);
  const want = new Map();
  for (const it of Array.isArray(b?.items) ? b.items.slice(0, 100) : []) {
    const qty = Math.floor(Number(it?.qty));
    if (typeof it?.id !== 'string' || !(qty >= 1 && qty <= 99)) continue;
    want.set(it.id, (want.get(it.id) ?? 0) + qty);
  }
  if (!want.size) throw new HttpError(400, 'السلة فاضية');
  const ids = [...want.keys()];
  const { results } = await env.DB.prepare(`SELECT id, name, price FROM products WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all();
  if (results.length !== ids.length) throw new HttpError(409, 'منتج بالسلة انحذف أو تغيّر — حدّث الصفحة');
  // السعر من قاعدة البيانات، مش من الجهاز
  const items = results.map((p) => ({ ...p, qty: want.get(p.id) }));
  const total = round2(items.reduce((s, it) => s + it.price * it.qty, 0));
  const now = Date.now();
  const e = { id: validId(b?.id), userId: user.id, day: dayOf(now, await shopTz(env)), createdAt: now, total, paid: b?.paid ? total : 0, inBox: true };
  if (!(await insertEntry(env, e, items))) { // طلب مكرر — نرجّع الحركة المسجلة أصلاً
    const old = await env.DB.prepare('SELECT total, paid FROM entries WHERE id = ?').bind(e.id).first();
    Object.assign(e, old);
  }
  return json({ ok: true, total: e.total, paid: e.paid, balance: await balanceOf(env, user.id) }, 201);
}

async function payment(req, env, user) {
  const b = await readBody(req);
  const amount = parseAmount(b?.amount);
  const now = Date.now();
  await insertEntry(env, { id: validId(b?.id), userId: user.id, day: dayOf(now, await shopTz(env)), createdAt: now, total: 0, paid: amount, inBox: true });
  return json({ ok: true, balance: await balanceOf(env, user.id) }, 201);
}

// الموظف يقدر يلغي حركته خلال ربع ساعة (لو غلط)
async function undoEntry(env, user, id) {
  const res = await env.DB.prepare('UPDATE entries SET voided_at = ? WHERE id = ? AND user_id = ? AND by_admin = 0 AND voided_at IS NULL AND created_at > ?')
    .bind(Date.now(), id, user.id, Date.now() - UNDO_WINDOW).run();
  if (!res.meta.changes) throw new HttpError(400, 'ما بتقدر تلغي هالحركة — راجع المدير');
  return json({ ok: true, balance: await balanceOf(env, user.id) });
}

// ================= لوحة المدير =================
const USERS_SQL = `SELECT u.id, u.username, u.display_name AS displayName, u.active, u.created_at AS createdAt,
  ROUND(COALESCE(SUM(e.total - e.paid), 0), 2) AS balance, COALESCE(SUM(e.total), 0) AS spent, MAX(e.created_at) AS lastAt
  FROM users u LEFT JOIN entries e ON e.user_id = u.id AND e.voided_at IS NULL`;

async function adminSummary(env, url) {
  const days = Math.min(366, Math.max(1, Number(url.searchParams.get('days')) || 30));
  const tz = await shopTz(env);
  const now = Date.now();
  const today = dayOf(now, tz);
  const from = dayOf(now - (days - 1) * 86400000, tz);
  const [daily, counts, users, top, topUsers] = await Promise.all([
    env.DB.prepare(`SELECT day, ROUND(SUM(total), 2) AS sales, ROUND(SUM(CASE WHEN in_box = 1 THEN paid ELSE 0 END), 2) AS cash,
      SUM(CASE WHEN total > 0 THEN 1 ELSE 0 END) AS purchases, COUNT(DISTINCT user_id) AS buyers
      FROM entries WHERE voided_at IS NULL AND day >= ? GROUP BY day ORDER BY day`).bind(from).all(),
    env.DB.prepare('SELECT day, counted, note FROM cash_counts WHERE day >= ?').bind(from).all(),
    env.DB.prepare(`${USERS_SQL} GROUP BY u.id ORDER BY balance DESC, u.display_name`).all(),
    env.DB.prepare(`SELECT i.name, SUM(i.qty) AS qty, ROUND(SUM(i.price * i.qty), 2) AS revenue
      FROM entry_items i JOIN entries e ON e.id = i.entry_id
      WHERE e.voided_at IS NULL AND e.day >= ? GROUP BY COALESCE(i.product_id, i.name) ORDER BY revenue DESC LIMIT 10`).bind(from).all(),
    env.DB.prepare(`SELECT u.display_name AS displayName, ROUND(SUM(e.total), 2) AS spent FROM entries e JOIN users u ON u.id = e.user_id
      WHERE e.voided_at IS NULL AND e.day >= ? AND e.total > 0 GROUP BY u.id ORDER BY spent DESC LIMIT 10`).bind(from).all(),
  ]);
  return json({ today, from, days, timezone: tz, daily: daily.results, counts: counts.results, users: users.results, topProducts: top.results, topUsers: topUsers.results });
}

async function adminDay(env, day) {
  const [{ results }, count] = await Promise.all([
    env.DB.prepare(`SELECT ${ENTRY_COLS}, u.display_name AS userName, u.username, e.user_id AS userId
      FROM entries e JOIN users u ON u.id = e.user_id WHERE e.day = ? ORDER BY e.created_at DESC`).bind(day).all(),
    env.DB.prepare('SELECT counted, note, updated_at AS updatedAt FROM cash_counts WHERE day = ?').bind(day).first(),
  ]);
  return json({ day, entries: await withItems(env, results), count });
}

async function saveCount(req, env, day) {
  const b = await readBody(req);
  const counted = parsePrice(b?.counted);
  if (Number.isNaN(counted) || counted < 0 || counted > 1e9) throw new HttpError(400, 'المبلغ غير صحيح');
  const note = cleanName(b?.note).slice(0, 300) || null;
  await env.DB.prepare(`INSERT INTO cash_counts (day, counted, note, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(day) DO UPDATE SET counted = excluded.counted, note = excluded.note, updated_at = excluded.updated_at`)
    .bind(day, round2(counted), note, Date.now()).run();
  return json({ ok: true });
}
async function clearCount(env, day) {
  await env.DB.prepare('DELETE FROM cash_counts WHERE day = ?').bind(day).run();
  return json({ ok: true });
}

async function adminUser(env, id) {
  const user = await env.DB.prepare(`${USERS_SQL} WHERE u.id = ? GROUP BY u.id`).bind(id).first();
  if (!user) throw new HttpError(404, 'المستخدم غير موجود');
  const { results } = await env.DB.prepare(`SELECT ${ENTRY_COLS} FROM entries e WHERE e.user_id = ? ORDER BY e.created_at DESC LIMIT 300`).bind(id).all();
  return json({ user, entries: await withItems(env, results) });
}

async function adminPatchUser(req, env, id) {
  const b = await readBody(req);
  const stmts = [];
  if (b?.active !== undefined) {
    stmts.push(env.DB.prepare('UPDATE users SET active = ? WHERE id = ?').bind(b.active ? 1 : 0, id));
    if (!b.active) stmts.push(env.DB.prepare('DELETE FROM user_sessions WHERE user_id = ?').bind(id));
  }
  if (b?.password !== undefined) {
    const h = await newPasswordHash(checkPassword(b.password));
    stmts.push(env.DB.prepare('UPDATE users SET pass_hash = ?, salt = ? WHERE id = ?').bind(h.pass_hash, h.salt, id));
    stmts.push(env.DB.prepare('DELETE FROM user_sessions WHERE user_id = ?').bind(id));
  }
  if (b?.displayName !== undefined) {
    const name = cleanName(b.displayName).slice(0, 40);
    if (!name) throw new HttpError(400, 'اكتب الاسم');
    stmts.push(env.DB.prepare('UPDATE users SET display_name = ? WHERE id = ?').bind(name, id));
  }
  if (!stmts.length) throw new HttpError(400, 'ما في تعديل');
  const res = await env.DB.batch(stmts);
  if (!res[0].meta.changes) throw new HttpError(404, 'المستخدم غير موجود');
  return json({ ok: true });
}

// المدير يسجّل دفعة (استلمها منه) أو دين يدوي (أخد شي مش بالنظام)
async function adminAddEntry(req, env, userId) {
  const b = await readBody(req);
  if (!(await env.DB.prepare('SELECT 1 FROM users WHERE id = ?').bind(userId).first())) throw new HttpError(404, 'المستخدم غير موجود');
  const amount = parseAmount(b?.amount);
  const charge = b?.type === 'charge';
  const now = Date.now();
  await insertEntry(env, {
    id: validId(b?.id), userId, day: dayOf(now, await shopTz(env)), createdAt: now,
    total: charge ? amount : 0, paid: charge ? 0 : amount, inBox: charge ? true : b?.inBox !== false,
    byAdmin: true, note: cleanName(b?.note).slice(0, 300) || null,
  });
  return json({ ok: true, balance: await balanceOf(env, userId) }, 201);
}

async function adminVoid(env, id) {
  const res = await env.DB.prepare('UPDATE entries SET voided_at = ? WHERE id = ? AND voided_at IS NULL').bind(Date.now(), id).run();
  if (!res.meta.changes) throw new HttpError(404, 'الحركة غير موجودة أو ملغاة');
  return json({ ok: true });
}
