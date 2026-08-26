-- 操作日誌：誰、什麼時候、對哪個東西做了什麼、成不成功（使用者五步計畫的步驟④＋安全批次③）
--
-- 為什麼要做這一批：在此之前，系統對「發生過什麼事」只有兩種殘缺的記憶——
--   ① 單據上的 created_by：只記得**建立者**，不記得誰核准、誰作廢、誰改了主檔、誰產了申報檔；
--   ② 什麼都沒有：主檔（客戶、商品、科目）與設定是覆寫式的，改了就沒了，
--      連「有人改過」這件事都查不到。
-- 內網時這件事的風險有限（打得到系統的人都在辦公室裡）；上公網之後，
-- 「有沒有人動過」與「是不是本人動的」變成必須回答得出來的問題，而目前一句也答不出來。
--
-- ★ 設計紀律一：**絕不記錄請求內容（body）**。
--   記 body 是最直覺的做法，也是最容易變成災難的做法——登入的 body 裡有密碼，
--   建立交易對象的 body 裡有身分證號，改密碼的 body 裡有新密碼。
--   「用關鍵字過濾掉敏感欄位」是**失敗開放**的設計：以後任何人新增一個 PII 欄位，
--   都會在沒有人注意的情況下自動流進日誌，而日誌是刻意不刪的。
--   所以這裡走**失敗封閉**：預設什麼都不記，只記結構性的事實（方法、路徑、狀態碼），
--   外加兩樣白名單過的東西：201 回應中的 id（純數字，不可能是 PII）、
--   以及路由自己主動填的 note（由寫程式的人逐一決定，不是自動抓的）。
--
-- ★ 設計紀律二：**這張表只增不刪，也沒有自動清理**。
--   login_failures（0017）是為了計數而存在、過期就刪；這張表正好相反。
--   兩者刻意分成兩張表，就是因為「為了稽核不敢刪」與「為了計數必須刪」放在一起會互相打架。
--   容量不是問題：十人公司一天數百筆寫入，一年約十萬列。
--
-- ★ 設計紀律三：**它記得到「誰動了什麼」，記不到「值從什麼變成什麼」**——
--   這件事要誠實寫出來，不要讓人以為有前後值可查。要前後值必須在領域表本身做版本化
--   （像 tax_parameters 那樣 append-only），那是各張表自己的事，不是日誌能補的。
--
-- ★ 為什麼 user_id 可以是 NULL：登入失敗、未登入就打 API 的嘗試，正是最需要留下紀錄的事件，
--   而那時沒有使用者。username 因此另存一份當下的字串快照（登入失敗時只有這個線索）。

CREATE TABLE audit_logs (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  user_id integer REFERENCES users(id),   -- NULL＝未登入（登入失敗、未授權的嘗試）
  username text NOT NULL DEFAULT '',      -- 當下的帳號字串快照；未登入的嘗試只有這個
  role user_role,                         -- NULL＝未登入
  method text NOT NULL,
  path text NOT NULL,                     -- 已正規化（去掉單埠部署的 /api 前綴）
  status integer NOT NULL,                -- 含 4xx：被擋下的嘗試才是安全上最該看的東西
  source text NOT NULL DEFAULT '',        -- 來源位址，取不到時空字串
  target_id integer,                      -- 201 回應 body 的 id；只取這一個欄位（見紀律一）
  note text NOT NULL DEFAULT ''           -- 路由主動補的一句話，預設沒有
);

-- 查詢形狀就兩種：「最近發生什麼」與「某個人做過什麼」，兩者都是時間新到舊
CREATE INDEX audit_logs_at_idx ON audit_logs (at DESC);
CREATE INDEX audit_logs_user_at_idx ON audit_logs (user_id, at DESC);
