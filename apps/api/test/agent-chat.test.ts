/**
 * 內建 agent 執行層驗收（Phase 1）。
 *
 * 要守住的四件事：
 *  1. 責任紅線是結構不是自律：工具集只有讀取與草稿類寫入；未知工具（如 approve_*）
 *     直接回「未知的工具」；agent 建的申請單是 pending，等人簽
 *  2. 權限零新增：工具以目前登入者身分打內部 API——employee 查薪資，工具收 403
 *  3. 未設定 LLM 時 422 指路，不是 500
 *  4. api_get 只吃站內相對路徑（擋 SSRF 與路徑跳脫）
 */
import { PGlite } from "@electric-sql/pglite";
import { applyMigrations } from "@tw-erp/db";
import { drizzle } from "drizzle-orm/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import type { LlmCall, LlmResult } from "../src/services/agent-chat.ts";
import { loginAs, setupAdmin } from "./auth-helper.ts";

let db: ReturnType<typeof drizzle>;
let plainApp: ReturnType<typeof buildApp>; // 無 LLM override：測「未設定」路徑
let admin: Record<string, string>;
let emp: Record<string, string>;
let empId: number;

/** 腳本化 LLM：照序回應（每個測試自備一份腳本與 app 實例；session 在 DB，cookie 跨實例通用） */
const scripted = (script: LlmResult[]): LlmCall => {
  const queue = [...script];
  return async () => {
    const next = queue.shift();
    if (!next) throw new Error("LLM 腳本用完了——迴圈比預期多跑了一輪");
    return next;
  };
};

async function call(app: ReturnType<typeof buildApp>, path: string, headers: Record<string, string>, body?: unknown, method = body ? "POST" : "GET") {
  const res = await app.request(path, {
    method,
    headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

beforeAll(async () => {
  const client = new PGlite();
  await applyMigrations((sql) => client.exec(sql));
  db = drizzle(client);
  plainApp = buildApp(db);
  admin = await setupAdmin(plainApp);
  empId = (await call(plainApp, "/employees", admin, { name: "聊天測試員" })).json.id;
  await call(plainApp, "/users", admin, { username: "chatter", displayName: "小聊", password: "secret-test", role: "employee", employeeId: empId });
  emp = await loginAs(plainApp, "chatter", "secret-test");
});

describe("設定與認證", () => {
  it("未登入 401/403；未設定 LLM 時 422 指路（不是 500）", async () => {
    expect((await call(plainApp, "/agent/chat", {}, { messages: [{ role: "user", content: "hi" }] })).status).toBeGreaterThanOrEqual(401);
    const res = await call(plainApp, "/agent/chat", emp, { messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(422);
    expect(res.json.error).toContain("Agent 接入");
  });
});

describe("tool-use 迴圈", () => {
  it("查詢：agent 用 api_get 以本人身分讀資料，回覆帶步驟", async () => {
    const app = buildApp(db, {
      agentLlm: scripted([
        { text: "", toolCalls: [{ id: "t1", name: "api_get", input: { path: "/leave-types" } }] },
        { text: "系統目前有 13 種內建假別。", toolCalls: [] },
      ]),
    });
    const res = await call(app, "/agent/chat", emp, { messages: [{ role: "user", content: "有哪些假別？" }] });
    expect(res.status).toBe(200);
    expect(res.json.reply).toContain("13 種");
    expect(res.json.steps).toEqual([{ tool: "api_get", summary: "讀取 /leave-types", ok: true }]);
  });

  it("權限繼承：employee 用 agent 查薪資，工具收 403（不是繞過）", async () => {
    const app = buildApp(db, {
      agentLlm: scripted([
        { text: "", toolCalls: [{ id: "t1", name: "api_get", input: { path: "/payroll-runs" } }] },
        { text: "你的帳號沒有薪資頁的權限，查不到發薪作業。", toolCalls: [] },
      ]),
    });
    const res = await call(app, "/agent/chat", emp, { messages: [{ role: "user", content: "這個月發薪了嗎" }] });
    expect(res.status).toBe(200);
    expect(res.json.steps[0].ok).toBe(false); // 403 → 工具標失敗，讓模型照實回答
  });

  it("紅線：核准類工具不存在——呼叫未知工具得到明確錯誤而不是執行", async () => {
    const app = buildApp(db, {
      agentLlm: scripted([
        { text: "", toolCalls: [{ id: "t1", name: "approve_expense_claim", input: { claimId: 1 } }] },
        { text: "我沒有核准的權限，核准要由財務在報銷頁操作。", toolCalls: [] },
      ]),
    });
    const res = await call(app, "/agent/chat", emp, { messages: [{ role: "user", content: "幫我核准報銷" }] });
    expect(res.json.steps[0].ok).toBe(false);
    expect(res.json.reply).toContain("核准");
  });

  it("api_get 擋站外與跳脫路徑（SSRF 防護）", async () => {
    const app = buildApp(db, {
      agentLlm: scripted([
        {
          text: "",
          toolCalls: [
            { id: "t1", name: "api_get", input: { path: "https://evil.example/steal" } },
            { id: "t2", name: "api_get", input: { path: "/../etc/passwd" } },
          ],
        },
        { text: "路徑不合法。", toolCalls: [] },
      ]),
    });
    const res = await call(app, "/agent/chat", emp, { messages: [{ role: "user", content: "x" }] });
    expect(res.json.steps.every((s: { ok: boolean }) => !s.ok)).toBe(true);
  });

  it("草稿紅線實測：agent 送出加班申請 → 單據是 pending 等人簽，不是生效", async () => {
    const app = buildApp(db, {
      agentLlm: scripted([
        {
          text: "",
          toolCalls: [
            { id: "t1", name: "create_hr_request", input: { kind: "overtime", workDate: "2026-09-01", dayType: "workday", minutes: 120, reason: "趕案子" } },
          ],
        },
        { text: "加班申請已送出，等主管簽核。", toolCalls: [] },
      ]),
    });
    // 先給小聊一個主管，鏈才不會空（空鏈自動核准是老闆形狀，這裡要測「等人簽」）
    const bossId = (await call(plainApp, "/employees", admin, { name: "聊天主管" })).json.id;
    await call(plainApp, `/employees/${empId}`, admin, { managerEmployeeId: bossId }, "PATCH");
    const res = await call(app, "/agent/chat", emp, { messages: [{ role: "user", content: "幫我申請 9/1 加班 2 小時" }] });
    expect(res.status).toBe(200);
    expect(res.json.steps[0]).toEqual({ tool: "create_hr_request", summary: "送出申請單", ok: true });
    const mine = (await call(plainApp, "/hr-requests/my", emp)).json;
    const created = mine.find((r: { workDate: string }) => r.workDate === "2026-09-01");
    expect(created.status).toBe("pending"); // 落地必須人確認——agent 只能到這裡
    expect(created.employeeId).toBe(empId); // 替自己申請，不是替別人
  });

  it("供應商解析：anthropic／openai／google／vertex-ai 都給得出轉接器；ollama 沒 baseUrl 擋下", async () => {
    const { resolveLlm } = await import("../src/services/agent-chat.ts");
    const set = (body: Record<string, unknown>) => call(plainApp, "/agent-settings", admin, body, "PUT");
    await set({ provider: "anthropic", model: "claude-test", apiKey: "sk-test", enabled: true });
    expect(typeof (await resolveLlm(db))).toBe("function");
    await set({ provider: "openai", model: "gpt-test" });
    expect(typeof (await resolveLlm(db))).toBe("function");
    await set({ provider: "google", model: "gemini-test" });
    expect(typeof (await resolveLlm(db))).toBe("function"); // Gemini API key → 原生 generateContent
    await set({ provider: "vertex-ai", model: "gemini-test" });
    expect(typeof (await resolveLlm(db))).toBe("function"); // Vertex express mode API key
    await set({ provider: "ollama", model: "llama-test", baseUrl: null });
    await expect(resolveLlm(db)).rejects.toThrowError(/Base URL/);
    await set({ enabled: false }); // 還原：別讓後面的測試打真網路
  });

  it("Gemini 轉換：tool_use→functionCall、tool_result 靠 id→name 對照補回名字、回應包物件", async () => {
    const { toGeminiBody, AGENT_TOOLS } = await import("../src/services/agent-chat.ts");
    const body = toGeminiBody(
      "system prompt",
      [
        { role: "user", content: [{ type: "text", text: "查假別" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "api_get", input: { path: "/leave-types" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "[...]", is_error: false }] },
      ] as never,
      AGENT_TOOLS,
    ) as {
      systemInstruction: { parts: { text: string }[] };
      contents: { role: string; parts: Record<string, unknown>[] }[];
      tools: { functionDeclarations: { name: string }[] }[];
    };
    expect(body.systemInstruction.parts[0]!.text).toBe("system prompt");
    expect(body.contents[1]).toEqual({ role: "model", parts: [{ functionCall: { name: "api_get", args: { path: "/leave-types" } } }] });
    // thought_signature 來回攜帶（Gemini 思考模型必要，缺了 400）
    const signed = toGeminiBody(
      "s",
      [{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "api_get", input: {}, signature: "sig-abc" }] }] as never,
      AGENT_TOOLS,
    ) as { contents: { parts: Record<string, unknown>[] }[] };
    expect(signed.contents[0]!.parts[0]).toEqual({ functionCall: { name: "api_get", args: {} }, thoughtSignature: "sig-abc" });
    expect(body.contents[2]).toEqual({ role: "user", parts: [{ functionResponse: { name: "api_get", response: { result: "[...]" } } }] });
    expect(body.tools[0]!.functionDeclarations.map((f) => f.name)).toEqual([
      "api_get", "create_quote", "create_hr_request", "read_memory", "search_memories", "propose_memory", "read_guide",
    ]);
  });

  it("記憶與地圖：system prompt 注入角色功能地圖與指南索引；記憶 propose→核准才進索引", async () => {
    // 捕捉 system prompt 的 stub LLM
    const systems: string[] = [];
    const capture = (script: LlmResult[]): LlmCall => {
      const q = [...script];
      return async (req) => {
        systems.push(req.system);
        return q.shift()!;
      };
    };
    // ① employee 的地圖只有自己看得到的頁；指南索引在；還沒有任何記憶 → 無記憶索引
    let app = buildApp(db, { agentLlm: capture([{ text: "好。", toolCalls: [] }]) });
    await call(app, "/agent/chat", emp, { messages: [{ role: "user", content: "hi" }] });
    expect(systems[0]).toContain("出勤打卡");
    expect(systems[0]).not.toContain("薪資（/payroll）"); // employee 沒有 payroll 頁
    expect(systems[0]).toContain("attendance-and-leave"); // 指南索引
    expect(systems[0]).not.toContain("公司記憶索引");

    // ② agent 提議記憶 → proposed，不進索引
    app = buildApp(db, {
      agentLlm: scripted([
        { text: "", toolCalls: [{ id: "m1", name: "propose_memory", input: { name: "saturday-is-restday", title: "本公司週六是休息日、週日是例假日", body: "固定班的加班申請：週六選休息日、週日選例假日。" } }] },
        { text: "已提議，等管理者核准。", toolCalls: [] },
      ]),
    });
    const res = await call(app, "/agent/chat", emp, { messages: [{ role: "user", content: "記住：我們週六是休息日" }] });
    expect(res.json.steps[0].ok).toBe(true);
    expect(res.json.steps[0].summary).toContain("待核准");
    const memories = (await call(plainApp, "/agent-memories", admin)).json;
    const m = memories.find((x: { name: string }) => x.name === "saturday-is-restday");
    expect(m.status).toBe("proposed");
    expect(m.source).toBe("agent");

    // 還沒核准 → 索引仍不含
    systems.length = 0;
    app = buildApp(db, { agentLlm: capture([{ text: "好。", toolCalls: [] }]) });
    await call(app, "/agent/chat", emp, { messages: [{ role: "user", content: "hi" }] });
    expect(systems[0]).not.toContain("saturday-is-restday");

    // ③ admin 核准 → 進索引；read_memory 讀得到全文
    expect((await call(plainApp, `/agent-memories/${m.id}/approve`, admin, {})).status).toBe(200);
    systems.length = 0;
    app = buildApp(db, {
      agentLlm: capture([
        { text: "", toolCalls: [{ id: "r1", name: "read_memory", input: { name: "saturday-is-restday" } }] },
        { text: "週六是休息日。", toolCalls: [] },
      ]),
    });
    const res2 = await call(app, "/agent/chat", emp, { messages: [{ role: "user", content: "週六加班選哪種日型" }] });
    expect(systems[0]).toContain("saturday-is-restday：本公司週六是休息日");
    expect(res2.json.steps[0]).toEqual({ tool: "read_memory", summary: "讀取記憶 saturday-is-restday", ok: true });

    // ④ 員工碰不到記憶管理 API（admin 限定；讀取只透過 agent 工具）
    expect((await call(plainApp, "/agent-memories", emp)).status).toBe(403);
  });

  it("記憶管理紀律：生效的只能封存不能刪；封存後退出索引；過期退出索引", async () => {
    const memories = (await call(plainApp, "/agent-memories", admin)).json;
    const m = memories.find((x: { name: string }) => x.name === "saturday-is-restday");
    // 生效中 → 刪除被擋、封存可以
    expect((await call(plainApp, `/agent-memories/${m.id}`, admin, undefined, "DELETE")).status).toBe(422);
    // 建一條有到期日的：過期 → 不進索引但 read_memory 讀不到（active 但 expired 排除於索引）
    const old = await call(plainApp, "/agent-memories", admin, {
      name: "calendar-2020",
      title: "2020 年行事曆（已過期示範）",
      body: "舊行事曆",
      staleAfter: "2020-12-31",
    });
    expect(old.status).toBe(201);
    const { memoryIndex } = await import("../src/services/agent-memories.ts");
    const idx = await memoryIndex(db);
    expect(idx).toContain("saturday-is-restday");
    expect(idx).not.toContain("calendar-2020"); // 過期退出索引
    expect((await call(plainApp, `/agent-memories/${m.id}/archive`, admin, {})).status).toBe(200);
    expect(await memoryIndex(db)).not.toContain("saturday-is-restday"); // 封存退出索引
  });

  it("read_guide：讀得到指南全文；不存在的名字給可讀錯誤", async () => {
    const app = buildApp(db, {
      agentLlm: scripted([
        {
          text: "",
          toolCalls: [
            { id: "g1", name: "read_guide", input: { name: "payroll-cycle" } },
            { id: "g2", name: "read_guide", input: { name: "no-such-guide" } },
          ],
        },
        { text: "發薪流程是草稿→定案→過帳。", toolCalls: [] },
      ]),
    });
    const res = await call(app, "/agent/chat", emp, { messages: [{ role: "user", content: "發薪流程？" }] });
    expect(res.json.steps[0]).toEqual({ tool: "read_guide", summary: "讀取指南 payroll-cycle", ok: true });
    expect(res.json.steps[1].ok).toBe(false);
  });

  it("多輪上限：模型一直呼叫工具時在 8 輪後停下，回覆講明原因", async () => {
    const loopy: LlmResult = { text: "", toolCalls: [{ id: "t", name: "api_get", input: { path: "/leave-types" } }] };
    const app = buildApp(db, { agentLlm: scripted(Array.from({ length: 9 }, () => loopy)) });
    const res = await call(app, "/agent/chat", emp, { messages: [{ role: "user", content: "x" }] });
    expect(res.status).toBe(200);
    expect(res.json.reply).toContain("上限");
    expect(res.json.steps).toHaveLength(8);
  });
});
