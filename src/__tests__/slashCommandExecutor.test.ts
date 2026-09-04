import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeSlashCommand, type SlashCommandDeps } from '../lib/ai/slashCommandExecutor';
import { parseSlashCommand } from '../lib/ai/slashCommands';
import { getBrainDocs } from '../lib/brain/brainDocs';

// slashCommandExecutor deliberately calls the REAL brainDocs.ts (localStorage-
// backed) rather than mocking it — this is the "brainDocs API branchee"
// coverage: /docs and /docs-add must exercise the actual module, not a stub.
beforeEach(() => {
  localStorage.clear();
});

/** Identity translator with {param} interpolation — mirrors i18n's own t()
 *  closely enough to assert on interpolated values without pulling in the
 *  full I18nProvider. */
function fakeT(key: string, params?: Record<string, string | number>): string {
  if (!params) return key;
  let out = key;
  for (const [k, v] of Object.entries(params)) out = out.replace(`{${k}}`, String(v));
  return out;
}

function makeDeps(overrides: Partial<SlashCommandDeps> = {}): SlashCommandDeps {
  return {
    clearConversation: vi.fn(),
    chatSessions: [],
    loadChatSession: vi.fn(),
    applyModelById: vi.fn(() => ({ applied: false })),
    openModelPicker: vi.fn(),
    brainSearch: vi.fn(async () => []),
    compactConversation: vi.fn(() => ({ foldedTurns: 0 })),
    t: fakeT,
    ...overrides,
  };
}

describe('executeSlashCommand', () => {
  it('/clear calls clearConversation and returns a success toast', async () => {
    const deps = makeDeps();
    const parsed = parseSlashCommand('/clear')!;

    const outcome = await executeSlashCommand(parsed, deps);

    expect(deps.clearConversation).toHaveBeenCalledOnce();
    expect(outcome).toEqual({ message: 'assistant.slashCommands.cleared', type: 'success' });
  });

  it('/help returns the module-formatted help text', async () => {
    const deps = makeDeps();
    const parsed = parseSlashCommand('/help')!;

    const outcome = await executeSlashCommand(parsed, deps);

    expect(outcome?.type).toBe('info');
    expect(outcome?.message).toContain('/clear');
    expect(outcome?.message).toContain('/docs');
  });

  it('/model <id> with no match returns null and opens the model picker', async () => {
    const deps = makeDeps();
    const parsed = parseSlashCommand('/model')!;

    const outcome = await executeSlashCommand(parsed, deps);

    expect(outcome).toBeNull();
    expect(deps.openModelPicker).toHaveBeenCalledOnce();
  });

  it('/model <id> applies a known model and reports its label', async () => {
    const deps = makeDeps({
      applyModelById: vi.fn(() => ({ applied: true, label: 'Claude Sonnet' })),
    });
    const parsed = parseSlashCommand('/model claude-sonnet-5')!;

    const outcome = await executeSlashCommand(parsed, deps);

    expect(deps.applyModelById).toHaveBeenCalledWith('claude-sonnet-5');
    expect(outcome).toEqual({ message: 'assistant.slashCommands.modelSet', type: 'success' });
  });

  it('/model <id> for an unknown model reports failure', async () => {
    const deps = makeDeps({ applyModelById: vi.fn(() => ({ applied: false })) });
    const parsed = parseSlashCommand('/model does-not-exist')!;

    const outcome = await executeSlashCommand(parsed, deps);

    expect(outcome).toEqual({ message: 'assistant.slashCommands.modelNotFound', type: 'error' });
  });

  it('/compact folds real turns when the store reports work', async () => {
    const compactConversation = vi.fn(() => ({ foldedTurns: 5 }));
    const deps = makeDeps({ compactConversation });
    const outcome = await executeSlashCommand(parseSlashCommand('/compact')!, deps);
    expect(compactConversation).toHaveBeenCalledOnce();
    expect(outcome).toEqual({ message: 'assistant.slashCommands.compacted', type: 'success' });
  });

  it('/compact reports nothing to fold when the conversation is still short', async () => {
    const deps = makeDeps();
    const outcome = await executeSlashCommand(parseSlashCommand('/compact')!, deps);
    expect(outcome).toEqual({ message: 'assistant.slashCommands.compactNothing', type: 'info' });
  });

  it('/diff, /apply, /fork are honestly reported as not wired up', async () => {
    const deps = makeDeps();
    for (const cmd of ['/diff', '/apply', '/fork']) {
      const outcome = await executeSlashCommand(parseSlashCommand(cmd)!, deps);
      expect(outcome).toEqual({ message: 'assistant.slashCommands.notAvailable', type: 'info' });
    }
  });

  it('an unrecognized command returns the unknown-command toast', async () => {
    const deps = makeDeps();
    const parsed = parseSlashCommand('/nope')!;

    const outcome = await executeSlashCommand(parsed, deps);

    expect(outcome).toEqual({ message: 'assistant.slashCommands.unknown', type: 'error' });
  });

  describe('/resume', () => {
    it('with no id returns the usage message', async () => {
      const deps = makeDeps();
      const outcome = await executeSlashCommand(parseSlashCommand('/resume')!, deps);
      expect(outcome).toEqual({ message: 'assistant.slashCommands.resumeUsage', type: 'error' });
    });

    it('with an unknown id reports not found', async () => {
      const deps = makeDeps({ chatSessions: [{ id: 'chat-1' }] });
      const outcome = await executeSlashCommand(parseSlashCommand('/resume chat-99')!, deps);
      expect(outcome).toEqual({ message: 'assistant.slashCommands.resumeNotFound', type: 'error' });
      expect(deps.loadChatSession).not.toHaveBeenCalled();
    });

    it('with a known id loads the session', async () => {
      const deps = makeDeps({ chatSessions: [{ id: 'chat-1' }] });
      const outcome = await executeSlashCommand(parseSlashCommand('/resume chat-1')!, deps);
      expect(deps.loadChatSession).toHaveBeenCalledWith('chat-1');
      expect(outcome).toEqual({ message: 'assistant.slashCommands.resumed', type: 'success' });
    });
  });

  describe('/brain-search', () => {
    it('with no query returns the usage message', async () => {
      const deps = makeDeps();
      const outcome = await executeSlashCommand(parseSlashCommand('/brain-search')!, deps);
      expect(outcome).toEqual({ message: 'assistant.slashCommands.brainSearchUsage', type: 'error' });
    });

    it('with results reports the count and titles', async () => {
      const deps = makeDeps({ brainSearch: vi.fn(async () => [{ title: 'auth.ts' }, { title: 'session.ts' }]) });
      const outcome = await executeSlashCommand(parseSlashCommand('/brain-search auth')!, deps);
      expect(deps.brainSearch).toHaveBeenCalledWith('auth');
      expect(outcome).toEqual({ message: 'assistant.slashCommands.brainSearchResults', type: 'success' });
    });

    it('with no results says so', async () => {
      const deps = makeDeps({ brainSearch: vi.fn(async () => []) });
      const outcome = await executeSlashCommand(parseSlashCommand('/brain-search nothing')!, deps);
      expect(outcome).toEqual({ message: 'assistant.slashCommands.brainSearchNoResults', type: 'info' });
    });
  });

  describe('/docs and /docs-add — real brainDocs.ts integration', () => {
    it('/docs-add with valid args persists a real brain doc entry', async () => {
      const deps = makeDeps();
      const outcome = await executeSlashCommand(
        parseSlashCommand('/docs add https://example.com/react-hooks | React Hooks | react,hooks')!,
        deps,
      );

      expect(outcome).toEqual({ message: 'assistant.slashCommands.docsAdded', type: 'success' });
      const stored = getBrainDocs();
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({
        url: 'https://example.com/react-hooks',
        title: 'React Hooks',
        tags: ['react', 'hooks'],
        source: 'manual',
      });
    });

    it('/docs-add with malformed args (missing url) returns the usage message and adds nothing', async () => {
      const deps = makeDeps();
      const outcome = await executeSlashCommand(parseSlashCommand('/docs add just-a-title')!, deps);

      expect(outcome).toEqual({ message: 'assistant.slashCommands.docsAddUsage', type: 'error' });
      expect(getBrainDocs()).toHaveLength(0);
    });

    it('/docs finds a previously added doc by tag/title text match', async () => {
      const deps = makeDeps();
      await executeSlashCommand(
        parseSlashCommand('/docs add https://example.com/react-hooks | React Hooks | react,hooks')!,
        deps,
      );

      const outcome = await executeSlashCommand(parseSlashCommand('/docs react')!, deps);

      expect(outcome?.type).toBe('success');
      expect(outcome?.message).toBe('assistant.slashCommands.docsResults');
    });

    it('/docs with no matching entries reports no results', async () => {
      const deps = makeDeps();
      const outcome = await executeSlashCommand(parseSlashCommand('/docs nothing-added-yet')!, deps);
      expect(outcome).toEqual({ message: 'assistant.slashCommands.docsNoResults', type: 'info' });
    });
  });
});
