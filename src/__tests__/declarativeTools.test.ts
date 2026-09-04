/**
 * declarativeTools.test.ts — W-PROVE safe-by-construction coverage for
 * lib/agents/declarativeTools.ts's two declarative BYO tool kinds: allowlist
 * enforcement (web_read) and the path guard (file_read), plus author-time
 * validation and CRUD persistence. Neither tool kind ever executes
 * user-authored code — these tests are about proving the SAFETY properties
 * (exact-host match, https-only, size cap, project-root containment) hold
 * even against an adversarial/malformed input, not about network behavior.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  isValidAllowlistHost,
  isPathWithinProjectScope,
  urlMatchesWebReadAllowlist,
  validateWebReadTool,
  validateFileReadTool,
  executeWebReadTool,
  executeFileReadTool,
  saveDeclarativeTool,
  listDeclarativeTools,
  deleteDeclarativeTool,
  generateDeclarativeToolId,
  isWebReadToolLike,
  isFileReadToolLike,
  _resetDeclarativeToolsForTests,
  WEB_READ_MAX_BYTES,
  type WebReadTool,
  type FileReadTool,
} from '../lib/agents/declarativeTools';

beforeEach(() => {
  _resetDeclarativeToolsForTests();
});

// ── Host validation ───────────────────────────────────────────────────

describe('isValidAllowlistHost', () => {
  it('accepts a bare hostname', () => {
    expect(isValidAllowlistHost('api.example.com')).toBe(true);
    expect(isValidAllowlistHost('example.com')).toBe(true);
    expect(isValidAllowlistHost('localhost')).toBe(true);
  });

  it('rejects a scheme, path, port, or credentials in the host field', () => {
    expect(isValidAllowlistHost('https://api.example.com')).toBe(false);
    expect(isValidAllowlistHost('api.example.com/path')).toBe(false);
    expect(isValidAllowlistHost('api.example.com:8080')).toBe(false);
    expect(isValidAllowlistHost('user@api.example.com')).toBe(false);
    expect(isValidAllowlistHost('api example.com')).toBe(false);
  });

  it('rejects an empty host', () => {
    expect(isValidAllowlistHost('')).toBe(false);
    expect(isValidAllowlistHost('   ')).toBe(false);
  });
});

// ── Path guard ────────────────────────────────────────────────────────

describe('isPathWithinProjectScope', () => {
  it('accepts a plain relative path', () => {
    expect(isPathWithinProjectScope('docs/README.md')).toBe(true);
    expect(isPathWithinProjectScope('src/index.ts')).toBe(true);
  });

  it('rejects an absolute path (Windows drive, verbatim, UNC, or POSIX root)', () => {
    expect(isPathWithinProjectScope('C:\\Users\\david\\secrets.env')).toBe(false);
    expect(isPathWithinProjectScope('\\\\?\\C:\\Windows\\system.ini')).toBe(false);
    expect(isPathWithinProjectScope('\\\\server\\share\\file')).toBe(false);
    expect(isPathWithinProjectScope('/etc/passwd')).toBe(false);
  });

  it('rejects a ".." escape anywhere in the path, either separator style', () => {
    expect(isPathWithinProjectScope('../secrets.env')).toBe(false);
    expect(isPathWithinProjectScope('..\\..\\Windows\\system.ini')).toBe(false);
    expect(isPathWithinProjectScope('docs/../../etc/passwd')).toBe(false);
    expect(isPathWithinProjectScope('a/b/../../../c')).toBe(false);
  });

  it('rejects an empty path', () => {
    expect(isPathWithinProjectScope('')).toBe(false);
    expect(isPathWithinProjectScope('   ')).toBe(false);
  });
});

// ── validateWebReadTool / validateFileReadTool ───────────────────────

describe('validateWebReadTool', () => {
  it('valid input passes', () => {
    const v = validateWebReadTool({ name: 'Docs', description: 'Lit la doc publique', allowedHost: 'docs.example.com' });
    expect(v.valid).toBe(true);
    expect(v.errors).toHaveLength(0);
  });

  it('rejects a missing/invalid host', () => {
    expect(validateWebReadTool({ name: 'x', description: 'y', allowedHost: '' }).valid).toBe(false);
    expect(validateWebReadTool({ name: 'x', description: 'y', allowedHost: 'http://evil.com' }).valid).toBe(false);
  });

  it('rejects a missing name or description', () => {
    expect(validateWebReadTool({ name: '', description: 'y', allowedHost: 'example.com' }).valid).toBe(false);
    expect(validateWebReadTool({ name: 'x', description: '', allowedHost: 'example.com' }).valid).toBe(false);
  });
});

describe('validateFileReadTool', () => {
  it('valid input passes', () => {
    const v = validateFileReadTool({ name: 'Changelog', description: 'Lit le changelog', path: 'CHANGELOG.md' });
    expect(v.valid).toBe(true);
  });

  it('rejects an outside-project path', () => {
    const v = validateFileReadTool({ name: 'x', description: 'y', path: '../../etc/passwd' });
    expect(v.valid).toBe(false);
    expect(v.errors.join(' ')).toMatch(/project root/);
  });

  it('rejects a missing path', () => {
    expect(validateFileReadTool({ name: 'x', description: 'y', path: '' }).valid).toBe(false);
  });
});

// ── urlMatchesWebReadAllowlist ────────────────────────────────────────

describe('urlMatchesWebReadAllowlist', () => {
  const tool = { allowedHost: 'api.example.com' };

  it('accepts an exact https host match', () => {
    expect(urlMatchesWebReadAllowlist('https://api.example.com/v1/status', tool)).toBe(true);
  });

  it('rejects a DIFFERENT (off-allowlist) host, even a subdomain or superdomain', () => {
    expect(urlMatchesWebReadAllowlist('https://evil.com/steal', tool)).toBe(false);
    expect(urlMatchesWebReadAllowlist('https://sub.api.example.com/', tool)).toBe(false);
    expect(urlMatchesWebReadAllowlist('https://example.com/', tool)).toBe(false);
    expect(urlMatchesWebReadAllowlist('https://api.example.com.evil.com/', tool)).toBe(false);
  });

  it('rejects http (non-https), even to the exact allowlisted host', () => {
    expect(urlMatchesWebReadAllowlist('http://api.example.com/v1/status', tool)).toBe(false);
  });

  it('rejects an unparsable URL', () => {
    expect(urlMatchesWebReadAllowlist('not a url', tool)).toBe(false);
  });
});

// ── executeWebReadTool ────────────────────────────────────────────────

function webReadTool(overrides: Partial<WebReadTool> = {}): WebReadTool {
  return {
    kind: 'web_read',
    id: 'dtool-1',
    name: 'API status',
    description: 'Lit le statut public de l’API',
    allowedHost: 'api.example.com',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function fakeResponse(opts: {
  status?: number;
  contentLength?: string | null;
  text?: string;
  chunks?: Uint8Array[];
}): Response {
  const headers = new Map<string, string>();
  if (opts.contentLength !== undefined && opts.contentLength !== null) headers.set('content-length', opts.contentLength);
  const body = opts.chunks
    ? {
        getReader: () => {
          let i = 0;
          return {
            read: async () => {
              if (i < opts.chunks!.length) {
                const value = opts.chunks![i];
                i += 1;
                return { done: false, value };
              }
              return { done: true, value: undefined };
            },
            cancel: async () => { /* no-op */ },
          };
        },
      }
    : null;
  return {
    status: opts.status ?? 200,
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    body,
    text: async () => opts.text ?? '',
  } as unknown as Response;
}

describe('executeWebReadTool — allowlist enforcement', () => {
  it('rejects a request to an OFF-ALLOWLIST host without ever calling fetch', async () => {
    const fetchImpl = vi.fn();
    const result = await executeWebReadTool(webReadTool(), 'https://evil.com/data', fetchImpl);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not allowlisted/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects an http:// URL to the exact allowlisted host without ever calling fetch', async () => {
    const fetchImpl = vi.fn();
    const result = await executeWebReadTool(webReadTool(), 'http://api.example.com/data', fetchImpl);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not allowlisted/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects an oversize response declared via Content-Length, before reading the body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeResponse({ contentLength: String(WEB_READ_MAX_BYTES + 1) }));
    const result = await executeWebReadTool(webReadTool(), 'https://api.example.com/huge', fetchImpl);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/exceeds the .* cap/);
  });

  it('rejects an oversize response even when Content-Length is ABSENT (a lying/missing header never bypasses the streamed cap)', async () => {
    const bigChunk = new Uint8Array(WEB_READ_MAX_BYTES + 1024).fill(65);
    const fetchImpl = vi.fn().mockResolvedValue(fakeResponse({ chunks: [bigChunk] }));
    const result = await executeWebReadTool(webReadTool(), 'https://api.example.com/huge-no-header', fetchImpl);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/exceeds the .* cap/);
  });

  it('accepts a well-formed response within the size cap from the allowlisted host', async () => {
    const encoder = new TextEncoder();
    const fetchImpl = vi.fn().mockResolvedValue(
      fakeResponse({ status: 200, chunks: [encoder.encode('{"status":"ok"}')] }),
    );
    const result = await executeWebReadTool(webReadTool(), 'https://api.example.com/status', fetchImpl);
    expect(result.ok).toBe(true);
    expect(result.body).toBe('{"status":"ok"}');
    expect(result.status).toBe(200);
  });

  it('surfaces a network failure honestly instead of throwing', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await executeWebReadTool(webReadTool(), 'https://api.example.com/down', fetchImpl);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/request failed/);
  });
});

// ── executeFileReadTool ───────────────────────────────────────────────

function fileReadTool(overrides: Partial<FileReadTool> = {}): FileReadTool {
  return {
    kind: 'file_read',
    id: 'dtool-2',
    name: 'Changelog',
    description: 'Lit le changelog du projet',
    path: 'CHANGELOG.md',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('executeFileReadTool — path guard', () => {
  it('rejects a tool whose OWN path escapes the project root, without ever touching the filesystem platform', async () => {
    const result = await executeFileReadTool(fileReadTool({ path: '../../etc/passwd' }), '/fixtures/project-root');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/outside the project root/);
  });

  it('rejects an absolute path the same way', async () => {
    const result = await executeFileReadTool(fileReadTool({ path: 'C:\\Windows\\system.ini' }), '/fixtures/project-root');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/outside the project root/);
  });
});

// ── Runtime shape guards ──────────────────────────────────────────────

describe('isWebReadToolLike / isFileReadToolLike', () => {
  it('accepts a well-shaped tool of the matching kind', () => {
    expect(isWebReadToolLike(webReadTool())).toBe(true);
    expect(isFileReadToolLike(fileReadTool())).toBe(true);
  });

  it('rejects the WRONG kind, a malformed shape, or a non-object', () => {
    expect(isWebReadToolLike(fileReadTool())).toBe(false);
    expect(isFileReadToolLike(webReadTool())).toBe(false);
    expect(isWebReadToolLike({ kind: 'web_read', name: 'x' })).toBe(false);
    expect(isWebReadToolLike(null)).toBe(false);
    expect(isWebReadToolLike('not an object')).toBe(false);
    expect(isWebReadToolLike(42)).toBe(false);
  });
});

// ── Persistence (CRUD) ────────────────────────────────────────────────

describe('declarative tools CRUD (web-mock fallback)', () => {
  it('save -> list -> delete round-trips both kinds', async () => {
    const web = webReadTool({ id: generateDeclarativeToolId() });
    const file = fileReadTool({ id: generateDeclarativeToolId() });

    await saveDeclarativeTool(web);
    await saveDeclarativeTool(file);

    const listed = await listDeclarativeTools();
    expect(listed).toHaveLength(2);
    expect(listed.find((t) => t.id === web.id)).toBeDefined();
    expect(listed.find((t) => t.id === file.id)).toBeDefined();

    await deleteDeclarativeTool(web.id);
    const afterDelete = await listDeclarativeTools();
    expect(afterDelete).toHaveLength(1);
    expect(afterDelete[0].id).toBe(file.id);
  });

  it('throws on save when the tool fails its own validation (invalid host)', async () => {
    await expect(saveDeclarativeTool(webReadTool({ allowedHost: 'not a host!' }))).rejects.toThrow(/Invalid declarative tool/);
  });

  it('throws on save when the tool fails its own validation (outside-project path)', async () => {
    await expect(saveDeclarativeTool(fileReadTool({ path: '../../secrets' }))).rejects.toThrow(/Invalid declarative tool/);
  });
});
