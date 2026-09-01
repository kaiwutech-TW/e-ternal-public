# WebMCP Challenge Submission Notes

> **What to judge — in one paragraph.** This is a pre-existing open-source ERP. Per the rules,
> please evaluate **only the work added during the Submission Period**: the WebMCP layer in
> `apps/web/src/webmcp/` (tools, live co-edited drafts, human approval gate, dynamic role-scoped
> registry, agent activity panel), the English internationalization, the demo dataset script and
> the live deployment. The ERP itself — inventory, double-entry accounting, e-invoicing, VAT
> filing, HR/payroll and its test suite — predates the challenge and is *not* submitted for
> scoring; it is the stage the WebMCP work performs on, which is why the demo feels like a real
> product rather than a toy. Verification commands and commit references are in the
> "Prior work vs. new work" section below.

This document exists for the [OpenAI WebMCP Challenge](https://webmcp.devpost.com/) judges and
satisfies the rule that pre-existing projects must *"provide clear documentation distinguishing
prior work from new work, including evidence that it was meaningfully extended with WebMCP
within the Submission Period."*

## What this project is

**E-ternal** is an open-source (LGPL-3.0-or-later) ERP for Taiwanese SMEs — quotes/orders/shipping,
double-entry accounting, e-invoicing (MIG-4.1), VAT filing, HR and payroll. For this challenge we
made the ERP **agent-native in the browser**: the pages a human works on now expose WebMCP tools
(`navigator.modelContext`), so a person and their browser agent operate the *same screen, same
state, same guardrails* — together.

## Prior work vs. new work (rules compliance)

- **Prior work (before the Submission Period):** the entire ERP itself, squashed into the root
  commit of this public repository (dated 2026-08-26). The private development history was
  squashed because it contains a client's confidential data; nothing about WebMCP existed in the
  codebase before the Submission Period.
- **New work (during the Submission Period, what we ask to be judged on):**
  - `apps/web/src/webmcp/` — the complete WebMCP integration (commit `7df6fbe`, 2026-08-27,
    and follow-ups). Every file in that directory is new work.
  - English internationalization of the full UI (`apps/web/src/i18n.ts`, `apps/web/src/locales/`)
    so agents and judges can use the product in English.
  - `scripts/demo-seed.mjs` — one-command demo dataset for the live site.
  - The live demo deployment.

  Verify with: `git log --oneline --since=2026-08-24 -- apps/web/src/webmcp apps/web/src/locales scripts/demo-seed.mjs`

## Why this is a *deep* use of WebMCP, not an API wrapper

1. **Human-in-the-loop by structure, not by prompt.** The tool registry contains *no* tool that
   posts to the ledger, approves a document, or voids one. Writes only ever produce an on-screen
   **draft**; the only path into the ERP is `submit_draft`, which suspends the tool call and pops
   an approval card that **only the human can click**. A jailbroken agent cannot open a door that
   was never registered. (This extends the project's existing assistant discipline —
   `agent/soul.md`: "the red line is structure, not self-restraint" — into the WebMCP layer.)
2. **Live co-editing on shared state.** `draft_quote` fills a visible draft card field by field;
   `update_draft_field` and direct human edits land on the *same* draft. Agent edits flash blue,
   human edits flash green. This is the thing a backend MCP server fundamentally cannot do:
   the agent and the human look at — and edit — the same pixels.
3. **Dynamic, least-privilege tool registry.** Tools are recomputed from *role × current page*
   and re-synced on every change (logout ⇒ zero tools; a sales account never sees finance tools).
   Read-only tools are annotated `readOnlyHint: true`; the browser/agent may call them freely.
4. **Domain guardrails inside the tools.** Prices are untaxed integers; the tax amount is *never*
   computed client-side — the ERP resolves it from user-maintained tax parameters at creation
   (this repo's "zero-assertion" tax discipline). Fuzzy customer/product resolution returns
   explicit candidate lists on ambiguity instead of guessing.
5. **Visible agency.** Every tool call is streamed into an on-screen "Agent activity" panel,
   so the human always sees what their agent just did.
6. **Hardened tool surface** (every claim below is tested in `apps/web/test/webmcp-hardening.test.ts`):
   - *In-handler validation.* The browser does **not** validate arguments against `inputSchema`
     before calling `execute` — so a central wrapper (which no tool can opt out of) validates
     every call and returns a structured `{ok:false, error:{code}, hint}` envelope where the
     `hint` names the agent's next legal move, instead of letting it retry blind.
   - *Live schemas as boundaries.* `update_draft_field`'s `lineIndex` carries a `maximum` equal
     to the open draft's last line; the draft changing shape re-registers the tool with the new
     contract. An out-of-range edit is unrepresentable, not merely refused.
   - *Untrusted-content quarantine.* Tools whose results carry third-party text (customer names,
     memos) declare `untrustedContentHint` and their entire output passes through a fence:
     NFKC normalization, invisible-character stripping by Unicode property (not blocklist),
     unforgeable `⟦UNTRUSTED⟧` markers, and a standing notice that fenced content is data, never
     instructions.
   - *Idempotent submission.* A `submit_draft` retried after a timeout replays the already-created
     quote instead of re-drafting it; while the approval card is on screen a second submit returns
     `approval_pending` rather than being misread as a human decline.
   - *Honest annotations + bounded output.* `readOnlyHint` / `untrustedContentHint` /
     `destructiveHint` / `idempotentHint` declared per tool; results are budget-capped with an
     explicit trim marker.

## Architecture (all new files)

```
apps/web/src/webmcp/
  model-context.ts   navigator.modelContext wrapper: feature detection, name-keyed
                     dynamic sync (provideContext when available, register/unregister diff
                     otherwise), window.webmcp console test bench
  tools.ts           11 tools (English descriptions; JSON-Schema inputs; role-gated)
  bus.ts             framework-free state bus: activity log, co-edited draft, approval requests,
                     idempotent submission record
  validate.ts        in-handler JSON-Schema validation (the browser does not validate for you)
  quarantine.ts      untrusted-content fence: NFKC + Unicode-property invisible-strip + ⟦UNTRUSTED⟧
  WebMcp.tsx         React mount: dynamic registration effect + draft card + approval card
                     + activity panel (fully i18n'd, light/dark aware)
  webmcp.css         styles on the app's existing theme tokens
apps/web/src/App.tsx  3-line mount (<WebMcp page={current.key} />)
scripts/demo-seed.mjs demo dataset via public API (idempotent)
```

## Try it

- **Live demo:** https://et-demo.kaiwu.com.tw — HTTPS, as WebMCP is SecureContext-only.
  Data resets are manual; feel free to create drafts and quotes.
  - **Judge account:** username `judge` / password `webmcp-judge` (role: finance — can read
    reports, draft documents *and* click the approval card; the gm role is read-only by design)
- **Source:** https://github.com/kaiwutech-TW/e-ternal-public (LGPL-3.0-or-later)
- **Reusable playbook:** we distilled this integration into an open-source agent skill —
  https://github.com/kaiwutech-TW/webmcp-skill (MIT) — so any team can make their own site
  agent-ready the same way: the API reality check, the browser traps we hit, the five
  structural guardrails, and framework-free TypeScript templates.
- **Demo video (2:14):** https://youtu.be/iiRdpZtWoyk — a real agent (ChatGPT desktop, GPT-5.6 Sol) runs the whole flow on the live site; edited for pacing only
- **Agent browsers:** ChatGPT's in-app browser supports WebMCP out of the box; Chrome 146+ works
  with the WebMCP experimental flag enabled.
- **No agent handy?** Open DevTools on any logged-in page:
  `webmcp.list()` → the registered tools; `await webmcp.execute("draft_quote", {customer: "ACME", lines: [{product: "Widget Pro", qty: 50}]})`
  → watch the draft card appear, then `await webmcp.execute("submit_draft")` → the approval card
  waits for your click.
- **Local run (3 minutes, no database):**
  ```bash
  pnpm install && pnpm --filter @tw-erp/web build && pnpm --filter @tw-erp/api dev:memory
  node scripts/demo-seed.mjs   # demo data + accounts (admin / judge)
  ```

## Suggested script for the agent

1. "What did we sell this month, and who owes us money?" — read-only reporting tools.
2. "Draft a quote for ACME: 80 Widget Pro at list price, plus one installation." — the draft
   card fills in field by field; edit a quantity yourself and watch the green flash.
3. "Make it 60 units and submit." — the approval card appears; the decision is yours, not the
   agent's.
