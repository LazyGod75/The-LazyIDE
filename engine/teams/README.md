# LazyBrain Teams

> **Internal evaluation prototype — local only, not licensed for distribution.**

LazyBrain Teams is a multi-user layer that turns LazyBrain's per-developer HTML
brains into a company knowledge system. It adds teams, role-based permissions,
governance (secret scrubbing, audit trail), and federated search on top of the
solo LazyBrain engine. Knowledge stays in plain HTML files; org metadata stays in
plain CSV files. The solo engine is orchestrated through its CLI — it is never
forked or modified.

---

## Relationship to solo LazyBrain

| Aspect | Solo LazyBrain | LazyBrain Teams |
|--------|---------------|-----------------|
| Dependency | — | `file:../LazyBrain` (peer on disk) |
| Reused as-is | CLI commands: `init`, `store`, `search`, `query`, `index-rebuild` | yes |
| Reused as-is | HTML note format (`data-cerveau-*` attributes) | yes |
| Added by Teams | HTTP server (Node built-in `http`) | multi-user sessions |
| Added by Teams | CSV stores for users, teams, memberships, sessions, audit | identity layer |
| Added by Teams | RBAC (org-admin / team lead / member / viewer) | access control |
| Added by Teams | CSRF double-submit, login rate-limit, CSP headers | security controls |
| Added by Teams | Secret scrubber at ingest boundary | governance |
| Added by Teams | Federated search across team brains | cross-team discovery |
| Added by Teams | Wiki renderer (native file read, sanitize, link-rewrite) | knowledge nav |
| Added by Teams | Capture tokens for agent/CI ingestion | automation |
| Added by Teams | Append-only audit CSV | compliance |

The engine facade (`src/server/engine-facade.ts`) is the single seam. The HTTP
layer never calls the CLI directly; the engine module (`src/engine/`) does.

---

## Quickstart

```sh
# Prerequisites: Node >= 20, LazyBrain cloned at ../LazyBrain
# (run `npm install && npm run build` inside ../LazyBrain first)

npm install
npm run typecheck   # 0 errors expected
npm test            # 177 tests green
npm run build       # produces dist/server/main.js (~105 KB)

# Run the Borealis Dynamics demo (seeds fresh data, keeps server running):
npm run demo
```

The demo prints a URL (`http://127.0.0.1:7777`) and the access guide below.
Press `Ctrl+C` to stop; the seeded data stays in `./data` until you re-run
`npm run demo` (which wipes and re-seeds with `--fresh`).

### Demo personas

Password for every persona: `123`

> Demo passwords are intentionally trivial; the real password policy (min 10 chars) still applies to password changes and admin-created users.

```
Username   Display Name         Org Role   What this persona demos
----------------------------------------------------------------------
claire     Claire Moreau        admin      Org admin — manage users, teams, audit log
alice      Alice Tan            member     Platform member — note authorship, wiki, search
bob        Bob Petrov           member     Firmware lead — private team, RTOS decisions
dana       Dana Okafor          member     Firmware member — hardware bugs, vendor errata
eric       Eric Lindqvist       member     Growth member + platform viewer — cross-team search
fatima     Fatima Benali        member     Growth lead — attribution decisions, brand voice
victor     Victor Haas          member     Platform viewer (read-only) — stakeholder persona
```

### 5 things to try

1. Log in as **victor** (password: `123`) and confirm `/t/firmware` returns 403
   (viewer of platform only, not firmware — private team).
2. Log in as **eric** (password: `123`) and search for "attribution" — hits from
   the growth team appear; firmware notes do not (private team).
3. Log in as **claire** (org admin) and browse `/admin/audit` to see the full
   activity trail: `team_create`, `user_create`, `member_add`, `note_store`.
4. Open the platform wiki (`/t/platform/wiki` as alice) and find the superseded
   canary-deploy decision pair (ADR-005 replaced by ADR-005-v2).
5. Log in as claire and read the security incident note on platform — the
   `api_key` is stored as `[REDACTED]` on disk (governance scrubber demo).

---

## Architecture overview

```
Browser
  |
  | HTTP (127.0.0.1 only)
  v
Node:http server  (src/server/main.ts)
  |
  +-- Auth/RBAC/CSRF middleware  (src/server/middleware.ts)
  +-- Route handlers             (src/server/routes/*.ts)
  |     |
  |     +-- CSV stores           (src/store/*.ts)
  |     |     data/db/*.csv
  |     |       users.csv
  |     |       teams.csv
  |     |       memberships.csv
  |     |       sessions.csv
  |     |       capture_tokens.csv
  |     |       audit.csv
  |     |       settings.csv
  |     |
  |     +-- EngineFacade         (src/server/engine-facade.ts)
  |           |
  |           +-- scrub.ts       (secret scrub at ingest)
  |           +-- write-queue.ts (per-brain serial writes)
  |           +-- brains.ts      (ensureTeamBrain)
  |           +-- cli.ts         (lazybrain spawn wrapper)
  |           +-- wiki.ts        (native HTML reader)
  |           |
  |           v
  |       lazybrain CLI          (node_modules/lazybrain/...)
  |           |
  |           v
  |       per-team brains        (data/brains/<slug>/brain/)
  |           notes/YYYY-MM/*.html
  |           .lazybrain-config.json
  |           index.db (SQLite, managed by CLI)
  |
  +-- Static assets              (src/assets/app.css)
```

Engine mode is selected at startup via `LBT_ENGINE`:
- `real` (default): dynamic import of `src/engine/facade.ts`; falls back to stub on failure.
- `stub`: deterministic in-memory responses; used for unit tests and offline dev.

---

## Security model

| Control | Implementation |
|---------|---------------|
| Password storage | scrypt (N=16384, r=8, p=1, 32-byte key), stored as `scrypt:N:r:p:<salt>:<hash>` |
| Session tokens | 32-byte random, base64url; stored as sha256 hex; 7-day TTL |
| CSRF | Double-submit: session's `csrfToken` matched against `_csrf` form field or `x-csrf-token` header |
| Login rate-limit | 5 failures per username or per IP → 60-second lockout (in-process, resets on restart) |
| CSP | `default-src 'none'`; no `unsafe-inline`, no `unsafe-eval`; `frame-ancestors 'none'` |
| Authed page caching | `Cache-Control: no-store` on every authenticated response |
| Brain ACL | Org-readable teams: any active user reads; private teams: members only; org-admin bypasses all |
| Secret scrubbing | Applied per-note at ingest boundary in `storeNote`; patterns: Anthropic/Stripe/GitHub/AWS keys, JWT tokens, `password=`, `secret=`, `api_key=` k-v patterns |
| Capture tokens | 32-byte random; hash-at-rest (sha256); revocable by owner; shown once on mint |
| Audit log | Append-only CSV; every auth, user, team, note, token event recorded with timestamp and userId |
| No TLS | Binds `127.0.0.1` only; TLS is the responsibility of a reverse proxy for any non-localhost deployment |

---

## Data layout

All data lives under `LBT_DATA_DIR` (default: `./data`).

```
data/
  db/
    users.csv          id, username, displayName, email, passwordHash, orgRole, status, createdAt
    teams.csv          id, slug, name, description, visibility, retentionDays, createdAt
    memberships.csv    userId, teamId, teamRole, addedAt
    sessions.csv       tokenHash, userId, createdAt, expiresAt, csrfToken
    capture_tokens.csv tokenHash, userId, teamId, label, createdAt, revokedAt
    audit.csv          ts, userId, action, resource, details
    settings.csv       key, value, updatedAt
  brains/
    <team-slug>/
      brain/           managed by lazybrain CLI
        notes/
          YYYY-MM/
            <noteId>.html
        .lazybrain-config.json
        index.db
```

Backups: copy the `data/` directory. No additional tooling required.

---

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `LBT_DATA_DIR` | `./data` | Root for all CSV stores and team brains |
| `LBT_PORT` | `7777` | TCP port (bound to `127.0.0.1` only) |
| `LBT_ENGINE` | `real` | `real` = lazybrain CLI; `stub` = deterministic in-memory stub |

---

## Design decisions

**CSV-as-database**: All org metadata (users, teams, memberships, sessions, audit)
is stored in append-friendly CSV files. This makes the data inspectable with any
spreadsheet tool, trivially version-controllable, and requires zero infrastructure.
The trade-off is performance: CSV is suitable up to roughly 10 000 rows per table;
beyond that, read latency grows linearly. This is acceptable for the evaluation
scope (tens to low hundreds of users, thousands of audit rows per week).

**CLI-first orchestration**: The lazybrain engine is called as a subprocess via
its CLI rather than importing its internals. This preserves a clean boundary —
LazyBrain Teams cannot break if the engine's internal APIs change — and avoids
the engine's SQLite index being opened by multiple processes simultaneously.
Write operations on each brain are serialised through a per-brain promise queue
(`write-queue.ts`) to prevent WAL contention.

**Native wiki render**: Wiki pages are rendered by reading HTML files directly
from the brain's `notes/YYYY-MM/` directories, sanitising the HTML (strip
`<script>`, `on*` attributes, `javascript:` hrefs), and rewriting internal brain
links to Teams URLs. This is intentional: it avoids spawning a CLI process on
every page load, keeps read latency low, and means wiki rendering works even
if the lazybrain CLI is unavailable.

---

## Limitations and roadmap

- **No SSO/OIDC**: Login is username + password only. SAML/OIDC integration is
  planned but not implemented.
- **Brain-level ACL, not note-level**: Access control is enforced at the team
  boundary. All members of a team can read all notes in that team's brain.
- **No TLS**: The server binds `127.0.0.1` only. A reverse proxy (nginx, Caddy)
  must handle TLS for any network-accessible deployment.
- **Single-node only**: All state is on the local filesystem. Horizontal scaling
  would require replacing CSV stores with a shared database.
- **Retention setting stored, pruning not implemented**: `retentionDays` is
  stored per team and displayed in the admin UI, but no background job enforces
  it. Old notes are not automatically deleted.
- **No `/api/capture` HTTP endpoint**: Capture tokens exist and are minted/revoked
  through the `/me/tokens` UI, but there is no HTTP endpoint for agents to push
  notes using a Bearer token. The `verifyCaptureToken` function exists in
  `src/auth/tokens.ts`; the ingest route is roadmap.
- **CSV not for > 10 000 rows**: Beyond that threshold, migrate `users.csv`,
  `sessions.csv`, and `audit.csv` to SQLite or Postgres.
- **Rate-limit state is in-process**: The login throttle resets on server restart
  and is not shared across processes.
