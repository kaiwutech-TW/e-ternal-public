import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
// vitest/config 的 defineConfig 就是 vite 的那一支，只是多認得 `test` 欄位——
// vitest 沒有自己的設定檔時會讀這支，所以測試與建置共用同一組 plugin（JSX 轉譯靠 react()）。
import { defineConfig } from "vitest/config";

/**
 * zxing-wasm 的**預設** `locateFile` 是一個指向 jsDelivr 的樣板字串
 * （node_modules/zxing-wasm/dist/es/share.js）。src/einvoice-qr.ts 在執行期一律覆寫掉它，
 * 所以那個預設值是死碼——但它還是會**原字串留在 dist 的 JS 裡**，而這套 ERP 要能裝在內網、
 * 也要禁得起「grep 一下產物裡有沒有外部主機」這種稽核。
 *
 * 這個 plugin 在打包時把那段主機名換成同源路徑：萬一哪天有人拿掉了執行期的覆寫，
 * 結果是同源 404（看得見、修得掉），而不是安靜地連上公網 CDN。
 *
 * ★ 找不到樣板就**中止建置**，不是靜靜跳過：升級 zxing-wasm 而字串換了寫法時，
 *   要在這裡炸掉，而不是讓 CDN 網址悄悄回到產物裡。
 */
const ZXING_CDN = /https:\/\/fastly\.jsdelivr\.net\/npm\/zxing-wasm@[^/`"']*\/dist\//g;
function stripZXingCdnDefault(): Plugin {
  let hits = 0;
  return {
    name: "tw-erp:strip-zxing-cdn-default",
    apply: "build",
    transform(code, id) {
      if (!id.includes("zxing-wasm") || !ZXING_CDN.test(code)) return null;
      ZXING_CDN.lastIndex = 0;
      hits++;
      // 同源、且明顯是「不該被用到」的路徑：真的被走到時，錯誤訊息本身就講得出發生什麼事
      return { code: code.replace(ZXING_CDN, "/zxing-wasm-cdn-default-disabled/"), map: null };
    },
    buildEnd() {
      if (hits === 0) {
        throw new Error(
          "找不到 zxing-wasm 的 CDN 預設樣板：套件寫法可能變了。" +
            "請重新確認 dist 產物裡沒有外部主機，再更新 vite.config.ts 的 ZXING_CDN。",
        );
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), stripZXingCdnDefault()],
  /**
   * 測試環境：**預設 node，需要 DOM 的檔案自己宣告**。
   *
   * 為什麼不整包切 jsdom：這裡絕大多數測試是純函式（payload 形狀、字串建議、額度計算），
   * 在 node 跑得又快又穩；替它們每一支都架一個 DOM 是白付成本，也會讓「這支測試到底
   * 依不依賴瀏覽器」變得看不出來。
   *
   * 要 render 元件的測試，在**檔案第一行**加上這個註解就會拿到 jsdom：
   *
   *     // @vitest-environment jsdom
   *
   * 並且從 `test/dom.ts` 取用 render／screen／userEvent（那支會註冊每則測試後的 cleanup，
   * 直接 import @testing-library/react 就少了這道，前一則的 DOM 會殘留到下一則）。
   * 命名慣例：`*.dom.test.tsx`——光看檔名就知道這支要 DOM。
   *
   * ★ 射程：jsdom **沒有 canvas**。影像解碼與 QR 掃描那條路（einvoice-qr.ts、
   *   Expenses 的批次上傳前處理）在這裡測不到，那部分只能靠實機。
   */
  test: {
    environment: "node",
  },
  server: {
    proxy: {
      // 不剝 /api 前綴——後端 API 統一掛在 /api（見 apps/api/src/server-app.ts）
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
});
