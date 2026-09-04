# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| 0.2.x   | Yes       |
| 0.1.x   | No — upgrade to 0.2.x |

Security fixes are applied to the current stable minor version only. If you are on an unsupported version, please upgrade before reporting.

---

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Report privately via GitHub Security Advisories:
`https://github.com/LazyGod75/LazyBrain/security/advisories/new`

GitHub keeps the report confidential until a fix is published.

You will receive an acknowledgment within **5 business days**. The goal is to publish a fix and a coordinated disclosure within **90 days** of the initial report, depending on complexity.

If you would like to be credited in the release notes and advisory, include a name or handle in your report.

---

## Threat model

LazyBrain is **local-first by default**. Understanding what this means in practice:

### What LazyBrain does

- Reads conversation transcripts and source code from the local filesystem.
- Writes HTML files to a local brain directory (`.lazybrain/brain/` by default).
- Runs a local HTTP server (`lazybrain serve`) bound to `127.0.0.1` only — never exposed to the network.
- Makes outbound network requests only when an external extractor is explicitly configured
  (`LAZYBRAIN_EXTRACTOR=vibe` or `LAZYBRAIN_EXTRACTOR=openai`). The default is offline.

### What LazyBrain does not do

- It does not send telemetry.
- It does not transmit conversation contents or source code to any remote server unless you
  configure an external extractor and explicitly opt in.
- It does not expose any service on a public interface.

### The `publish` command

`lazybrain publish` is designed for sharing a sanitized brain publicly (e.g., on GitHub Pages).
Before using it:

- Review the `public` profile in your brain's configuration — it controls which neuron types
  and attributes are included in the published output.
- The `publish` command applies a scrubbing pass that removes `data-cerveau-*` attributes
  flagged as private and strips content matching configured secret patterns.
- Even so, **review the output before publishing**. No automated scrubber catches every
  sensitive detail — treat the published brain as you would any public repository.

### Your brain is not the repo

The brain directory (`.lazybrain/`) is listed in `.gitignore` by default. It contains
distilled knowledge about your code and conversations and must not be committed to version
control unless you have explicitly reviewed its contents for sensitive information.

Never commit:

- Real brain files (`.lazybrain/`)
- Conversation transcript files (`~/.claude/projects/**`)
- API keys, tokens, or credentials of any kind

### Responsible disclosure

We follow a coordinated disclosure model. Please give us a reasonable window to prepare a fix
before publishing details publicly. We will credit reporters who request it and aim to
publish advisories promptly after a fix is released.
