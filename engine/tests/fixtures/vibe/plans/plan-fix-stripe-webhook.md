# Plan: fix stripe webhook idempotency

Decision: we will deduplicate webhook events by event id before processing.

Steps:
1. Add a seen-set keyed by event id in src/payments/idempotency.ts
2. Guard handleWebhook with the seen check
3. Add a regression test for duplicate delivery
