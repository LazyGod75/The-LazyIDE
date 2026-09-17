# Jev (TypeSafe) — optional semantic-judgment layer

Jev is TypeSafe's "System One" model: not a generative LLM — a bounded
judgment primitive. Callers send an opaque JSON `state` plus typed
questions (`noul` → P(yes), `choice` → option + probabilities,
`score` → level + confidence) and get calibrated answers back in
~300–800 ms. LazyIDE uses it as an **opt-in enhancement layer** the
orchestrator and agents can consult — never as the orchestrator, never
as a required dependency.

## The contract

- **Optional**: Jev mode requires BOTH a TypeSafe key in the vault AND
  the user toggle (`lazy.jev.enabled`). No key → every code path is
  byte-identical to before; the `ask_jev` tool is not even documented
  in prompts.
- **BYOK only**: the key is the user's own TypeSafe key — no Lazy Pro
  involvement, no proxy.
- **Fail-safe everywhere**: timeout, HTTP error, malformed response, or
  mode off → the caller falls back to the deterministic behavior.
  Nothing can block or break because of Jev.
- **Key never enters the WebView**: `jev_ask` (src-tauri) reads the key
  from the OS vault inside Rust — required anyway since
  api.typesafe.ai emits no `Access-Control-Allow-Origin`, which also
  matches TypeSafe's "credentials server-side" recommendation.

## Layout

| File | Role |
|---|---|
| `src/lib/jev/jevTypes.ts` | Wire types (questions, answers, response) |
| `src/lib/jev/jevMode.ts` | `isJevConfigured()` / `isJevModeOn()` gates, vault init, `jev:stateChange` bus event |
| `src/lib/jev/jevClient.ts` | `jevAsk` — invoke `jev_ask` on Tauri, fetch fallback on browser; timeout, one retry on 408/429/5xx, answer validation |
| `src/lib/jev/jevAskRunner.ts` | `runAskJev` — shared validator + formatter behind the manager action and the managed-agent tool; never throws |
| `src/lib/jev/jevEnhancements.ts` | The four product judgments (below) with conservative thresholds |
| `src/lib/jev/jevJournal.ts` | `jev.judgment` journal event — model, latency, input tokens, compact answers; never raw state |
| `src-tauri/src/commands/jev.rs` | `jev_ask` command — vault read + HTTPS call + bounded timeout/body, categorized errors |

## What Jev mode enables

1. **`ask_jev` manager action** — the LazyManager can ask a bounded
   judgment mid-turn (`state` + up to 5 questions) and gets a grounded
   follow-up result. Prompt documentation is injected only when the
   mode is on, so users without a key pay zero prompt tokens.
2. **`ask_jev` managed-agent tool** — same runner, same formatting,
   visible in tool profiles only when the mode is on; classified
   read-only/safe (search-lane permissions).
3. **LazyBot intent disambiguation** — when the deterministic
   regex fallback fails to resolve which bot a message means, Jev
   `choice`s among candidates; below the probability threshold it
   declines rather than guessing. Live: "lance le bot scraper" →
   resolved `bot-1`.
4. **Wakeup triage** — before spending a real manager turn on a
   coalesced wakeup batch, Jev votes proceed/skip plus a per-item
   keep-list. Critical kinds (mission failures, approval blocks, bot
   completions…) always survive the filter; any failure is fail-open.
   Live: single noise item → `proceed:false`; mixed batch →
   `{proceed:true, keep:[…]}` in 318 ms.
5. **Mission-review advisory** — fire-and-forget when a mission enters
   review: `P(satisfies)` + urgency shown as an advisory chip on the
   mission card. Advisory ONLY — it cannot approve, reject, or merge.
   Live: satisfies 0.82, urgency normalized to the 0–2 index.
6. **Federated-recall rerank** — Jev rescues relevance ordering of
   recalled hits; if every hit is dropped or the call fails, the
   original context is kept untouched.

## Settings UI

`Settings → Jev` (its own tab): key field (vault-backed, save/remove),
mode toggle, configured/on badges, feature list with honest numbers
(~100 ms-class judgments, ≈$0.042/Mtok input, output free), links to
docs.typesafe.ai. The LazyManager header gets a `Jev` chip (on / off /
no-key states) that deep-links to the tab via `nav:navigateSpace`.

## Thresholds (first pass — calibrate on real usage)

In `jevEnhancements.ts`: noul yes ≥ 0.6, choice pick ≥ 0.5, wakeup
keep ≥ 0.5, recall keep ≥ 0.4, batch cap 10 questions. Interactive
calls time out at 2.5 s, background batches at 4 s, the recall rerank
at 2 s (measured: a 3-question batch takes ~1.5–3 s; the rerank sits
on the manager-turn path so it gets a tighter budget and still fails
open on timeout). The review chip dims when the score's own
confidence is < 0.35 (confidence-gated display — a weak judgment
must look weak).

## Testing

- `src/lib/jev/__tests__/jev.test.ts` — 30 tests: client retry/timeout/
  validation, mode gates, runner never-throws contract, all four
  enhancements' fallback behavior, journal event shape.
- Live-verified under Tauri (CDP): real key → `jev-1.13.0` answers,
  vault-only storage (`window.__lazyJevKey` stays undefined), journal
  events in FLUX, manager end-to-end `ask_jev` turn.
