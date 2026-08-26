-- 費用報銷三段補課（R11/R13）＋使用者連結員工的查重（R11）。
--
-- ① 作廢層（欄位形狀照 0025）：核准後發現金額打錯，原本 approved/paid 一律鎖死，
--    手工反向傳票救得了總帳、救不了 401——vat.ts 的進項直接 join expense_items，
--    那張多報的進項稅照樣進媒體檔。作廢＝反向傳票沖回＋voided_at 標記，
--    401 與彙總一律以 voided_at 排除；status 保持原值（「它曾被核准」是事實）。
--    reversal_entry_id 沖核准傳票；已付款的另有 paid_reversal_entry_id 沖付款傳票。
-- ② 核准留痕：approve 端點原本連登入者都沒取——財務可以核准自己送的單，
--    而且單據上查不到誰核准的（唯一留痕的 audit_logs 只有 admin 看得到）。
--    approved_by_user_id / approved_at 落在單據上，人人查得到自己那張是誰核的。
-- ③ paid_by（R13）：公司信用卡付的費用也要走報銷（進項稅才進 401），原本要靠
--    「建一個假員工當付款主體」的沒被文件化的 workaround。'company' 的單在核准時
--    直接貸付款科目、狀態進 paid，不經過「其他應付款→付款」兩段。
-- ④ users.employee_id 查重：兩個帳號連到同一個員工＝一個人的報銷紀錄（住哪、吃什麼）
--    全開給另一個帳號，且能以他的名義送單。partial unique（多個 NULL 合法：
--    不連結員工的帳號如純管理者帳號可以有很多個）。

ALTER TABLE expense_claims ADD COLUMN approved_by_user_id integer REFERENCES users(id);
ALTER TABLE expense_claims ADD COLUMN approved_at timestamptz;
ALTER TABLE expense_claims ADD COLUMN paid_by text NOT NULL DEFAULT 'employee'
  CHECK (paid_by IN ('employee', 'company'));
ALTER TABLE expense_claims ADD COLUMN voided_at timestamptz;
ALTER TABLE expense_claims ADD COLUMN voided_by integer REFERENCES users(id);
ALTER TABLE expense_claims ADD COLUMN void_reason text;
ALTER TABLE expense_claims ADD COLUMN reversal_entry_id integer REFERENCES journal_entries(id);
ALTER TABLE expense_claims ADD COLUMN paid_reversal_entry_id integer REFERENCES journal_entries(id);

-- 既有資料若已經兩帳號連同一員工，建索引會失敗——與其讓啟動時炸出一句
-- 「duplicate key」誰也看不懂，先自己檢查並把「哪個員工被誰們連著」講清楚。
-- 不自動解除連結：解除哪一個是管理者的決定，系統沒有立場替他挑。
DO $$
DECLARE dup text;
BEGIN
  SELECT string_agg(format('員工 #%s 被使用者 %s 同時連結', employee_id, usernames), '；')
    INTO dup
    FROM (
      SELECT employee_id, string_agg(username, '、') AS usernames
        FROM users
       WHERE employee_id IS NOT NULL
       GROUP BY employee_id
      HAVING count(*) > 1
    ) d;
  IF dup IS NOT NULL THEN
    RAISE EXCEPTION '無法建立 users.employee_id 唯一索引：%。請先在「設定」頁把重複的連結解除（每個員工只能連一個帳號），再重新啟動', dup;
  END IF;
END $$;

CREATE UNIQUE INDEX uq_users_employee_id ON users (employee_id) WHERE employee_id IS NOT NULL;
