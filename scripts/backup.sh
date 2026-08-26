#!/bin/sh
# tw-erp 資料庫備份：pg_dump 到 backups/，保留最近 30 份。
#
# 用法：./scripts/backup.sh（在 repo 根目錄；容器名依 compose 專案而定，可用 BACKUP_CONTAINER 覆蓋）
# 排程：crontab 例——每日 02:00
#   0 2 * * * cd /path/to/tw_erp && ./scripts/backup.sh >> backups/backup.log 2>&1
#
# 加密（公網／雲端部署必要）：設 BACKUP_PASSPHRASE 即以 gpg 對稱式 AES-256 加密，
#   產出 .sql.gz.gpg。備份依 3-2-1 原則本來就會被複製到第二台機器或雲端硬碟，
#   而複製出去的那一份不再受本系統的權限守衛保護——裡面躺著全公司的帳、
#   以及往來個人的身分證號（未設 PII_KEY 時是明文）。
#   ⚠️ 通行語遺失＝備份永久打不開。請與備份分開保管。
#
# 為什麼不用管線直接 `pg_dump | gzip > out`（原本的寫法）：
#   POSIX sh 沒有 pipefail，pg_dump 失敗時 gzip 仍會成功，於是留下一個大小正常、
#   內容是半截或空的檔案，而腳本印「備份完成」。備份的失敗模式必須是「明顯壞掉」，
#   不能是「看起來好好的，還原時才發現」。所以改成分步驟＋每步驗證。
set -eu

DIR="$(cd "$(dirname "$0")/.." && pwd)"
CONTAINER="${BACKUP_CONTAINER:-$(docker compose -f "$DIR/docker-compose.yml" ps -q db)}"
[ -n "$CONTAINER" ] || { echo "找不到 db 容器（compose 是否啟動？）"; exit 1; }

if [ -n "${BACKUP_PASSPHRASE:-}" ] && ! command -v gpg >/dev/null 2>&1; then
  # 設了通行語卻沒有 gpg 時**停下來**，不要默默改存明文——
  # 那正是「以為有加密」與「其實沒有」之間唯一會被發現的時機
  echo "已設定 BACKUP_PASSPHRASE 但找不到 gpg，中止（請安裝 gnupg，或取消該環境變數以明文備份）"
  exit 1
fi

mkdir -p "$DIR/backups"
chmod 700 "$DIR/backups"
STAMP=$(date +%Y%m%d-%H%M%S)
TMP="$DIR/backups/.twerp-$STAMP.sql"
trap 'rm -f "$TMP" "$TMP.gz"' EXIT

# 步驟一：傾印。set -e 會在 pg_dump 非零退出時停在這裡
docker exec "$CONTAINER" pg_dump -U twerp twerp > "$TMP"
# 傾印成功但內容不對（權限不足、資料庫是空的）也要擋下來：完整的 dump 一定有結束標記
grep -q "PostgreSQL database dump complete" "$TMP" || {
  echo "傾印檔沒有結束標記，內容可能不完整——不產生備份檔"
  exit 1
}

# 步驟二：壓縮，並實際驗證壓縮檔解得開
gzip "$TMP"
gzip -t "$TMP.gz"

# 步驟三：加密（有設通行語才做）
if [ -n "${BACKUP_PASSPHRASE:-}" ]; then
  OUT="$DIR/backups/twerp-$STAMP.sql.gz.gpg"
  printf '%s' "$BACKUP_PASSPHRASE" | gpg --batch --quiet --yes \
    --passphrase-fd 0 --pinentry-mode loopback \
    --symmetric --cipher-algo AES256 --output "$OUT" "$TMP.gz"
else
  OUT="$DIR/backups/twerp-$STAMP.sql.gz"
  mv "$TMP.gz" "$OUT"
  echo "提醒：BACKUP_PASSPHRASE 未設定，本備份為未加密明文（內網可接受；異地保存或雲端部署請設定）"
fi
chmod 600 "$OUT"

echo "備份完成: $OUT ($(du -h "$OUT" | cut -f1))"

# 輪替：保留最近 30 份。兩種副檔名一起算——切換加密前後的檔案混在同一個目錄裡，
# 只掃其中一種會讓另一種永遠不被清掉（或反過來，把剛切換完的新備份誤刪）
ls -1t "$DIR/backups"/twerp-*.sql.gz "$DIR/backups"/twerp-*.sql.gz.gpg 2>/dev/null |
  tail -n +31 | xargs rm -f 2>/dev/null || true
