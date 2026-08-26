-- 內建 agent 的公司記憶（OKF 形狀存 DB；DECISIONS 2026-08-13 的成長機制）
--
-- ★ 為什麼是 DB 表不是檔案：記憶必須讓 admin 在設定頁可見可改可刪——
--   非工程師使用者管不了 git。欄位照 OKF（Open Knowledge Format）的慣例：
--   name/title/tags/status/stale_after——與 .flightwake 知識庫同一套紀律。
--
-- ★ 成長迴圈與責任紅線同構：agent 只能「提議」（status='proposed'），
--   admin 核准才進入 active、才會出現在之後每一輪對話的索引裡。
--   絕不讓 agent 自己改自己的腦——不可稽核的行為漂移比沒有記憶更糟。
--
-- ★ 檢索走「索引注入＋按名讀取＋關鍵字搜尋」（agentic retrieval，2026 小語料共識），
--   刻意不建 embedding pipeline；條目破數百再上 pgvector（我們本來就在 Postgres 上）。
--
-- ★ 汰舊：stale_after 到期的條目**退出索引**並在管理頁標示待覆核——
--   記憶不整併不汰舊會爛掉（consolidation ceiling）；封存用 status='archived' 不刪列。

CREATE TABLE agent_memories (
  id serial PRIMARY KEY,
  name text NOT NULL UNIQUE,          -- kebab-case slug（索引與 read_memory 的鍵）
  title text NOT NULL,                -- 一行摘要：注入索引用，寫得好壞決定 agent 找不找得到
  body text NOT NULL,
  type text NOT NULL DEFAULT 'fact',  -- fact | preference | process | reference（自由字串）
  tags text NOT NULL DEFAULT '',      -- 逗號分隔
  status text NOT NULL DEFAULT 'proposed',  -- proposed | active | archived
  source text NOT NULL DEFAULT 'user',      -- user（admin 直接建）| agent（對話中提議）
  stale_after date,                   -- NULL＝不過期
  proposed_by integer REFERENCES users(id),
  approved_by integer REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
