---
id: sample-project
type: aggregate-neuron
topic: sample-project
created: 2026-05-01T10:00:00Z

tags: [sample, project, architecture, stack]
---

# Sample Project

## Tldr

A minimal sample project used for benchmark smoke-testing.

## Architecture

Architecture Stack: Node.js backend, React frontend, Postgres database. Authentication via OAuth2 PKCE. Deployment on Render.

## Decisions

Key Decisions Chose Postgres over SQLite for multi-instance writes. Migrated from JWT custom tokens to OAuth2 PKCE.