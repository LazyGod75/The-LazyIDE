---
id: acme/concepts
type: concept
topic: acme/concepts
created: 2026-05-06T00:00:00Z
confidence: 0.85
tags: [concept, architecture, acme, auth, session, token]
---

# Session management: short-lived tokens with silent refresh

## Tldr

Auth sessions use 1-hour access tokens with silent refresh via refresh tokens stored in httpOnly cookies. Managed by Supabase Auth.

## Body

Sessions are short-lived (1 hour) with silent refresh via refresh tokens stored in httpOnly cookies. The refresh logic runs automatically in the background — users never see a re-login prompt unless the refresh token has also expired (7-day default). Supabase Auth handles the token rotation natively.