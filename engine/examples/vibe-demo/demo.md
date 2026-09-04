# LazyBrain + Vibe: 90-second demo

This script walks through the four acts of the Vibe integration.
Each act takes about 20 seconds. No Claude Code session required;
all memory lives in the local HTML brain.

---

## Prerequisites

1. **Vibe** installed and authenticated:
   ```bash
   pip install mistral-vibe   # or: uv add mistral-vibe
   vibe --version              # must print a version string
   ```

2. **MISTRAL_API_KEY** exported in your shell:
   ```bash
   export MISTRAL_API_KEY=sk-...
   vibe "hello"                # smoke test: should print a short reply
   ```

3. **LazyBrain** built from this repo:
   ```bash
   npm ci && npm run build
   # Optionally add dist/bin to PATH or use: node dist/bin/lazybrain.js
   ```

4. A **sample repo** to work in — create the fixture below so Act 1 has
   something real to fix:

   ```bash
   mkdir -p my-app/src/payments
   cat > my-app/src/payments/stripe.ts << 'EOF'
   import Stripe from 'stripe';

   const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

   // BUG: no duplicate-event guard — Stripe retries will reprocess the same event
   export async function handleWebhook(raw: Buffer, sig: string): Promise<void> {
     const event = stripe.webhooks.constructEvent(raw, sig, process.env.STRIPE_WEBHOOK_SECRET!);
     await processEvent(event);   // crashes on retry: duplicate processing
   }

   async function processEvent(event: Stripe.Event): Promise<void> {
     // ... business logic
   }
   EOF
   ```

---

## Setup: wire everything in one command

```bash
cd my-app/
lazybrain init              # initialise the brain directory (one-time)
lazybrain init --agent vibe --enable-hooks --tools --explore
```

What `lazybrain init --agent vibe` does:

- Merges a `[[hooks]]` entry named `lazybrain-capture` into `$VIBE_HOME/hooks.toml`
  (merge-safe: only the `lazybrain-capture` entry is touched; other hooks are
  preserved; TOML comments may be lost because smol-toml rewrites the file).
- Copies the hook shim to `~/.lazybrain/hooks/vibe-hook.mjs` (stable location
  that survives npm reinstalls) and references that path in `hooks.toml`.
- `--enable-hooks` sets `enable_experimental_hooks = true` in
  `~/.vibe/config.toml` (required; hooks are experimental in Vibe).
- `--tools` installs `lazybrain_read.py` into `~/.vibe/tools/`.
- `--explore` installs a brain-aware override of Vibe's `explore` subagent.
- Skills are installed to `~/.agents/skills/<name>/SKILL.md` — the
  cross-agent directory Vibe scans natively (not `~/.vibe/skills/`).

No daemon is started by this command. The hook shim auto-spawns the daemon on
the first hook call, but that adds ~6 s of latency to the first turn. Start it
explicitly before the session so the demo stays snappy:

```bash
lazybrain daemon start
```

Expected output from `init`:
```
init: vibe hook installed       ~/.lazybrain/hooks/vibe-hook.mjs (referenced in $VIBE_HOME/hooks.toml)
init: skills installed          lazybrain-recall, lazybrain-search, lazybrain-query,
                                lazybrain-summary, lazybrain-time-travel
warn: Hooks stay dormant until enable_experimental_hooks=true (re-run with --enable-hooks)
```

(With `--enable-hooks` the warning is absent and `experimentalHooksEnabled: true` is logged.)

---

## Act 1: Live capture

Start a real Vibe session and fix the bug in the fixture file.

```bash
vibe "The stripe webhook crashes on duplicate event IDs. Fix it in src/payments/stripe.ts."
```

Inside the Vibe TUI, the model reads the file, adds an idempotency check, and
explains the approach. End the session normally (Ctrl-D or `/exit`).

The `post_agent_turn` hook fires after the session ends, sending the transcript
path to the LazyBrain daemon. After a few seconds, query the brain:

```bash
lazybrain index-rebuild   # fast; re-reads only changed files
lazybrain query 'article[data-cerveau-agent="vibe"]' --pretty
```

Expected: at least one note appears, tagged `bug` or `decision`, with a fact
about deduplicating webhook events by event ID.

---

## Act 2: Memory that survives session restart

Export the settled decisions into the project `AGENTS.md` that Vibe loads at
startup:

```bash
lazybrain export-agents-md --target project
```

This writes (or updates) `my-app/AGENTS.md` with a fenced block:

```markdown
<!-- lazybrain:begin generated:do-not-edit -->
## Project memory (LazyBrain — generated, do not edit)

### Settled decisions (do not re-litigate)
- we will deduplicate webhook events by event id before processing `[#2026-06-01-...]`

Recall more: `lazybrain search "<topic>" --top 5 --strip`
<!-- lazybrain:end -->
```

Open a **new** Vibe session in the same repo:

```bash
vibe
```

Inside the TUI:
```
> What do you already know about this repo?
```

Vibe loads `AGENTS.md` as part of its system prompt, so the model responds with
the settled decisions from the previous session — no re-explanation needed.

Note: after a batch `lazybrain dream --agent vibe` ingest, re-run
`lazybrain export-agents-md` manually. The live-capture path refreshes
`AGENTS.md` automatically (debounced, default 300 s), but batch dream does not.

---

## Act 3: Lazy spatial recall

This feature is **TUI-only** — it works in the Vibe interactive terminal, not
in ACP/editor integrations.

Still in the new Vibe session (or start a fresh one with `vibe`), ask the model
to open the file that was fixed:

```
> Read src/payments/stripe.ts and summarize what changed recently.
```

When `--tools` is installed, `~/.vibe/tools/lazybrain_read.py` registers itself
as `read` in Vibe's tool registry, overriding the builtin. This happens because
Vibe loads user tools after builtins, and the class name `Read` shadows the
original. Only `get_result_extra` is overridden — the underlying file read is
unchanged.

When the model reads a file, the override runs one `lazybrain query` subprocess
(capped at 0.8 s) looking for settled notes about that file. If any are found,
they are appended as a `<lazybrain-memory>` block in the tool result:

```xml
<lazybrain-memory>
  decision: deduplicate webhook events by event id before processing
  source: session:vibe-9931627b  confidence: 0.86
</lazybrain-memory>
```

The model surfaces the prior decision without any explicit recall request.
If the brain is unavailable or `lazybrain` is not on PATH, the override falls
back to plain builtin behaviour silently.

---

## Act 4: Anti-amnesia after compaction

Force a context compaction inside the Vibe TUI:

```
> /compact
```

Vibe compacts the context and injects a summary as an inline `user` message
(marked `injected: true`) with the literal prefix
`"Another language model started to solve this problem"`. Normally the raw
messages before compaction are no longer accessible. With LazyBrain, the hook
captured the transcript before compaction, so the full session detail is already
in the brain. Query the lineage:

```bash
lazybrain query 'article[data-cerveau-source-kind="compaction-summary"]' --pretty
```

Expected: a note appears — it was stored from the pre-compaction transcript, so
it contains the full session detail that Vibe's compaction would otherwise lose.

To recover the session-parent chain (what context the model had before the
compaction):

```bash
lazybrain query 'article[data-cerveau-source-kind="compaction-summary"]' \
  | grep "data-cerveau-session-parent"
```

The `data-cerveau-session-parent` attribute points back to the pre-compaction
session ID.

Note on `/clear`: in Vibe v2.9.4+, `/clear` no longer chains
`parent_session_id` to the previous session. Lineage chains may simply end at a
`/clear` — this is expected behaviour, not a bug.

---

## Batch ingest (first-time setup or catch-up)

If you have many existing Vibe sessions, ingest them all at once:

```bash
lazybrain dream --agent vibe --pretty
lazybrain index-rebuild
lazybrain export-agents-md --target project
```

`dream` must run before `index-rebuild` — it writes the HTML notes that
`index-rebuild` indexes. After batch ingestion, run `export-agents-md` manually
to propagate the new notes into `AGENTS.md` (the live hook does this
automatically during normal Vibe sessions, but `dream` does not trigger it).

---

## What to show a live audience

| Moment | Command | What to highlight |
|--------|---------|-------------------|
| End of Act 1 | `lazybrain query '...' --pretty` | Note appears < 2 s after session ends |
| Start of Act 2 | Open `AGENTS.md` in an editor | Fenced block, human prose untouched |
| Middle of Act 2 | Ask "what do you know?" in new session | Same decision, zero re-explanation |
| Act 3 | Watch Vibe open the file (TUI only) | `<lazybrain-memory>` block in context |
| Act 4 | `/compact` then query | Compaction note exists; session-parent linked |

The full round-trip from "end session" to "new session already knows" is under 5
seconds on a laptop with a warm daemon.
