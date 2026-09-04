---
id: acme/concepts
type: concept
topic: acme/concepts
created: 2026-05-15T00:00:00Z
confidence: 0.9
tags: [concept, decision, acme, auth, oauth, security]
---

# Decision: Migrate from JWT to OAuth2 PKCE

## Tldr

Migrated authentication from custom JWT tokens to OAuth2 PKCE after Q2 security audit.

## Body

Decision recorded 2026-05-15. Q2 2026 security audit found manual secret rotation and weak HMAC key management. OAuth2 PKCE eliminates the need for client secrets and is more resilient to code interception. All clients must re-onboard via the new PKCE flow before end of July. Kind decision