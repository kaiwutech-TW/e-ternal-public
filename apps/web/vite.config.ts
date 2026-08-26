import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

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
