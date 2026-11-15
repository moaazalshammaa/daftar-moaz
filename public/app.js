// Ejad Mini Market — الواجهة.
// البيانات محفوظة بقاعدة بيانات على Cloudflare (D1). الجهاز يحتفظ بنسخة مؤقتة
// حتى يكون البحث فوري ويشتغل حتى لو النت ضعيف. الإضافة والتعديل تمر عبر الخادم
// وتحتاج تسجيل دخول المدير (كلمة السر تُفحص على الخادم، مش على الجهاز).
import { barcodeVariants, cleanName, normBarcode, normText, parsePrice } from './lib/text.js';
import { Scanner, cameraError } from './scanner.js';

// ================= أدوات مساعدة =================
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const byName = (a, b) => a.name.localeCompare(b.name, 'ar');

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

let audioCtx;
function beep(ok = true) {
  try {
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.frequency.value = ok ? 1200 : 380;
    g.gain.setValueAtTime(0.15, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.15);
    o.connect(g).connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + 0.15);
  } catch { /* الصوت اختياري */ }
  navigator.vibrate?.(ok ? 60 : [40, 60, 40]);
}

// ================= الاتصال بالخادم =================
class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(`/api/${path}`, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'ما في اتصال بالإنترنت');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && path !== 'login') setAdmin(false);
    throw new ApiError(res.status, data.error || 'حدث خطأ');
  }
  return data;
}

// ================= البيانات =================
const CACHE_KEY = 'ejad:cache:v1';
const LEGACY_KEY = 'price-scanner:products:v1'; // النسخة القديمة كانت تحفظ على الجهاز فقط

let products = [];
let settings = { currency: '' };
let byCode = new Map();
let lastSync = 0;

function setData(list, s) {
  products = list.sort(byName);
  if (s) settings = { currency: '', ...s };
  byCode = new Map(products.filter((p) => p.barcode).map((p) => [p.barcode, p]));
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ products, settings })); } catch { /* المساحة ممتلئة — مش مشكلة */ }
  renderAll();
}

function loadCache() {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    if (c) setData(c.products ?? [], c.settings);
  } catch { /* ignore */ }
}

let syncing;
function sync() {
  syncing ??= api('products')
    .then((d) => { setData(d.products, d.settings); lastSync = Date.now(); })
    .catch((e) => { if (!products.length) toast(e.message); })
    .finally(() => { syncing = null; });
  return syncing;
}

function upsertLocal(p) {
  const i = products.findIndex((x) => x.id === p.id);
  if (i >= 0) products[i] = p; else products.push(p);
  setData(products);
}
function removeLocal(id) { setData(products.filter((x) => x.id !== id)); }

function findByBarcode(code, exceptId) {
  for (const v of barcodeVariants(code)) {
    const p = byCode.get(v);
    if (p && p.id !== exceptId) return p;
  }
  return null;
}

const normCache = new WeakMap();
const normName = (p) => {
  let n = normCache.get(p);
  if (n === undefined) { n = normText(p.name); normCache.set(p, n); }
  return n;
};

function search(q) {
  const nq = normText(q);
  if (!nq) return products;
  const code = normBarcode(q);
  const variants = barcodeVariants(code);
  const tokens = nq.split(' ');
  const out = [];
  for (const p of products) {
    const n = normName(p);
    let s = -1;
    if (p.barcode && variants.includes(p.barcode)) s = 100;
    else if (n.startsWith(nq)) s = 50;
    else if (tokens.every((t) => n.includes(t))) s = 20;
    else if (/^\d{3,}$/.test(code) && p.barcode?.includes(code)) s = 10;
    if (s >= 0) out.push([s, p]);
  }
  return out.sort((a, b) => b[0] - a[0] || byName(a[1], b[1])).map((x) => x[1]);
}

const fmtPrice = (n) => {
  const s = Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
  return settings.currency ? `${s} ${settings.currency}` : s;
};

// ================= الدخول =================
let admin = false;
// صفحة /product: إدارة المنتجات للمدير فقط، ومخفية عن التطبيق العادي
const productPage = /^\/product\/?$/.test(location.pathname);
function setAdmin(v) {
  admin = v;
  $('#lock').hidden = !v;
  if (!v && productPage) return openProductPage();
  if (!v && $('#view-products').classList.contains('active')) switchView('scan');
}

const loginDlg = $('#login-dialog');
const loginForm = $('#login-form');
let loginResolve = null;

function askLogin() {
  loginForm.reset();
  $('#login-error').textContent = '';
  loginDlg.showModal();
  loginForm.password.focus();
  return new Promise((resolve) => { loginResolve = resolve; });
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = loginForm.querySelector('[type=submit]');
  btn.disabled = true;
  try {
    await api('login', { method: 'POST', body: { password: loginForm.password.value } });
    const r = loginResolve;
    loginResolve = null;
    loginDlg.close();
    r?.(true);
  } catch (err) {
    $('#login-error').textContent = err.message;
    loginForm.password.select();
  } finally {
    btn.disabled = false;
  }
});
loginDlg.addEventListener('close', () => { loginResolve?.(false); loginResolve = null; });
$('#login-cancel').addEventListener('click', () => loginDlg.close());

async function requireAdmin() {
  if (admin) return true;
  if (!(await askLogin())) return false;
  setAdmin(true);
  offerLegacyUpload();
  return true;
}

$('#lock').addEventListener('click', async () => {
  await api('logout', { method: 'POST' }).catch(() => {});
  setAdmin(false);
  toast('تم تسجيل الخروج 🔒');
});

// منتجات محفوظة على هالجهاز من النسخة القديمة؟ نعرض رفعها لقاعدة البيانات
async function offerLegacyUpload() {
  let old;
  try { old = JSON.parse(localStorage.getItem(LEGACY_KEY) || '[]'); } catch { return; }
  if (!Array.isArray(old) || !old.length) return;
  if (!confirm(`في ${old.length} منتج محفوظين على هذا الجهاز من النسخة القديمة. رفعهم لقاعدة البيانات؟`)) return;
  try {
    const r = await api('import', { method: 'POST', body: { items: old } });
    localStorage.removeItem(LEGACY_KEY);
    toast(`تم الرفع: أُضيف ${r.added}، عُدّل ${r.updated}`);
    sync();
  } catch (e) { toast(e.message); }
}

// ================= شاشة المسح =================
const camBox = $('#camera');
const camBtn = $('#cam-toggle');
const resultEl = $('#result');
const mainScanner = new Scanner($('#video'), (code) => showResult(code, true));

function setCamUI(live, msg) {
  camBox.classList.toggle('live', live);
  camBtn.textContent = live ? '⏹ إيقاف الكاميرا' : '📷 تشغيل الكاميرا';
  if (msg) $('#cam-msg').textContent = msg;
}

async function startMain() {
  camBtn.disabled = true;
  try {
    await mainScanner.start();
    setCamUI(mainScanner.running);
  } catch (e) {
    setCamUI(false, cameraError(e));
    toast(cameraError(e));
  } finally {
    camBtn.disabled = false;
  }
}
function stopMain() {
  mainScanner.stop();
  setCamUI(false, 'وجّه الكاميرا نحو باركود المنتج');
}
camBtn.addEventListener('click', () => (mainScanner.running ? stopMain() : startMain()));

function renderResult(code, p) {
  resultEl.hidden = false;
  resultEl.style.animation = 'none';
  void resultEl.offsetWidth; // إعادة تشغيل الحركة
  resultEl.style.animation = '';
  if (p) {
    resultEl.className = 'result found';
    resultEl.innerHTML = `
      <div class="name">${esc(p.name)}</div>
      <div class="price"><bdi>${esc(fmtPrice(p.price))}</bdi></div>
      <div class="code">${esc(p.barcode)}</div>
      ${buyButtons(p.id)}
      ${admin ? `<div class="row"><button class="btn" data-edit="${esc(p.id)}">تعديل</button></div>` : ''}`;
  } else {
    resultEl.className = 'result missing';
    resultEl.innerHTML = `
      <div class="name">منتج غير مسجّل</div>
      <div class="code">${esc(code)}</div>
      ${admin ? `<div class="row"><button class="btn primary" data-add="${esc(code)}">+ إضافة هذا المنتج</button></div>` : ''}`;
  }
}

async function showResult(code, fromCamera = false) {
  let p = findByBarcode(code);
  if (!p) {
    // يمكن انضاف من جهاز تاني وما وصلنا لسا — نسأل الخادم مباشرة
    try { p = await api(`products/barcode/${encodeURIComponent(code)}`); upsertLocal(p); } catch { p = null; }
  }
  renderResult(code, p);
  if (fromCamera) {
    beep(!!p);
    camBox.classList.add('flash');
    setTimeout(() => camBox.classList.remove('flash'), 250);
  }
}

resultEl.addEventListener('click', (e) => {
  const edit = e.target.closest('[data-edit]');
  const add = e.target.closest('[data-add]');
  const buyBtn = e.target.closest('[data-buy]');
  if (buyBtn) buy(buyBtn.dataset.buy, buyBtn.dataset.paid === '1', buyBtn);
  if (edit) openProduct(products.find((p) => p.id === edit.dataset.edit));
  if (add) openProduct(null, { barcode: add.dataset.add });
});

// ================= البحث والقوائم =================
function highlight(name, q) {
  const tokens = normText(q).split(' ').filter(Boolean);
  let html = esc(name);
  for (const t of tokens) {
    const i = name.toLowerCase().indexOf(t);
    if (i >= 0) {
      const part = esc(name.slice(i, i + t.length));
      html = html.replace(part, `<mark>${part}</mark>`);
    }
  }
  return html;
}

function renderList(ul, items, q = '', emptyMsg = 'لا يوجد منتجات') {
  if (!items.length) {
    ul.innerHTML = `<li class="empty">${esc(emptyMsg)}</li>`;
    return;
  }
  const shown = items.slice(0, 200);
  ul.innerHTML = shown.map((p) => `
    <li class="item" data-id="${esc(p.id)}">
      <div class="item-main">
        <div class="item-name">${highlight(p.name, q)}</div>
        ${p.barcode ? `<div class="item-code">${esc(p.barcode)}</div>` : ''}
      </div>
      <div class="item-price"><bdi>${esc(fmtPrice(p.price))}</bdi></div>
    </li>`).join('') + (items.length > shown.length ? `<li class="empty">و ${items.length - shown.length} منتج آخر… حدّد البحث أكثر</li>` : '');
}

const qInput = $('#q');
const filterInput = $('#filter');
const currencyInput = $('#currency');

function renderSearch() {
  const q = qInput.value;
  renderList($('#search-results'), q.trim() ? search(q) : [], q,
    q.trim() ? 'ما في منتج بهذا الاسم' : 'اكتب اسم المنتج لتعرف سعره');
}
function renderProducts() {
  const q = filterInput.value;
  renderList($('#product-list'), search(q), q, products.length ? 'لا نتائج' : 'ابدأ بإضافة منتجاتك من الزر بالأعلى');
  $('#count').textContent = `${products.length} منتج`;
}
function renderAll() {
  renderSearch();
  renderProducts();
  if (document.activeElement !== currencyInput) currencyInput.value = settings.currency ?? '';
}

qInput.addEventListener('input', renderSearch);
filterInput.addEventListener('input', renderProducts);
for (const ul of [$('#search-results'), $('#product-list')]) {
  ul.addEventListener('click', (e) => {
    const li = e.target.closest('.item');
    if (!li) return;
    if (ul.id === 'search-results' && !admin) return openBuy(li.dataset.id);
    openProduct(products.find((p) => p.id === li.dataset.id));
  });
}

// ================= التبويبات =================
async function switchView(name) {
  if (name === 'products' && !(await requireAdmin())) return;
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  if (name !== 'scan' && mainScanner.running) stopMain();
  if (name === 'search') qInput.focus();
  if (name === 'account') refreshAccount();
}
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => switchView(b.dataset.view)));

document.addEventListener('visibilitychange', () => {
  if (document.hidden) { if (mainScanner.running) stopMain(); return; }
  if (Date.now() - lastSync > 30_000) sync(); // رجعنا للتطبيق — نجيب آخر الأسعار
});

// ================= نافذة المنتج =================
const pd = $('#product-dialog');
const form = $('#product-form');
let editingId = null;
let resumeCamera = false;

async function openProduct(p, prefill = {}) {
  if (!(await requireAdmin())) return;
  resumeCamera = mainScanner.running;
  if (resumeCamera) stopMain();
  editingId = p?.id ?? null;
  $('#pd-title').textContent = p ? 'تعديل منتج' : 'منتج جديد';
  form.name.value = p?.name ?? prefill.name ?? '';
  form.barcode.value = p?.barcode ?? prefill.barcode ?? '';
  form.price.value = p ? String(p.price) : '';
  $('#pd-delete').hidden = !p;
  pd.showModal();
  form.name.focus();
}

pd.addEventListener('close', () => {
  if (resumeCamera && $('#view-scan').classList.contains('active')) startMain();
  resumeCamera = false;
});
$('#pd-cancel').addEventListener('click', () => pd.close());
$('#add').addEventListener('click', () => openProduct(null));

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = { name: cleanName(form.name.value), barcode: normBarcode(form.barcode.value), price: parsePrice(form.price.value) };
  if (!body.name) return toast('اكتب اسم المنتج');
  if (Number.isNaN(body.price)) { form.price.focus(); return toast('السعر غير صحيح'); }
  const dup = findByBarcode(body.barcode, editingId);
  if (dup) { form.barcode.focus(); return toast(`الباركود مستخدم لـ «${dup.name}»`); }

  const btn = form.querySelector('[type=submit]');
  btn.disabled = true;
  const wasEdit = !!editingId;
  try {
    const saved = wasEdit
      ? await api(`products/${editingId}`, { method: 'PUT', body })
      : await api('products', { method: 'POST', body });
    upsertLocal(saved);
    pd.close();
    toast(wasEdit ? 'تم تعديل المنتج ✓' : 'تمت الإضافة ✓');
    if (!resultEl.hidden && saved.barcode) renderResult(saved.barcode, saved);
  } catch (err) {
    toast(err.message);
    if (err.status === 401) { pd.close(); requireAdmin(); }
  } finally {
    btn.disabled = false;
  }
});

$('#pd-delete').addEventListener('click', async () => {
  const p = products.find((x) => x.id === editingId);
  if (!p || !confirm(`حذف «${p.name}»؟`)) return;
  try {
    await api(`products/${p.id}`, { method: 'DELETE' });
    removeLocal(p.id);
    pd.close();
    resultEl.hidden = true;
    toast('تم الحذف');
  } catch (err) { toast(err.message); }
});

// مسح الباركود من داخل النموذج
const sd = $('#scan-dialog');
const dlgScanner = new Scanner($('#dlg-video'), (code) => {
  beep(true);
  form.barcode.value = code;
  sd.close();
  const dup = findByBarcode(code, editingId);
  if (dup) toast(`تنبيه: الباركود مستخدم لـ «${dup.name}»`);
});
$('#pd-scan').addEventListener('click', async () => {
  sd.showModal();
  try { await dlgScanner.start(); } catch (e) { sd.close(); toast(cameraError(e)); }
});
$('#scan-dialog-close').addEventListener('click', () => sd.close());
sd.addEventListener('close', () => dlgScanner.stop());

// ================= الإعدادات والاستيراد/التصدير =================
currencyInput.addEventListener('change', async () => {
  try {
    const r = await api('settings', { method: 'PUT', body: { currency: currencyInput.value } });
    settings.currency = r.currency;
    setData(products);
    toast('تم حفظ العملة ✓');
  } catch (e) { toast(e.message); }
});

function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const stamp = () => new Date().toISOString().slice(0, 10);
const plain = (p) => ({ name: p.name, barcode: p.barcode ?? '', price: p.price });

$('#export-json').addEventListener('click', () => {
  download(`ejad-mini-market-${stamp()}.json`, JSON.stringify({ version: 2, settings, products: products.map(plain) }, null, 2), 'application/json');
});
$('#export-csv').addEventListener('click', () => {
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['الاسم', 'الباركود', 'السعر'].map(cell).join(',')]
    .concat(products.map((p) => [p.name, p.barcode, p.price].map(cell).join(',')));
  download(`ejad-mini-market-${stamp()}.csv`, '﻿' + lines.join('\r\n'), 'text/csv;charset=utf-8');
});

function parseCSV(text) {
  text = text.replace(/^﻿/, '');
  const first = text.split(/\r?\n/)[0] ?? '';
  const sep = [',', ';', '\t'].map((s) => [s, first.split(s).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c;
    } else if (c === '"') q = true;
    else if (c === sep) { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(f); rows.push(row); row = []; f = '';
    } else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim()));
}

const ALIASES = {
  name: ['name', 'product', 'الاسم', 'اسم', 'المنتج', 'اسم المنتج'],
  barcode: ['barcode', 'code', 'ean', 'الباركود', 'باركود', 'الكود', 'كود'],
  price: ['price', 'السعر', 'سعر'],
};
function rowsToItems(rows) {
  if (!rows.length) return [];
  const header = rows[0].map(normText);
  const idx = {};
  for (const [k, names] of Object.entries(ALIASES)) idx[k] = header.findIndex((h) => names.map(normText).includes(h));
  const hasHeader = idx.name >= 0 && idx.price >= 0;
  const cols = hasHeader ? idx : { name: 0, barcode: 1, price: 2 };
  return rows.slice(hasHeader ? 1 : 0).map((r) => ({
    name: r[cols.name], barcode: cols.barcode >= 0 ? r[cols.barcode] : '', price: r[cols.price],
  }));
}

$('#import').addEventListener('click', () => $('#import-file').click());
$('#import-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let items;
  try {
    const text = await file.text();
    const t = text.trim();
    if (/\.json$/i.test(file.name) || t.startsWith('{') || t.startsWith('[')) {
      const data = JSON.parse(t);
      items = Array.isArray(data) ? data : data.products ?? [];
    } else {
      items = rowsToItems(parseCSV(text));
    }
  } catch {
    return toast('الملف غير صالح');
  }
  try {
    const r = await api('import', { method: 'POST', body: { items } });
    toast(`أُضيف ${r.added}، عُدّل ${r.updated}${r.skipped ? `، تُجوهل ${r.skipped}` : ''}`);
    sync();
  } catch (err) { toast(err.message); }
});


// ================= حسابي (السلة والدين) =================
// كل موظف له حساب خاص. يشتري: إما يدفع كاش فوراً، أو ينسجل عليه دين ويسدّده بعدين.
let account = null; // { user, balance, entries, undoWindow }
let accountLoaded = false;
try { localStorage.removeItem('ejad:cart:v1'); } catch { /* السلة القديمة */ }

const productById = (id) => products.find((p) => p.id === id);

// زرّين الشراء: يا دفع كاش يا دين
const buyButtons = (id) => `<div class="buy-wrap" data-pid="${esc(id)}">
  <div class="qty">
    <button type="button" class="btn" data-qty="-1" aria-label="أقل">−</button>
    <span class="qty-n" aria-live="polite">1</span>
    <button type="button" class="btn" data-qty="1" aria-label="أكتر">+</button>
  </div>
  <div class="qty-total" hidden></div>
  <div class="row buy-row">
    <button class="btn primary block" data-buy="${esc(id)}" data-paid="1">💵 دفعت كاش</button>
    <button class="btn block" data-buy="${esc(id)}" data-paid="0">📝 سجّل عليّ</button>
  </div>
</div>`;

// عدّاد الكمية: كم وحدة أخد
const MAX_QTY = 99;
const qtyOf = (wrap) => Math.min(MAX_QTY, Math.max(1, Number(wrap?.querySelector('.qty-n')?.textContent) || 1));
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-qty]');
  const wrap = b?.closest('.buy-wrap');
  if (!wrap) return;
  const n = Math.min(MAX_QTY, Math.max(1, qtyOf(wrap) + Number(b.dataset.qty)));
  wrap.querySelector('.qty-n').textContent = n;
  const p = productById(wrap.dataset.pid);
  const t = wrap.querySelector('.qty-total');
  t.hidden = n === 1 || !p;
  if (p) t.innerHTML = `${n} × <bdi>${esc(fmtPrice(p.price))}</bdi> = <bdi>${esc(fmtPrice(p.price * n))}</bdi>`;
});

const buyDlg = $('#buy-dialog');
function openBuy(id) {
  const p = productById(id);
  if (!p) return;
  buyDlg.querySelector('.buy-box').innerHTML = `
    <div class="name">${esc(p.name)}</div>
    <div class="price"><bdi>${esc(fmtPrice(p.price))}</bdi></div>
    ${buyButtons(p.id)}`;
  buyDlg.showModal();
}
buyDlg.addEventListener('click', (e) => {
  if (e.target === buyDlg || e.target.closest('[data-close]')) return buyDlg.close();
  const b = e.target.closest('[data-buy]');
  if (b) buy(b.dataset.buy, b.dataset.paid === '1', b);
});

let buying = false;
async function buy(id, paid, btn) {
  const p = productById(id);
  if (!p || buying) return;
  if (!account) {
    if (buyDlg.open) buyDlg.close();
    toast('سجّل دخول بحسابك أول 👤');
    return switchView('account');
  }
  buying = true;
  const row = btn?.closest('.buy-wrap');
  const qty = qtyOf(row);
  const what = qty > 1 ? `${qty} × ${p.name}` : p.name;
  const sum = fmtPrice(p.price * qty);
  row?.querySelectorAll('button').forEach((b) => { b.disabled = true; });
  try {
    await api('account/purchase', { method: 'POST', body: { id: crypto.randomUUID(), paid, items: [{ id, qty }] } });
    beep(true);
    toast(paid ? `✓ ${what} — مدفوع ${sum}، شكراً` : `✓ ${what} — انسجل عليك ${sum}`);
    if (buyDlg.open) buyDlg.close();
    if (row && resultEl.contains(row)) row.outerHTML = `<div class="bought">${paid ? '💵 تم — مدفوع' : '📝 تم — انسجل عليك'}${qty > 1 ? ` (${qty} قطع)` : ''}</div>`;
    await refreshAccount();
  } catch (err) {
    toast(err.message);
    if (err.status === 409) sync();
    if (err.status === 401) refreshAccount();
    row?.querySelectorAll('button').forEach((b) => { b.disabled = false; });
  } finally {
    buying = false;
  }
}

// ---- عرض الحساب ----
const fmtTime = (ms) => new Date(ms).toLocaleString('ar', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

function renderAccount() {
  $('#acct-guest').hidden = !!account;
  $('#acct-user').hidden = !account;
  if (!account) return;
  const { user, balance, entries } = account;
  $('#acct-hello').textContent = `أهلاً \u2066${user.username}\u2069`;
  const bal = $('#balance');
  bal.className = 'balance ' + (balance > 0 ? 'owe' : 'clear');
  if (balance > 0) {
    bal.innerHTML = `عليك <bdi>${esc(fmtPrice(balance))}</bdi>`;
    $('#balance-note').textContent = 'سدّد المبلغ بالصندوق واضغط «سدّدت مبلغ»';
  } else if (balance < 0) {
    bal.innerHTML = `إلك رصيد <bdi>${esc(fmtPrice(-balance))}</bdi>`;
    $('#balance-note').textContent = 'دفعت زيادة — بينخصم من مشترياتك الجاية';
  } else {
    bal.textContent = 'حسابك صافي ✓';
    $('#balance-note').textContent = '';
  }
  const now = Date.now();
  $('#history').innerHTML = entries.length ? entries.map((e) => {
    const isPay = !e.total;
    const title = isPay ? '💰 تسديد' : (e.paid ? '💵 شراء — مدفوع كاش' : '📝 شراء — دين');
    const items = (e.items ?? []).map((i) => `${esc(i.name)}${i.qty > 1 ? ` ×${i.qty}` : ''}`).join('، ');
    const canUndo = !e.voidedAt && !e.byAdmin && now - e.createdAt < account.undoWindow;
    return `<li class="entry ${e.voidedAt ? 'voided' : ''}">
      <div class="item-main">
        <div class="item-name">${title}${e.byAdmin ? ' <span class="tag">المدير</span>' : ''}${e.voidedAt ? ' <span class="tag">ملغاة</span>' : ''}</div>
        ${items ? `<div class="small">${items}</div>` : ''}
        ${e.note ? `<div class="small muted">${esc(e.note)}</div>` : ''}
        <div class="small muted">${esc(fmtTime(e.createdAt))}</div>
      </div>
      <div class="entry-side">
        <div class="item-price ${isPay ? 'pos' : e.paid < e.total ? 'debt' : ''}"><bdi>${esc(fmtPrice(isPay ? e.paid : e.total))}</bdi></div>
        ${canUndo ? `<button class="btn small-btn" data-undo="${esc(e.id)}">تراجع</button>` : ''}
      </div>
    </li>`;
  }).join('') : '<li class="empty">ما في حركات لسا</li>';
}

async function refreshAccount() {
  try {
    account = await api('account');
  } catch (e) {
    if (e.status === 401) account = null;
    else if (!accountLoaded) toast(e.message);
  }
  accountLoaded = true;
  renderAccount();
}

// ---- دخول / تسجيل ----
let authMode = 'login';
const authForm = $('#auth-form');
document.querySelectorAll('[data-auth]').forEach((b) => b.addEventListener('click', () => {
  authMode = b.dataset.auth;
  document.querySelectorAll('[data-auth]').forEach((x) => x.classList.toggle('active', x === b));
  authForm.password.autocomplete = authMode === 'register' ? 'new-password' : 'current-password';
  authForm.querySelector('[type=submit]').textContent = authMode === 'register' ? 'إنشاء الحساب' : 'دخول';
  $('#auth-error').textContent = '';
}));

authForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = authForm.querySelector('[type=submit]');
  btn.disabled = true;
  $('#auth-error').textContent = '';
  try {
    const body = { username: authForm.username.value, password: authForm.password.value };
    await api(authMode === 'register' ? 'auth/register' : 'auth/login', { method: 'POST', body });
    authForm.reset();
    await refreshAccount();
    toast(authMode === 'register' ? 'تم إنشاء حسابك ✓' : 'أهلاً فيك 👋');
  } catch (err) {
    $('#auth-error').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

$('#user-logout').addEventListener('click', async () => {
  await api('auth/logout', { method: 'POST' }).catch(() => {});
  account = null;
  renderAccount();
  toast('تم تسجيل الخروج');
});

$('#pw-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api('account/password', { method: 'PUT', body: { current: f.current.value, next: f.next.value } });
    f.reset();
    toast('تم تغيير كلمة السر ✓');
  } catch (err) { toast(err.message); }
});

// ---- التسديد ----
const payDlg = $('#pay-dialog');
const payForm = $('#pay-form');
$('#pay-btn').addEventListener('click', () => {
  payForm.reset();
  if (account?.balance > 0) payForm.amount.value = String(account.balance);
  payDlg.showModal();
  payForm.amount.select();
});
$('#pay-cancel').addEventListener('click', () => payDlg.close());
payForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const amount = parsePrice(payForm.amount.value);
  if (Number.isNaN(amount) || amount <= 0) return toast('المبلغ غير صحيح');
  const btn = payForm.querySelector('[type=submit]');
  btn.disabled = true;
  try {
    await api('account/payment', { method: 'POST', body: { id: crypto.randomUUID(), amount } });
    payDlg.close();
    toast('تم تسجيل التسديد ✓');
    await refreshAccount();
  } catch (err) { toast(err.message); } finally { btn.disabled = false; }
});

$('#history').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-undo]');
  if (!b || !confirm('إلغاء هالحركة؟')) return;
  try {
    await api(`account/entries/${b.dataset.undo}`, { method: 'DELETE' });
    toast('تم الإلغاء');
    await refreshAccount();
  } catch (err) { toast(err.message); }
});

// ================= بدء التشغيل =================
loadCache();
sync();
async function openProductPage() {
  if (await requireAdmin()) return switchView('products');
  location.href = '/'; // لغى الدخول: يرجع للتطبيق
}
if (productPage) {
  document.body.classList.add('product-page');
  $('#back-app').hidden = false;
  document.title = 'المنتجات — Ejad Mini Market';
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-products'));
  api('me').then((r) => (r.admin ? (setAdmin(true), switchView('products')) : openProductPage())).catch(() => openProductPage());
} else {
  api('me').then((r) => setAdmin(!!r.admin)).catch(() => {});
  refreshAccount();
}

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
