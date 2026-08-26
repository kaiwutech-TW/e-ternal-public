# 安裝流程

> 這份是「**把系統裝起來**」。裝好之後要怎麼用、按什麼順序導入，看 [`SOP.md`](./SOP.md)。
> 部署形狀的細節與環境變數對照表在 [`deployment.md`](./deployment.md)。
>
> 本檔同時給人和 agent 用：每一步都有可複製的指令與**可驗證的完成條件**，
> agent 執行時請逐步核對完成條件，不要看到指令沒報錯就當作成功。

## 先決定：你要哪一種

| 情境 | 選這個 | 資料會不會留著 |
|---|---|---|
| 想先玩玩看、評估功能 | **A. 試用模式** | ❌ 重啟就清空 |
| 公司內部用，10 人以內，同一個辦公室或 VPN | **B. 內網單機** | ✅ |
| 要從外面連（在家、手機、多據點） | **C. 公網／雲端** | ✅ |
| 要改程式 | **D. 開發機** | ✅（自備 Postgres） |

---

## A. 試用模式（3 分鐘，免資料庫）

```sh
git clone <repo> && cd tw_erp
pnpm install
pnpm --filter @tw-erp/web build
pnpm --filter @tw-erp/api dev:memory
```

瀏覽器開 `http://localhost:3000`。

**完成條件**：看到「初始設定：建立管理者帳號」的畫面。

想直接看到一家有資料的公司（10 個客戶、12 項商品＋2 個服務項目、6 份合約、期初帳），
不要從空的開始：

```sh
node --experimental-strip-types apps/api/scripts/demo-data.ts
```

> ⚠️ 試用模式的資料庫在記憶體裡，**這支腳本要對著有持久化的資料庫跑才有意義**
> （見 B 的最後一步）。試用模式請改用 `dev:memory` 啟動前先灌，或直接用 B。

---

## B. 內網單機（正式，建議大多數公司用這個）

### B-1 主機需求

- Linux 或 macOS，2 core / 2GB RAM 起（10 人公司的實測用量遠低於此）
- Docker 與 Docker Compose v2（`docker compose version` 要有輸出）
- 要用加密備份的話另需 `gnupg`

### B-2 安裝

```sh
git clone <repo> && cd tw_erp
printf 'POSTGRES_PASSWORD=%s\n' "$(openssl rand -base64 24)" > .env
chmod 600 .env
docker compose up -d --build
```

**完成條件**（三個都要過）：

```sh
docker compose ps                      # app 與 db 都是 running/healthy
curl -s localhost:3000/api/auth/setup-status   # → {"needsSetup":true}
docker compose logs app | grep migrations      # → migrations + seed 完成
```

> `docker compose up` 即使啟動失敗退出碼仍是 0——**一定要自己看 `ps` 的狀態**。

### B-3（選用，但要做就得**現在**做）灌示範資料

想先用假資料熟悉系統的話，**必須在建立管理者之前**灌：

```sh
docker compose exec app node --experimental-strip-types apps/api/scripts/demo-data.ts
```

腳本會拒絕灌進已經有人建檔的資料庫（實測訊息：「資料庫已有 0 筆交易對象與 1 個使用者，
拒絕灌入示範資料」）。這是刻意的防呆——示範資料混進真帳是不可逆的。
真的要在非空的庫上灌請帶 `--force`，但你八成不該這樣做。

灌完會印出 5 個示範帳號（密碼 `demo-1234`）。**跳到 B-5**，不必再建管理者。

> ⚠️ **正式啟用前務必清空重來**：`docker compose down -v && docker compose up -d --build`
> （`-v` 會刪掉資料卷，不可逆）。示範資料裡的每一個數字——含統編、身分證號、
> 稅率、扣繳費率——都是捏造的。

### B-4 建立第一個管理者

瀏覽器開 `http://<主機 IP>:3000`，照畫面建立管理者帳號。
這個入口在建完第一個帳號後**永久關閉**。

**完成條件**：能登入，左側看得到「首頁／設定」等選單。

### B-5 排程備份

```sh
crontab -e
# 每日 02:00
0 2 * * * cd /path/to/tw_erp && ./scripts/backup.sh >> backups/backup.log 2>&1
```

**完成條件**：手動跑一次 `./scripts/backup.sh`，`backups/` 出現 `.sql.gz`，
而且**實際還原到一個測試庫確認打得開**（沒演練過的備份不算備份）。

---

## C. 公網／雲端

先做完 B-1 到 B-4，然後：

```sh
# 網域要真的解析到這台主機，且 80/443 通得到（caddy 要靠它申請憑證）
echo "SITE_ADDRESS=erp.example.com" >> .env
echo "PII_KEY=$(openssl rand -base64 32)" >> .env
docker compose -f docker-compose.yml -f docker-compose.public.yml up -d --build
```

**完成條件**：

```sh
curl -sI https://erp.example.com | head -1        # → HTTP/2 200
curl -sI http://<主機IP>:3000 2>&1 | head -1      # → 連不上（app 不該再直接對外）
```

**上線前必做的四件事**：

1. 替管理者帳號啟用**二階段驗證**（設定頁 → 二階段驗證），備援碼抄下來放手機以外的地方
2. 設定**備份加密**：`BACKUP_PASSPHRASE`（通行語與備份分開保管，遺失＝備份永久打不開）
3. 確認 `.env` 是 `chmod 600` 且沒有進版控
4. 讀 `deployment.md` 的「上線前還缺什麼」——那是誠實清單，你要自己決定接不接受

⚠️ **`PII_KEY` 一旦開始使用就不能遺失也不能更換**：身分證號、TOTP 密鑰、LLM 金鑰
都用它加密。請與備份分開保管一份。

---

## D. 開發機

```sh
pnpm install
pnpm typecheck && pnpm test          # 應該全綠（769 項）
pnpm --filter @tw-erp/web build

export DATABASE_URL=postgres://user:pw@localhost:5432/twerp
node --experimental-strip-types apps/api/scripts/migrate.ts
node --experimental-strip-types apps/api/src/server.ts
```

前端熱重載：另開一個終端跑 `pnpm --filter @tw-erp/web dev`（vite proxy 不剝 `/api` 前綴）。

---

## 升級

```sh
cd /path/to/tw_erp
./scripts/backup.sh                  # 先備份，不要跳過
git pull
docker compose up -d --build         # 重啟時自動套用新 migration（冪等，只補新檔）
docker compose ps                    # 自己確認狀態
```

已套用的 migration 記在資料庫的 `schema_migrations`，重啟只補沒跑過的檔。
升級**不需要**設定任何新的環境變數——所有安全相關的變數都是「未設＝維持既有行為＋出聲提醒」。

---

## 給 agent 的接入（裝完之後）

1. 在「設定 → 使用者管理」建一個**角色受限的專用帳號**（例如只給 `sales`）
2. 在「設定 → Agent 接入」替它產生 API 金鑰（明文只顯示一次）
3. 註冊 MCP：

```sh
claude mcp add tw-erp \
  -e TWERP_URL=http://localhost:3000/api \
  -e TWERP_API_KEY=twerp_sk_… \
  -- node --experimental-strip-types /path/to/tw_erp/apps/mcp/src/server.ts
```

4. 讓 agent 先讀 `agent/soul.md`（身分與底線）與 `agent/skill.md`（能力與操作手冊）

**完成條件**：agent 問得出「現在有多少現金」而且答案與畫面上的儀表板一致。

---

## 裝不起來時

| 症狀 | 原因與處置 |
|---|---|
| `docker compose up` 沒報錯但連不上 | `docker compose ps` 看狀態；退出碼騙人 |
| 啟動時說「偵測到 schema_migrations 出現前建立的資料庫」 | 這個庫建於 2026-07-28 之前。照錯誤訊息印出的 `INSERT` 補登一次即可 |
| 登入成功卻又跳回登入頁 | `SESSION_COOKIE_SECURE=1` 但實際跑 http。拿掉那個變數（預設會自動判斷） |
| 全公司突然登不進去，說「登入失敗次數過多」 | 站在反代後面卻沒設 `TRUST_PROXY=1`，整間公司被算成同一個來源。設了它並重啟 |
| 唯一的管理者被二階段驗證鎖在外面 | `docker compose exec app node --experimental-strip-types apps/api/scripts/disable-totp.ts <帳號>` |
| agent 說「這個帳號已啟用二階段驗證」 | 機器不能用帳密。改發 API 金鑰，設 `TWERP_API_KEY` |
