/**
 * CSMB — Coding Session Memory Bench.
 *
 * Designed for the LazyBrain usecase: persistent memory across Claude Code
 * sessions of an agent that writes code, runs tools, makes decisions. The
 * public benchmarks (LOCOMO / LongMemEval / BEAM) test chatbot-style
 * conversations and are not representative — they undersell systems that
 * actually carry tool-call traces, supersession chains, and architectural
 * invariants.
 *
 * Five categories that matter for coding agents:
 *
 *   TF  — Tool-trace fidelity:        recall a specific Bash/Edit outcome from N turns ago
 *   DI  — Decision invalidation:      surface the *current* active decision when the
 *                                     mind was changed mid-session (bi-temporal)
 *   CF  — Cross-file consistency:     when a convention was established for X, find it
 *                                     when asked about Y
 *   RT  — Reasoning trail:            "why is this async?" → retrieve the original
 *                                     decision + its causal context
 *   AR  — Anti-redo / negative:       remember failed experiments so the agent doesn't
 *                                     re-propose them
 *
 * Each fixture:
 *   - ingest : ordered turns to store (text + session tag)
 *   - question : what the agent later asks
 *   - expectedSnippets : substrings that MUST appear in retrieved top-K hits
 *   - mustNotContain (optional) : substrings that, if present, indicate the
 *     memory served a superseded / invalidated answer → counted as a failure
 *
 * Scoring:
 *   - substring recall over top-K
 *   - LLM-as-judge via Claude CLI (Haiku) — gold answer vs retrieved evidence
 *   - per-category roll-up + overall
 *
 * Usage:
 *   node --import tsx bench/csmb.ts --top 5 --judge haiku
 *   node --import tsx bench/csmb.ts --top 5 --judge haiku --warm
 *   node --import tsx bench/csmb.ts --top 5 --judge haiku --no-isolated  # use prod daemon
 *   node --import tsx bench/csmb.ts --top 5 --judge haiku --brain /path  # explicit brain
 *
 * Tags everything `bench:csmb:*` so a single
 *   lazybrain compress --purge-source bench:csmb
 * cleans up after a run.
 *
 * Sprint #5: isolated bench brain by default (--isolated true) to prevent
 * contamination from the user's real notes when interlink runs in warm mode.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { callClaudeCli, isClaudeCliAvailable } from '../src/util/claude-cli.js';

const BENCH_PORT_DEFAULT = 37789;
const BENCH_PORT = parseInt(process.env.LAZYBRAIN_BENCH_PORT ?? String(BENCH_PORT_DEFAULT), 10);

type Category =
  | 'tool-trace'
  | 'decision-invalidation'
  | 'cross-file'
  | 'reasoning-trail'
  | 'negative-memory'
  | 'error-recall'
  | 'filetree-scope'
  | 'commit-trail'
  | 'schema-evolution'
  | 'dep-history';

interface CSMBFixture {
  id: string;
  category: Category;
  ingest: Array<{ session: string; text: string }>;
  question: string;
  expectedSnippets: string[];
  mustNotContain?: string[];
  notes?: string;
}

const FIXTURES: CSMBFixture[] = [
  // ─── Tool-trace fidelity ───────────────────────────────────────────────
  {
    id: 'tf-pytest-output',
    category: 'tool-trace',
    ingest: [
      { session: 'tf-pytest-1', text: 'Bash: pytest tests/test_auth.py -v. Output: FAILED test_token_refresh - AssertionError: expected 200 got 401. 3 passed, 1 failed.' },
      { session: 'tf-pytest-2', text: 'Edit src/auth.py: fixed token refresh to use new endpoint /v2/oauth/refresh.' },
      { session: 'tf-pytest-3', text: 'Bash: pytest tests/test_auth.py -v. Output: 4 passed.' },
    ],
    question: 'What did the pytest run on test_auth.py originally fail on?',
    expectedSnippets: ['token_refresh', '401'],
  },
  {
    id: 'tf-grep-find',
    category: 'tool-trace',
    ingest: [
      { session: 'tf-grep-1', text: 'Bash: grep -rn "TODO" src/. Found 7 TODOs in src/payment.py and src/email.py.' },
      { session: 'tf-grep-2', text: 'Edit src/payment.py: removed 4 TODOs by implementing stripe webhook handler.' },
    ],
    question: 'Where were the TODOs found in the codebase?',
    expectedSnippets: ['payment.py', 'email.py'],
  },

  // ─── Decision invalidation (bi-temporal) ───────────────────────────────
  {
    id: 'di-tailwind-version',
    category: 'decision-invalidation',
    ingest: [
      { session: 'di-tw-1', text: 'Decision: use Tailwind v3 for the new dashboard. Stable, well-documented.' },
      { session: 'di-tw-2', text: 'Decision: switching to Tailwind v4 instead. Reason: native CSS variables, smaller bundle, and we need oklch colors.' },
    ],
    question: 'What is the current Tailwind version we are using on the dashboard?',
    expectedSnippets: ['v4'],
    mustNotContain: ['Stable, well-documented'],
    notes: 'Active state should beat the original (invalidated) decision.',
  },
  {
    id: 'di-orm-switch',
    category: 'decision-invalidation',
    ingest: [
      { session: 'di-orm-1', text: 'Decision: use Prisma as the ORM. Strong typing, migrations are easy.' },
      { session: 'di-orm-2', text: 'Update: rolling back to raw SQL with Kysely. Prisma migrations broke twice in prod.' },
    ],
    question: 'Which ORM are we using now?',
    expectedSnippets: ['Kysely'],
    mustNotContain: ['Strong typing, migrations are easy'],
  },

  // ─── Cross-file consistency ────────────────────────────────────────────
  {
    id: 'cf-repository-pattern',
    category: 'cross-file',
    ingest: [
      { session: 'cf-repo-1', text: 'Created UserRepository in src/repositories/user.ts: findAll, findById, create, update, delete. All return Promise<User | null>. Constructor takes a Kysely instance.' },
      { session: 'cf-repo-2', text: 'Edit src/repositories/user.ts: added findByEmail. Same Promise<User | null> shape.' },
    ],
    question: 'I need to write OrderRepository — what is the convention I should follow?',
    expectedSnippets: ['UserRepository', 'Kysely'],
  },
  {
    id: 'cf-error-handling',
    category: 'cross-file',
    ingest: [
      { session: 'cf-err-1', text: 'Convention: API handlers wrap business calls in try/catch and return { ok: false, error: { code, message } } on failure. See src/api/login.ts as the reference implementation.' },
      { session: 'cf-err-2', text: 'Edit src/api/signup.ts: applied the { ok: false, error } envelope used by login.' },
    ],
    question: 'How should I handle errors in the new /api/password-reset handler?',
    expectedSnippets: ['ok: false', 'error'],
  },

  // ─── Reasoning trail (why?) ────────────────────────────────────────────
  {
    id: 'rt-async-decision',
    category: 'reasoning-trail',
    ingest: [
      { session: 'rt-async-1', text: 'Why we made parseCsv() async: the benchmark showed a 4x speedup vs sync when streaming files > 50MB. Decision date: 2026-03-12.' },
      { session: 'rt-async-2', text: 'Edit src/csv.ts: changed parseCsv signature to async. Updated 3 call sites.' },
    ],
    question: 'Why is parseCsv() async?',
    expectedSnippets: ['benchmark', '4x', '50MB'],
  },
  {
    id: 'rt-postgres-constraint',
    category: 'reasoning-trail',
    ingest: [
      { session: 'rt-pg-1', text: 'Reason for the email-lower index: Postgres ILIKE could not use the existing btree because of case sensitivity. We added a functional index ON email_lower(email).' },
      { session: 'rt-pg-2', text: 'Bash: EXPLAIN ANALYZE confirmed the new index is used by login queries.' },
    ],
    question: 'Why is there a functional index on email_lower?',
    expectedSnippets: ['ILIKE', 'case sensitivity'],
  },

  // ─── Negative / anti-redo memory ───────────────────────────────────────
  {
    id: 'ar-server-actions',
    category: 'negative-memory',
    ingest: [
      { session: 'ar-rsc-1', text: 'We tried using Server Actions for the admin dashboard mutations. Result: broke streaming responses and tanked LCP. Reverted to API routes. Do not retry this on Next 15.' },
      { session: 'ar-rsc-2', text: 'Edit src/app/admin/page.tsx: reverted from action={mutate} back to fetch("/api/mutate"). Performance recovered.' },
    ],
    question: 'Should I use Server Actions for the dashboard mutations?',
    expectedSnippets: ['broke streaming', 'do not retry', 'Do not retry'],
  },
  {
    id: 'ar-bun-runtime',
    category: 'negative-memory',
    ingest: [
      { session: 'ar-bun-1', text: 'Attempted: replace Node with Bun runtime in CI. Result: better-sqlite3 native binding failed to link on the Bun version we used. Abandoned. Keep Node 20 in CI.' },
    ],
    question: 'Can we switch the CI to Bun runtime?',
    expectedSnippets: ['better-sqlite3', 'Abandoned'],
  },

  // ─── A/B: <mark> format comparison ────────────────────────────────────
  {
    id: 'ab-mark-element',
    category: 'tool-trace',
    ingest: [
      { session: 'ab-mark-el-1', text: 'Critical finding: the query planner skips the <mark>composite_idx</mark> index when the OFFSET clause exceeds 10000 rows. Fix: use keyset pagination.' },
    ],
    question: 'Which index does the query planner skip with large OFFSET?',
    expectedSnippets: ['composite_idx', 'keyset'],
    notes: 'A/B variant: <mark> HTML element for highlighting.',
  },
  {
    id: 'ab-mark-class',
    category: 'tool-trace',
    ingest: [
      { session: 'ab-mark-cls-1', text: 'Critical finding: the query planner skips the <span class="mark">composite_idx</span> index when the OFFSET clause exceeds 10000 rows. Fix: use keyset pagination.' },
    ],
    question: 'Which index does the query planner skip with large OFFSET?',
    expectedSnippets: ['composite_idx', 'keyset'],
    notes: 'A/B variant: class="mark" span for highlighting.',
  },
  {
    id: 'ab-mark-markdown',
    category: 'tool-trace',
    ingest: [
      { session: 'ab-mark-md-1', text: 'Critical finding: the query planner skips the **composite_idx** index when the OFFSET clause exceeds 10000 rows. Fix: use keyset pagination.' },
    ],
    question: 'Which index does the query planner skip with large OFFSET?',
    expectedSnippets: ['composite_idx', 'keyset'],
    notes: 'A/B variant: **markdown bold** for highlighting.',
  },

  // ─── CAT 6 — Error-recall ─────────────────────────────────────────────────
  {
    id: 'er-python-traceback',
    category: 'error-recall',
    ingest: [
      {
        session: 'er-py-tb-1',
        text: 'Bash: python manage.py migrate. Output: django.db.utils.OperationalError: no such table: auth_user. Traceback: File "django/db/backends/sqlite3/base.py", line 357, in execute. Root cause: migrations were not applied after git pull.',
      },
      {
        session: 'er-py-tb-2',
        text: 'Fix applied: ran "python manage.py migrate --run-syncdb" then "python manage.py createsuperuser". All subsequent migrations applied cleanly. Added post-pull hook reminder.',
      },
    ],
    question: 'How do I fix this error: django.db.utils.OperationalError: no such table: auth_user?',
    expectedSnippets: ['migrate --run-syncdb', 'auth_user'],
  },
  {
    id: 'er-js-typeerror',
    category: 'error-recall',
    ingest: [
      {
        session: 'er-js-te-1',
        text: "Runtime error in browser console: TypeError: Cannot read properties of undefined (reading 'map'). Stack: at UserList (UserList.tsx:34). Cause: the API response shape changed — data is now nested under response.data.users, not response.users.",
      },
      {
        session: 'er-js-te-2',
        text: 'Fix: updated UserList.tsx line 34 to use response.data.users instead of response.users. Added optional chaining: response.data?.users ?? []. Added Zod schema validation on API boundary to catch shape regressions early.',
      },
    ],
    question: "How do I fix: TypeError: Cannot read properties of undefined (reading 'map') in UserList?",
    expectedSnippets: ['response.data.users', 'optional chaining'],
  },
  {
    id: 'er-npm-install-failure',
    category: 'error-recall',
    ingest: [
      {
        session: 'er-npm-1',
        text: 'Bash: npm install. Output: npm ERR! code ERESOLVE. npm ERR! ERESOLVE unable to resolve dependency tree. npm ERR! peer eslint@"^8.0.0" from eslint-config-next@14.0.0. Root cause: project has eslint@9 but eslint-config-next requires eslint@8.',
      },
      {
        session: 'er-npm-2',
        text: 'Fix: downgraded eslint to 8.57.0 with "npm install eslint@8.57.0 --save-dev". Alternatively: npm install --legacy-peer-deps works as a one-shot but masks the real conflict. Chose to pin eslint@8 explicitly in package.json.',
      },
    ],
    question: 'How do I fix: npm ERR! ERESOLVE unable to resolve dependency tree for eslint-config-next?',
    expectedSnippets: ['eslint@8.57.0', 'legacy-peer-deps'],
  },
  {
    id: 'er-git-merge-conflict',
    category: 'error-recall',
    ingest: [
      {
        session: 'er-git-mc-1',
        text: 'Bash: git merge feature/auth. Output: CONFLICT (content): Merge conflict in src/middleware/auth.ts. Auto-merging failed. Both branches modified the validateToken function signature — main added an options param, feature/auth changed the return type to a discriminated union.',
      },
      {
        session: 'er-git-mc-2',
        text: 'Fix: manually resolved by merging both changes — kept the options param from main AND the discriminated union return type from feature/auth. Updated all 6 call sites. Ran tsc --noEmit to confirm no remaining type errors. Committed with "fix: merge auth middleware changes from feature/auth".',
      },
    ],
    question: 'How do I resolve a git merge conflict in src/middleware/auth.ts involving validateToken?',
    expectedSnippets: ['discriminated union', 'tsc --noEmit'],
  },
  {
    id: 'er-docker-build-error',
    category: 'error-recall',
    ingest: [
      {
        session: 'er-docker-1',
        text: 'Bash: docker build -t app:latest .. Output: Step 7/12: RUN npm ci. ERROR: npm ci can only install packages when your package.json and package-lock.json are in sync. Root cause: package-lock.json was not committed after adding the sharp dependency.',
      },
      {
        session: 'er-docker-2',
        text: 'Fix: ran npm install locally to regenerate package-lock.json, committed it with "chore: sync package-lock after adding sharp". Docker build then succeeded. Added pre-commit check: npm run check:lock to detect future drift.',
      },
    ],
    question: 'How do I fix Docker build error: npm ci package.json and package-lock.json out of sync?',
    expectedSnippets: ['package-lock.json', 'check:lock'],
  },
  {
    id: 'er-postgres-deadlock',
    category: 'error-recall',
    ingest: [
      {
        session: 'er-pg-dl-1',
        text: 'Production error: ERROR: deadlock detected. DETAIL: Process 1234 waits for ShareLock on transaction 5678; Process 5678 waits for ShareLock on transaction 1234. Table: orders. Two concurrent requests were updating orders and order_items in opposite order.',
      },
      {
        session: 'er-pg-dl-2',
        text: 'Fix: enforced consistent lock acquisition order — always lock orders before order_items. Wrapped both updates in a single transaction with explicit SELECT FOR UPDATE on the orders row first. Added retry logic with exponential backoff for deadlock error code 40P01.',
      },
    ],
    question: 'How do I fix the Postgres deadlock on the orders table?',
    expectedSnippets: ['SELECT FOR UPDATE', '40P01'],
  },
  {
    id: 'er-oauth-token-expired',
    category: 'error-recall',
    ingest: [
      {
        session: 'er-oauth-1',
        text: 'Error in CI: Error: OAuth token expired or revoked. Request to GitHub API failed with 401. The GITHUB_TOKEN secret stored in GitHub Actions had not been rotated — it was a Personal Access Token (classic) with a 90-day expiry.',
      },
      {
        session: 'er-oauth-2',
        text: 'Fix: replaced the classic PAT with a fine-grained GitHub token scoped to only this repo (read:contents, write:packages). Set expiry to 365 days. Updated the GITHUB_TOKEN secret in Settings > Secrets. Added a calendar reminder for renewal. Token name: lazybrain-ci-2026.',
      },
    ],
    question: 'How do I fix the OAuth token expired 401 error in GitHub Actions CI?',
    expectedSnippets: ['fine-grained', 'lazybrain-ci-2026'],
  },
  {
    id: 'er-cors-preflight',
    category: 'error-recall',
    ingest: [
      {
        session: 'er-cors-1',
        text: "Browser error: Access to fetch at 'https://api.lazybrain.app/capture' from origin 'http://localhost:3000' has been blocked by CORS policy: Response to preflight request doesn't pass access control check: No 'Access-Control-Allow-Origin' header. The OPTIONS preflight was hitting the rate limiter before the CORS middleware ran.",
      },
      {
        session: 'er-cors-2',
        text: 'Fix: moved cors() middleware registration above the rate-limiter in src/server.ts. Also added OPTIONS method to the rate-limiter whitelist. Verified: preflight now returns Access-Control-Allow-Origin and Access-Control-Allow-Methods headers correctly.',
      },
    ],
    question: 'How do I fix CORS preflight blocked error for https://api.lazybrain.app/capture?',
    expectedSnippets: ['cors() middleware', 'above the rate-limiter'],
  },

  // ─── CAT 7 — Filetree-scope ───────────────────────────────────────────────
  {
    id: 'ft-auth-dir',
    category: 'filetree-scope',
    ingest: [
      {
        session: 'ft-auth-1',
        text: '<data value="src/auth/login.ts">src/auth/login.ts</data> — Added JWT validation middleware. Validates Bearer token from Authorization header, attaches user to req.user.',
      },
      {
        session: 'ft-auth-2',
        text: '<data value="src/auth/refresh.ts">src/auth/refresh.ts</data> — Added /auth/refresh endpoint. Accepts refresh_token cookie, issues new access token. Rotation enforced: each refresh invalidates the old token.',
      },
      {
        session: 'ft-auth-3',
        text: '<data value="src/auth/logout.ts">src/auth/logout.ts</data> — Logout clears the refresh_token cookie and adds the access token to a Redis blocklist with TTL matching token expiry.',
      },
    ],
    question: 'What notes are related to the src/auth/ directory?',
    expectedSnippets: ['src/auth/', 'refresh_token'],
  },
  {
    id: 'ft-tests-dir',
    category: 'filetree-scope',
    ingest: [
      {
        session: 'ft-tests-1',
        text: '<data value="tests/unit/auth.test.ts">tests/unit/auth.test.ts</data> — 24 unit tests for JWT validation. Uses vitest + msw to mock the Supabase Auth API. Coverage: 94%.',
      },
      {
        session: 'ft-tests-2',
        text: '<data value="tests/integration/api.test.ts">tests/integration/api.test.ts</data> — Integration tests against a local Postgres via docker-compose. 15 tests. Requires POSTGRES_URL env var.',
      },
    ],
    question: 'What notes are related to the tests/ directory?',
    expectedSnippets: ['tests/', 'vitest'],
  },
  {
    id: 'ft-api-users-dir',
    category: 'filetree-scope',
    ingest: [
      {
        session: 'ft-api-users-1',
        text: '<data value="src/api/users/list.ts">src/api/users/list.ts</data> — GET /api/users. Paginated with cursor. Returns { users: User[], nextCursor: string | null }. Requires admin role.',
      },
      {
        session: 'ft-api-users-2',
        text: '<data value="src/api/users/update.ts">src/api/users/update.ts</data> — PATCH /api/users/:id. Validates body with Zod userUpdateSchema. Returns updated user. Emits user.updated event.',
      },
    ],
    question: 'What did we change in src/api/users/?',
    expectedSnippets: ['src/api/users/', 'nextCursor'],
  },
  {
    id: 'ft-migrations-dir',
    category: 'filetree-scope',
    ingest: [
      {
        session: 'ft-mig-1',
        text: '<data value="migrations/0012_add_refresh_tokens.sql">migrations/0012_add_refresh_tokens.sql</data> — Creates table refresh_tokens(id uuid, user_id uuid, token_hash text, expires_at timestamptz, revoked_at timestamptz). Index on user_id.',
      },
      {
        session: 'ft-mig-2',
        text: '<data value="migrations/0013_add_audit_log.sql">migrations/0013_add_audit_log.sql</data> — Creates table audit_log(id bigserial, actor_id uuid, action text, resource text, created_at timestamptz). Partitioned by month.',
      },
    ],
    question: 'What notes are related to the migrations/ directory?',
    expectedSnippets: ['migrations/', 'refresh_tokens'],
  },
  {
    id: 'ft-docs-dir',
    category: 'filetree-scope',
    ingest: [
      {
        session: 'ft-docs-1',
        text: '<data value="docs/architecture.md">docs/architecture.md</data> — Updated architecture diagram to show the new event bus between API and worker. Added sequence diagram for the async email flow.',
      },
      {
        session: 'ft-docs-2',
        text: '<data value="docs/api-reference.md">docs/api-reference.md</data> — Documented /api/users endpoints including pagination params and error codes. Added curl examples.',
      },
    ],
    question: 'What notes are related to the docs/ directory?',
    expectedSnippets: ['docs/', 'architecture'],
  },
  {
    id: 'ft-package-json',
    category: 'filetree-scope',
    ingest: [
      {
        session: 'ft-pkg-1',
        text: '<data value="package.json">package.json</data> — Added "check:types" script: "tsc --noEmit". Added "check:lock" script: "node scripts/check-lock.js". Both wired into pre-commit hook.',
      },
      {
        session: 'ft-pkg-2',
        text: '<data value="package.json">package.json</data> — Bumped vitest from 1.6.0 to 2.1.0. Updated test script to use --pool=forks for better isolation on Windows.',
      },
    ],
    question: 'What did we change in package.json?',
    expectedSnippets: ['package.json', 'check:types'],
  },
  {
    id: 'ft-tailwind-config',
    category: 'filetree-scope',
    ingest: [
      {
        session: 'ft-tw-1',
        text: '<data value="tailwind.config.ts">tailwind.config.ts</data> — Migrated from v3 to v4 config format. Removed the theme.extend block — now using CSS variables in globals.css via @theme. Added custom oklch color tokens: --color-brand-500, --color-brand-600.',
      },
    ],
    question: 'What did we change in tailwind.config.ts?',
    expectedSnippets: ['tailwind.config.ts', 'oklch'],
  },
  {
    id: 'ft-monorepo-web-vs-mobile',
    category: 'filetree-scope',
    ingest: [
      {
        session: 'ft-mono-1',
        text: '<data value="apps/web/src/components/Button.tsx">apps/web/src/components/Button.tsx</data> — Added loading spinner state. Uses Tailwind v4 animate-spin. Web-only: uses HTML button element.',
      },
      {
        session: 'ft-mono-2',
        text: '<data value="apps/mobile/src/components/Button.tsx">apps/mobile/src/components/Button.tsx</data> — Added haptic feedback on press via expo-haptics. Mobile-only: uses React Native Pressable.',
      },
    ],
    question: 'What notes are related to apps/web/ versus apps/mobile/?',
    expectedSnippets: ['apps/web/', 'apps/mobile/'],
  },

  // ─── CAT 8 — Commit-trail ─────────────────────────────────────────────────
  {
    id: 'ct-last-week',
    category: 'commit-trail',
    ingest: [
      {
        session: 'ct-week-1',
        text: 'Session 2026-05-19 — feat: added /api/users/list endpoint with cursor pagination. Reviewed by: John Doe. Merged to main.',
      },
      {
        session: 'ct-week-2',
        text: 'Session 2026-05-20 — fix: resolved deadlock on orders table by enforcing consistent lock order. Deployed to staging.',
      },
      {
        session: 'ct-week-3',
        text: 'Session 2026-05-21 — refactor: migrated auth middleware from express-jwt to custom validateToken. Removed 3 unused dependencies.',
      },
    ],
    question: 'What did we work on this week?',
    expectedSnippets: ['cursor pagination', 'validateToken'],
  },
  {
    id: 'ct-yesterday',
    category: 'commit-trail',
    ingest: [
      {
        session: 'ct-yest-1',
        text: 'Session 2026-05-22 — chore: updated GitHub Actions workflow to Node 22. Fixed CORS preflight issue by moving cors() above rate-limiter. Added pre-commit lock-file check.',
      },
    ],
    question: 'What did we work on yesterday?',
    expectedSnippets: ['GitHub Actions', 'cors()'],
    notes: 'Today is 2026-05-23 per context.',
  },
  {
    id: 'ct-last-sprint',
    category: 'commit-trail',
    ingest: [
      {
        session: 'ct-sprint-1',
        text: 'Sprint 12 (2026-05-05 to 2026-05-18) — Delivered: user management CRUD, email verification flow, rate limiting on all public endpoints. Not delivered: SSO integration (moved to Sprint 13).',
      },
      {
        session: 'ct-sprint-2',
        text: 'Sprint 12 retro — velocity: 34 SP. Blockers: Supabase outage on 2026-05-10 delayed 2 days. Team decision: add chaos-monkey tests to Sprint 13 to harden against upstream failures.',
      },
    ],
    question: 'What did we work on last sprint?',
    expectedSnippets: ['Sprint 12', 'rate limiting'],
  },
  {
    id: 'ct-since-v2-release',
    category: 'commit-trail',
    ingest: [
      {
        session: 'ct-v2-1',
        text: 'v2.0.0 released 2026-04-01. Post-v2 changes: added webhook signature verification (2026-04-08), migrated from Prisma to Kysely (2026-04-15), added Redis caching layer for search (2026-04-28).',
      },
      {
        session: 'ct-v2-2',
        text: 'Post-v2 changes continued: added audit_log table (2026-05-03), added /api/export endpoint (2026-05-10), enabled row-level security on all tables (2026-05-17).',
      },
    ],
    question: 'What did we work on since the v2 release?',
    expectedSnippets: ['v2.0.0', 'Kysely'],
  },
  {
    id: 'ct-auth-module-last-month',
    category: 'commit-trail',
    ingest: [
      {
        session: 'ct-auth-lm-1',
        text: 'April 2026 auth changes: 2026-04-03 — added refresh token rotation. 2026-04-11 — added device fingerprint to token payload. 2026-04-22 — added magic link login via Supabase Auth. 2026-04-30 — added brute-force protection: 5 failed logins then 15min lockout.',
      },
    ],
    question: 'What did we work on in the auth module last month?',
    expectedSnippets: ['refresh token rotation', 'magic link'],
  },
  {
    id: 'ct-after-prisma-migration',
    category: 'commit-trail',
    ingest: [
      {
        session: 'ct-prisma-post-1',
        text: 'Prisma to Kysely migration completed 2026-04-15. Post-migration work: removed prisma/ directory, deleted schema.prisma, uninstalled @prisma/client and prisma devDep. Updated all 14 repository files to use Kysely query builder.',
      },
      {
        session: 'ct-prisma-post-2',
        text: 'After Prisma migration: added Kysely migration runner (2026-04-18). Added type-safe query builder helpers in src/db/helpers.ts (2026-04-19). CI green: all 89 tests pass with Kysely.',
      },
    ],
    question: 'What did we do after the Prisma migration?',
    expectedSnippets: ['Kysely', 'src/db/helpers.ts'],
  },
  {
    id: 'ct-before-deploying',
    category: 'commit-trail',
    ingest: [
      {
        session: 'ct-predeploy-1',
        text: 'Pre-deploy checklist completed 2026-05-17: ran full test suite (89 pass), updated CHANGELOG, bumped version to 2.3.0, ran database migration dry-run, verified environment variables in staging match prod.',
      },
      {
        session: 'ct-predeploy-2',
        text: 'Pre-deploy tasks 2026-05-17: enabled row-level security on users and orders tables, added /health endpoint for load balancer probe, smoke-tested all API routes in staging.',
      },
    ],
    question: 'What did we do before deploying?',
    expectedSnippets: ['row-level security', '/health endpoint'],
  },
  {
    id: 'ct-week-21-2026',
    category: 'commit-trail',
    ingest: [
      {
        session: 'ct-w21-1',
        text: '2026-W21 (May 18-24): Monday — added audit_log partitioning. Tuesday — fixed CORS preflight. Wednesday — added SSO SAML provider. Thursday — performance profiling: reduced p95 latency from 420ms to 180ms via query optimization.',
      },
    ],
    question: 'What did we work on in 2026-W21?',
    expectedSnippets: ['2026-W21', 'audit_log'],
  },

  // ─── CAT 9 — Schema-evolution ─────────────────────────────────────────────
  {
    id: 'se-users-table',
    category: 'schema-evolution',
    ingest: [
      {
        session: 'se-users-v1',
        text: 'Migration 0001: CREATE TABLE users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text UNIQUE NOT NULL, created_at timestamptz DEFAULT now()). Initial schema.',
      },
      {
        session: 'se-users-v2',
        text: "Migration 0007: ALTER TABLE users ADD COLUMN display_name text, ADD COLUMN avatar_url text, ADD COLUMN role text NOT NULL DEFAULT 'member'. Added role column for RBAC.",
      },
      {
        session: 'se-users-v3',
        text: 'Migration 0014: ALTER TABLE users ADD COLUMN deleted_at timestamptz, ADD COLUMN mfa_enabled boolean NOT NULL DEFAULT false. Soft delete pattern + MFA flag. Current schema as of 2026-05-17.',
      },
    ],
    question: 'What is the current schema of the users table?',
    expectedSnippets: ['deleted_at', 'mfa_enabled'],
    mustNotContain: ['Initial schema', 'ADD COLUMN display_name'],
    notes: 'Must surface migration 0014 (latest), not 0001 or 0007.',
  },
  {
    id: 'se-api-login-endpoint',
    category: 'schema-evolution',
    ingest: [
      {
        session: 'se-login-v1',
        text: 'POST /api/login v1: accepts { email, password }, returns { token: string }. Simple JWT. No refresh token.',
      },
      {
        session: 'se-login-v2',
        text: 'POST /api/login v2 (2026-03-10): changed response to { accessToken, refreshToken, expiresIn }. Added httpOnly refresh_token cookie. Breaking change — clients must update.',
      },
      {
        session: 'se-login-v3',
        text: 'POST /api/login v3 (2026-05-01): added device fingerprint in request body (optional). Added response field sessionId for audit trail. Current behavior: returns { accessToken, refreshToken, expiresIn, sessionId }.',
      },
    ],
    question: 'How does the /api/login endpoint work now?',
    expectedSnippets: ['sessionId', 'device fingerprint'],
    mustNotContain: ['No refresh token', 'clients must update'],
  },
  {
    id: 'se-tsconfig-strict',
    category: 'schema-evolution',
    ingest: [
      {
        session: 'se-tsconfig-v1',
        text: 'tsconfig.json initial: { "compilerOptions": { "target": "ES2020", "module": "NodeNext", "strict": false } }. Strict mode off to unblock initial migration.',
      },
      {
        session: 'se-tsconfig-v2',
        text: 'tsconfig.json update (2026-04-20): enabled strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true. Fixed 47 type errors that surfaced. Current tsconfig is fully strict.',
      },
    ],
    question: 'What is the current tsconfig setup?',
    expectedSnippets: ['noUncheckedIndexedAccess', 'exactOptionalPropertyTypes'],
    mustNotContain: ['"strict": false'],
  },
  {
    id: 'se-database-url-renamed',
    category: 'schema-evolution',
    ingest: [
      {
        session: 'se-dburl-v1',
        text: 'Environment variable DB_URL used for database connection. Format: postgresql://user:pass@host:5432/dbname.',
      },
      {
        session: 'se-dburl-v2',
        text: 'Environment variable renamed from DB_URL to DATABASE_URL (2026-02-14) to align with Supabase and Prisma conventions. Updated all .env.example files, CI secrets, and Render service config. DB_URL is no longer read by the application.',
      },
    ],
    question: 'What is the correct env var for the database connection?',
    expectedSnippets: ['DATABASE_URL', 'DB_URL is no longer read'],
    mustNotContain: ['DB_URL used for database'],
  },
  {
    id: 'se-feature-flag-new-ui',
    category: 'schema-evolution',
    ingest: [
      {
        session: 'se-ff-v1',
        text: 'Feature flag enableNewUI: default false. Launched 2026-01-15 to gate the redesigned dashboard. Only enabled for beta users via Supabase feature_flags table.',
      },
      {
        session: 'se-ff-v2',
        text: 'Feature flag enableNewUI: default flipped to true (2026-04-01). Old UI removed from codebase. The flag is still read for backward compat but all users now see the new UI. Scheduled for full removal in v3.',
      },
    ],
    question: 'What is the current behavior of the enableNewUI feature flag?',
    expectedSnippets: ['default flipped to true', 'Old UI removed'],
    mustNotContain: ['Only enabled for beta users'],
  },
  {
    id: 'se-webhook-signature',
    category: 'schema-evolution',
    ingest: [
      {
        session: 'se-wh-v1',
        text: 'Webhook signature verification v1: HMAC-SHA1 using shared secret. Header: X-Webhook-Signature: sha1=<hex>. Implemented 2026-01-20.',
      },
      {
        session: 'se-wh-v2',
        text: 'Webhook signature verification upgraded to HMAC-SHA256 (2026-04-08). Header changed to X-Webhook-Signature-256: sha256=<hex>. Old SHA1 header still accepted until 2026-07-01 deprecation deadline. New webhooks only emit SHA256.',
      },
    ],
    question: 'What is the current webhook signature algorithm?',
    expectedSnippets: ['HMAC-SHA256', 'X-Webhook-Signature-256'],
    mustNotContain: ['HMAC-SHA1'],
  },
  {
    id: 'se-test-framework-vitest',
    category: 'schema-evolution',
    ingest: [
      {
        session: 'se-jest-v1',
        text: 'Test framework: Jest 29.x. Config in jest.config.ts. Transform: ts-jest. Coverage via jest --coverage. 89 tests total.',
      },
      {
        session: 'se-vitest-v2',
        text: 'Test framework migrated from Jest to Vitest 2.1 (2026-04-25). jest.config.ts removed. New: vitest.config.ts. Coverage via @vitest/coverage-v8. All 89 tests migrated. Speed improvement: full suite from 42s to 11s. Current setup uses --pool=forks on Windows.',
      },
    ],
    question: 'What test framework are we using?',
    expectedSnippets: ['Vitest 2.1', 'vitest.config.ts'],
    mustNotContain: ['Jest 29', 'ts-jest'],
  },
  {
    id: 'se-bundler-vite',
    category: 'schema-evolution',
    ingest: [
      {
        session: 'se-webpack-v1',
        text: 'Bundler: Webpack 5. Config in webpack.config.js. Build time: ~90s cold, ~8s HMR. Used since project inception (2025-09).',
      },
      {
        session: 'se-vite-v2',
        text: "Bundler migrated from Webpack 5 to Vite 6 (2026-03-18). webpack.config.js removed. New: vite.config.ts. Cold start reduced from 90s to 4s. HMR: 200ms. CSS handled by Vite's built-in PostCSS. Current bundler is Vite 6.",
      },
    ],
    question: 'What bundler are we currently using?',
    expectedSnippets: ['Vite 6', 'vite.config.ts'],
    mustNotContain: ['Webpack 5', 'webpack.config.js'],
  },

  // ─── CAT 10 — Dep-history ─────────────────────────────────────────────────
  {
    id: 'dh-zod-added',
    category: 'dep-history',
    ingest: [
      {
        session: 'dh-zod-1',
        text: 'Added Zod 3.23 to the project (2026-02-10). Decision: needed runtime schema validation at API boundaries after a prod incident where a malformed user payload crashed the signup handler. Zod chosen over Yup for better TypeScript inference and smaller bundle. npm install zod.',
      },
    ],
    question: 'When did we add Zod and why?',
    expectedSnippets: ['Zod 3.23', 'API boundaries'],
  },
  {
    id: 'dh-drizzle-vs-prisma',
    category: 'dep-history',
    ingest: [
      {
        session: 'dh-drizzle-1',
        text: 'Dependency decision 2026-04-15: chose Drizzle ORM over Prisma. Reasons: (1) Prisma migrations broke in prod twice with the connection pooler. (2) Drizzle generates plain SQL, no engine binary, smaller Docker image. (3) Drizzle type inference works with our existing Postgres jsonb columns. (4) No Prisma schema DSL to maintain — Drizzle schema is just TypeScript.',
      },
    ],
    question: 'Why did we choose Drizzle instead of Prisma?',
    expectedSnippets: ['connection pooler', 'no engine binary'],
  },
  {
    id: 'dh-tailwind-v4-migration',
    category: 'dep-history',
    ingest: [
      {
        session: 'dh-tw-v4-1',
        text: 'Tailwind v4 migration completed 2026-03-05. Previous: tailwindcss@3.4.1. Current: tailwindcss@4.0.0. Key changes: removed tailwind.config.js (now CSS-native via @theme), PostCSS config simplified, all color tokens migrated to oklch. Bundle size reduced by 22%.',
      },
    ],
    question: 'When did we migrate to Tailwind v4 and what changed?',
    expectedSnippets: ['tailwindcss@4.0.0', '@theme'],
  },
  {
    id: 'dh-react-query-to-swr',
    category: 'dep-history',
    ingest: [
      {
        session: 'dh-rq-swr-1',
        text: 'Dependency switch 2026-02-28: replaced React Query (TanStack Query v5) with SWR 2.3. Reason: React Query v5 introduced a breaking API change in useMutation that broke 11 components. SWR has a simpler mental model and suffices for our read-heavy use case. Uninstalled @tanstack/react-query, installed swr.',
      },
    ],
    question: 'Why did we switch from React Query to SWR?',
    expectedSnippets: ['TanStack Query v5', 'breaking API change'],
  },
  {
    id: 'dh-stripe-to-lemon',
    category: 'dep-history',
    ingest: [
      {
        session: 'dh-stripe-1',
        text: 'Payment provider switch under evaluation (2026-04-20): considering Lemon Squeezy instead of Stripe. Reason: Stripe requires business registration in France (6-8 weeks). Lemon Squeezy acts as merchant of record — handles EU VAT automatically. Decision pending legal review.',
      },
      {
        session: 'dh-stripe-2',
        text: 'Decision finalized 2026-05-02: switching to Lemon Squeezy as payment provider. Stripe integration removed (src/billing/stripe.ts deleted). New: src/billing/lemon.ts using @lemonsqueezy/lemonsqueezy-js. Webhooks updated — new signing secret in LEMON_SQUEEZY_WEBHOOK_SECRET.',
      },
    ],
    question: 'Why did we switch from Stripe to Lemon Squeezy?',
    expectedSnippets: ['merchant of record', 'EU VAT'],
  },
  {
    id: 'dh-eslint-to-biome',
    category: 'dep-history',
    ingest: [
      {
        session: 'dh-biome-1',
        text: 'Linter migration 2026-03-22: replaced ESLint + Prettier with Biome 1.9. Reasons: (1) single tool for lint + format, (2) Biome lint runs in ~80ms vs ESLint ~4s on full codebase, (3) zero config for TypeScript. Removed: eslint, @typescript-eslint/*, prettier, eslint-config-next. Added: @biomejs/biome. biome.json added to root.',
      },
    ],
    question: 'Why did we replace ESLint with Biome?',
    expectedSnippets: ['Biome 1.9', '80ms'],
  },
  {
    id: 'dh-jest-to-vitest',
    category: 'dep-history',
    ingest: [
      {
        session: 'dh-vitest-1',
        text: 'Test framework migration 2026-04-25: replaced Jest 29 with Vitest 2.1. Decision drivers: (1) Jest requires babel transform for ESM, causing intermittent transform errors. (2) Vitest natively supports ESM + TypeScript via vite-plugin. (3) Full suite: 42s (Jest) to 11s (Vitest). (4) Compatible API — migration required only config file changes. Removed: jest, ts-jest, @types/jest. Added: vitest, @vitest/coverage-v8.',
      },
    ],
    question: 'When did we switch from Jest to Vitest and why?',
    expectedSnippets: ['Vitest 2.1', 'ESM'],
  },
  {
    id: 'dh-husky-removed',
    category: 'dep-history',
    ingest: [
      {
        session: 'dh-husky-1',
        text: 'Removed husky from the project (2026-05-08). Reason: husky v9 changed the install hook mechanism, breaking git commits in the Windows dev environment (Git Bash path issue). Replaced with lefthook 1.6 — faster, cross-platform, no shell dependency. npm uninstall husky. npm install --save-dev lefthook. Migrated .husky/ hooks to lefthook.yml.',
      },
    ],
    question: 'Why did we remove husky?',
    expectedSnippets: ['lefthook', 'Windows dev environment'],
  },
];

const JUDGE_SYSTEM = `You evaluate whether a coding-agent memory system surfaced the correct answer to a question.

Compare the gold answer (or expected behaviour) to the retrieved evidence. Output strictly "yes" or "no" — yes if the evidence supports the gold answer, no if the evidence is unrelated, contradictory, or omits the key fact.

Be strict on decision-invalidation: if the question asks for the *current* state and the evidence surfaces only the *original* (superseded) decision, output "no".`;

interface BenchOptions {
  topK: number;
  daemonUrl: string;
  outputDir: string;
  judge: 'none' | 'substring' | 'haiku';
  warm: boolean;
  isolated: boolean;
  brainPath: string | null;
  keepBrain: boolean;
  /**
   * Fixture-subset filter. 'all' = every fixture. 'sprint4' = the original 13
   * fixtures used as the Sprint #4 baseline (tf-*, di-*, cf-*, rt-*, ar-*,
   * ab-mark-*). Lets us check that Sprint #5 work does not regress against the
   * Sprint #4 number even though the bench corpus grew to 53 fixtures.
   */
  subset: 'all' | 'sprint4';
}

/** The 13 fixtures that constituted the Sprint #4 baseline. */
const SPRINT4_FIXTURE_IDS = new Set<string>([
  'tf-pytest-output',
  'tf-grep-find',
  'di-tailwind-version',
  'di-orm-switch',
  'cf-repository-pattern',
  'cf-error-handling',
  'rt-async-decision',
  'rt-postgres-constraint',
  'ar-server-actions',
  'ar-bun-runtime',
  'ab-mark-element',
  'ab-mark-class',
  'ab-mark-markdown',
]);

function parseArgs(argv: string[]): BenchOptions {
  const opts: BenchOptions = {
    topK: 5,
    daemonUrl: process.env.LAZYBRAIN_DAEMON_URL ?? `http://127.0.0.1:${BENCH_PORT}`,
    outputDir: 'bench/results',
    judge: 'haiku',
    warm: false,
    isolated: true,
    brainPath: null,
    keepBrain: false,
    subset: 'all',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--top') opts.topK = parseInt(argv[++i] ?? '5', 10);
    else if (a === '--out') opts.outputDir = argv[++i] ?? opts.outputDir;
    else if (a === '--daemon') opts.daemonUrl = argv[++i] ?? opts.daemonUrl;
    else if (a === '--judge') opts.judge = (argv[++i] as BenchOptions['judge']) ?? 'haiku';
    else if (a === '--warm') opts.warm = true;
    else if (a === '--cold') opts.warm = false;
    else if (a === '--isolated') opts.isolated = true;
    else if (a === '--no-isolated') opts.isolated = false;
    else if (a === '--brain') opts.brainPath = argv[++i] ?? null;
    else if (a === '--keep-brain') opts.keepBrain = true;
    else if (a === '--subset') {
      const value = argv[++i];
      if (value === 'sprint4' || value === 'all') opts.subset = value;
    }
  }

  // --brain overrides isolation logic: treat it as explicit brain, disable auto-isolation
  if (opts.brainPath !== null) {
    opts.isolated = false;
  }

  return opts;
}

/**
 * Ping a daemon at the given URL, return true when healthy.
 */
async function pingDaemon(url: string, timeoutMs = 2000): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}/health`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Resolve the path of the lazybrain entry-point for spawning a second daemon.
 * Tries the built dist first, falls back to the source tsx path.
 */
function resolveLazyBrainEntry(): { cmd: string; args: string[]; useShell: boolean } {
  // __dirname equivalent for ESM
  const thisFile = fileURLToPath(import.meta.url);
  // bench/csmb.ts → project root
  const projectRoot = join(thisFile, '..', '..');
  const distEntry = join(projectRoot, 'dist', 'bin', 'lazybrain.js');
  if (existsSync(distEntry)) {
    return {
      cmd: process.execPath,
      args: [distEntry, 'daemon', 'start', '--foreground', '--port', String(BENCH_PORT)],
      useShell: false,
    };
  }
  // tsx fallback: node --import tsx bin/lazybrain.ts daemon start --foreground --port XXXX
  const srcEntry = join(projectRoot, 'bin', 'lazybrain.ts');
  if (existsSync(srcEntry)) {
    return {
      cmd: process.execPath,
      args: ['--import', 'tsx', srcEntry, 'daemon', 'start', '--foreground', '--port', String(BENCH_PORT)],
      useShell: false,
    };
  }
  // Fallback: hope `lazybrain` is in PATH
  return {
    cmd: 'lazybrain',
    args: ['daemon', 'start', '--foreground', '--port', String(BENCH_PORT)],
    useShell: process.platform === 'win32',
  };
}

/**
 * Action A — spawn an isolated bench daemon on BENCH_PORT.
 *
 * Returns: { brainPath, logPath, process, isNew }
 *   isNew = false when a daemon already existed on the port (reuse it).
 */
async function spawnIsolatedDaemon(outputDir: string): Promise<{
  brainPath: string;
  logPath: string;
  daemonProcess: ChildProcess | null;
  isNew: boolean;
}> {
  const benchUrl = `http://127.0.0.1:${BENCH_PORT}`;

  // 1.C — detect if a daemon is already running on the bench port; reuse it.
  const alreadyRunning = await pingDaemon(benchUrl, 1000);
  if (alreadyRunning) {
    // Try to get the brain path from /health
    const brainPath = '<unknown — reused daemon>';
    try {
      const res = await fetch(`${benchUrl}/health`);
      const json = await res.json() as Record<string, unknown>;
      // The health endpoint doesn't expose brainPath directly, but we can note it's reused
      void json;
    } catch { /* */ }
    console.log(`[bench] Reusing existing daemon on port ${BENCH_PORT}`);
    return { brainPath, logPath: '', daemonProcess: null, isNew: false };
  }

  // 1.B — create temp brain directory
  const brainPath = join(tmpdir(), `lazybrain-csmb-${Date.now()}`);
  const subdirs = ['notes', 'batches', '_cache', 'meta'];
  mkdirSync(brainPath, { recursive: true });
  for (const sub of subdirs) {
    mkdirSync(join(brainPath, sub), { recursive: true });
  }

  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
  const logPath = join(outputDir, `bench-daemon-${Date.now()}.log`);

  const { cmd, args, useShell } = resolveLazyBrainEntry();

  const daemonEnv: NodeJS.ProcessEnv = {
    ...process.env,
    LAZYBRAIN_BRAIN_PATH: brainPath,
    LAZYBRAIN_CACHE_PATH: join(brainPath, '_cache'),
    // Bench ingests 53 unrelated scenarios into one brain; auto-invalidate across
    // fixtures marks most notes valid_until and retrieval returns empty hits.
    LAZYBRAIN_AUTO_INVALIDATE: '0',
    LAZYBRAIN_HARD_INVALIDATE: '1',
    // Disable HyDE inside the bench daemon. The daemon runs as a spawned child
    // process with no active Claude Code session, so claude CLI calls inside
    // the daemon always timeout (12 s wasted per query with no gain). Both
    // explicit HyDE (LAZYBRAIN_HYDE=1) and auto-HyDE (shouldAutoHyde) are
    // gated on LAZYBRAIN_HYDE != "0" / "false".
    LAZYBRAIN_HYDE: '0',
    LAZYBRAIN_BENCH: '1',
    // Suppress idle timeout for bench runs
    LAZYBRAIN_DAEMON_IDLE_MS: String(60 * 60 * 1000),
  };

  const logFd = { fd: -1, path: logPath };
  const daemonProcess = spawn(cmd, args, {
    env: daemonEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    shell: useShell,
  });

  // Pipe daemon output to log file
  const logLines: string[] = [];
  const captureLog = (chunk: Buffer): void => {
    const line = chunk.toString('utf8');
    logLines.push(line);
    // Write incrementally to log file
    try {
      writeFileSync(logPath, logLines.join(''), 'utf8');
    } catch { /* */ }
  };
  void logFd;
  daemonProcess.stdout?.on('data', captureLog);
  daemonProcess.stderr?.on('data', captureLog);
  daemonProcess.once('error', (err) => {
    logLines.push(`[bench] daemon spawn error: ${err.message}\n`);
    try { writeFileSync(logPath, logLines.join(''), 'utf8'); } catch { /* */ }
  });

  // Wait up to 12s for the daemon to become healthy
  const deadline = Date.now() + 12_000;
  let healthy = false;
  while (Date.now() < deadline) {
    await sleep(300);
    if (await pingDaemon(benchUrl, 600)) {
      healthy = true;
      break;
    }
  }

  if (!healthy) {
    const logSnippet = logLines.slice(-10).join('').slice(0, 600);
    throw new Error(`Isolated bench daemon failed to start on port ${BENCH_PORT}.\nLog:\n${logSnippet}`);
  }

  return { brainPath, logPath, daemonProcess, isNew: true };
}

/**
 * Kill the isolated daemon and optionally remove the temp brain.
 */
async function teardownIsolatedDaemon(
  daemonProcess: ChildProcess | null,
  brainPath: string,
  keepBrain: boolean,
): Promise<void> {
  if (daemonProcess) {
    try {
      // Ask the daemon to shut down gracefully first
      await fetch(`http://127.0.0.1:${BENCH_PORT}/shutdown`, { method: 'POST' }).catch(() => null);
      await sleep(500);
      try { daemonProcess.kill('SIGTERM'); } catch { /* */ }
      await sleep(300);
      if (daemonProcess.exitCode === null) {
        try { daemonProcess.kill('SIGKILL'); } catch { /* */ }
      }
    } catch { /* */ }
  }

  if (!keepBrain && brainPath && existsSync(brainPath)) {
    try {
      rmSync(brainPath, { recursive: true, force: true });
      console.log(`[bench] Removed temp brain: ${brainPath}`);
    } catch (err) {
      console.warn(`[bench] Could not remove temp brain ${brainPath}: ${(err as Error).message}`);
    }
  } else if (keepBrain) {
    console.log(`[bench] Kept temp brain (--keep-brain): ${brainPath}`);
  }
}

/**
 * Run maintenance (compress, purge, profile, graph, interlink) so pre-computed
 * graph signals and wikilinks activate — simulates a stationary brain state.
 */
async function runWarmUp(daemonUrl: string): Promise<void> {
  console.log('Warm-up: running /maintenance (compress + purge + graph + interlink)…');
  try {
    const resp = await fetch(`${daemonUrl}/maintenance`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    if (!resp.ok) {
      console.warn(`/maintenance returned ${resp.status} — warm-up may be incomplete`);
    } else {
      const json = await resp.json() as Record<string, unknown>;
      const interlinkResult = json.interlink as Record<string, unknown> | undefined;
      const graphResult = json.graph as Record<string, unknown> | string | undefined;
      console.log(`  interlink: ${JSON.stringify(interlinkResult ?? 'n/a')}`);
      console.log(`  graph:     ${typeof graphResult === 'string' ? graphResult.slice(0, 80) : JSON.stringify(graphResult ?? 'n/a')}`);
    }
  } catch (err) {
    console.warn(`/maintenance failed: ${(err as Error).message}`);
  }
}

interface Hit {
  id: string;
  score: number;
  note?: { text?: string; facts?: Array<{ text: string }> };
}

async function storeFixture(f: CSMBFixture, daemonUrl: string): Promise<number> {
  let stored = 0;
  for (const item of f.ingest) {
    const tagged = `bench:csmb:${f.id}:${item.session}`;
    try {
      const resp = await fetch(`${daemonUrl}/capture`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ raw: item.text, session: tagged, async: false }),
      });
      if (resp.ok) {
        const json = (await resp.json()) as { status?: string };
        if (json.status !== 'skipped') stored += 1;
      }
    } catch {
      // skip
    }
  }
  return stored;
}

async function search(
  query: string,
  topK: number,
  daemonUrl: string,
  fixtureId: string,
): Promise<{ hits: Hit[]; latencyMs: number }> {
  const start = Date.now();
  try {
    const resp = await fetch(`${daemonUrl}/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query,
        top: topK,
        strip: false,
        // Dense brain: every fixture is ingested, but each question targets one scenario.
        source_prefix: `session:bench:csmb:${fixtureId}:`,
      }),
    });
    const text = await resp.text();
    const latencyMs = Date.now() - start;
    if (!resp.ok) return { hits: [], latencyMs };
    const parsed = JSON.parse(text) as { hits?: Hit[] };
    return { hits: parsed.hits ?? [], latencyMs };
  } catch {
    return { hits: [], latencyMs: Date.now() - start };
  }
}

interface FixtureResult {
  id: string;
  category: Category;
  question: string;
  hitIds: string[];
  substringRecall: number;
  substringHit: boolean;
  contaminated: boolean;
  judgeVerdict: boolean | null;
  latencyMs: number;
}

function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreSubstring(fixture: CSMBFixture, hits: Hit[]): { recall: number; hit: boolean; contaminated: boolean } {
  const corpus = normalizeForMatch(
    hits
      .map((h) => {
        const facts = h.note?.facts?.map((f) => f.text).join(' · ') ?? '';
        const txt = h.note?.text ?? '';
        return `${facts}\n${txt}\n${h.id}`;
      })
      .join('\n'),
  );
  const expected = fixture.expectedSnippets.map((s) => normalizeForMatch(s));
  let matched = 0;
  for (const s of expected) {
    if (corpus.includes(s)) matched += 1;
  }
  const recall = matched / expected.length;
  const hit = matched > 0;
  const contaminated = (fixture.mustNotContain ?? []).some((s) =>
    corpus.includes(normalizeForMatch(s)),
  );
  return { recall, hit, contaminated };
}

async function judgeWithLlm(fixture: CSMBFixture, hits: Hit[]): Promise<boolean | null> {
  const evidence = hits.slice(0, 3).map((h, i) => {
    const facts = h.note?.facts?.map((f) => f.text).join(' · ') ?? '';
    const txt = h.note?.text ?? '';
    return `[${i + 1}] ${(facts || txt).slice(0, 500)}`;
  }).join('\n');
  const gold = `Expected snippets: ${fixture.expectedSnippets.join(' / ')}` +
    (fixture.mustNotContain ? `\nMust not contain (superseded): ${fixture.mustNotContain.join(' / ')}` : '');
  const prompt = `Question: ${fixture.question}\n\nGold answer guidance:\n${gold}\n\nRetrieved evidence:\n${evidence}\n\nVerdict (yes/no):`;
  let raw = await callClaudeCli(prompt, { system: JUDGE_SYSTEM, model: 'haiku', timeoutMs: 30_000 });
  let tok = raw?.trim().toLowerCase().replace(/[^a-z]/g, '') ?? '';
  if (tok.startsWith('yes')) return true;
  if (tok.startsWith('no')) return false;
  // RETRY 1x on null with larger timeout and explicit directive
  raw = await callClaudeCli(prompt + '\n\nAnswer with exactly "yes" or "no", no other text.', { system: JUDGE_SYSTEM, model: 'haiku', timeoutMs: 45_000 });
  tok = raw?.trim().toLowerCase().replace(/[^a-z]/g, '') ?? '';
  if (tok.startsWith('yes')) return true;
  if (tok.startsWith('no')) return false;
  return null;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  // ── Action A: isolated brain setup ──────────────────────────────────────
  let benchDaemonUrl: string;
  let isolatedBrainPath = '';
  let daemonProcess: ChildProcess | null = null;
  let isNewDaemon = false;
  let logPath = '';

  if (opts.isolated) {
    console.log(`[bench] Spawning isolated bench daemon on port ${BENCH_PORT}…`);
    const result = await spawnIsolatedDaemon(opts.outputDir);
    isolatedBrainPath = result.brainPath;
    logPath = result.logPath;
    daemonProcess = result.daemonProcess;
    isNewDaemon = result.isNew;
    benchDaemonUrl = `http://127.0.0.1:${BENCH_PORT}`;
  } else if (opts.brainPath) {
    // --brain <path> mode: use user-supplied brain path, still use bench port
    benchDaemonUrl = opts.daemonUrl;
    isolatedBrainPath = opts.brainPath;
    console.log(`[bench] Using explicit brain path: ${opts.brainPath}`);
  } else {
    // --no-isolated: use prod daemon as-is
    benchDaemonUrl = process.env.LAZYBRAIN_DAEMON_URL ?? 'http://127.0.0.1:37788';
    console.log(`[bench] Using prod daemon at ${benchDaemonUrl} (no isolation)`);
  }

  // Register cleanup
  const cleanup = async (keepBrain: boolean): Promise<void> => {
    if (opts.isolated && isNewDaemon) {
      await teardownIsolatedDaemon(daemonProcess, isolatedBrainPath, keepBrain);
    }
  };

  process.on('SIGINT', () => { void cleanup(opts.keepBrain).then(() => process.exit(130)); });
  process.on('SIGTERM', () => { void cleanup(opts.keepBrain).then(() => process.exit(143)); });

  try {
    // Health check
    const healthy = await pingDaemon(benchDaemonUrl, 3000);
    if (!healthy) {
      console.error(`Daemon not reachable at ${benchDaemonUrl}.`);
      await cleanup(opts.keepBrain);
      process.exit(1);
    }

    const haikuReady = opts.judge === 'haiku' ? await isClaudeCliAvailable() : false;
    if (opts.judge === 'haiku' && !haikuReady) {
      console.warn('claude CLI unavailable — falling back to substring judge');
    }

    const mode = opts.warm ? 'WARM' : 'COLD';
    const brainDisplay = opts.isolated ? isolatedBrainPath : (opts.brainPath ?? benchDaemonUrl);

    // We always ingest the FULL fixture corpus so the brain matches "real
    // session" density. The --subset flag only filters which fixtures we
    // QUERY against. This isolates "is retrieval working for X?" from "did
    // we forget to ingest Y?".
    const queryFixtures = opts.subset === 'sprint4'
      ? FIXTURES.filter((f) => SPRINT4_FIXTURE_IDS.has(f.id))
      : FIXTURES;

    console.log(`CSMB — ${FIXTURES.length} fixtures ingested, ${queryFixtures.length} queried (subset=${opts.subset}), top-${opts.topK}, judge=${haikuReady ? 'haiku' : opts.judge}, mode=${mode}`);
    // 1.D — print brain path in header
    if (opts.isolated) {
      console.log(`Bench brain: ${isolatedBrainPath}`);
    } else {
      console.log(`Bench brain: ${brainDisplay} (prod / explicit)`);
    }
    if (logPath) console.log(`Daemon log:  ${logPath}`);
    console.log('Ingesting fixtures…');

    for (const f of FIXTURES) {
      await storeFixture(f, benchDaemonUrl);
    }

    if (opts.warm) {
      await runWarmUp(benchDaemonUrl);
    }

    const results: FixtureResult[] = [];
    for (const f of queryFixtures) {
      const s = await search(f.question, opts.topK, benchDaemonUrl, f.id);
      const sub = scoreSubstring(f, s.hits);
      const judge = haikuReady ? await judgeWithLlm(f, s.hits) : null;
      results.push({
        id: f.id,
        category: f.category,
        question: f.question,
        hitIds: s.hits.map((h) => h.id),
        substringRecall: sub.recall,
        substringHit: sub.hit,
        contaminated: sub.contaminated,
        judgeVerdict: judge,
        latencyMs: s.latencyMs,
      });
    }

    // Per-category roll-up
    const byCat = new Map<Category, FixtureResult[]>();
    for (const r of results) {
      const arr = byCat.get(r.category) ?? [];
      arr.push(r);
      byCat.set(r.category, arr);
    }
    const perCategory: Record<string, { count: number; substringRecall: number; judgeAccuracy: number | null; contaminationRate: number }> = {};
    for (const [cat, rows] of byCat) {
      const judged = rows.filter((r) => r.judgeVerdict !== null);
      perCategory[cat] = {
        count: rows.length,
        substringRecall: Math.round(rows.reduce((s, r) => s + r.substringRecall, 0) / rows.length * 1000) / 1000,
        judgeAccuracy: judged.length > 0 ? Math.round(judged.filter((r) => r.judgeVerdict).length / judged.length * 1000) / 1000 : null,
        contaminationRate: Math.round(rows.filter((r) => r.contaminated).length / rows.length * 1000) / 1000,
      };
    }
    const judged = results.filter((r) => r.judgeVerdict !== null);
    const overall = {
      fixtures: results.length,
      overallSubstringRecall: Math.round(results.reduce((s, r) => s + r.substringRecall, 0) / results.length * 1000) / 1000,
      overallJudgeAccuracy: judged.length > 0 ? Math.round(judged.filter((r) => r.judgeVerdict).length / judged.length * 1000) / 1000 : null,
      overallContamination: Math.round(results.filter((r) => r.contaminated).length / results.length * 1000) / 1000,
      p50LatencyMs: results.map((r) => r.latencyMs).sort((a, b) => a - b)[Math.floor(results.length * 0.5)] ?? 0,
      p95LatencyMs: results.map((r) => r.latencyMs).sort((a, b) => a - b)[Math.floor(results.length * 0.95)] ?? 0,
      perCategory,
      finishedAt: new Date().toISOString(),
      benchBrainPath: isolatedBrainPath || benchDaemonUrl,
    };

    if (!existsSync(opts.outputDir)) mkdirSync(opts.outputDir, { recursive: true });
    const modeTag = opts.warm ? 'warm' : 'cold';
    const subsetTag = opts.subset === 'sprint4' ? '-sprint4' : '';
    const outPath = join(opts.outputDir, `csmb-${modeTag}${subsetTag}-${Date.now()}.json`);
    writeFileSync(outPath, JSON.stringify({ mode: modeTag, subset: opts.subset, overall, results }, null, 2), 'utf8');

    console.log(`\n=== CSMB results [${mode}] ===`);
    console.log(`  Fixtures:               ${results.length}`);
    console.log(`  Overall substring rec.: ${(overall.overallSubstringRecall * 100).toFixed(1)}%`);
    console.log(`  Overall judge acc.:     ${overall.overallJudgeAccuracy === null ? 'n/a' : (overall.overallJudgeAccuracy * 100).toFixed(1) + '%'}`);
    console.log(`  Contamination:          ${(overall.overallContamination * 100).toFixed(1)}%   (lower is better)`);
    console.log(`  Latency p50/p95:        ${overall.p50LatencyMs} / ${overall.p95LatencyMs} ms`);
    console.log(`  Per-category:           ${JSON.stringify(overall.perCategory, null, 2)}`);
    console.log(`\nFull report → ${outPath}`);

  } finally {
    await cleanup(opts.keepBrain);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
