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

/**
 * ترتيب المقاسات — المتجر يُرجعها بترتيب إدخالها لا بترتيبها المنطقي
 * (شوهد: 42 · 42.5 · 43.5 · 44 … ثم 36 · 37). ونتعامل مع ثلاث صيغ:
 *   رقمية      «42.5»                    → بالرقم
 *   حرفية      «M: 35-37» · «XL: 40-45»  → بسلّم S→XXL
 *   ذات لاحقة  «42 للطلب تواصل معنا»      → بالرقم المستخرج، وتُؤخّر عن نظيرتها
 */
const LETTER = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL'];

function sizeRank(name) {
  const t = String(name ?? '').trim();
  const num = t.match(/^\s*(\d+(?:[.,]\d+)?)/);
  if (num) {
    const v = parseFloat(num[1].replace(',', '.'));
    const bare = /^\s*\d+(?:[.,]\d+)?\s*$/.test(t);
    return [0, v, bare ? 0 : 1, t];        // المجرّد قبل ذي اللاحقة
  }
  const letter = LETTER.findIndex((l) => new RegExp(`^${l}\\b`, 'i').test(t));
  if (letter >= 0) return [1, letter, 0, t];
  return [2, 0, 0, t];                      // ما لا يُفهم يبقى في الآخر بترتيبه النصّي
}

function bySize(a, b) {
  const x = sizeRank(a), y = sizeRank(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return String(x[3]).localeCompare(String(y[3]), 'ar');
}

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
        values: (o.details ?? []).map((d) => ({
        id: String(d.id),
        name: clean(d.name),
        out: !!d.is_out,                       // نافد — نعرضه باهتاً بدل أن يكتشفه عند الدفع
      })),
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

    // رتّب قيم خيار المقاس **داخل الخيار نفسه** — شاشة المنتج ترسم من options
    for (const o of options) {
      if (/مقاس|size/i.test(o.name ?? '')) o.values.sort((a, b) => bySize(a.name, b.name));
    }

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

  // ── كشف التغيّر مقابل النسخة السابقة ────────────────────────────────
  // يفيد ثلاثة أشياء: قسم «وصل حديثاً» في التطبيق، وأساس الإشعارات لاحقاً،
  // وسجلّ يخبرك ما تغيّر في متجرك دون أن تفتح اللوحة.
  let changes = { added: [], removed: [], priceUp: [], priceDown: [], restocked: [] };
  try {
    const prev = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    const before = new Map((prev.products ?? []).map((p) => [p.id, p]));
    const after = new Map(products.map((p) => [p.id, p]));

    for (const [id, p] of after) {
      const b = before.get(id);
      if (!b) { changes.added.push({ id, name: p.name, price: p.price }); continue; }
      if (b.price != null && p.price != null && b.price !== p.price) {
        (p.price > b.price ? changes.priceUp : changes.priceDown)
          .push({ id, name: p.name, from: b.price, to: p.price });
      }
      // عاد للمخزون: قيمة كانت نافدة ولم تعد
      const wasOut = new Set((b.options ?? []).flatMap((o) => o.values.filter((v) => v.out).map((v) => v.id)));
      const back = (p.options ?? []).flatMap((o) =>
        o.values.filter((v) => !v.out && wasOut.has(v.id)).map((v) => `${o.name} ${v.name}`));
      if (back.length) changes.restocked.push({ id, name: p.name, values: back });
    }
    for (const [id, b] of before) if (!after.has(id)) changes.removed.push({ id, name: b.name });
  } catch { /* أول تشغيل — لا سابق نقارن به */ }

  // حارس جودة: اختفاء مفاجئ لثلث المنتجات يعني عطلاً في سلة لا حذفاً حقيقياً.
  // نشرُ كتالوج ناقص أسوأ من الإبقاء على القديم — التطبيق يعرض ما لا يوجد.
  if (changes.removed.length > Math.max(3, products.length * 0.3)) {
    console.error(`✗ اختفى ${changes.removed.length} منتجاً دفعة واحدة — يُرجَّح عطل لا حذف. لا تُنشر.`);
    process.exit(1);
  }

  const CHANGES = path.join(path.dirname(OUT), 'changes.json');
  fs.writeFileSync(CHANGES, JSON.stringify({ at: catalog.generatedAt, ...changes }, null, 2));

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(catalog, null, 2));

  const withOpts = products.filter((p) => p.options.length).length;
  const withImgs = products.filter((p) => p.images.length).length;
  console.log(`\n✓ ${products.length} منتجاً → ${path.relative(process.cwd(), OUT)}`);
  console.log(`  خيارات: ${withOpts}/${products.length} · صور: ${withImgs}/${products.length}`);
  console.log(`  ماركات: ${catalog.brands.join(' · ')}`);

  const chg = [
    changes.added.length && `+${changes.added.length} جديد`,
    changes.removed.length && `-${changes.removed.length} مُزال`,
    changes.priceUp.length && `↑${changes.priceUp.length} سعر`,
    changes.priceDown.length && `↓${changes.priceDown.length} سعر`,
    changes.restocked.length && `↺${changes.restocked.length} عاد للمخزون`,
  ].filter(Boolean);
  console.log(`  تغيّرات: ${chg.length ? chg.join(' · ') : 'لا شيء'}`);
}

main();
