import { useState, useCallback } from 'react';
import { getProvider, describeProviderReadiness } from '../../lib/models';
import type { ChatMessage } from '../../lib/models';
import { useI18n } from '../../i18n';

interface AiCommitMessageProps {
  diff: string;
  onApply: (message: string) => void;
}

export function AiCommitMessage({ diff, onApply }: AiCommitMessageProps) {
  const { t } = useI18n();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generated, setGenerated] = useState<string | null>(null);

  const generate = useCallback(async () => {
    if (!diff.trim()) return;
    setLoading(true);
    setError(null);
    setGenerated(null);

    const readiness = describeProviderReadiness(undefined, t);
    if (!readiness.ready) {
      setError(readiness.reason ?? 'No model available');
      setLoading(false);
      return;
    }

    try {
      const provider = getProvider(t);
      const userMsg: ChatMessage = {
        id: `commit-${Date.now()}`,
        role: 'user',
        content: `Generate a concise git commit message for the following diff. Use conventional commit format (type: description). Return ONLY the commit message, no explanation.\n\n\`\`\`diff\n${diff.slice(0, 4000)}\n\`\`\``,
      };

      let accumulated = '';
      const stream = provider.streamChat({
        messages: [userMsg],
        model: { id: 'claude-haiku-4-5', label: 'Claude Haiku', provider: 'anthropic' },
        mode: 'ask',
      });

      for await (const token of stream) {
        accumulated += token;
      }

      const cleaned = accumulated.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '').trim();
      setGenerated(cleaned);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate');
    } finally {
      setLoading(false);
    }
  }, [diff, t]);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <button
        onClick={generate}
        disabled={loading || !diff.trim()}
        title={!diff.trim() ? t('git.aiCommitDisabledNoStaged') : undefined}
        style={{
          background: 'rgba(124,92,255,0.1)',
          border: '1px solid rgba(124,92,255,0.2)',
          borderRadius: 4,
          padding: '3px 10px',
          color: '#A78BFF',
          cursor: loading ? 'wait' : 'pointer',
          fontSize: 10,
          fontFamily: 'inherit',
          opacity: loading || !diff.trim() ? 0.5 : 1,
          whiteSpace: 'nowrap',
        }}
      >
        {loading ? 'Generating...' : '✨ AI Commit'}
      </button>
      {error && <span style={{ fontSize: 10, color: '#F07178' }}>{error}</span>}
      {generated && (
        <>
          <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.5)', fontStyle: 'italic' }}>
            {generated.slice(0, 60)}{generated.length > 60 ? '...' : ''}
          </span>
          <button
            onClick={() => onApply(generated)}
            style={{
              background: 'rgba(102,226,122,0.1)',
              border: '1px solid rgba(102,226,122,0.2)',
              borderRadius: 4,
              padding: '3px 8px',
              color: '#66E27A',
              cursor: 'pointer',
              fontSize: 10,
              fontFamily: 'inherit',
            }}
          >
            Use
          </button>
        </>
      )}
    </div>
  );
}
