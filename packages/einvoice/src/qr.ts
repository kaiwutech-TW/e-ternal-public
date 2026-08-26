/**
 * 台灣電子發票證明聯「左側」QR code 的解析（財政部「電子發票證明聯二維條碼規格」）。
 *
 * 欄位配置（前 77 碼定長，之後才是 : 分隔的自行使用區與明細）：
 *   發票號碼(10, 兩碼英文＋八碼數字)＋開立日期(7，**民國年**3＋月 2＋日 2)＋隨機碼(4)
 *   ＋銷售額(8, **hex**，未稅)＋總計額(8, **hex**，含稅)
 *   ＋買方統編(8，**全 0 代表未打統編**)＋賣方統編(8)＋加密驗證(24)。
 *
 * ⚠️ **可機讀不等於已驗真**：那 24 碼加密驗證區本系統從未驗證（也還沒有大平台核發的
 * QRCode 專用金鑰可驗），任何人都能自己印一張欄位齊全的紙。所以這裡解出來的東西
 * 一律稱「**憑證所載的結構化值**」——它只代表「這張紙上是這樣寫的」，
 * **不得**在程式、註解或介面上稱之為權威值、已驗證金額或可信來源。
 *
 * 放在 packages/einvoice 而不是 apps/web：伺服端也要能自己解 QR 原始字串，
 * 否則只能相信前端傳來的數字（前端可以把任意金額宣稱成進項稅）。
 * 因此這支**完全不依賴 DOM／瀏覽器 API**，只是字串處理。
 */
export interface EInvoiceLeftQr {
  invoiceNumber: string;
  /** 開立日期，已從民國年換算成西元 YYYY-MM-DD */
  invoiceDate: string;
  /**
   * 銷售額（未稅）——憑證所載的結構化值。
   * 帶它出來的理由：少了它，只能拿使用者設定的費率去回推未稅額，
   * 而回推值與憑證自己印的數字可能不同（捨入殘差，或整筆差一個級距），
   * 兩者不同時該用哪一個是使用者的判斷——沒有這個欄位就連「不同」都看不出來。
   */
  salesAmount: number;
  /** 總計額（含稅）——憑證所載的結構化值 */
  totalAmount: number;
  /** 買方統編；規格以全 0 表示未打統編，這裡轉成 null（別讓 "00000000" 流進帳上） */
  buyerTaxId: string | null;
  sellerTaxId: string;
}

/** 右碼固定以 ** 起頭；左碼的 ** 只會出現在第 78 碼之後的自行使用區，不會在開頭。 */
const LEFT_QR = /^([A-Z]{2}\d{8})(\d{7})([0-9]{4})([0-9A-Fa-f]{8})([0-9A-Fa-f]{8})(\d{8})(\d{8})/;

/**
 * 解析左碼原始字串。不是左碼（含右碼、其他 QR、亂碼）一律回 null——絕不猜、絕不部分回傳，
 * 因為呼叫端拿它去核金額，半套資料比沒有資料更危險。
 */
export function parseEInvoiceLeftQr(text: string): EInvoiceLeftQr | null {
  if (text.startsWith("**")) return null; // 右碼：明細接續，沒有這些欄位
  const m = LEFT_QR.exec(text);
  if (!m) return null;
  const rocDate = m[2]!;
  const year = Number(rocDate.slice(0, 3)) + 1911;
  const buyer = m[6]!;
  return {
    invoiceNumber: m[1]!,
    invoiceDate: `${year}-${rocDate.slice(3, 5)}-${rocDate.slice(5, 7)}`,
    salesAmount: parseInt(m[4]!, 16),
    totalAmount: parseInt(m[5]!, 16),
    buyerTaxId: buyer === "00000000" ? null : buyer,
    sellerTaxId: m[7]!,
  };
}
