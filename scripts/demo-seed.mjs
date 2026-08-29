#!/usr/bin/env node
/**
 * Demo 資料灌入（WebMCP Challenge 展示站用）：對「跑起來的站」透過 API 灌一套英文示範資料——
 * 客戶/供應商、商品、進貨（庫存與成本）、報價（各種狀態）、轉單、出貨（銷貨＋應收）、
 * 營業稅參數（附出處備註）、評審用帳號。跑完儀表板／損益表／應收帳齡都有東西看。
 *
 * 冪等：偵測到第一個 demo 客戶已存在就直接退出（要重灌請開新資料庫或重啟記憶體模式）。
 *
 * 用法：
 *   node scripts/demo-seed.mjs                          # 對 http://localhost:3000
 *   BASE_URL=https://demo.example.com node scripts/demo-seed.mjs
 *   ADMIN_USER=admin ADMIN_PASS=xxx node scripts/demo-seed.mjs   # 站上已有帳號時
 *
 * 站是全新的（還在「建立管理者帳號」畫面）時，會自動用 ADMIN_USER/ADMIN_PASS 建立管理者。
 */

const BASE = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const ADMIN_USER = process.env.ADMIN_USER ?? "admin";
const ADMIN_PASS = process.env.ADMIN_PASS ?? "demo-erp-2026";
const JUDGE_USER = process.env.JUDGE_USER ?? "judge";
const JUDGE_PASS = process.env.JUDGE_PASS ?? "webmcp-judge";

let cookie = "";

async function call(method, path, body) {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
      "accept-language": "en",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const detail = typeof json?.error === "string" ? json.error : JSON.stringify(json ?? text);
    throw new Error(`${method} ${path} → HTTP ${res.status}: ${detail}`);
  }
  return json;
}
const get = (p) => call("GET", p);
const post = (p, b) => call("POST", p, b);

/** N 天前（YYYY-MM-DD）——資料貼著今天長，儀表板「本月」永遠有數字 */
const d = (daysAgo) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);

async function main() {
  console.log(`Seeding ${BASE} …`);

  // 1. 登入（全新站先建管理者）
  const { needsSetup } = await get("/auth/setup-status");
  if (needsSetup) {
    await post("/auth/setup", { username: ADMIN_USER, displayName: "Demo Admin", password: ADMIN_PASS });
    console.log(`✓ created admin account "${ADMIN_USER}"`);
  } else {
    await post("/auth/login", { username: ADMIN_USER, password: ADMIN_PASS });
    console.log(`✓ logged in as "${ADMIN_USER}"`);
  }

  // 2. 冪等檢查
  const existing = await get("/partners");
  if (existing.some((p) => p.name === "ACME Corporation")) {
    console.log("Demo data already present — nothing to do.");
    return;
  }

  // 3. 營業稅參數（零斷言紀律：稅率是使用者資料，這裡以 demo 身分填入並附出處）。
  //    遷移可能已帶一列既有值——有生效中的 vat 列就沿用，不重複建。
  const taxParams = (await get("/tax-parameters")).rows;
  if (!taxParams.some((p) => p.kind === "vat" && p.validTo === null)) {
    await post("/tax-parameters", {
      kind: "vat",
      label: "VAT 5% (demo)",
      validFrom: "2020-01-01",
      brackets: [{ from: 0, to: null, mode: "rate_on_total", rateBp: 500 }],
      sourceNote: "Demo dataset. Taiwan Business Tax Act Art. 10 — verify with your accountant.",
    });
    console.log("✓ VAT parameter (5%, with source note)");
  } else {
    console.log("✓ VAT parameter already present (from migration) — kept as-is");
  }

  // 4. 交易對象與商品
  const partner = (name, extra) => post("/partners", { name, ...extra });
  const acme = await partner("ACME Corporation", { isCustomer: true, taxId: "12345675" });
  const blue = await partner("Blue Harbor Trading", { isCustomer: true });
  const nova = await partner("Nova Retail Group", { isCustomer: true });
  const formosa = await partner("Formosa Components Ltd.", { isSupplier: true });
  await partner("Pacific Supplies Co.", { isSupplier: true });

  const product = (b) => post("/products", b);
  const widgetPro = await product({ sku: "WID-100", name: "Widget Pro", unit: "pcs", listPrice: 1500 });
  const widgetMini = await product({ sku: "WID-050", name: "Widget Mini", unit: "pcs", listPrice: 800 });
  const hub = await product({ sku: "HUB-200", name: "Control Hub", unit: "pcs", listPrice: 5200 });
  const install = await product({ sku: "SVC-01", name: "Installation Service", unit: "job", listPrice: 3000, isService: true });
  await product({ sku: "SVC-02", name: "Annual Maintenance Plan", unit: "yr", listPrice: 12000, isService: true });
  console.log("✓ 5 partners, 5 products");

  // 5. 進貨（先有庫存與移動平均成本，之後才能出貨）
  await post("/purchases", {
    partnerId: formosa.id,
    docDate: d(45),
    lines: [
      { productId: widgetPro.id, qty: 200, unitPrice: 900 },
      { productId: widgetMini.id, qty: 300, unitPrice: 450 },
      { productId: hub.id, qty: 40, unitPrice: 3600 },
    ],
  });
  await post("/purchases", {
    partnerId: formosa.id,
    docDate: d(18),
    lines: [
      { productId: widgetPro.id, qty: 100, unitPrice: 950 },
      { productId: hub.id, qty: 20, unitPrice: 3700 },
    ],
  });
  console.log("✓ 2 purchase receipts (inventory + moving-average cost)");

  // 6. 報價：成交轉單出貨 ×2、洽談中 ×1、未成交 ×1
  const quote = (partnerId, daysAgo, lines, memo) =>
    post("/quotes", { partnerId, quoteDate: d(daysAgo), lines, ...(memo ? { memo } : {}) });

  const q1 = await quote(acme.id, 30, [
    { productId: widgetPro.id, qty: 80, unitPrice: 1500 },
    { productId: install.id, qty: 1, unitPrice: 3000 },
  ], "Q3 rollout, phase 1");
  const o1 = await post(`/quotes/${q1.id}/convert`, { orderDate: d(28) });
  await post(`/orders/${o1.id}/ship`, { docDate: d(25) });

  const q2 = await quote(blue.id, 14, [
    { productId: hub.id, qty: 12, unitPrice: 5200 },
    { productId: widgetMini.id, qty: 100, unitPrice: 780 },
  ]);
  const o2 = await post(`/quotes/${q2.id}/convert`, { orderDate: d(12) });
  await post(`/orders/${o2.id}/ship`, { docDate: d(8) });

  await quote(nova.id, 5, [
    { productId: widgetPro.id, qty: 150, unitPrice: 1450 },
    { productId: install.id, qty: 2, unitPrice: 3000 },
  ], "Waiting for budget approval");

  const qLost = await quote(nova.id, 40, [{ productId: hub.id, qty: 5, unitPrice: 5000 }]);
  await post(`/quotes/${qLost.id}/lost`);
  console.log("✓ 4 quotes (2 won→shipped, 1 open, 1 lost)");

  // 7. 進行中訂單：部分出貨（儀表板「在手訂單」有數字）
  const o3 = await post("/orders", {
    partnerId: nova.id,
    orderDate: d(6),
    lines: [
      { productId: widgetMini.id, qty: 120, unitPrice: 800 },
      { productId: widgetPro.id, qty: 40, unitPrice: 1500 },
    ],
  });
  const o3detail = (await get("/orders")).find((o) => o.id === o3.id);
  await post(`/orders/${o3.id}/ship`, {
    docDate: d(2),
    lines: [{ orderLineId: o3detail.lines[0].id, qty: 60 }],
  });
  console.log("✓ 1 open order, partially shipped");

  // 8. 評審帳號（finance：看得到全部頁面與報表、可開報價；gm 在後端一律唯讀，submit_draft 會 403）
  await post("/users", { username: JUDGE_USER, displayName: "Guest Judge", password: JUDGE_PASS, role: "finance" });
  console.log(`✓ judge account "${JUDGE_USER}" (role: finance)`);

  console.log(`
Done. Demo dataset ready at ${BASE}
  admin: ${ADMIN_USER} / ${ADMIN_PASS}
  judge: ${JUDGE_USER} / ${JUDGE_PASS}
Try in the browser agent: "What did we sell this month?" → "Draft a quote for ACME: 50 Widget Pro plus installation."`);
}

main().catch((e) => {
  console.error(`Seed failed: ${e.message}`);
  process.exit(1);
});
