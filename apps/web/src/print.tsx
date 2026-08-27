/**
 * 列印視圖的共用零件（B5）：對外文件（報價單、出貨單、B2C 證明聯、扣繳憑單套印）
 * 一律走「畫面浮層＋window.print()」——瀏覽器列印就夠，不引入 PDF 函式庫。
 * 列印時只有 .print-sheet 可見（styles.css 的 @media print），其餘畫面全部隱藏。
 */
import { useEffect, useState, type ReactNode } from "react";
import QRCode from "qrcode";
import type { CompanyHeader } from "./types.ts";
import { t as tStatic, useT } from "./i18n.ts";

/**
 * 浮層＋列印工具列。size="a4"＝A4 直式版面；size="receipt"＝57mm 感熱紙版面。
 * 工具列掛 no-print：它是給操作者的，不該出現在紙上。
 */
export function PrintOverlay(props: {
  onClose: () => void;
  size?: "a4" | "receipt";
  /** 只在螢幕上顯示的操作者提示（no-print）：例如證明聯的加密驗證區佔位說明 */
  screenNote?: string;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <div className="print-overlay">
      <div className="print-toolbar no-print">
        <button className="primary" onClick={() => window.print()}>{t("列印")}</button>{" "}
        <button onClick={props.onClose}>{t("關閉")}</button>
        {props.screenNote && <div className="print-screen-note">{props.screenNote}</div>}
      </div>
      <div className={`print-sheet ${props.size === "receipt" ? "receipt" : "a4"}`}>{props.children}</div>
    </div>
  );
}

/** 公司抬頭區塊：未設定公司基本檔時明講去哪補，不留一塊空白讓人猜 */
export function CompanyHeaderBlock(props: { company: CompanyHeader | null; docTitle: string }) {
  const t = useT();
  const c = props.company;
  return (
    <div className="print-head">
      {c ? (
        <>
          <div className="co-name">{c.name}</div>
          <div className="co-meta">
            {t("統一編號 {taxId}", { taxId: c.taxId })}
            {c.telephone ? t("　電話 {tel}", { tel: c.telephone }) : ""}
            {c.address ? `　${c.address}` : ""}
          </div>
        </>
      ) : (
        <div className="co-name">{t("（公司基本檔未設定——請至「設定」頁填寫公司名稱與統編後再列印）")}</div>
      )}
      <div className="doc-title">{props.docTitle}</div>
    </div>
  );
}

/**
 * Code 39 一維條碼（純 SVG，無依賴）。每字元 9 元素（5 條 4 空）、3 寬 6 窄，
 * 前後加起訖字元「*」。證明聯的內容只有數字與大寫字母，表內字元集足夠。
 */
const CODE39: Record<string, string> = {
  "0": "000110100", "1": "100100001", "2": "001100001", "3": "101100000",
  "4": "000110001", "5": "100110000", "6": "001110000", "7": "000100101",
  "8": "100100100", "9": "001100100",
  A: "100001001", B: "001001001", C: "101001000", D: "000011001",
  E: "100011000", F: "001011000", G: "000001101", H: "100001100",
  I: "001001100", J: "000011100", K: "100000011", L: "001000011",
  M: "101000010", N: "000010011", O: "100010010", P: "001010010",
  Q: "000000111", R: "100000110", S: "001000110", T: "000010110",
  U: "110000001", V: "011000001", W: "111000000", X: "010010001",
  Y: "110010000", Z: "011010000",
  "-": "010000101", ".": "110000100", " ": "011000100", "*": "010010100",
};

export function Code39(props: { value: string; height?: number }) {
  // qr-fixtures 直接把 Code39 當純函式呼叫（非 React 樹），所以這裡用非 hook 版 t
  const narrow = 1;
  const wide = 2.5;
  const height = props.height ?? 28;
  const chars = `*${props.value.toUpperCase()}*`.split("");
  const rects: { x: number; w: number }[] = [];
  let x = 0;
  for (const ch of chars) {
    const pattern = CODE39[ch];
    if (!pattern) return <div>{tStatic("（條碼含不支援的字元：{ch}）", { ch })}</div>;
    for (let i = 0; i < 9; i++) {
      const w = pattern[i] === "1" ? wide : narrow;
      if (i % 2 === 0) rects.push({ x, w }); // 偶數位是條，奇數位是空
      x += w;
    }
    x += narrow; // 字元間隔
  }
  return (
    <svg
      viewBox={`0 0 ${x} ${height}`}
      preserveAspectRatio="none"
      style={{ width: "100%", height }}
      role="img"
      aria-label={props.value}
    >
      {rects.map((r, i) => (
        <rect key={i} x={r.x} y={0} width={r.w} height={height} fill="#000" />
      ))}
    </svg>
  );
}

/**
 * QR 四周要留的空白圈（quiet zone）圈數，單位是「模組」——QR 最小的那一格。
 * 用模組數而不是公分，一來 qrcode 套件的 margin 本來就以模組計，二來官方規格說明的
 * 原始 PDF 本專案還沒核對過（未驗證清單 U1），所以這裡刻意不去斷言「規格要求幾公分」，
 * 只保守取一個足以讓掃描器認得出碼邊界的圈數。真正的判準是實體列印後拿掃描器逐碼掃。
 */
const QUIET_ZONE_MODULES = 4;

/**
 * QR code 圖（qrcode 套件轉 data URL）；產生失敗時顯示原因而不是留白。
 *
 * 留白為什麼做在圖裡（margin）而不是只靠 CSS padding：白邊變成點陣圖的一部分之後，
 * 不管這張圖被複製、截圖、轉 PDF 或樣式被列印引擎改掉，白圈都跟著走；純靠 CSS 的話
 * 只要樣式沒套上就整圈不見。CSS 那邊管的是版面（見 styles.css 的 .r-qrs），兩者分工不同。
 *
 * size 的語意是「碼身」的邊長，不含白圈：實際 <img> 會按模組比例放大，
 * 這樣加白圈不會反過來把模組愈縮愈小（模組縮小才是掃不到的主因）。
 * 放大的代價是圖比 size 寬一圈，寬到證明聯（57mm）並排放不下兩碼——
 * 這筆紙寬預算的算式寫在 styles.css 的 .r-qrs 上方，改動 size 或 QUIET_ZONE_MODULES 前先看那段。
 */
export function QrImg(props: { text: string; size?: number }) {
  const t = useT();
  const size = props.size ?? 88;
  const [src, setSrc] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [boxSize, setBoxSize] = useState(size);
  useEffect(() => {
    let alive = true;
    // 先問出這串資料會排成幾乘幾個模組，才能把白圈加回去之後仍維持呼叫端要的模組尺寸。
    // 這裡的 errorCorrectionLevel 必須跟下面 toDataURL 一致，否則算出來的版本（模組數）會對不上。
    let payload = 0;
    try {
      payload = QRCode.create(props.text, { errorCorrectionLevel: "L" }).modules.size;
    } catch {
      // 量不到就退回原尺寸，白圈改成從碼身裡分——寧可模組小一點，也不要整個不顯示。
      payload = 0;
    }
    if (alive) {
      setBoxSize(payload > 0 ? Math.round((size * (payload + QUIET_ZONE_MODULES * 2)) / payload) : size);
    }
    QRCode.toDataURL(props.text, { errorCorrectionLevel: "L", margin: QUIET_ZONE_MODULES, scale: 4 })
      .then((url) => alive && setSrc(url))
      .catch((e: Error) => alive && setErr(e.message));
    return () => {
      alive = false;
    };
  }, [props.text, size]);
  if (err) return <div style={{ fontSize: 9 }}>{t("QR 產生失敗：{err}", { err })}</div>;
  return src ? (
    <img
      className="qr-img"
      src={src}
      width={boxSize}
      height={boxSize}
      alt="QR code"
      style={{ imageRendering: "pixelated", background: "#fff" }}
    />
  ) : (
    <div style={{ width: boxSize, height: boxSize }} />
  );
}
