// قارئ الباركود — يشتغل بخيط منفصل (Web Worker) حتى ما تعلق الواجهة.
// المحرّك: zxing-cpp مترجم لـ WebAssembly (أسرع بكثير من نسخة JavaScript).
importScripts('/vendor/zxing-reader.js');

const ready = ZXingWASM.prepareZXingModule({
  overrides: {
    locateFile: (path, prefix) => (path.endsWith('.wasm') ? '/vendor/zxing_reader.wasm' : prefix + path),
  },
  fireImmediately: true,
});

const OPTIONS = {
  formats: ['EAN13', 'EAN8', 'UPCA', 'UPCE', 'Code128', 'Code39', 'Code93', 'ITF', 'Codabar', 'QRCode', 'DataMatrix'],
  tryHarder: true,
  tryRotate: false,
  tryInvert: false,
  maxNumberOfSymbols: 1,
};

ready.then(() => postMessage({ type: 'ready' }), (e) => postMessage({ type: 'error', message: String(e) }));

onmessage = async ({ data }) => {
  const { id, width, height, buffer } = data;
  try {
    await ready;
    const img = new ImageData(new Uint8ClampedArray(buffer), width, height);
    const results = await ZXingWASM.readBarcodes(img, OPTIONS);
    const hit = results.find((r) => r.isValid && r.text);
    postMessage({ type: 'result', id, text: hit?.text ?? null, format: hit?.format ?? null });
  } catch (e) {
    postMessage({ type: 'result', id, text: null, error: String(e) });
  }
};
