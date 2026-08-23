#!/usr/bin/env node
/**
 * رقيب صناعي — يشتري وهمياً كل نصف ساعة ليكتشف العطل قبل العميل.
 *
 * كل الحرّاس الأخرى تراقب الكتالوج؛ ولا شيء يراقب المسار الذي يجلب المال.
 * لو غيّرت سلة نقاط السلة، أو كسر فخّ الـ19 رقماً، أو رفض الدفع — لا أحد
 * يعلم حتى يشتكي عميل. هذا الملف يجرّب السلسلة كاملةً على متجرك الحيّ.
 *
 * ولا يُتمّ أي طلب: يسكّ سلة ضيف، يضيف صنفاً، يطلب رابط الدفع، ثم يُفرغها.
 */
import fs from 'node:fs';
import path from 'node:path';

const cfg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '../store.config.json'), 'utf8'));
const H = {
  'Store-Identifier': cfg.storeId,
  'accept-language': cfg.lang,
  currency: cfg.currency,
  Accept: 'application/json',
};
const HJ = { ...H, 'Content-Type': 'application/json' };

const fails = [];
const notes = [];
const fail = (m) => { fails.push(m); console.error('  ✗ ' + m); };
const ok = (m) => { notes.push(m); console.log('  ✓ ' + m); };

async function get(url, init) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 20000);
  try { return await fetch(url, { headers: H, ...init, signal: ac.signal }); }
  finally { clearTimeout(t); }
}

// ── ١) نضارة الملفّات المنشورة ─────────────────────────────────────
// يكشف الحالة التي يعمى عنها `if: failure()`: المهمّة لم تعمل أصلاً
// (GitHub يوقف الجدولة على المستودعات الخاملة، والتشغيل قد يُلغى).
const FRESH = [
  { name: 'الكتالوج', url: cfg.catalogUrl, maxHours: 3 },
  { name: 'المخزون', url: cfg.stockUrl, maxHours: 1 },
];
for (const f of FRESH) {
  try {
    const r = await get(`${f.url}?cb=${Date.now()}`);
    if (!r.ok) { fail(`${f.name}: HTTP ${r.status}`); continue; }
    const j = JSON.parse(await r.text());
    const ageH = (Date.now() - Date.parse(j.generatedAt)) / 3.6e6;
    if (!Number.isFinite(ageH)) fail(`${f.name}: طابع زمني غير صالح`);
    else if (ageH > f.maxHours) fail(`${f.name}: قديم ${ageH.toFixed(1)} ساعة (الحدّ ${f.maxHours})`);
    else ok(`${f.name} طازج (${(ageH * 60).toFixed(0)} دقيقة)`);
  } catch (e) { fail(`${f.name}: ${String(e).slice(0, 60)}`); }
}

// ── ٢) سلسلة الشراء كاملةً ─────────────────────────────────────────
let cartId = null;
try {
  const catalog = JSON.parse(await (await get(cfg.catalogUrl)).text());
  // اختر صنفاً حيّاً بمقاس متوفّر — أي شيء آخر يُنتج إنذاراً كاذباً
  const p = catalog.products.find((x) =>
    x.status !== 'out' && x.price > 0 && x.options?.some((o) => o.values.some((v) => !v.out)));
  if (!p) throw new Error('لا منتج صالح للاختبار في الكتالوج');

  const options = {};
  for (const o of p.options) {
    const v = o.values.find((x) => !x.out);
    if (v) options[o.id] = Number(v.id);
  }

  const txt = await (await get(`${cfg.api}/cart/latest`)).text();
  cartId = txt.match(/"id"\s*:\s*"?(\d{15,})"?/)?.[1];
  if (!cartId) throw new Error('تعذّر سكّ سلة');
  ok(`سُكّت سلة ${cartId.slice(-6)}`);

  const add = await get(`${cfg.api}/cart/${cartId}/item/${p.id}/add`, {
    method: 'POST', headers: HJ,
    body: JSON.stringify({ id: Number(p.id), quantity: 1, options }),
  });
  const aj = JSON.parse(await add.text());
  if (!aj?.success) throw new Error(`رفض الإضافة: HTTP ${add.status} ${JSON.stringify(aj?.error?.fields ?? {}).slice(0, 80)}`);
  ok(`أُضيف ${p.name.slice(0, 26)}`);

  // السعر المنشور يجب أن يطابق ما تحسبه سلة
  const storeTotal = aj?.data?.cart?.total?.amount;
  if (Number.isFinite(storeTotal) && Math.abs(storeTotal - p.price) >= 1) {
    fail(`انحراف سعر: الكتالوج ${p.price} · سلة ${storeTotal}`);
  } else ok(`السعر مطابق (${storeTotal})`);

  const st = JSON.parse(await (await get(`${cfg.api}/cart/${cartId}/status?guest_checkout=1`)).text());
  const url = st?.data?.next_step?.url;
  if (!url || !url.includes('/checkout/')) throw new Error('لم يُرجَع رابط دفع');
  const page = await get(url);
  if (!page.ok) throw new Error(`صفحة الدفع HTTP ${page.status}`);
  ok('وصلت صفحة الدفع');
} catch (e) {
  fail(`سلسلة الشراء: ${String(e.message ?? e).slice(0, 120)}`);
} finally {
  // لا تترك سلال اختبار معلّقة
  if (cartId) {
    try {
      const d = JSON.parse(await (await get(`${cfg.api}/cart/${cartId}`)).text());
      const c = Array.isArray(d?.data) ? d.data[0] : d?.data;
      for (const it of c?.items ?? []) {
        await get(`${cfg.api}/cart/${cartId}/item/${it.id}`, { method: 'DELETE' });
      }
    } catch {}
  }
}

console.log(`\n${fails.length ? '✗' : '✓'} ${notes.length} فحصاً ناجحاً · ${fails.length} فشلاً`);
if (fails.length) {
  fs.writeFileSync(process.env.CANARY_OUT ?? '/tmp/canary.txt', fails.join('\n'));
  process.exit(1);
}
