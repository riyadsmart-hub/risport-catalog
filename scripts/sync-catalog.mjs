#!/usr/bin/env node
/**
 * يبني catalog.json تلقائياً من واجهة متجر ري سبورت العامة — بلا تصدير يدوي،
 * وبلا متصفّح، وبلا أي واجهة إدارية. يعمل في أي جدولة (GitHub Actions مثلاً).
 *
 *   node scripts/sync-catalog.mjs [--out assets/data/catalog.json]
 *
 * المصادر (كلّها تحتاج ترويسة Store-Identifier وحدها):
 *   GET /store/v1/categories                                   → شجرة التصنيفات
 *   GET /store/v1/products?source=categories&source_value[]=…   → منتجات كل تصنيف
 *   GET /store/v1/products/{id}/details                         → وصف وسعر وصور
 *   GET /ar/x/p{id}  (HTML)                                     → معرّفات الخيارات
 *
 * ⚠️ فخّان مقيسان:
 *   · `source_value` **يجب أن يكون مصفوفة** `source_value[]=` وإلا رجعت صفر نتائج.
 *   · `/products` بلا تصنيف مقفول على ١٥ نتيجة ويتجاهل الترقيم — لذلك نمرّ على
 *     كل التصنيفات ونوحّد المعرّفات.
 */
import fs from 'node:fs';
import path from 'node:path';

const STORE_ID = '1713072379';
const API = 'https://api.salla.dev/store/v1';
const SITE = 'https://risport-sa.com';
// مسار الإخراج قابل للتهيئة ليعمل داخل مستودع الكتالوج أو داخل التطبيق
const OUT = process.env.CATALOG_OUT
  ? path.resolve(process.env.CATALOG_OUT)
  : path.join(import.meta.dirname, '../assets/data/catalog.json');

const H = {
  'Store-Identifier': STORE_ID,
  'accept-language': 'ar',
  currency: 'SAR',
  Accept: 'application/json',
};

const SPORTS = ['كرة الطائرة', 'الجري', 'المشي', 'كرة السلة', 'كرة القدم'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: H });
      if (r.ok) return await r.json();
    } catch {}
    await sleep(400 * (i + 1));
  }
  return null;
}

const clean = (v) =>
  v == null ? null
    : String(v).replace(/<[^>]+>/g, ' ').replace(/&nbsp;?/g, ' ')
        .replace(/\s+/g, ' ').trim() || null;

/** يفكّ ترميز HTML entities في قيمة سمة */
const unescapeAttr = (s) =>
  s.replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&amp;/g, '&')
   .replace(/&lt;/g, '<').replace(/&gt;/g, '>');

/**
 * الخيارات **والمعرض** موجودان في HTML المخدوم — لا حاجة لمتصفّح.
 * `details` من الـAPI يعطي صورة واحدة بعرض ٥٠٠ فقط، والمعرض داخل
 * `<salla-slider id="details-slider-{id}">` في الصفحة.
 */
async function fetchProductPage(productId) {
  try {
    const html = await (await fetch(`${SITE}/ar/x/p${productId}`)).text();

    let options = [];
    const m = html.match(/<salla-product-options[^>]*\soptions="([^"]*)"/);
    if (m) {
      options = JSON.parse(unescapeAttr(m[1])).map((o) => ({
        id: String(o.id),
        name: clean(o.name),
        required: !!o.required,
        values: (o.details ?? []).map((d) => ({ id: String(d.id), name: clean(d.name) })),
      }));
    }

    let images = [];
    const i = html.indexOf(`id="details-slider-${productId}"`);
    const j = html.indexOf('</salla-slider>', i);
    if (i > 0 && j > i) {
      images = [...new Set(
        [...html.slice(i, j).matchAll(/(?:src|data-src)="(https:\/\/cdn\.salla\.sa\/[^"]+)"/g)]
          .map((x) => x[1])
      )];
    }
    return { options, images };
  } catch {
    return { options: [], images: [] };
  }
}

async function main() {
  // ── ١) شجرة التصنيفات ──────────────────────────────────────────────
  const catsRoot = (await getJson(`${API}/categories`))?.data ?? [];
  const cats = [];
  (function walk(list) {
    for (const c of list) {
      const id = (c.url ?? '').split('/c').pop();
      if (/^\d+$/.test(id)) cats.push({ id, name: clean(c.name) });
      walk(c.sub_categories ?? []);
    }
  })(catsRoot);
  console.log(`… ${cats.length} تصنيفاً`);

  // ── ٢) اتحاد المنتجات عبر التصنيفات ───────────────────────────────
  const found = new Map();                       // id → { product, cats:Set }
  for (const c of cats) {
    const d = await getJson(
      `${API}/products?source=categories&filterable=1&source_value%5B%5D=${c.id}&per_page=100`
    );
    for (const p of d?.data ?? []) {
      if (!found.has(p.id)) found.set(p.id, { p, cats: new Set() });
      found.get(p.id).cats.add(c.name);
    }
  }
  console.log(`… ${found.size} منتجاً فريداً`);

  // ── ٣) التفاصيل والخيارات ─────────────────────────────────────────
  const products = [];
  let done = 0;
  for (const [id, { p, cats: cnames }] of found) {
    if (p.is_available === false) { done++; continue; }   // المخفيّ/النافد لا يُعرض

    const det = (await getJson(`${API}/products/${id}/details`))?.data ?? {};
    const { options, images: gallery } = await fetchProductPage(id);

    const names = [...cnames];
    const sport = SPORTS.find((s) => names.some((n) => n && n.includes(s))) ?? null;
    const isShoe = names.some((n) => n && n.includes('أحذية')) ||
                   /حذاء/.test(det.name ?? p.name ?? '');

    const sizeOpt = options.find((o) => /مقاس|size/i.test(o.name ?? ''));
    const colorOpt = options.find((o) => /لون|color/i.test(o.name ?? ''));

    const price = det.sale_price || det.price || p.price || null;
    const regular = det.regular_price || det.price || null;

    // المعرض من الصفحة، وإلا الصورة الوحيدة من الـAPI
    const imgs = gallery.length ? gallery
      : [det.image?.url].filter((u) => typeof u === 'string' && u.startsWith('http'));

    products.push({
      id: String(id),
      sallaId: String(id),
      sku: clean(det.sku ?? p.sku),
      name: clean(det.name ?? p.name),
      brand: clean(det.brand?.name ?? p.brand?.name) ?? 'أخرى',
      category: isShoe ? 'shoes' : 'gear',
      sport,
      tags: names.filter((n) => n && !SPORTS.includes(n)),
      price: price ? Number(price) : null,
      compareAt: regular && price && Number(regular) > Number(price) ? Number(regular) : null,
      tagline: clean(det.promotion_title ?? p.promotion_title),
      description: clean(det.description ?? p.description),
      images: imgs,
      optionNames: { size: sizeOpt?.name ?? null, color: colorOpt?.name ?? null },
      sizes: sizeOpt?.values.map((v) => v.name) ?? [],
      colors: colorOpt?.values.map((v) => v.name) ?? [],
      options,
      model: null,
      url: `${SITE}/ar/x/p${id}`,
    });
    if (++done % 5 === 0) process.stdout.write(`\r  ${done}/${found.size}`);
  }

  products.sort((a, b) =>
    (a.category === 'shoes' ? 0 : 1) - (b.category === 'shoes' ? 0 : 1) ||
    a.brand.localeCompare(b.brand, 'ar') || (a.price ?? 0) - (b.price ?? 0));

  const catalog = {
    version: 3,
    generatedAt: new Date().toISOString(),
    source: 'storefront-api',
    store: { name: 'ري سبورت', url: SITE, currency: 'SAR' },
    brands: [...new Set(products.map((p) => p.brand))].sort(),
    sports: [...new Set(products.map((p) => p.sport).filter(Boolean))].sort(),
    products,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(catalog, null, 2));

  const withOpts = products.filter((p) => p.options.length).length;
  const withImgs = products.filter((p) => p.images.length).length;
  console.log(`\n✓ ${products.length} منتجاً → ${path.relative(process.cwd(), OUT)}`);
  console.log(`  خيارات: ${withOpts}/${products.length} · صور: ${withImgs}/${products.length}`);
  console.log(`  ماركات: ${catalog.brands.join(' · ')}`);
}

main();
