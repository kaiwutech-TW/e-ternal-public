-- 二階段驗證（TOTP）：公網部署前的安全批次最後一項
--
-- 為什麼要做：登入節流（0017）把密碼猜測從「每天幾十萬次」壓到「每天幾百次」，
-- 但它對**密碼已經外洩**的情況一點用都沒有——外洩的密碼第一次就會對。
-- 而密碼外洩不需要本系統出事：同事在別的網站用了同一組密碼、手機被安裝了鍵盤側錄，
-- 都會讓那一次登入完全合法。第二因子是唯一能把「知道密碼」與「就是本人」分開的東西。
--
-- ★ 設計紀律一：**自願啟用，不是強制**。
--   強制會在升級的那一刻把所有人擋在門外（包含唯一的管理者），而十人公司沒有人可以求救。
--   建議寫在文件裡（公網部署請至少替管理者帳號啟用），選擇權留給使用者。
--
-- ★ 設計紀律二：**備援碼是必要的，不是選配**。
--   手機掉了、換手機忘了搬移、app 被誤刪——這些都不是意外，是必然會發生的事。
--   沒有備援碼的二階段驗證，最後一定會變成「請工程師直接改資料庫」，
--   而那條路徑一旦被走過一次就會變成常態，等於二階段驗證從此形同虛設。
--   備援碼以 scrypt 雜湊儲存（與密碼同一個格式），單次有效，用掉即記時間不刪除——
--   「這組碼被用過」本身是稽核資訊。
--
-- ★ 設計紀律三：**密鑰要加密儲存**。
--   密碼存的是雜湊（不可逆），但 TOTP 密鑰必須可逆才驗得了，所以資料庫拿到手就等於
--   第二因子全破。這裡沿用 PII_KEY 那把金鑰（services/pii.ts）——同一台主機、
--   同一個威脅模型，沒有理由為它再開一個金鑰管理流程。未設 PII_KEY 時存明文，
--   與身分證號同樣的取捨：內網可接受，啟動時有警告。
--
-- ★ 唯一的逃生門寫成腳本而不是 API：scripts/disable-totp.ts 需要資料庫存取權才跑得動。
--   做成 API 就等於在系統裡放一個「關掉二階段驗證」的端點，那是攻擊者最想要的東西。

ALTER TABLE users ADD COLUMN totp_secret text;              -- 加密儲存；NULL＝從未設定
ALTER TABLE users ADD COLUMN totp_enabled_at timestamptz;   -- NULL＝密鑰已產生但尚未驗證通過（未生效）

-- 備援碼。刻意獨立一張表而不是塞成 users 的陣列欄位：
-- 每一組碼有自己的「被用掉的時間」，那是稽核資訊，塞進陣列就記不下來
CREATE TABLE totp_recovery_codes (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id),
  code_hash text NOT NULL,          -- scrypt，格式與 users.password_hash 相同（s2$salt$hash）
  created_at timestamptz NOT NULL DEFAULT now(),
  used_at timestamptz               -- NULL＝還沒用過。用掉不刪，留著才知道「用掉了幾組」
);

CREATE INDEX totp_recovery_codes_user_idx ON totp_recovery_codes (user_id);
