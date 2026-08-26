import QRCode from "qrcode";
import type { ReactElement } from "react";
import { Code39 } from "../src/print.tsx";

/**
 * 測試用的點陣圖工具（不是測試檔，vitest 的 include 只收 *.test.ts）。
 *
 * 這裡不用 canvas：測試環境沒有 canvas 實作，而解碼器本來就只吃 RGBA 陣列。
 * 所以用 QRCode.create() 拿到 module 矩陣（1=黑），自己塗成 pixel array 餵進去，
 * 不必為了測試多裝一個原生相依。
 */
export interface Bitmap {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export const SCALE = 6; // 每個 module 幾個 pixel：太小會抓不到定位圖
export const QUIET = 4; // 規格要求的靜區（4 個 module 的白邊）

export function blank(width: number, height: number): Bitmap {
  const data = new Uint8ClampedArray(width * height * 4);
  data.fill(255);
  return { data, width, height };
}

export function fillRect(bmp: Bitmap, x0: number, y0: number, w: number, h: number, value: number): void {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const i = (y * bmp.width + x) * 4;
      bmp.data[i] = value;
      bmp.data[i + 1] = value;
      bmp.data[i + 2] = value;
      bmp.data[i + 3] = 255;
    }
  }
}

export function renderQr(text: string): Bitmap {
  const qr = QRCode.create(text, { errorCorrectionLevel: "L" });
  const size = qr.modules.size;
  const modules = qr.modules.data;
  const side = (size + QUIET * 2) * SCALE;
  const bmp = blank(side, side);
  for (let my = 0; my < size; my++) {
    for (let mx = 0; mx < size; mx++) {
      if (!modules[my * size + mx]) continue;
      fillRect(bmp, (mx + QUIET) * SCALE, (my + QUIET) * SCALE, SCALE, SCALE, 0);
    }
  }
  return bmp;
}

/** 把數張圖並排貼到一張白底上（模擬證明聯上左右兩個 QR）。 */
export function sideBySide(parts: Bitmap[], gap = 24): Bitmap {
  const width = parts.reduce((s, p) => s + p.width, 0) + gap * (parts.length + 1);
  const height = Math.max(...parts.map((p) => p.height)) + gap * 2;
  const out = blank(width, height);
  let x = gap;
  for (const p of parts) {
    const y = Math.round((height - p.height) / 2);
    pasteOn(out, p, x, y);
    x += p.width + gap;
  }
  return out;
}

/** 把一張小圖貼到大白底的指定位置（模擬「整張證明聯拍進去」而不是只拍 QR）。 */
export function pasteOn(canvas: Bitmap, part: Bitmap, x: number, y: number): Bitmap {
  for (let py = 0; py < part.height; py++) {
    const src = py * part.width * 4;
    canvas.data.set(part.data.subarray(src, src + part.width * 4), ((y + py) * canvas.width + x) * 4);
  }
  return canvas;
}

/**
 * 證明聯中段那條 Code39 一維條碼，點陣化。
 *
 * 條碼圖樣**不在這裡重寫**：直接叫 src/print.tsx 的 `Code39` 元件（列印那條路用的同一支），
 * 讀它回傳的 <rect> 座標塗成 pixel array。字元表只有那邊一份，這裡不複製。
 * 不用 react-dom：只需要元素樹上的座標，render 不必真的發生。
 */
export function renderCode39(value: string, scale = 3, barHeight = 90, quiet = 30): Bitmap {
  const el = Code39({ value }) as ReactElement<{
    viewBox?: string;
    children?: ReactElement<{ x: number; width: number }>[];
  }>;
  const rects = el.props.children;
  const viewBox = el.props.viewBox;
  if (!Array.isArray(rects) || !viewBox) throw new Error(`Code39 畫不出 ${value}（含不支援的字元？）`);
  const units = Number(viewBox.split(" ")[2]);
  const bmp = blank(Math.ceil(units * scale) + quiet * 2, barHeight + quiet * 2);
  for (const r of rects) {
    fillRect(bmp, quiet + Math.round(r.props.x * scale), quiet, Math.max(1, Math.round(r.props.width * scale)), barHeight, 0);
  }
  return bmp;
}
