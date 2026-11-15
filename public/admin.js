// لوحة الإدارة: جرد الصندوق اليومي، ديون الموظفين، والإحصائيات.
import { parsePrice } from './lib/text.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const r2 = (n) => Math.round(n * 100) / 100;

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }
async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(`/api/${path}`, {
      method, credentials: 'same-origin',
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch { throw new ApiError(0, 'ما في اتصال بالإنترنت'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && path !== 'login') showLogin();
    throw new ApiError(res.status, data.error || 'حدث خطأ');
  }
  return data;
}

let settings = { currency: '' };
const money = (n) => {
  const s = Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
  return settings.currency ? `${s} ${settings.currency}` : s;
};
const bdi = (n) => `<bdi>${esc(money(n))}</bdi>`;
const signed = (n) => {
  n = r2(n);
  if (n === 0) return '<span class="pos">مطابق ✓</span>';
  return `<span class="${n < 0 ? 'neg' : 'pos'}"><bdi>${n > 0 ? '+' : '−'}${esc(money(Math.abs(n)))}</bdi></span>`;
};
const fmtTime = (ms) => new Date(ms).toLocaleTimeString('ar', { hour: 'numeric', minute: '2-digit' });
const fmtDateTime = (ms) => new Date(ms).toLocaleString('ar', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const fmtDay = (d, opts = { weekday: 'short', day: 'numeric', month: 'short' }) => new Date(`${d}T12:00:00Z`).toLocaleDateString('ar', { ...opts, timeZone: 'UTC' });
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

// ================= الدخول =================
function showLogin() {
  $('#login-view').hidden = false;
  $('#app-view').hidden = true;
  $('#logout').hidden = true;
  $('#login-form').password.focus();
}
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api('login', { method: 'POST', body: { password: f.password.value } });
    f.reset();
    start();
  } catch (err) { $('#login-error').textContent = err.message; }
});
$('#logout').addEventListener('click', async () => {
  await api('logout', { method: 'POST' }).catch(() => {});
  showLogin();
});

// ================= التبويبات =================
document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('active', x === b));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${b.dataset.tab}`));
  if (b.dataset.tab === 'stats') loadStats();
}));

// ================= الصندوق =================
let summary = null; // آخر ٣٠ يوم
let today = '';
let day = '';
let dayData = null;

const dayRow = (d) => {
  const row = summary?.daily.find((x) => x.day === d) ?? { sales: 0, cash: 0, purchases: 0 };
  const count = summary?.counts.find((x) => x.day === d);
  return { ...row, counted: count?.counted };
};

async function loadSummary() {
  summary = await api('admin/summary?days=30');
  settings.timezone = summary.timezone;
  today = summary.today;
  renderDaysTable();
  renderDebts();
}

function renderDaysTable() {
  const rows = [];
  for (let d = today; d >= summary.from; d = addDays(d, -1)) {
    const r = dayRow(d);
    rows.push(`<tr data-day="${d}" class="${d === day ? 'sel' : ''}">
      <td>${esc(fmtDay(d))}</td><td>${bdi(r.sales)}</td><td>${bdi(r.cash)}</td>
      <td>${r.counted != null ? bdi(r.counted) : '<span class="muted">—</span>'}</td>
      <td>${r.counted != null ? signed(r.counted - r.cash) : ''}</td></tr>`);
  }
  $('#days-table tbody').innerHTML = rows.join('');
}
$('#days-table').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-day]');
  if (tr) { selectDay(tr.dataset.day); window.scrollTo({ top: 0, behavior: 'smooth' }); }
});

async function selectDay(d) {
  day = d;
  $('#day').value = d;
  $('#day').max = today;
  $('#day-next').disabled = d >= today;
  document.querySelectorAll('#days-table tr[data-day]').forEach((tr) => tr.classList.toggle('sel', tr.dataset.day === d));
  try {
    dayData = await api(`admin/days/${d}`);
    if (day === d) renderDay();
  } catch (err) { toast(err.message); }
}

function renderDay() {
  const live = dayData.entries.filter((e) => !e.voidedAt);
  const sales = r2(live.reduce((s, e) => s + e.total, 0));
  const cash = r2(live.reduce((s, e) => s + (e.inBox ? e.paid : 0), 0));
  const credit = r2(live.filter((e) => e.total > 0 && !e.paid).reduce((s, e) => s + e.total, 0));
  $('#k-sales').innerHTML = bdi(sales);
  $('#k-cash').innerHTML = bdi(cash);
  $('#k-credit').innerHTML = bdi(credit);
  const count = dayData.count;
  $('#k-diff').innerHTML = count ? signed(count.counted - cash) : '<span class="muted small">ما انعمل جرد</span>';
  const f = $('#count-form');
  f.counted.value = count ? String(count.counted) : '';
  f.note.value = count?.note ?? '';
  $('#count-clear').hidden = !count;
  $('#day-entries').innerHTML = dayData.entries.length
    ? dayData.entries.map((e) => entryRow(e, true)).join('')
    : '<li class="empty">ما في حركات بهاليوم</li>';
}

function entryRow(e, withUser) {
  const isPay = !e.total;
  let title = isPay ? '💰 تسديد' : (e.paid ? '💵 شراء كاش' : '📝 شراء دين');
  if (isPay && !e.inBox) title += ' (خارج الصندوق)';
  const items = (e.items ?? []).map((i) => `${esc(i.name)}${i.qty > 1 ? ` ×${i.qty}` : ''}`).join('، ');
  const who = withUser ? `<a href="#" data-user="${esc(e.userId)}"><bdi>${esc(e.username)}</bdi></a> · ` : '';
  return `<li class="entry ${e.voidedAt ? 'voided' : ''}">
    <div class="item-main">
      <div class="item-name">${title}${e.byAdmin ? ' <span class="tag">المدير</span>' : ''}${e.voidedAt ? ' <span class="tag">ملغاة</span>' : ''}</div>
      ${items ? `<div class="small">${items}</div>` : ''}
      ${e.note ? `<div class="small muted">${esc(e.note)}</div>` : ''}
      <div class="small muted">${who}${esc(withUser ? fmtTime(e.createdAt) : fmtDateTime(e.createdAt))}</div>
    </div>
    <div class="entry-side">
      <div class="item-price ${isPay ? 'pos' : e.paid < e.total ? 'debt' : ''}">${bdi(isPay ? e.paid : e.total)}</div>
      ${e.voidedAt ? '' : `<button class="btn small-btn danger" data-void="${esc(e.id)}">إلغاء</button>`}
    </div>
  </li>`;
}

async function voidEntry(id) {
  if (!confirm('إلغاء هالحركة؟ ما رح تنحسب بالصندوق ولا بالدين.')) return false;
  try {
    await api(`admin/entries/${id}`, { method: 'DELETE' });
    toast('تم الإلغاء');
    return true;
  } catch (err) { toast(err.message); return false; }
}

$('#day-entries').addEventListener('click', async (e) => {
  const u = e.target.closest('[data-user]');
  if (u) { e.preventDefault(); return openUser(u.dataset.user); }
  const v = e.target.closest('[data-void]');
  if (v && await voidEntry(v.dataset.void)) refreshCash();
});

$('#day').addEventListener('change', (e) => { if (e.target.value) selectDay(e.target.value > today ? today : e.target.value); });
$('#day-prev').addEventListener('click', () => selectDay(addDays(day, -1)));
$('#day-next').addEventListener('click', () => { if (day < today) selectDay(addDays(day, 1)); });
$('#day-today').addEventListener('click', () => selectDay(today));

$('#count-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const counted = parsePrice(f.counted.value);
  if (Number.isNaN(counted) || counted < 0) return toast('المبلغ غير صحيح');
  try {
    await api(`admin/days/${day}/count`, { method: 'PUT', body: { counted, note: f.note.value } });
    toast('تم حفظ الجرد ✓');
    refreshCash();
  } catch (err) { toast(err.message); }
});
$('#count-clear').addEventListener('click', async () => {
  if (!confirm('حذف جرد هاليوم؟')) return;
  try { await api(`admin/days/${day}/count`, { method: 'DELETE' }); refreshCash(); } catch (err) { toast(err.message); }
});

async function refreshCash() {
  await loadSummary().catch((err) => toast(err.message));
  await selectDay(day || today);
}

// ================= الديون والموظفين =================
const userRow = (u) => `
    <li class="item user-row ${u.active ? '' : 'inactive'}" data-user="${esc(u.id)}">
      <div class="item-main">
        <div class="item-name"><bdi>${esc(u.username)}</bdi> ${u.active ? '' : '<span class="tag">موقوف</span>'}</div>
        ${u.lastAt ? `<div class="item-code">آخر حركة ${esc(fmtDateTime(u.lastAt))}</div>` : ''}
      </div>
      <div class="item-price ${u.balance > 0 ? 'owe' : 'clear'}">${u.balance > 0 ? bdi(u.balance) : u.balance < 0 ? `رصيد ${bdi(-u.balance)}` : 'صافي'}</div>
    </li>`;

function renderDebts() {
  const users = summary.users;
  const debtors = users.filter((u) => u.balance > 0);
  $('#k-debt').innerHTML = bdi(debtors.reduce((s, u) => s + u.balance, 0));
  $('#k-debtors').textContent = debtors.length;
  $('#k-users').textContent = users.length;
  $('#debtors').innerHTML = debtors.length ? debtors.map(userRow).join('') : '<li class="empty">ما حدا عليه دين ✓</li>';
  renderUsers();
}

function renderUsers() {
  const users = [...summary.users].sort((a, b) => a.username.localeCompare(b.username));
  const q = $('#user-filter').value.trim().toLowerCase();
  const shown = users.filter((u) => !q || u.username.includes(q));
  $('#users').innerHTML = shown.length ? shown.map(userRow).join('')
    : `<li class="empty">${users.length ? 'لا نتائج' : 'ما في حسابات لسا — اعمل حساب من فوق، أو الموظف بيسجّل من تبويب «حسابي» بالتطبيق'}</li>`;
}
$('#user-filter').addEventListener('input', renderUsers);

$('#new-user-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const btn = f.querySelector('button');
  btn.disabled = true;
  try {
    const username = f.username.value.trim();
    await api('admin/users', { method: 'POST', body: { username, password: f.password.value } });
    f.reset();
    toast(`تم إنشاء حساب ${username} ✓`);
    await loadSummary();
  } catch (err) { toast(err.message); } finally { btn.disabled = false; }
});

$('#debtors').addEventListener('click', (e) => {
  const li = e.target.closest('[data-user]');
  if (li) openUser(li.dataset.user);
});
$('#users').addEventListener('click', (e) => {
  const li = e.target.closest('[data-user]');
  if (li) openUser(li.dataset.user);
});

// ---- نافذة الموظف ----
const ud = $('#user-dialog');
let current = null;
let entryType = 'payment';

async function openUser(id) {
  try {
    current = await api(`admin/users/${id}`);
  } catch (err) { return toast(err.message); }
  renderUser();
  if (!ud.open) ud.showModal();
}

function renderUser() {
  const { user, entries } = current;
  $('#u-name').textContent = `\u2066${user.username}\u2069`;
  $('#u-meta').textContent = `مشترياته الكلية ${money(user.spent)}`;
  const b = $('#u-balance');
  b.className = 'balance ' + (user.balance > 0 ? 'owe' : 'clear');
  b.innerHTML = user.balance > 0 ? `عليه ${bdi(user.balance)}` : user.balance < 0 ? `إله رصيد ${bdi(-user.balance)}` : 'حسابه صافي ✓';
  const f = $('#u-entry-form');
  if (user.balance > 0 && entryType === 'payment' && !f.amount.value) f.amount.value = String(user.balance);
  $('#u-entries').innerHTML = entries.length ? entries.map((e) => entryRow(e, false)).join('') : '<li class="empty">ما في حركات</li>';
  $('#u-toggle').textContent = user.active ? '⛔ إيقاف الحساب' : '✅ تفعيل الحساب';
}

$('#u-close').addEventListener('click', () => ud.close());
ud.addEventListener('close', () => { $('#u-entry-form').reset(); current = null; });

document.querySelectorAll('[data-type]').forEach((b) => b.addEventListener('click', () => {
  entryType = b.dataset.type;
  document.querySelectorAll('[data-type]').forEach((x) => x.classList.toggle('active', x === b));
  $('#u-inbox-wrap').hidden = entryType !== 'payment';
  $('#u-entry-form').amount.value = '';
}));

async function afterUserChange() {
  await openUser(current.user.id);
  refreshCash();
}

$('#u-entry-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const amount = parsePrice(f.amount.value);
  if (Number.isNaN(amount) || amount <= 0) return toast('المبلغ غير صحيح');
  try {
    await api(`admin/users/${current.user.id}/entries`, {
      method: 'POST',
      body: { id: crypto.randomUUID(), type: entryType, amount, note: f.note.value, inBox: f.inBox.checked },
    });
    f.amount.value = '';
    f.note.value = '';
    toast('تم التسجيل ✓');
    afterUserChange();
  } catch (err) { toast(err.message); }
});

$('#u-entries').addEventListener('click', async (e) => {
  const v = e.target.closest('[data-void]');
  if (v && await voidEntry(v.dataset.void)) afterUserChange();
});

$('#u-pw-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api(`admin/users/${current.user.id}`, { method: 'PATCH', body: { password: e.target.password.value } });
    e.target.reset();
    toast('تم تعيين كلمة السر — أعطها للموظف');
  } catch (err) { toast(err.message); }
});

$('#u-toggle').addEventListener('click', async () => {
  const active = !current.user.active;
  if (!active && !confirm(`إيقاف حساب ${current.user.username}؟ ما رح يقدر يدخل.`)) return;
  try {
    await api(`admin/users/${current.user.id}`, { method: 'PATCH', body: { active } });
    afterUserChange();
  } catch (err) { toast(err.message); }
});

// ================= الإحصائيات =================
let statDays = 30;
document.querySelectorAll('[data-days]').forEach((b) => b.addEventListener('click', () => {
  statDays = Number(b.dataset.days);
  document.querySelectorAll('[data-days]').forEach((x) => x.classList.toggle('active', x === b));
  loadStats();
}));

async function loadStats() {
  let s;
  try { s = await api(`admin/summary?days=${statDays}`); } catch (err) { return toast(err.message); }
  const by = new Map(s.daily.map((d) => [d.day, d]));
  const series = [];
  for (let d = s.from; d <= s.today; d = addDays(d, 1)) series.push({ day: d, sales: by.get(d)?.sales ?? 0 });
  const sales = s.daily.reduce((a, d) => a + d.sales, 0);
  const cash = s.daily.reduce((a, d) => a + d.cash, 0);
  const countsDiff = s.counts.reduce((a, c) => a + (c.counted - (by.get(c.day)?.cash ?? 0)), 0);
  $('#s-sales').innerHTML = bdi(sales);
  $('#s-cash').innerHTML = bdi(cash);
  $('#s-avg').innerHTML = bdi(s.daily.length ? sales / s.daily.length : 0); // معدل أيام البيع
  const debtors = s.users.filter((u) => u.balance > 0);
  $('#s-debt').innerHTML = bdi(debtors.reduce((a, u) => a + u.balance, 0));
  $('#s-debtors').textContent = debtors.length ? `على ${debtors.length} ${debtors.length === 1 ? 'شخص' : 'أشخاص'}` : 'ما حدا عليه دين';
  $('#s-count').textContent = s.daily.reduce((a, d) => a + d.purchases, 0);
  $('#s-diff').innerHTML = s.counts.length ? signed(countsDiff) : '<span class="muted small">ما في جرد</span>';

  const max = Math.max(...series.map((d) => d.sales), 1);
  $('#chart').innerHTML = series.map((d) => `<div class="bar ${d.sales ? '' : 'zero'}" style="height:${(d.sales / max) * 100}%"
    title="${esc(fmtDay(d.day))}: ${esc(money(d.sales))}"></div>`).join('');
  const axis = $('#chart').nextElementSibling?.classList.contains('chart-axis') ? $('#chart').nextElementSibling : null;
  const axisHtml = `<span>${esc(fmtDay(s.from, { day: 'numeric', month: 'short' }))}</span><span>${esc(fmtDay(s.today, { day: 'numeric', month: 'short' }))}</span>`;
  if (axis) axis.innerHTML = axisHtml; else $('#chart').insertAdjacentHTML('afterend', `<div class="chart-axis">${axisHtml}</div>`);

  $('#top-products').innerHTML = s.topProducts.length
    ? s.topProducts.map((p) => `<li><span>${esc(p.name)} <span class="muted small">×${p.qty}</span></span><span>${bdi(p.revenue)}</span></li>`).join('')
    : '<li class="muted">ما في مبيعات</li>';
  $('#top-users').innerHTML = s.topUsers.length
    ? s.topUsers.map((u) => `<li><span><bdi>${esc(u.username)}</bdi></span><span>${bdi(u.spent)}</span></li>`).join('')
    : '<li class="muted">ما في مشتريات</li>';
}

// ================= الإعدادات =================
$('#settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    const r = await api('settings', { method: 'PUT', body: { timezone: f.timezone.value.trim() || 'Asia/Riyadh', currency: f.currency.value } });
    Object.assign(settings, r);
    toast('تم الحفظ ✓');
    refreshCash();
  } catch (err) { toast(err.message); }
});

// ================= البدء =================
async function start() {
  $('#login-view').hidden = true;
  $('#app-view').hidden = false;
  $('#logout').hidden = false;
  try {
    const p = await api('products');
    settings = { ...settings, ...p.settings };
    const f = $('#settings-form');
    f.currency.value = settings.currency ?? '';
    // أول مرة: نعتمد توقيت جهاز المدير
    if (!p.settings?.timezone) {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (tz) await api('settings', { method: 'PUT', body: { timezone: tz } }).catch(() => {});
    }
    await loadSummary();
    f.timezone.value = summary.timezone;
    await selectDay(today);
  } catch (err) { if (err.status !== 401) toast(err.message); }
}

api('me').then((r) => (r.admin ? start() : showLogin())).catch(() => showLogin());
