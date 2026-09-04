import { useState, useCallback } from 'react';
import { getProvider, describeProviderReadiness, getActiveModel } from '../../lib/models';
import type { ChatMessage } from '../../lib/models';
import { useI18n } from '../../i18n';

interface AiReviewProps {
  diff: string;
  onDone?: (review: string) => void;
}

interface ReviewResult {
  summary: string;
  issues: Array<{ severity: 'high' | 'medium' | 'low'; file: string; line: string; message: string }>;
  suggestions: string[];
}

export function AiReview({ diff, onDone }: AiReviewProps) {
  const { t } = useI18n();
  const [loading, setLoading] = useState(false);
  const [review, setReview] = useState<ReviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runReview = useCallback(async () => {
    if (!diff.trim()) return;
    setLoading(true);
    setError(null);
    setReview(null);

    const readiness = describeProviderReadiness(undefined, t);
    if (!readiness.ready) {
      setError(readiness.reason ?? 'No model available');
      setLoading(false);
      return;
    }

    try {
      const provider = getProvider(t);
      const userMsg: ChatMessage = {
        id: `review-${Date.now()}`,
        role: 'user',
        content: `Review this code diff. Identify potential bugs, security issues, performance problems, and suggest improvements. Format your response as JSON with this structure: {"summary":"brief overview","issues":[{"severity":"high|medium|low","file":"filename","line":"line range","message":"description"}],"suggestions":["improvement1","improvement2"]}. Return ONLY the JSON.\n\n\`\`\`diff\n${diff.slice(0, 6000)}\n\`\`\``,
      };

      let accumulated = '';
      const stream = provider.streamChat({
        messages: [userMsg],
        // Resolved active model (not a hardcoded literal) — see getActiveModel().
        model: getActiveModel(),
        mode: 'ask',
      });

      for await (const token of stream) {
        accumulated += token;
      }

      const cleaned = accumulated.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '').trim();
      try {
        const parsed = JSON.parse(cleaned) as ReviewResult;
        setReview(parsed);
        onDone?.(cleaned);
      } catch {
        setReview({
          summary: accumulated.slice(0, 500),
          issues: [],
          suggestions: [],
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Review failed');
    } finally {
      setLoading(false);
    }
  }, [diff, onDone, t]);

  const severityColor: Record<string, string> = {
    high: '#F07178',
    medium: '#FFC76B',
    low: '#4FC3F7',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          onClick={runReview}
          disabled={loading || !diff.trim()}
          style={{
            background: 'rgba(124,92,255,0.1)',
            border: '1px solid rgba(124,92,255,0.2)',
            borderRadius: 4,
            padding: '4px 12px',
            color: '#A78BFF',
            cursor: loading ? 'wait' : 'pointer',
            fontSize: 11,
            fontFamily: 'inherit',
            opacity: loading || !diff.trim() ? 0.5 : 1,
          }}
        >
          {loading ? 'Reviewing...' : '🔍 AI Review'}
        </button>
        {error && <span style={{ fontSize: 10, color: '#F07178' }}>{error}</span>}
      </div>

      {review && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 11 }}>
          <div style={{ color: '#D5D8E0', fontWeight: 500 }}>{review.summary}</div>

          {review.issues.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              {review.issues.map((issue, i) => (
                <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                  <span style={{
                    color: severityColor[issue.severity] ?? '#fff',
                    fontSize: 9,
                    fontWeight: 600,
                    flexShrink: 0,
                    marginTop: 1,
                    textTransform: 'uppercase',
                  }}>
                    {issue.severity}
                  </span>
                  <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: 10, flexShrink: 0 }}>
                    {issue.file}:{issue.line}
                  </span>
                  <span style={{ color: 'rgba(255,255,255,0.7)' }}>
                    {issue.message}
                  </span>
                </div>
              ))}
            </div>
          )}

          {review.suggestions.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: 10, fontWeight: 600 }}>Suggestions:</div>
              {review.suggestions.map((s, i) => (
                <div key={i} style={{ color: 'rgba(255,255,255,0.6)', paddingLeft: 12 }}>
                  • {s}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
