---
id: acme/concepts
type: concept
topic: acme/concepts
created: 2026-05-10T00:00:00Z
confidence: 0.95
tags: [concept, decision, acme, database, postgres]
---

# Decision: Postgres over SQLite for multi-instance writes

## Tldr

Chose Postgres over SQLite for multi-instance writes in production deployment.

## Body

Decision recorded 2026-05-10. SQLite cannot handle concurrent writes from multiple app instances. Postgres with connection pooling via Supabase handles this natively. Migration completed with zero downtime using logical replication. Kind decision