# Contributing to Lazy

Short version: install, run the checks below, follow the code standards, commit with Conventional Commits.

## Setup

```bash
npm install
```

Requirements: Node 20.12+, Rust (rustup) + MSVC C++ Build Tools on Windows. See [README.md](./README.md#prerequisites) for the full list (LazyBrain engine, `claude` CLI for agent features).

## Running in dev

```bash
npm run tauri dev     # desktop app, hot-reload, full features
npm run build && npm run preview   # web-only preview (mock data only)
```

## Verification commands

Run these before opening a PR — they mirror `.github/workflows/ci.yml` and `checks-full.yml`:

```bash
npm run typecheck        # tsc -p tsconfig.app.json — must report 0 errors
npm run lint              # eslint . — must report 0 errors, 0 warnings
npm test                  # vitest run — all tests must pass
npm run build              # tsc -b && vite build
cd src-tauri && cargo check && cargo test   # Rust backend
npx playwright test        # e2e/smoke.spec.ts
```

`npm run verify` additionally scans for committed secrets (`npm run secrets:check`). Install the local git hook with `npm run hooks:install` (also runs on `npm install`).

Do not commit Stripe keys, Supabase service-role keys, OpenRouter keys, R2/AWS secrets, or Tauri signing private keys. See [SECURITY.md](./SECURITY.md). Before a public GitHub publish, follow [docs/OPEN-SOURCE-CHECKLIST.md](./docs/OPEN-SOURCE-CHECKLIST.md) and run `npm run export:public:dry`.

## Commit conventions

Conventional Commits, in English:

```
<type>: <description>

<optional body>
```

Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`.

## Code standards

- Files: 200-400 lines typical, 800 max. Extract cohesive units instead of growing one file.
- Functions: under 50 lines, no nesting beyond 4 levels.
- Immutability: never mutate inputs or shared state — always return new objects.
- Validate at system boundaries; handle errors explicitly, never swallow silently.
- No hardcoded secrets — environment variables only (see `.env.example`).

## Error handling: marking a best-effort catch

`.catch(() => {})` (or an empty `catch {}` block) is sometimes the right call — cleanup, telemetry, a fire-and-forget notification whose failure genuinely changes nothing the user can act on. The problem is that an empty catch looks identical whether it is a deliberate decision or a forgotten error path. Convention:

- **A best-effort swallow MUST carry a one-line comment immediately above (or on) the catch explaining why the failure is safe to ignore** — what fails, and why nothing downstream depends on it. Example:

  ```ts
  // Best-effort cleanup: killing the process is advisory here — the user has
  // already taken over manually, and a lingering process is caught by the
  // next status poll either way.
  await killAgentRun(id).catch(() => {});
  ```

- **If you cannot write that sentence, it is not a best-effort catch — it is an oversight.** Add at minimum `console.error('<Module>: <operation> failed', { ...context, error })` so the failure leaves a trace. Add a visible toast too when a user-initiated action silently no-opping would leave them with no way to tell what happened (see `SpacesRail.tsx`'s `handleSwitchFailure` for the pattern).
- Never change the nominal (success-path) behavior when adding this observability — only the failure path gains a trace.

## Where things live

See [README.md](./README.md#architecture) for the stack and the "Cockpit of Spaces" overview, and [SPEC.md](./SPEC.md) for the full product specification.
