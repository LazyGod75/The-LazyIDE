# Security Policy

## Supported versions

Security fixes are applied on the active development branch of Lazy.
Report issues against the latest published source when possible.

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities or leaked secrets.**

Email the maintainers privately (see the repository’s GitHub Security Advisories
tab, or the contact listed in the org profile). Include:

- A short description of the issue and impact
- Steps to reproduce (minimal, no full exploit payload if avoidable)
- Affected version / commit if known

We aim to acknowledge reports within a few business days.

## Secrets and credentials

- Never commit API keys, Stripe secrets, Supabase **service-role** keys,
  OpenRouter keys, R2/AWS credentials, or Tauri signing private keys.
- Client `.env` templates live in `.env.example` (optional Cloud URL + anon key).
- Operator / server secrets live only in `cloud/.env.example` (private tree)
  and in Supabase / GitHub Actions secret stores.
- Run `npm run secrets:check` before committing. A pre-commit hook runs the
  same scan (`npm run hooks:install`).

If you accidentally commit a secret:

1. Rotate the credential immediately at the provider.
2. Remove it from the tree and history (`git filter-repo` or BFG) before any
   public push.
3. Notify maintainers if the leak may already be in a public fork or mirror.

## Scope

In scope: Lazy desktop app, CLI, documented APIs, and the public source tree.
Out of scope: third-party CLIs (`claude`, `codex`), user BYOK providers, and
self-hosted forks’ custom backends unless the bug is clearly in Lazy’s code.
