---
id: content-pipeline/concepts
type: concept
topic: content-pipeline/concepts
created: 2026-05-12T00:00:00Z
confidence: 0.88
tags: [concept, decision, content-pipeline, deploy, render-kit]
---

# Decision: Deploy content-pipeline on render-kit

## Tldr

Chose render-kit as the deployment target for the content-pipeline service over self-hosted VPS.

## Body

Decision recorded 2026-05-12. render-kit provides auto-scaling, zero-config SSL, and managed PostgreSQL. The content-pipeline runs scheduled cron jobs (daily publish, weekly drift, monthly performance) which map cleanly to render-kit background workers. Cost is predictable at current scale. Kind decision