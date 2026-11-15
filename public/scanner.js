// ماسح الباركود — مصمم ليكون خفيف على الموبايل:
//  • يقرأ فقط المنطقة داخل الإطار (مش الصورة كاملة) ويصغّرها قبل التحليل
//  • التحليل بخيط منفصل (Web Worker + WebAssembly) فالواجهة ما بتعلق
//  • إطار واحد قيد التحليل بأي لحظة، وبحد أقصى ~7 مرات بالثانية
//  • يستعمل قارئ الجهاز المدمج (BarcodeDetector) إذا موجود — أسرع وأوفر بطارية
import { normBarcode } from './lib/text.js';

const NATIVE_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'code_93', 'itf', 'codabar', 'qr_code', 'data_matrix'];
const MIN_INTERVAL = 140;   // ms بين كل تحليلين
const PAUSE_AFTER_HIT = 1200;
const SAME_CODE_GAP = 2500;
const ROI_MAX_WIDTH = 960;  // نصغّر المنطقة لهالعرض كحد أقصى
// المنطقة المقروءة = الإطار الظاهر (inset: 25% 10%) مع هامش بسيط
const ROI = { x: 0.06, y: 0.18, w: 0.88, h: 0.64 };

// ---- قارئ WebAssembly (مشترك بين كل الماسحات) ----
let wasm;
function getWasm() {
  if (wasm) return wasm;
  const worker = new Worker('/scanner-worker.js');
  const pending = new Map();
  let seq = 0;
  worker.onmessage = ({ data }) => {
    if (data.type !== 'result') return;
    pending.get(data.id)?.(data);
    pending.delete(data.id);
  };
  worker.onerror = () => { for (const r of pending.values()) r({ text: null }); pending.clear(); };
  wasm = {
    decode(imageData) {
      const id = ++seq;
      return new Promise((resolve) => {
        pending.set(id, resolve);
        worker.postMessage({ id, width: imageData.width, height: imageData.height, buffer: imageData.data.buffer }, [imageData.data.buffer]);
      });
    },
  };
  return wasm;
}

// ---- قارئ الجهاز المدمج (Android Chrome) ----
let nativePromise;
function getNative() {
  nativePromise ??= (async () => {
    try {
      if (!('BarcodeDetector' in window)) return null;
      const supported = await BarcodeDetector.getSupportedFormats();
      const formats = NATIVE_FORMATS.filter((f) => supported.includes(f));
      return formats.includes('ean_13') ? new BarcodeDetector({ formats }) : null;
    } catch { return null; }
  })();
  return nativePromise;
}

const IS_ANDROID = /android/i.test(navigator.userAgent);

function openCamera(extra) {
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    // دقة أعلى = خطوط الباركود أوضح حتى لو بعيد شوي
    video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30, max: 30 }, ...extra },
  });
}

// الكاميرا الخلفية الرئيسية عادةً أصغر رقم بين الخلفيات ("camera2 0, facing back")
async function mainBackCameraId() {
  const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  const back = cams.filter((d) => /back|rear|environment|خلف/i.test(d.label));
  if (back.length < 2) return null;
  const num = (d) => { const m = d.label.match(/(\d+)/); return m ? Number(m[1]) : 99; };
  back.sort((a, b) => num(a) - num(b));
  return back[0].deviceId;
}

// تركيز تلقائي مستمر + تقريب خفيف بأندرويد (حتى ما يقرّب الموبايل كتير ويضيع التركيز)
async function tuneTrack(track) {
  try {
    const caps = track.getCapabilities?.() ?? {};
    const adv = {};
    if (caps.focusMode?.includes('continuous')) adv.focusMode = 'continuous';
    if (IS_ANDROID && caps.zoom && caps.zoom.max >= 1.5) adv.zoom = Math.max(caps.zoom.min ?? 1, Math.min(1.8, caps.zoom.max));
    if (Object.keys(adv).length) await track.applyConstraints({ advanced: [adv] });
  } catch {
    try { await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }); } catch { /* غير مدعوم */ }
  }
}

const isRetail = (format) => /ean|upc/i.test(format ?? '');

export class Scanner {
  constructor(video, onCode) {
    this.video = video;
    this.onCode = onCode;
    this.running = false;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
  }

  async start() {
    if (this.running) return;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      throw Object.assign(new Error('insecure'), { name: 'InsecureContext' });
    }
    this.running = true;
    getWasm(); // نبدأ تحميل المحرك مع الكاميرا بالتوازي
    try {
      let stream = await openCamera({ facingMode: { ideal: 'environment' } });
      // أندرويد: بالموبايلات اللي فيها أكتر من كاميرا خلفية، Chrome أحياناً بيختار العدسة العريضة
      // (ما فيها تركيز تلقائي) — منختار الكاميرا الخلفية الرئيسية بالاسم
      if (IS_ANDROID) {
        const id = await mainBackCameraId(stream).catch(() => null);
        const cur = stream.getVideoTracks()[0]?.getSettings?.().deviceId;
        if (id && id !== cur) {
          // بعض الموبايلات ما بتفتح كاميرتين سوا، فمنسكّر الأولى قبل
          stream.getTracks().forEach((t) => t.stop());
          try { stream = await openCamera({ deviceId: { exact: id } }); }
          catch { stream = await openCamera({ facingMode: { ideal: 'environment' } }); }
        }
      }
      if (!this.running) { stream.getTracks().forEach((t) => t.stop()); return; }
      this.stream = stream;
      this.track = stream.getVideoTracks()[0];
      await tuneTrack(this.track);
      // كبسة على الكاميرا = إعادة تركيز
      this.tapTarget = this.video.parentElement;
      this.onTap ??= () => this.refocus();
      this.tapTarget?.addEventListener('click', this.onTap);
      this.video.srcObject = stream;
      await this.video.play();
      this.native = await getNative();
      this.misses = 0;
      this.pendingCode = null;
      this.pausedUntil = 0;
      this.schedule();
    } catch (e) {
      this.stop();
      throw e;
    }
  }

  schedule() {
    if (!this.running) return;
    this.timer = setTimeout(() => this.tick(), MIN_INTERVAL);
  }

  async tick() {
    if (!this.running) return;
    try {
      if (Date.now() >= this.pausedUntil && this.video.readyState >= 2 && !document.hidden) {
        const hit = await this.decodeFrame();
        if (hit) this.handle(hit);
      }
    } catch { /* إطار غير صالح — نكمل */ }
    this.schedule(); // التحليل التالي يبدأ فقط بعد انتهاء الحالي
  }

  // نقص المنطقة داخل الإطار مع مراعاة object-fit: cover
  grabROI() {
    const v = this.video;
    const vw = v.videoWidth, vh = v.videoHeight;
    const bw = v.clientWidth || vw, bh = v.clientHeight || vh;
    if (!vw || !vh) return false;
    const s = Math.max(bw / vw, bh / vh);
    const offX = (vw * s - bw) / 2, offY = (vh * s - bh) / 2;
    const sx = Math.max(0, (ROI.x * bw + offX) / s);
    const sy = Math.max(0, (ROI.y * bh + offY) / s);
    const sw = Math.min(vw - sx, (ROI.w * bw) / s);
    const sh = Math.min(vh - sy, (ROI.h * bh) / s);
    const k = Math.min(1, ROI_MAX_WIDTH / sw);
    const w = Math.round(sw * k), h = Math.round(sh * k);
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    this.ctx.drawImage(v, sx, sy, sw, sh, 0, 0, w, h);
    return true;
  }

  async decodeFrame() {
    if (!this.grabROI()) return null;
    // قارئ الجهاز أولاً؛ إذا ما لقى شي لفترة نجرّب محرك WebAssembly بالتناوب
    const useNative = this.native && (this.misses < 12 || this.misses % 2 === 0);
    let hit = null;
    if (useNative) {
      const codes = await this.native.detect(this.canvas);
      if (codes[0]?.rawValue) hit = { text: codes[0].rawValue, format: codes[0].format };
    } else {
      const img = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
      const r = await getWasm().decode(img);
      if (r.text) hit = { text: r.text, format: r.format };
    }
    this.misses = hit ? 0 : this.misses + 1;
    return hit;
  }

  handle({ text, format }) {
    const code = normBarcode(text);
    if (!code) return;
    // EAN/UPC فيها رقم تحقق فقراءة وحدة كافية؛ باقي الأنواع نأكدها بقراءتين متطابقتين
    if (!isRetail(format) && this.pendingCode !== code) { this.pendingCode = code; return; }
    this.pendingCode = null;
    const now = Date.now();
    if (code === this.last && now - this.lastAt < SAME_CODE_GAP) { this.lastAt = now; return; }
    this.last = code;
    this.lastAt = now;
    this.pausedUntil = now + PAUSE_AFTER_HIT;
    this.onCode(code);
  }

  async refocus() {
    const t = this.track;
    if (!t || t.readyState !== 'live') return;
    try {
      const caps = t.getCapabilities?.() ?? {};
      if (!caps.focusMode?.includes('single-shot')) return;
      await t.applyConstraints({ advanced: [{ focusMode: 'single-shot', pointsOfInterest: [{ x: 0.5, y: 0.5 }] }] });
      setTimeout(() => { if (caps.focusMode.includes('continuous')) t.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {}); }, 800);
    } catch { /* غير مدعوم */ }
  }

  stop() {
    this.running = false;
    this.tapTarget?.removeEventListener('click', this.onTap);
    this.track = null;
    clearTimeout(this.timer);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.last = null;
  }
}

export function cameraError(e) {
  switch (e?.name) {
    case 'InsecureContext': return 'الكاميرا تحتاج رابط https';
    case 'NotAllowedError': return 'تم رفض إذن الكاميرا — اسمح بها من إعدادات المتصفح';
    case 'NotFoundError':
    case 'OverconstrainedError': return 'لم يتم العثور على كاميرا';
    case 'NotReadableError': return 'الكاميرا مستخدمة من تطبيق آخر';
    default: return 'تعذّر تشغيل الكاميرا';
  }
}
