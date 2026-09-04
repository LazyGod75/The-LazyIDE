---
id: acme/concepts
type: concept
topic: acme/concepts
created: 2026-05-09T00:00:00Z
confidence: 0.04
tags: [concept, bug, acme, build, error, npm]
---

# 851 Error: Command "npm run build" exited with 1

## Tldr

bug concept — 851 Error: Command "npm run build" exited with 1

## Body

851 Error: Command "npm run build" exited with 1. CI pipeline failure on content-pipeline deployment. The build step crashes with exit code 1 — root cause traced to missing env var SUPABASE_URL in the CI environment.

## Related

Related neurons content-pipeline/src/agents/publisher.ts content-pipeline/src/lib/env.ts acme-app/app/details/cal/index.jsx