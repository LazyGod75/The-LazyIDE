---
id: acme/concepts
type: concept
topic: acme/concepts
created: 2026-05-05T00:00:00Z
confidence: 0.9
tags: [concept, architecture, acme, database, supabase, rls, security]
---

# Architecture: Supabase RLS for multi-tenant data isolation

## Tldr

Supabase row-level security (RLS) policies enforce multi-tenant data isolation without application-layer filtering.

## Body

Architecture note recorded 2026-05-05. All tables with tenant data have RLS enabled. Policies use auth.uid() to scope queries. This ensures that even if the application layer has a bug, the database will not return another tenant's data. AdminPanel queries use a service-role key with explicit filters — RLS is bypassed intentionally for admin operations.