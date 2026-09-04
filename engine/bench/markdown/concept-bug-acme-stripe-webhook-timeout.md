---
id: acme/concepts
type: concept
topic: acme/concepts
created: 2026-05-14T00:00:00Z
confidence: 0.7
tags: [concept, bug, acme, stripe, payment, webhook]
---

# Bug: Stripe webhook timeout on subscription renewal

## Tldr

Stripe webhook handler times out on subscription renewal events when the Supabase write takes more than 5 seconds.

## Body

Bug recorded 2026-05-14. Stripe requires webhook acknowledgement within 30 seconds, but the payment confirmation handler in onboarding.jsx triggers a synchronous database write with no timeout guard. When the Supabase connection pool is saturated, the webhook response is delayed past Stripe's limit, causing duplicate renewal events. Fix: move the database write to a background queue and respond to Stripe immediately with HTTP 200.

## Related

Related neurons acme-app/app/stripe/onboarding.jsx