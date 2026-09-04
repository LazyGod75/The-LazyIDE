---
id: acme/concepts
type: concept
topic: acme/concepts
created: 2026-05-20T00:00:00Z
confidence: 0.08
tags: [concept, bug, acme, auth, database, testing]
---

# Type: episodic | Status: active | Tags: auth, database, testing

## Tldr

bug concept — Type: episodic | Status: active | Tags: auth, database, testing

## Body

Type: episodic | Status: active | Tags: auth, database, testing | Source: session:dream-ab12cd34 | Confidence: 0.08 Auth integration tests fail when database connection pool exhausted. Test teardown does not properly release connections, causing subsequent test suites to timeout.

## Related

Related neurons tests/auth/integration.test.ts src/db/pool.ts