---
id: content-pipeline/concepts
type: concept
topic: content-pipeline/concepts
created: 2026-05-11T00:00:00Z
confidence: 0.85
tags: [concept, bug, content-pipeline, build, error, env]
---

# Bug: Missing SUPABASE_URL env var in CI build

## Tldr

CI build fails because SUPABASE_URL is not set in the build environment, causing env.ts validation to throw at startup.

## Body

Bug recorded 2026-05-11. The content-pipeline validates required environment variables at startup via content-pipeline/src/lib/env.ts. The CI pipeline was missing SUPABASE_URL and SUPABASE_ANON_KEY in the build step environment — these were only set for the deploy step. Fixed by moving env var injection to the build step in the CI config.

## Related

Related neurons content-pipeline/src/lib/env.ts