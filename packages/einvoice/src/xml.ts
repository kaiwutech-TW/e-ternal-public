/** 極簡 XML 產生器：4 空格縮排、固定欄位順序（與官方範例一致，XSD 驗欄位序） */

export function esc(value: string | number): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export type Node = { tag: string; children: Node[] } | { tag: string; text: string | number } | null;

export function el(tag: string, text: string | number | undefined | null): Node {
  return text === undefined || text === null ? null : { tag, text };
}

export function parent(tag: string, children: Node[]): Node {
  return { tag, children: children.filter((c): c is Exclude<Node, null> => c !== null) };
}

export function render(node: Node, indent = 1): string {
  if (!node) return "";
  const pad = "    ".repeat(indent);
  if ("text" in node) return `${pad}<${node.tag}>${esc(node.text)}</${node.tag}>`;
  const inner = node.children.map((c) => render(c, indent + 1)).filter(Boolean).join("\n");
  return `${pad}<${node.tag}>\n${inner}\n${pad}</${node.tag}>`;
}

export function document(root: string, ns: string, children: Node[]): string {
  const body = children.map((c) => render(c, 1)).filter(Boolean).join("\n");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<${root} xsi:schemaLocation="urn:GEINV:eInvoiceMessage:${ns} ${ns.split(":")[0]}.xsd" ` +
    `xmlns="urn:GEINV:eInvoiceMessage:${ns}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n` +
    `${body}\n</${root}>`
  );
}
