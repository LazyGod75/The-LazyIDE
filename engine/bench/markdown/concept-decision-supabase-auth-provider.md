---
id: acme/concepts
type: concept
topic: acme/concepts
created: 2026-05-08T00:00:00Z
confidence: 0.92
tags: [concept, decision, acme, auth, supabase, session]
---

# Decision: Use Supabase Auth as the auth provider

## Tldr

Chose Supabase Auth over Auth0 for unified auth + database provider model.

## Body

Decision recorded 2026-05-08. Supabase Auth provides row-level security (RLS) integration directly with the database, removing the need for a separate service. Auth0 would add a monthly cost and require token bridging between auth and database layers. Session management via httpOnly cookies, 1-hour TTL with silent refresh. Kind decision