#!/usr/bin/env node
/**
 * i18n 掃描（零相依）：
 *   node scripts/i18n-scan.mjs            → 報告
 *   node scripts/i18n-scan.mjs --strict   → 有孤兒 key 或跨字典衝突就 exit 1（給 CI）
 *
 * 報三件事：
 * 1. 孤兒 key：字典裡有、程式碼裡沒有任何 t("…")／AppError(…, "…") 用到——通常是中文原句改了字
 * 2. 未翻 key：程式碼用了 t("…") 但字典沒有（照檔案分組，方便挑 demo 路徑先翻）
 * 3. 還沒包 t() 的中文 JSX 文字（粗估，只看 apps/web/src/pages 的 >中文< 與 "中文" 字面值），量工作量用
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const strict = process.argv.includes("--strict");
/** --emit：把「未翻 key」依來源檔分組寫成 JSON（翻譯者照這份填進 locales/en/<檔名>.ts） */
const emitIdx = process.argv.indexOf("--emit");
const emitPath = emitIdx > 0 ? process.argv[emitIdx + 1] : null;
const emitted = {};
const CJK = /[一-鿿]/;

function walk(dir, out = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (f === "node_modules" || f === "dist") continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f) && !/\/locales\//.test(p) && !/\/test\//.test(p)) out.push(p);
  }
  return out;
}
/** 讀 locales/en/ 底下所有字典檔的 key（以及 locales/en.ts 本身）；同時收集每個 key 在各檔的值，供衝突偵測 */
const dictValues = new Map(); // key -> Map(file -> value)
function dictKeys(dir) {
  const keys = new Set();
  const files = [join(dir, "en.ts"), ...readdirSync(join(dir, "en")).map((f) => join(dir, "en", f))];
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/^\s*"((?:[^"\\]|\\.)*)":\s*"((?:[^"\\]|\\.)*)"/gm)) {
      const k = m[1].replace(/\\"/g, '"');
      keys.add(k);
      if (!dictValues.has(k)) dictValues.set(k, new Map());
      dictValues.get(k).set(relative(ROOT, file), m[2]);
    }
  }
  return keys;
}
/** 同一 key 在多份字典有**不同**英文：index 用 spread 合併，後者無聲蓋掉前者——列出來讓人統一 */
function reportConflicts(label) {
  const rows = [];
  for (const [k, byFile] of dictValues) {
    const distinct = new Set(byFile.values());
    if (distinct.size > 1) rows.push([k, byFile]);
  }
  console.log(`\n== ${label} 跨字典衝突（同 key 不同值，後 spread 者勝）：${rows.length} ==`);
  for (const [k, byFile] of rows) {
    console.log(`  「${k}」`);
    for (const [f, v] of byFile) console.log(`     ${f.split("/").pop().padEnd(24)} ${v}`);
  }
  dictValues.clear();
  return rows.length;
}
// t("…") / t('…') / AppError(NNN, "…")
const USE_RE = /(?:\bt(?:r)?\(|(?:AppError|fail)\(\s*\d+\s*,\s*)\s*(["'])((?:(?!\1)[^\\]|\\.)*)\1/g;

function scan(label, srcDir, dictDir) {
  const dict = dictKeys(join(ROOT, dictDir));
  const used = new Map(); // key -> files
  for (const f of walk(join(ROOT, srcDir))) {
    // `"…" +\n "…"` 拼接的字面值：runtime key 是整句，這裡先合併再比對（否則只看到第一段、誤報未翻）
    const src = readFileSync(f, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "") // 區塊註解裡的範例不是 key
      .replace(/"\s*\+\s*\n?\s*"/g, "");
    for (const m of src.matchAll(USE_RE)) {
      const k = m[2].replace(/\\(["'])/g, "$1");
      if (!used.has(k)) used.set(k, new Set());
      used.get(k).add(relative(ROOT, f));
    }
  }
  const orphans = [...dict].filter((k) => !used.has(k));
  const missing = [...used].filter(([k]) => !dict.has(k) && CJK.test(k));
  console.log(`\n== ${label}: 字典 ${dict.size} 條／程式碼用到 ${used.size} 個 key ==`);
  console.log(`孤兒 key（字典有、沒人用）：${orphans.length}`);
  for (const k of orphans) console.log(`  - ${k}`);
  console.log(`未翻 key（程式碼有、字典沒有）：${missing.length}`);
  const byFile = new Map();
  for (const [k, files] of missing) for (const f of files) (byFile.get(f) ?? byFile.set(f, []).get(f)).push(k);
  if (emitPath) for (const [f, ks] of byFile) emitted[f] = Object.fromEntries(ks.map((k) => [k, ""]));
  for (const [f, ks] of [...byFile].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${f}（${ks.length}）`);
    for (const k of ks.slice(0, 5)) console.log(`     ${k}`);
    if (ks.length > 5) console.log(`     …還有 ${ks.length - 5} 條`);
  }
  return orphans.length;
}

let orphanTotal = 0;
let conflictTotal = 0;
orphanTotal += scan("apps/web", "apps/web/src", "apps/web/src/locales");
conflictTotal += reportConflicts("apps/web");
orphanTotal += scan("apps/api", "apps/api/src", "apps/api/src/locales");
conflictTotal += reportConflicts("apps/api");
if (emitPath) {
  writeFileSync(emitPath, JSON.stringify(emitted, null, 2) + "\n");
  console.log(`\n未翻 key 已寫到 ${emitPath}（${Object.keys(emitted).length} 個來源檔）`);
}

// 3. 還沒包 t() 的 JSX 中文（粗估）
console.log("\n== apps/web/src/pages 還沒包 t() 的中文行（粗估，量工作量用） ==");
const rows = [];
for (const f of walk(join(ROOT, "apps/web/src"))) {
  const lines = readFileSync(f, "utf8").split("\n");
  let n = 0;
  for (const l of lines) {
    const code = l.replace(/\/\/.*$/, "").replace(/\{\/\*.*?\*\/\}/g, "");
    if (/^\s*(\*|\/\*)/.test(l)) continue;
    if (CJK.test(code) && !/\bt\(/.test(code)) n++;
  }
  if (n) rows.push([relative(ROOT, f), n]);
}
rows.sort((a, b) => b[1] - a[1]);
for (const [f, n] of rows) console.log(`  ${String(n).padStart(4)}  ${f}`);
console.log(`  總計 ${rows.reduce((s, r) => s + r[1], 0)} 行`);

if (strict && (orphanTotal > 0 || conflictTotal > 0)) process.exit(1);
