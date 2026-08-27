#!/usr/bin/env node
/**
 * i18n 掃描（零相依）：
 *   node scripts/i18n-scan.mjs            → 報告
 *   node scripts/i18n-scan.mjs --strict   → 有孤兒 key 就 exit 1（給 CI）
 *
 * 報三件事：
 * 1. 孤兒 key：字典裡有、程式碼裡沒有任何 t("…")／AppError(…, "…") 用到——通常是中文原句改了字
 * 2. 未翻 key：程式碼用了 t("…") 但字典沒有（照檔案分組，方便挑 demo 路徑先翻）
 * 3. 還沒包 t() 的中文 JSX 文字（粗估，只看 apps/web/src/pages 的 >中文< 與 "中文" 字面值），量工作量用
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const strict = process.argv.includes("--strict");
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
function dictKeys(file) {
  const src = readFileSync(file, "utf8");
  const keys = new Set();
  for (const m of src.matchAll(/^\s*"((?:[^"\\]|\\.)*)":\s*"/gm)) keys.add(m[1].replace(/\\"/g, '"'));
  return keys;
}
// t("…") / t('…') / AppError(NNN, "…")
const USE_RE = /(?:\bt\(|(?:AppError|fail)\(\s*\d+\s*,\s*)\s*(["'])((?:(?!\1)[^\\]|\\.)*)\1/g;

function scan(label, srcDir, dictFile) {
  const dict = dictKeys(join(ROOT, dictFile));
  const used = new Map(); // key -> files
  for (const f of walk(join(ROOT, srcDir))) {
    const src = readFileSync(f, "utf8");
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
  for (const [f, ks] of [...byFile].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${f}（${ks.length}）`);
    for (const k of ks.slice(0, 5)) console.log(`     ${k}`);
    if (ks.length > 5) console.log(`     …還有 ${ks.length - 5} 條`);
  }
  return orphans.length;
}

let orphanTotal = 0;
orphanTotal += scan("apps/web", "apps/web/src", "apps/web/src/locales/en.ts");
orphanTotal += scan("apps/api", "apps/api/src", "apps/api/src/locales/en.ts");

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

if (strict && orphanTotal > 0) process.exit(1);
