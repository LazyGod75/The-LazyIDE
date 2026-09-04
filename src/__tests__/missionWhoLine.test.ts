import { describe, expect, it } from 'vitest';
import { missionWhoLabel, missionWhoWhatLine, missionWorkLine } from '../lib/agents/missionWhoLine';

describe('missionWhoLabel', () => {
  it('prefers the real agentName and falls back to the model id', () => {
    expect(missionWhoLabel({ agentName: 'Coder', model: 'sonnet' })).toBe('Coder');
    expect(missionWhoLabel({ model: 'opus' })).toBe('opus');
    expect(missionWhoLabel({ agentName: '  ', model: 'haiku' })).toBe('haiku');
  });
});

describe('missionWorkLine', () => {
  it('surfaces a pending question instead of the liveAction', () => {
    expect(missionWorkLine('Write: Write {"file_path":"src/a.ts"}', 'Overwrite auth.rs?')).toBe(
      'Overwrite auth.rs?',
    );
  });

  it('turns a Write tool JSON step into verb + basename, never the raw JSON', () => {
    const raw = 'Write: Write {"file_path":"src/auth.ts","content":"x"}';
    expect(missionWorkLine(raw)).toBe('écrit auth.ts');
    expect(missionWorkLine(raw)).not.toContain('{');
  });

  it('passes already-human liveAction through unchanged', () => {
    expect(missionWorkLine('Worktree prêt — démarrage du loop…')).toBe(
      'Worktree prêt — démarrage du loop…',
    );
  });
});

describe('missionWhoWhatLine', () => {
  it('joins who and what with a middle dot, never inventing a name or path', () => {
    expect(
      missionWhoWhatLine({
        agentName: 'Coder',
        model: 'sonnet',
        liveAction: 'Write: Write {"file_path":"src/auth.ts","content":"x"}',
      }),
    ).toBe('Coder · écrit auth.ts');
  });

  it('shows only who when there is no liveAction yet', () => {
    expect(missionWhoWhatLine({ agentName: 'Coder', model: 'sonnet' })).toBe('Coder');
  });
});
