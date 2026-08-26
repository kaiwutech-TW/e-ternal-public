# 第三方元件授權聲明

> 本專案自己的授權是 **LGPL-3.0-or-later**（見 [`LICENSE`](./LICENSE) 與 [`COPYING`](./COPYING)）。
> 這份檔案列的是**第三方**元件。

本專案的**建置產物**會散布下列第三方元件。這份檔案存在的理由是
Apache-2.0 §4(a)：散布時必須附上授權副本——只在原始碼註解裡寫「照辦即可」不算照辦。

## zxing-wasm（npm 套件）

- 用途：`apps/web` 的電子發票 QR 解碼（一次讀出影像中所有條碼）。
- 授權：**MIT** — Copyright (c) 2023 Ze-Zheng Wu
- 授權全文：[`licenses/zxing-wasm-MIT.txt`](./licenses/zxing-wasm-MIT.txt)

## ZXing-C++（編進 `zxing_reader.wasm` 的本體）

- 用途：同上；`zxing-wasm` 是它的 WebAssembly 封裝。
- 授權：**Apache-2.0**
- 授權全文：[`licenses/Apache-2.0.txt`](./licenses/Apache-2.0.txt)
- ⚠️ 建置產物 `dist/assets/zxing_reader-*.wasm` 就是這份 Apache-2.0 程式碼的散布形式。
  部署時若只上傳 `dist/`，**這兩份授權檔要一起帶上**（或在頁面上提供可取得的連結）。

---

**維護提醒**：新增任何會進到 `dist/` 的執行期相依時，回來補一條。
只在開發期使用（測試、建置工具、typecheck）的相依不散布，不必列在這裡。
