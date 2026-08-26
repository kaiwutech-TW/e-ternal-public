-- Agent 接入層：API 金鑰（機器登入）＋ LLM 供應商設定
--
-- 為什麼要做這一批：本專案的定位是「API-first，AI Agent 原生接入」，但在此之前
-- agent 進得來的唯一方式是 apps/mcp 拿**人的帳號密碼**去登入。這件事有三個問題，
-- 而第三個是這一批的直接導火線：
--   ① 帳密給了機器就等於給了完整的人類身分（能改密碼、能登入畫面）；
--   ② 密碼輪替時沒有任何地方查得到「哪些機器在用這組密碼」；
--   ③ **二階段驗證（0019/0020）上線後，帳密登入會被 TotpRequiredError 擋下**——
--      機器沒有手機，等於「開了 2FA 就不能用 agent」。這不是可以接受的取捨。
--
-- ★ 設計紀律一：**API 金鑰依附在使用者身上，不自成一套權限**。
--   金鑰帶 user_id，請求進來後解析成同一個 AuthUser，之後走完全相同的 ACL、
--   完全相同的操作日誌。理由是「權限的單一事實來源」——另立一套 scope 機制的話，
--   權限就有兩份會漂移的定義，而漂移的那一天沒有人會發現。
--   要限制 agent 能做什麼，做法是**給它一個角色受限的專用帳號**（見 docs/mcp.md），
--   不是在金鑰上另外長出一套權限模型。
--
-- ★ 設計紀律二：**金鑰只存雜湊，明文只在產生的那一刻出現一次**。
--   與備援碼（0019）同一個做法、同一個理由。前 8 碼另存明文當作辨識前綴，
--   讓管理者在列表上分得出「這把是哪一把」而不必把整串存起來。
--
-- ★ 設計紀律三：**金鑰略過二階段驗證是刻意的，不是漏洞**。
--   第二因子的用途是證明「螢幕前面是本人」，而 agent 前面本來就沒有人。
--   代價（金鑰外洩＝無第二道防線）用另外三件事補：可即時撤銷、
--   每次使用都更新 last_used_at（看得出來還活著沒）、所有動作都進操作日誌。
--
-- ★ agent_settings 只會有一列（單列設定表），用 CHECK 把它釘死。
--   api_key 欄位沿用 PII_KEY 加密（services/pii.ts）——它是一把會產生費用的憑證，
--   與身分證號、TOTP 密鑰同一個保護層級。

CREATE TABLE api_keys (
  id serial PRIMARY KEY,
  name text NOT NULL,                    -- 人看的用途說明，如「Claude Desktop（會計助理）」
  prefix text NOT NULL,                  -- 明文前 8 碼，列表辨識用（不足以還原金鑰）
  key_hash text NOT NULL,                -- scrypt，格式與 users.password_hash 相同
  user_id integer NOT NULL REFERENCES users(id),   -- 這把金鑰就是「以這個人的身分」呼叫
  created_by integer REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,              -- NULL＝從未使用；用來判斷哪些金鑰可以撤掉
  revoked_at timestamptz                 -- 撤銷不刪除：刪掉就查不出「這把金鑰做過什麼」
);

CREATE INDEX api_keys_user_idx ON api_keys (user_id);

-- LLM 供應商設定（單列）。系統本身不呼叫 LLM——這張表是給「跑在旁邊的 agent」
-- 一個統一的設定位置，讓金鑰不必散落在各人的環境變數裡。
CREATE TABLE agent_settings (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),   -- 單列，釘死
  provider text NOT NULL DEFAULT 'anthropic',        -- anthropic / openai / google / azure-openai / ollama / custom
  model text NOT NULL DEFAULT '',                    -- 刻意不預設任何型號：寫死的型號會過期，而過期的預設值比空值更難發現
  base_url text,                                     -- 自架或代理端點；NULL＝用供應商官方端點
  api_key text,                                      -- 加密儲存（PII_KEY），NULL＝尚未設定
  enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by integer REFERENCES users(id)
);

INSERT INTO agent_settings (id) VALUES (1);
