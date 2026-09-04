---
id: marketing/concepts
type: concept
topic: marketing/concepts
created: 2026-05-22T00:00:00Z
confidence: 0.05
tags: [concept, bug, marketing, scheduler, cal, error]
---

# Bug critique: le template a invent&#233; un URL Scheduler `scheduler

## Tldr

bug concept — Bug critique: le template a invent&#233; un URL Scheduler

## Body

Bug critique: the LLM template invented a non-existent Scheduler URL in outreach emails. Emails sent to leads contained a broken booking link pointing to scheduler.acme-app.com/cal/add which does not exist. The Scheduler integration was planned but never shipped. Root cause: the prompt template for outreach generation included a placeholder for the Scheduler booking URL that was never replaced with a real value or removed when Scheduler feature was deprioritized.

## Related

Related neurons outreach/templates/v8.py acme-app/app/details/cal/add.jsx