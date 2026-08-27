import type { Dictionary } from "@tw-erp/core";

export const CategorySuggestions: Dictionary = {
  // 句子被 <strong> 切成片段，英文照順序拼回一句
  "這家賣方（統編 {id}）在公司過去": "This seller (Tax ID {id}) was filed under these categories on the company's past ",
  "的報銷單裡被歸過這幾個分類，括號裡是": " expense claims; the number in brackets is ",
  "幾張單": "how many claims",
  "這樣歸過（同一張單裡的好幾筆只算一次——那是一次被接受的決定）。要用哪一個由你決定（同一家店可以有不同用途，系統不替你挑）：": " used that category (several lines on one claim count once; that is one accepted decision). Which one to use is your call (the same shop can serve different purposes; the system will not pick for you):",
  "{code} {label}（{count} 張單）": "{code} {label} ({count} claims)",
};
