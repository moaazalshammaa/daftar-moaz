// دوال مشتركة بين الواجهة والخادم (Worker) — لازم تبقى متطابقة بالطرفين.

export const toLatinDigits = (s) => String(s ?? '')
  .replace(/[٠-٩]/g, (d) => d.charCodeAt(0) - 0x660)
  .replace(/[۰-۹]/g, (d) => d.charCodeAt(0) - 0x6f0);

export const normBarcode = (s) => toLatinDigits(s).replace(/\s+/g, '').trim();

// توحيد النص العربي للبحث: بدون تشكيل، أ/إ/آ = ا، ة = ه، ى = ي ...
export const normText = (s) => toLatinDigits(s).toLowerCase()
  .replace(/[ً-ٰٟـ]/g, '')
  .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
  .replace(/ؤ/g, 'و').replace(/ئ/g, 'ي')
  .replace(/\s+/g, ' ').trim();

export const cleanName = (s) => String(s ?? '').trim().replace(/\s+/g, ' ');

// يقبل ١٢٫٥ و 12.5 و 1,500
export const parsePrice = (s) => {
  if (typeof s === 'number') return Number.isFinite(s) && s >= 0 ? s : NaN;
  const t = toLatinDigits(s).replace(/[\s,٬]/g, '').replace('٫', '.');
  if (t === '') return NaN;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : NaN;
};

// EAN-13 و UPC-A نفس الكود أحياناً مع صفر في البداية — نطابق الحالتين
export function barcodeVariants(code) {
  const c = normBarcode(code);
  if (!c) return [];
  const v = [c];
  if (/^\d{12}$/.test(c)) v.push('0' + c);
  if (/^0\d{12}$/.test(c)) v.push(c.slice(1));
  return v;
}
