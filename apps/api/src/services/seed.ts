import { CASH_ACCOUNT_CODES, SEED_ACCOUNTS, SYSTEM_ACCOUNT_CODES, isSystemAccount } from "@tw-erp/core";
import { schema } from "@tw-erp/db";
import { and, eq, inArray, notInArray } from "drizzle-orm";
import type { Db } from "../db.ts";

/**
 * 科目種子：新增缺少的科目，並「每次啟動」校正種子科目的 is_system / is_cash / active。
 *
 * 冪等靠 accounts.code 的 UNIQUE ＋ onConflictDoNothing：既有列的 name/type 不會被覆寫
 * （使用者在科目維護頁改過的名稱不該被啟動流程蓋掉；要改既有科目的名稱請走維護頁）。
 *
 * 旗標為什麼是「每次啟動校正」而不是一次性 migration：
 * 1. onConflictDoNothing 不會更新既有列——舊部署升級時，既有科目的旗標會永遠停在 DEFAULT false，
 *    等於系統科目保護與現金科目判定對「升級上來的資料庫」完全失效
 *    （新裝的資料庫反而正常，最難察覺的那種差異）。
 * 2. SYSTEM_ACCOUNT_CODES 是推導值（ACCOUNT／ASSET_CATEGORIES／EXPENSE_CATEGORIES），
 *    日後補一個報銷分類就會多一個系統科目。migration 只跑一次，追不上這種變動；
 *    每次啟動校正則讓 core 成為唯一事實來源，且部署即自我修復。
 * 3. 兩個方向都要校正：該是 true 的設 true，不該是的設回 false——
 *    否則從清單裡移除某科目後，資料庫會留著一個再也沒人保護、卻永遠停不掉的「幽靈系統科目」。
 *
 * 校正範圍刻意只涵蓋 SEED_ACCOUNTS 的代號（seedCodes），理由有二：
 * a. is_cash 對「使用者自建科目」而言是使用者自己在維護頁勾的（自建的 1104 銀行存款－玉山
 *    必須算進現金流量表），校正若一律設回 false，等於每次重啟就把使用者的設定清掉。
 * b. is_system 同理：撞號的自建科目不該因為代號長得像就被標成系統科目而再也停不掉。
 *    注意撞號在 POST /accounts 會被 409（code UNIQUE）擋下，真正會發生的情境是
 *    「舊庫早就有同碼的自建科目，之後該碼才被加進 SEED_ACCOUNTS」——這種情況下該碼會落入
 *    校正範圍而被標成系統科目，這是對的：該代號從此被拋轉邏輯以字面值硬引用，停用它會讓單據過不了帳，
 *    保護它比尊重「它原本是自建的」更重要（名稱與類別仍保留使用者的版本，不覆寫）。
 * 代價（已知並接受）：曾經是種子科目、之後被移出 SEED_ACCOUNTS 的代號，旗標不再被校正回 false。
 */
export async function seedAccounts(db: Db): Promise<void> {
  await db
    .insert(schema.accounts)
    .values(
      SEED_ACCOUNTS.map((a) => ({
        code: a.code,
        name: a.name,
        type: a.type,
        isSystem: isSystemAccount(a.code),
        isCash: CASH_ACCOUNT_CODES.includes(a.code),
      })),
    )
    .onConflictDoNothing();

  const seedCodes = SEED_ACCOUNTS.map((a) => a.code);
  const systemCodes = [...SYSTEM_ACCOUNT_CODES];
  const cashCodes = [...CASH_ACCOUNT_CODES];

  // 系統科目：標記 is_system，同時強制 active=true。
  // 為什麼連 active 也校正：系統科目被自動分錄以字面代號指定，一旦處於停用狀態，
  // 進銷貨／收付款／折舊／報銷／結轉全部過不了帳；而 PATCH 擋停用、前端對系統科目不給啟用按鈕，
  // 於是那個狀態沒有任何途徑救得回來（來源是 0013 之前的舊資料，或 is_system 尚未校正時的誤操作）。
  // 系統科目本來就不該停用，這裡直接扳回啟用，讓部署即自我修復。
  // 強制 active 會靜默覆蓋使用者的設定（例如某公司刻意停用了 6112，下一版它被納入報銷分類
  // 而成為系統科目，部署後就自己復活了）。覆蓋本身是必要的，但不能無聲——先查出來記一筆 log，
  // 讓事後查「這個科目怎麼又開了」的人找得到原因。
  const revived = await db
    .select({ code: schema.accounts.code, name: schema.accounts.name })
    .from(schema.accounts)
    .where(and(inArray(schema.accounts.code, systemCodes), eq(schema.accounts.active, false)));
  if (revived.length > 0) {
    console.warn(
      `[seed] 以下科目是系統科目（自動分錄直接指定），原為停用狀態，已強制啟用：` +
        revived.map((a) => `${a.code} ${a.name}`).join("、"),
    );
  }
  await db
    .update(schema.accounts)
    .set({ isSystem: true, active: true })
    .where(inArray(schema.accounts.code, systemCodes));
  // 種子科目中的非系統科目：is_system 一律回 false（不動 active——非系統的種子科目使用者有權停用）
  await db
    .update(schema.accounts)
    .set({ isSystem: false })
    .where(and(inArray(schema.accounts.code, seedCodes), notInArray(schema.accounts.code, systemCodes)));

  // is_cash 雙向校正，同樣只限種子科目
  await db.update(schema.accounts).set({ isCash: true }).where(inArray(schema.accounts.code, cashCodes));
  await db
    .update(schema.accounts)
    .set({ isCash: false })
    .where(and(inArray(schema.accounts.code, seedCodes), notInArray(schema.accounts.code, cashCodes)));
}
