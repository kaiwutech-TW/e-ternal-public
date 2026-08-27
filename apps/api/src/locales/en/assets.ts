import type { Dictionary } from "@tw-erp/core";

export const assets: Dictionary = {
  "資產類別不存在: {category}": "Asset category not found: {category}",
  "殘值不得大於等於取得成本": "Salvage value must be less than the acquisition cost",
  "year 須為四位數西元年（收到「{raw}」）": "year must be a four-digit calendar year (received \"{raw}\")",
  "資產不存在: {id}": "Asset not found: {id}",
  "資產 #{id} 已於 {date} 作廢（理由：{reason}），不可修改。請重新登錄一筆正確的資產": "Asset #{id} was voided on {date} (reason: {reason}) and cannot be edited. Register a new asset with the correct details.",
  "沒有要修改的欄位（請至少帶一個要改的欄位）": "No fields to update (provide at least one field to change)",
  "資產 #{id}（{name}）{why}。目前只可修改：名稱、備註（這次要改的「{fields}」不在其中）。若登錄確實有誤：要讓資產下帳請走「處分」（價款 0＝報廢），折舊差額請以手工傳票調整": "Asset #{id} ({name}) {why}. Only the name and notes can be edited now (the requested fields \"{fields}\" are not allowed). If the registration is wrong: use \"Dispose\" to write the asset off (proceeds 0 = scrap), and adjust any depreciation difference with a manual journal voucher.",
  "殘值（{salvage}）不得大於等於取得成本（{cost}）——若剛改了成本，請同時帶上正確的殘值": "Salvage value ({salvage}) must be less than the acquisition cost ({cost}) — if you just changed the cost, provide the correct salvage value as well.",
  "資產 #{id} 已於 {date} 作廢（理由：{reason}），沒有可處分的帳面": "Asset #{id} was voided on {date} (reason: {reason}); there is no book value to dispose of.",
  "資產已處分": "Asset has already been disposed of",
  "處分日 {date} 早於啟用日 {startDate}——資產不可能在啟用前被處分，請檢查日期": "Disposal date {date} is before the in-service date {startDate} — an asset cannot be disposed of before it is placed in service. Check the date.",
  "資產「{name}」的取得成本 {cost} 元尚未入帳：科目 {code} 目前借餘 {balance} 元，處分要貸記 {cost} 元，會把帳面打成負數。登錄刻意不拋轉取得傳票（取得走進貨單或手工傳票）——請先到「傳票」頁補一張取得分錄（借 {code} {cost}／貸 銀行存款或其他應付款），再處分": "The acquisition cost NT${cost} of asset \"{name}\" has not been recorded: account {code} currently has a debit balance of NT${balance}, and disposal would credit NT${cost}, driving the balance negative. Asset registration deliberately does not post an acquisition voucher (acquisitions go through a purchase invoice or manual voucher) — post an acquisition entry on the Journal Vouchers page first (debit {code} {cost} / credit bank deposits or other payables), then dispose.",
  "收款科目須為現金科目（目前可用：{available}）。要新增銀行帳戶科目請到「會計科目」頁建立資產類科目並勾選「現金科目」": "The receipt account must be a cash account (available: {available}). To add a bank account, create an asset account on the Chart of Accounts page and mark it as a cash account.",
  "科目已停用，不可再過帳: {code} {name}": "Account is inactive and cannot be posted to: {code} {name}",
};
