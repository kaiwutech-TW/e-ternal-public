import type { Dictionary } from "@tw-erp/core";

export const contracts: Dictionary = {
  "合約不存在: {id}": "Contract not found: {id}",
  "合約 #{contractId} 沒有這一期請款計畫: {installmentId}": "Contract #{contractId} has no billing installment {installmentId}",
  "已終止的合約不能再排請款計畫。若要繼續合作請建立新合約": "A terminated contract cannot have new billing installments. To continue working together, create a new contract",
  "每月請款日必須是 1–31": "Monthly billing day must be between 1 and 31",
  "迄月（{to}）不可早於起月（{from}）": "End month ({to}) cannot be earlier than start month ({from})",
  "一次最多產生 {max} 期（本次會產生 {months} 期）——請確認起迄年份沒有打錯；真的要更長請分次產生":
    "At most {max} installments can be generated at once (this would generate {months}) — check the start/end years; for longer schedules, generate in batches",
  "第 {seq} 期已開銷貨單 #{saleId}，不能刪除計畫列。要取消這期請先作廢那張銷貨單（作廢後本期自動回到未請款）":
    "Installment {seq} has already been billed as sales invoice #{saleId} and cannot be deleted. To cancel it, void that sales invoice first (the installment then returns to unbilled)",
  "第 {seq} 期已勾對進貨單 #{purchaseId}，不能刪除計畫列。要取消這期請先解除勾對":
    "Installment {seq} is matched to purchase invoice #{purchaseId} and cannot be deleted. To cancel it, unmatch first",
  "第 {seq} 期已開銷貨單 #{saleId}，金額與日期以那張單為準。要改請先作廢它":
    "Installment {seq} has already been billed as sales invoice #{saleId}; its amount and date come from that invoice. Void it first to make changes",
  "第 {seq} 期已勾對進貨單 #{purchaseId}，金額與日期以那張單為準。要改請先解除勾對":
    "Installment {seq} is matched to purchase invoice #{purchaseId}; its amount and date come from that invoice. Unmatch first to make changes",
  "進貨合約不開請款單——單據來源是對方寄來的發票。請在該期上用「勾對進貨單」把收到的進貨單對上":
    "Purchase contracts are not billed — the document comes from the supplier's invoice. Use \"Match purchase invoice\" on the installment to link the received purchase invoice",
  "已終止的合約不能再請款": "A terminated contract cannot be billed",
  "這份合約沒有連結交易對象，開不了銷貨單。請先在合約上選擇客戶（交易對象要先建在「客戶與商品」頁）":
    "This contract is not linked to a contact, so a sales invoice cannot be created. Select a customer on the contract first (contacts are created on the Customers & Products page)",
  "第 {seq} 期已開過銷貨單 #{saleId}。重複請款請先作廢那張單": "Installment {seq} has already been billed as sales invoice #{saleId}. To bill again, void that invoice first",
  "銷貨合約的期別是開請款單（bill），不是勾對進貨單": "Installments on a sales contract are billed (bill), not matched to purchase invoices",
  "已終止的合約不能再勾對付款": "A terminated contract cannot have payments matched",
  "第 {seq} 期已勾對進貨單 #{purchaseId}。要換一張請先解除勾對": "Installment {seq} is already matched to purchase invoice #{purchaseId}. Unmatch first to link a different one",
  "進貨單不存在: {purchaseId}": "Purchase invoice not found: {purchaseId}",
  "進貨單 #{purchaseId} 已作廢，不能勾對": "Purchase invoice #{purchaseId} has been voided and cannot be matched",
  "進貨單 #{purchaseId} 的供應商與合約連結的交易對象不同——勾錯對象的單會讓應付與合約對不上。確定是同一家（例如集團內開票主體不同）請先調整合約的交易對象連結":
    "The supplier on purchase invoice #{purchaseId} differs from the contact linked to this contract — matching the wrong contact's invoice would put accounts payable out of step with the contract. If it really is the same party (e.g. a different billing entity within the group), update the contract's contact link first",
  "進貨單 #{purchaseId} 已勾對在合約 #{contractId} 第 {seq} 期。一張單只能勾一期":
    "Purchase invoice #{purchaseId} is already matched to installment {seq} of contract #{contractId}. An invoice can only be matched to one installment",
  "只有進貨合約的期別有勾對可解除": "Only installments on purchase contracts can be unmatched",
  "第 {seq} 期沒有勾對任何進貨單": "Installment {seq} is not matched to any purchase invoice",
  "已終止的合約不能續約——終止是雙方合意的結束。要重啟合作請建立全新合約":
    "A terminated contract cannot be renewed — termination is the agreed end of the contract. To resume working together, create a brand-new contract",
};
