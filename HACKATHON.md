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

- **Prior work (before the Submission Period):** the entire ERP itself — see the git history,
  which is continuous and timestamped. Nothing about WebMCP existed in the codebase before the
  Submission Period.
- **New work (during the Submission Period, what we ask to be judged on):**
  - `apps/web/src/webmcp/` — the complete WebMCP integration (commit `d39a3f5`, 2026-08-27,
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

## Architecture (all new files)

```
apps/web/src/webmcp/
  model-context.ts   navigator.modelContext wrapper: feature detection, name-keyed
                     dynamic sync (provideContext when available, register/unregister diff
                     otherwise), window.webmcp console test bench
  tools.ts           11 tools (English descriptions; JSON-Schema inputs; role-gated)
  bus.ts             framework-free state bus: activity log, co-edited draft, approval requests
  WebMcp.tsx         React mount: dynamic registration effect + draft card + approval card
                     + activity panel (fully i18n'd, light/dark aware)
  webmcp.css         styles on the app's existing theme tokens
apps/web/src/App.tsx  3-line mount (<WebMcp page={current.key} />)
scripts/demo-seed.mjs demo dataset via public API (idempotent)
```

## Try it

- **Live demo:** _URL in the Devpost submission_ — sign in as `judge` (credentials in the
  submission). The site is HTTPS (WebMCP is SecureContext-only).
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
