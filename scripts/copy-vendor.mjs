// ينسخ قارئ الباركود (zxing-wasm) إلى public/vendor ليُخدم من نفس الموقع ويعمل أوفلاين
import { cpSync, mkdirSync } from 'node:fs';
const src = 'node_modules/zxing-wasm/dist';
mkdirSync('public/vendor', { recursive: true });
cpSync(`${src}/iife/reader/index.js`, 'public/vendor/zxing-reader.js');
cpSync(`${src}/reader/zxing_reader.wasm`, 'public/vendor/zxing_reader.wasm');
console.log('vendor: zxing-wasm copied');
