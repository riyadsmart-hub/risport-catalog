#!/usr/bin/env node
/**
 * مسار المخزون السريع — يعمل كل ١٠ دقائق، مستقلّاً عن المزامنة الكاملة.
 *
 * المزامنة الكاملة ثقيلة (تقرأ صفحات المنتجات لاستخراج الخيارات والمعرض)
 * فتعمل كل ساعة. لكن المخزون يتغيّر أسرع من ذلك بكثير، وعميل يشتري مقاساً
 * نفد قبل أربعين دقيقة هو خطأ يراه العميل. هذا الملف يعالج ذلك وحده.
 *
 *   GET /products/{id}/details?with[]=skus   → ٣٧ ك.ب بدل ١١٠ للصفحة
 *
 * 🔑 منطق التوفّر — أهمّ سطر هنا:
 * `related_option_values` هي **التركيبة كاملةً** (لون + مقاس)، لا قيمة واحدة.
 * فقيمة الخيار متوفّرة إن كان **أيّ** تركيب يحويها فيه مخزون. أخذُ العنصر
 * الأول فقط يجعل لوناً كامل النفاد لمجرّد نفاد مقاس واحد منه
 * (قِيس: ٢١ خطأ من ٢٥٨؛ وبالمنطق الصحيح ٢٨٩/٢٨٩ مطابقة).
 */
import fs from 'node:fs';
import path from 'node:path';

const cfg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '../store.config.json'), 'utf8'));
const OUT = process.env.STOCK_OUT
  ? path.resolve(process.env.STOCK_OUT)
  : path.join(import.meta.dirname, '../assets/data/stock.json');
const CATALOG = process.env.CATALOG_IN
  ? path.resolve(process.env.CATALOG_IN)
  : path.join(import.meta.dirname, '../assets/data/catalog.json');

const H = {
  'Store-Identifier': cfg.storeId,
  'accept-language': cfg.lang,
  currency: cfg.currency,
  Accept: 'application/json',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: H });
      if (r.ok) return JSON.parse(await r.text());
    } catch {}
    await sleep(400 * (i + 1));
  }
  return null;
}

const catalog = JSON.parse(fs.readFileSync(CATALOG, 'utf8'));

const out = {};                  // productId → [valueId نافدة]
const gone = [];                 // منتجات نفدت كلّها
let checked = 0, failed = 0;

for (const p of catalog.products) {
  const d = (await getJson(`${cfg.api}/products/${p.id}/details?with%5B%5D=skus`))?.data;
  if (!d) { failed++; continue; }
  checked++;

  if (d.is_available === false || d.is_out_of_stock === true) { gone.push(p.id); continue; }

  const skus = (d.skus ?? []).filter((s) => Array.isArray(s.related_option_values) && s.related_option_values.length);
  if (!skus.length) continue;                                  // منتج بلا تركيبات

  // كم تركيباً فيه مخزون لكل قيمة خيار
  const live = {};
  for (const s of skus) {
    for (const vid of s.related_option_values) {
      const k = String(vid);
      live[k] = (live[k] ?? 0) + (s.stock_quantity > 0 ? 1 : 0);
    }
  }

  const sold = [];
  for (const opt of p.options ?? []) {
    for (const v of opt.values) {
      if (live[v.id] === 0) sold.push(v.id);                    // كل تركيباته صفر
    }
  }
  if (sold.length) out[p.id] = sold;
}

// حارس: لا تنشر نتيجة نصفها فاشل — الإبقاء على القديم أأمن من نشر كذب
if (failed > catalog.products.length / 3) {
  console.error(`✗ فشل ${failed} من ${catalog.products.length} — لا تُنشر`);
  process.exit(1);
}

const payload = {
  generatedAt: new Date().toISOString(),
  checked,
  failed,
  gone,
  out,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(payload));

const soldCount = Object.values(out).reduce((n, a) => n + a.length, 0);
console.log(`✓ ${checked} منتجاً · ${soldCount} قيمة نافدة · ${gone.length} منتجاً نفد كلّه · فشل ${failed}`);
console.log(`  ${(fs.statSync(OUT).size / 1024).toFixed(1)} ك.ب → ${path.basename(OUT)}`);
