# Open-source publish checklist

Use this before creating or updating the **public** GitHub repository.
Do **not** push until every item is checked.

## 1. Working tree hygiene

- [ ] No `_qa-*`, `_qa-design/`, `scrape-*.txt`, or root debug dumps left unignored
- [ ] `.lazy/` runtime (missions, gate-audit, solari-sessions) is gitignored
- [ ] No `.env`, `.env.local`, or `cloud/.env` tracked (`git ls-files '.env*'`)
- [ ] `npm run secrets:check` exits 0 on tracked files

## 2. Architecture / docs

- [ ] [README.md](../README.md) explains the app, LazyManager, agents, Brain, LazyBot, models
- [ ] [SECURITY.md](../SECURITY.md) exists (responsible disclosure)
- [ ] [LICENSE.md](../LICENSE.md) is FSL-1.1-ALv2 (or intended public license)
- [ ] [CONTRIBUTING.md](../CONTRIBUTING.md) mentions `secrets:check` + hooks

## 3. Private vs public surfaces

| Keep private (this repo / `cloud/`) | Public export |
|---|---|
| `supabase/` Edge Functions + migrations | App, agents, Brain, BYOK/CLI |
| `cloud/` + `cloud/.env.example` (operator) | `.env.example` (client, optional Cloud) |
| `RELEASING.md`, `ACTIVATION.md`, `DEPLOY-NOTES.md` | `SECURITY.md`, checklist |
| `release.yml` / `republish-manifest.yml` | `ci.yml` / `checks-full.yml` (redacted IDs) |
| Real Stripe / service-role / R2 / signing keys | Empty updater endpoints in `tauri.conf.json` |

Confirm: `cloud/PRIVATE_MANIFEST.json` matches `scripts/export-public-repo.mjs`.

## 4. Export dry-run then real export

```bash
npm run export:public:dry
npm run export:public
# optional: npm run export:public -- ./dist/public-export
```

- [ ] Export refuses to write if `scanText` finds secrets
- [ ] Dest has `LICENSE.md`, `README.md`, `CONTRIBUTING.md`, `SECURITY.md`
- [ ] Dest has **no** `cloud/`, `supabase/`, `ACTIVATION.md`, `.env.local`

## 5. History risk

- [ ] `git log --all --full-history -- .env .env.local` is empty (or history rewritten)
- [ ] If a secret was ever committed: rotate + `git filter-repo` **before** first public push

## 6. Smoke guest / OSS mode

- [ ] `cloudConfig.ts` ships Lazy Cloud URL + anon key
- [ ] With no `.env.local` override, Cloud is active (sign-up + LazyPro work out of the box)
- [ ] Skip / guest mode still works when Cloud *is* configured
- [ ] UI does not hardcode private Stripe/Supabase operator URLs

## 7. Publish (manual — not part of this checklist automation)

- [ ] Create public remote from the **export** directory (not from this private tree)
- [ ] First push from export only after review of `git log` and secret scan there
- [ ] Keep this working repo private for Cloud / releases
