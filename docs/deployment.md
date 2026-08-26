# 部署指南

> 兩種形狀：**內網單機**（預設，以下大部分內容）與**公網／雲端**（見最後一章，多一個 compose 疊加檔）。
> 兩者共用同一套映像與 migration，差別在對外的那一層與幾個環境變數。
>
> 電子發票的 Turnkey 簽章依架構紅線必須留在本地（DECISIONS 2026-07-21）——這條與部署在哪無關：
> 工商憑證是實體卡。**報稅模組不受影響**：401 與扣繳都只是產檔案給人上傳，沒有網路依賴。

## 首次部署

```sh
git clone <repo> && cd tw_erp
echo "POSTGRES_PASSWORD=請換成強密碼" > .env
docker compose up -d --build
```

啟動時自動套用 migration＋科目種子（冪等）。瀏覽器開 `http://<主機>:3000`，
首次進入會出現「初始設定」建立第一個管理者，之後在「設定」頁新增其他同事的帳號。

- 改埠：`.env` 加 `APP_PORT=8080`
- Tailscale：主機裝 tailscaled 後，同事以 `http://<tailscale 名稱>:3000` 存取，零額外設定

## 升級

```sh
git pull
docker compose up -d --build   # 重啟時自動套用新 migration（冪等，只補新檔）
docker compose ps              # compose 啟動失敗時退出碼仍是 0，狀態要自己確認
```

先跑 `./scripts/backup.sh` 再升級是好習慣。

已套用的 migration 記在資料庫的 `schema_migrations` 表，重啟只補沒跑過的檔。
若啟動時看到「偵測到 schema_migrations 出現前建立的資料庫」，表示這個庫建立於
2026-07-28 之前（那時還沒有這張表），照錯誤訊息印出的 `INSERT` 補登一次即可，之後不再出現。

## 備份與還原

```sh
./scripts/backup.sh            # pg_dump → backups/twerp-<時間>.sql.gz，保留最近 30 份
```

排程（主機 crontab，每日 02:00）：

```
0 2 * * * cd /path/to/tw_erp && ./scripts/backup.sh >> backups/backup.log 2>&1
```

還原（會覆蓋現有資料，先確認）：

```sh
gunzip -c backups/twerp-YYYYMMDD-HHMMSS.sql.gz | \
  docker exec -i $(docker compose ps -q db) psql -U twerp -d twerp
```

備份檔在 `backups/`，建議另行同步到第二台機器或雲端硬碟（3-2-1 原則）。

### 備份加密（異地保存或雲端部署時必要）

備份被複製出去的那一份不再受系統的權限守衛保護——裡面躺著全公司的帳，
以及往來個人的身分證號（未設 `PII_KEY` 時是明文）。設 `BACKUP_PASSPHRASE` 即以
gpg 對稱式 AES-256 加密，產出 `.sql.gz.gpg`（主機需安裝 `gnupg`）：

```sh
BACKUP_PASSPHRASE='另外保管的長通行語' ./scripts/backup.sh
```

排程時把它寫進 crontab 那一行，或放在只有 root 讀得到的檔案裡 source 進來。
**通行語遺失＝備份永久打不開**，請與備份分開保管（同一顆硬碟上的通行語沒有意義）。

還原加密的備份：

```sh
gpg --decrypt backups/twerp-YYYYMMDD-HHMMSS.sql.gz.gpg | gunzip | \
  docker exec -i $(docker compose ps -q db) psql -U twerp -d twerp
```

腳本本身的兩個保護：傾印檔沒有 `PostgreSQL database dump complete` 結束標記就中止
（避免留下大小正常、內容半截的檔案）；設了 `BACKUP_PASSPHRASE` 卻找不到 `gpg` 也中止
（不會默默改存明文——那是「以為有加密」與「其實沒有」之間唯一會被發現的時機）。

## 不用 Docker 的替代（開發機直跑）

```sh
pnpm install
pnpm --filter @tw-erp/web build
DATABASE_URL=postgres://... node --experimental-strip-types apps/api/scripts/migrate.ts
DATABASE_URL=postgres://... node --experimental-strip-types apps/api/src/server.ts
```

試用（免資料庫、重啟即清空）：`pnpm --filter @tw-erp/api dev:memory`

## 架構備忘

- 單埠：API 掛 `/api`，其餘路徑 serve `apps/web/dist`＋SPA fallback（apps/api/src/server-app.ts）
- session cookie 為 HttpOnly＋SameSite=Lax；`Secure` 依請求實際協定自動決定（見下），內網 http 照常可用
- 資料庫在 named volume `twerp-pgdata`；`docker compose down` 不會刪資料，`down -v` 才會

## 安全相關的環境變數

| 變數 | 預設 | 什麼時候要設 |
|---|---|---|
| `TRUST_PROXY` | 未設 | **站在反代（caddy/nginx）後面時必設 `1`**，否則登入節流的「來源」桶會把全公司算成同一個來源（反代自己的 IP）。反過來，app 直接暴露在公網時**絕不可設**——那等於讓任何人自己編一個來源位址 |
| `SESSION_COOKIE_SECURE` | 未設＝自動 | 自動判斷（X-Forwarded-Proto，其次請求本身的協定）不準時才用。`1` 強制加 `Secure`，`0` 強制不加。設錯成 `1` 而實際跑 http 的症狀是「登入成功後又跳回登入頁」，畫面上不會有錯誤訊息 |
| `PII_KEY` | 未設＝明文 | 交易對象身分證號的加密金鑰。**未設時該欄位以明文存在資料庫與備份檔中**（內網可接受），啟動時會印一行警告。建議 `openssl rand -base64 32`。⚠️ 金鑰遺失＝已加密的身分證號無法復原；換金鑰不會自動重新加密既有資料（讀取時會明確報錯，不會靜默變成空值） |
| `BACKUP_PASSPHRASE` | 未設＝不加密 | 備份加密的通行語，見上一章 |
| `DATABASE_PASSWORD_FILE` | 未設 | 從檔案讀資料庫密碼（`<VAR>_FILE` 慣例），給 docker secrets／Kubernetes 用。設了就蓋掉 `DATABASE_URL` 裡的密碼。單機部署上它縮小的只是「`docker inspect` 看得到」的範圍，**不是加密** |

## 公網／雲端部署

單一疊加檔，把內網形狀改成可以對外的形狀：

```sh
# .env 需要多兩個值
echo "SITE_ADDRESS=erp.example.com" >> .env     # 真的解析到這台主機的網域
echo "PII_KEY=$(openssl rand -base64 32)" >> .env
docker compose -f docker-compose.yml -f docker-compose.public.yml up -d --build
```

它改的四件事（每一件不改就不該對外，理由寫在 `docker-compose.public.yml` 裡）：

1. caddy 反代終結 TLS 並自動申請憑證；app 不再直接對外開埠
   （內網形狀的 3000 埠綁 0.0.0.0，在雲端主機上等於整個網際網路都連得到 http 明文）
2. `TRUST_PROXY=1`
3. `PII_KEY` 必填（用 `:?` 而非預設值——預設值會讓「忘了設」變成沒人會發現的靜默降級）
4. 憑證留在 named volume，重建容器不會重新申請

### 二階段驗證

自願啟用（強制會在升級那一刻把所有人擋在門外，包含唯一的管理者）。
**公網部署請至少替管理者帳號啟用**：登入節流擋得住密碼猜測，但擋不住已經外洩的密碼——
外洩的密碼第一次就會對，而外洩不需要本系統出事（同事在別的網站用了同一組就夠了）。

在「設定」頁自助啟用，每個人管自己的。啟用時會拿到 10 組**只顯示一次**的備援碼，
請放在手機以外的地方。同事手機掉了：管理者在使用者列表關掉他的二階段驗證即可（會記進操作日誌）。
**唯一的管理者自己被鎖在外面**時才走這條：

```sh
docker compose exec app node --experimental-strip-types apps/api/scripts/disable-totp.ts <帳號>
```

刻意做成腳本而不是 API——需要主機與資料庫存取權才跑得動。

**上線前還缺什麼**（誠實清單，不是待辦——是你要自己決定接不接受的風險）：

- 密碼最短仍是 6 碼。二階段驗證沒啟用的帳號，防線只有這個長度＋登入節流
- 資料庫密碼仍在 `.env`（0600、已在 `.gitignore`；db 服務沒有 publish 任何埠，
  只在 compose 內網可達）。要更嚴請用 `DATABASE_PASSWORD_FILE` 接 secrets
- **操作日誌記得到「誰改了什麼」，記不到「值從什麼變成什麼」**（設定頁的 admin 區塊可查）
- 個資：身分證號的明文查詢有存取軌跡與角色限制，但拿到主機就拿得到金鑰。
  多家公司代管另有責任層級問題（會讓經營者變成資料處理者），與技術措施無關

登入節流（滑動視窗 15 分鐘）：同一帳號 5 次失敗、同一來源 30 次失敗即回 429。
不需要任何人解鎖，最舊的失敗滿 15 分鐘就自動退出視窗。停用中的帳號用對密碼不計入。
