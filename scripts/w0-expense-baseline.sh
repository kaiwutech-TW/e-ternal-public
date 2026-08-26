#!/bin/sh
# W0 基線量測：報銷單的「每單明細筆數分布」與「明細解析成功率」——**只讀，不寫任何一列**。
#
# 用法：./scripts/w0-expense-baseline.sh（在 repo 根目錄；容器名依 compose 專案而定，
#   可用 BASELINE_CONTAINER 覆蓋。連法與 scripts/backup.sh 一致：docker exec 進 db 容器跑 psql，
#   不需要 DATABASE_URL，也就不必把密碼放進這支腳本的環境。）
# 輸出：純文字表格到 stdout，直接貼進 deepseekHarnessDoc/w0-baseline.md。
#
# ⚠️ 這支腳本**只能**回答兩個問題，其餘一律不要拿它的輸出去推論
# ────────────────────────────────────────────────────────────────────
# ① 每張報銷單有幾筆明細（expense_items 對 claim_id 的分組計數）。
# ② 明細裡 doc_type = 'einvoice' 的比例。這個數字叫「**解析成功率**」。
#
# 為什麼 ② 不可以叫「原件有沒有 QR」：
#   `receipt` 是解析結果的 fallback，同時包含「這張憑證本來就沒有 QR」與
#   「有 QR 但沒掃出來」（後者正是 W1 在修的雙碼缺陷）。兩者在資料庫裡長得一模一樣。
#   把 receipt 讀成「無 QR」，會把 W1 的缺陷算成使用者的憑證特性，整個優先序就反了。
#   真正的無 QR 比例只有人眼看原始憑證才知道，見 w0-baseline.md 的前瞻抽樣一節。
#
# 為什麼沒有「分類改選率」：
#   退回重送（expenses.ts 的 resubmitClaim／R11）會把舊明細整批刪掉再插新的，
#   舊分類不留任何一列；audit 依隱私紀律只記 method/path/status，不記 body 與欄位 diff
#   （audit.ts 開頭那段）。所以歷史表反推不出「初選是什麼、後來被改成什麼」——
#   算出來的任何數字都不是那個現象。這裡選擇不算，而不是算一個近似值。
#
# ⚠️ 目前這個資料庫裝的是 demo-data.ts 灌的**示範公司**（捏造的假資料）。
#   腳本會盡力偵測並在最上面標明。示範資料的數字不能拿來排任何工作包的優先序。
set -eu

DIR="$(cd "$(dirname "$0")/.." && pwd)"
CONTAINER="${BASELINE_CONTAINER:-$(docker compose -f "$DIR/docker-compose.yml" ps -q db 2>/dev/null || true)}"
[ -n "$CONTAINER" ] || {
  echo "找不到 db 容器（compose 是否啟動？docker daemon 是否在跑？）" >&2
  echo "本腳本只讀資料；請自行啟動既有環境後重跑，**不要** docker compose down -v。" >&2
  exit 1
}

# psql 的 -v ON_ERROR_STOP=1：任何一段 SQL 出錯就整支停下來，不要印半截報表還回 0。
# SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY 是這支腳本「只讀」的機器保證——
# 靠人眼檢查 SQL 裡沒有 UPDATE 是失敗開放的（日後有人加一段就破功），
# 讓資料庫把整個 session 鎖成唯讀，寫入會是硬錯誤而不是靜默生效。
docker exec -i "$CONTAINER" psql -U twerp -d twerp -v ON_ERROR_STOP=1 <<'SQL'
SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;

\echo '=============================================================='
\echo 'W0 報銷基線（只讀）'
\echo '=============================================================='
\echo ''
\echo '── 0. 這份資料是不是示範資料 ──────────────────────────────'
-- demo-data.ts 的示範統編一律以 '0' 開頭（見該檔 DEMO_TAX_IDS 的說明）。
-- 這不是保證，只是一個明顯的訊號：命中就幾乎確定是示範庫，沒命中也不代表是真實使用資料。
SELECT
  (SELECT count(*) FROM partners)                                AS 交易對象數,
  (SELECT count(*) FROM partners WHERE tax_id LIKE '0%')         AS 統編以0開頭數,
  CASE WHEN (SELECT count(*) FROM partners WHERE tax_id LIKE '0%') > 0
       THEN '極可能是 demo-data.ts 的示範公司：數字不得用於排優先序'
       ELSE '未偵測到示範統編特徵（仍需人工確認來源）' END        AS 判讀;

\echo ''
\echo '── 1. 觀測期間與母體 ──────────────────────────────────────'
-- 樣本數與期間必須跟每一個比例一起看：3 張單算出的 67% 不是 67%，是「樣本不足」。
SELECT
  count(*)                                   AS 報銷單總數,
  count(*) FILTER (WHERE voided_at IS NULL)  AS 未作廢單數,
  count(*) FILTER (WHERE voided_at IS NOT NULL) AS 已作廢單數,
  min(claim_date)                            AS 最早報銷日,
  max(claim_date)                            AS 最晚報銷日,
  min(created_at)::date                      AS 最早建立日,
  max(created_at)::date                      AS 最晚建立日
FROM expense_claims;

\echo ''
\echo '   （狀態分布：rejected 的單代表至少被重送過一次的可能性，'
\echo '     但重送次數本身沒有留痕——見腳本開頭說明，不要從這欄推改選率）'
SELECT status, count(*) AS 單數 FROM expense_claims GROUP BY status ORDER BY 單數 DESC;

\echo ''
\echo '── 2. 每張報銷單的明細筆數分布 ────────────────────────────'
\echo '   定義：expense_items 依 claim_id 分組的列數。資料來源：expense_items。'
-- 這行 echo 會被原樣貼進報告，所以它的措辭必須跟下面的 WHERE 一字不差地對得上：
-- 下面每一段都帶 voided_at IS NULL，本節就不能宣稱母體「含作廢」。這一包是量基線不是做報表，
-- 作廢單只需要一個總數（第 1 節已印 已作廢單數），不另做一份分布。
\echo '   母體：未作廢的報銷單（voided_at IS NULL）；作廢單只在第 1 節計數，不在此做分布。'
WITH per_claim AS (
  SELECT c.id, c.voided_at, count(i.id) AS n
  FROM expense_claims c
  LEFT JOIN expense_items i ON i.claim_id = c.id
  GROUP BY c.id, c.voided_at
)
SELECT
  count(*)                        AS 樣本數_單,
  min(n)                          AS 最少明細數,
  max(n)                          AS 最多明細數,
  round(avg(n), 2)                AS 平均,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY n) AS 中位數,
  percentile_cont(0.9) WITHIN GROUP (ORDER BY n) AS p90
FROM per_claim
WHERE voided_at IS NULL;

\echo ''
\echo '   直方圖（未作廢單）：'
WITH per_claim AS (
  SELECT c.id, count(i.id) AS n
  FROM expense_claims c
  LEFT JOIN expense_items i ON i.claim_id = c.id
  WHERE c.voided_at IS NULL
  GROUP BY c.id
)
-- 分組鍵與排序鍵分開：直接 ORDER BY 文字會把 '10+' 排在 '5-9' 前面（字串比較），
-- 讀者會以為直方圖的桶少了一個或順序錯了
, bucketed AS (
  SELECT
    CASE WHEN n = 0 THEN '0（空單）'
         WHEN n <= 4 THEN n::text
         WHEN n <= 9 THEN '5-9'
         ELSE '10+' END AS label,
    CASE WHEN n <= 4 THEN n WHEN n <= 9 THEN 5 ELSE 6 END AS sort_key
  FROM per_claim
)
SELECT label AS 明細筆數, count(*) AS 單數
FROM bucketed
GROUP BY label, sort_key
ORDER BY sort_key;

\echo ''
\echo '── 3. 明細的 doc_type 分布＝「解析成功率」 ─────────────────'
\echo '   定義：doc_type = ''einvoice'' 的明細數 ÷ 明細總數。'
\echo '   ⚠️ 這是「掃描＋解析成功」的比例，**不是**「原件印有 QR」的比例。'
\echo '      receipt 同時含真的無 QR 與 QR 沒掃到（W1 修的缺陷），兩者無法從資料庫分開。'
\echo '   資料來源：expense_items.doc_type（enum: einvoice / receipt / other）。'
SELECT
  i.doc_type                                                   AS 憑證型別,
  count(*)                                                     AS 明細數,
  round(100.0 * count(*) / nullif(sum(count(*)) OVER (), 0), 1) AS 佔比百分比
FROM expense_items i
JOIN expense_claims c ON c.id = i.claim_id
WHERE c.voided_at IS NULL
GROUP BY i.doc_type
ORDER BY 明細數 DESC;

\echo ''
\echo '   彙總（樣本數不足時請直接寫「不足」，不要引用下面的百分比）：'
SELECT
  count(*)                                              AS 明細總數,
  count(*) FILTER (WHERE i.doc_type = 'einvoice')       AS 解析成功數,
  round(100.0 * count(*) FILTER (WHERE i.doc_type = 'einvoice')
        / nullif(count(*), 0), 1)                       AS 解析成功率百分比
FROM expense_items i
JOIN expense_claims c ON c.id = i.claim_id
WHERE c.voided_at IS NULL;

\echo ''
\echo '   附帶事實（給 W7 判斷「歷史賣方分類候選」冷啟動有多冷）：'
\echo '   seller_tax_id 是 W7 唯一能當 key 的欄位。它在 claimInput 裡是獨立的選填欄位，'
\echo '   與 doc_type／qrPayload 無關——任何 API 呼叫者都能在非 einvoice 的明細上填它，'
\echo '   所以「有統編的多半是解析成功的」只是這批資料觀察到的相關性，不是任何規則保證的。'
\echo '   下面直接數實際有統編的明細，不要拿解析成功率去推 W7 的可用量。'
SELECT
  count(DISTINCT i.seller_tax_id)                          AS 出現過的賣方統編數,
  count(*) FILTER (WHERE i.seller_tax_id IS NOT NULL)       AS 有統編的明細數,
  count(*)                                                 AS 明細總數
FROM expense_items i
JOIN expense_claims c ON c.id = i.claim_id
WHERE c.voided_at IS NULL;

\echo ''
\echo '=============================================================='
\echo '以上只有兩個可引用的量：每單明細筆數分布、解析成功率。'
\echo '拍照到送出的秒數／真正無 QR 比例／分類改選率都不在這裡，'
\echo '也算不出來（原因見腳本開頭）。要那三個數字請走前瞻抽樣。'
\echo '=============================================================='
SQL
