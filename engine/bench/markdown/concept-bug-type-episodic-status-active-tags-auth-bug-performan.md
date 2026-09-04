---
id: tradelab/concepts
type: concept
topic: tradelab/concepts
created: 2026-05-19T00:00:00Z
confidence: 0.01
tags: [concept, bug, tradelab, auth, performance]
---

# Type: episodic | Status: active | Tags: auth, bug, performance

## Tldr

bug concept — Type: episodic | Status: active | Tags: auth, bug, performance

## Body

Type: episodic | Status: active | Tags: auth, bug, performance, llm, python, docs, shell, config | Source: session:dream-ca39c6cd | Confidence: 0.01 Auth middleware adds 200ms+ latency per request due to redundant token validation calls. JWT verification hits the database on every request instead of using the in-memory cache.

## Related

Related neurons src/middleware/auth.py src/cache/token_cache.py