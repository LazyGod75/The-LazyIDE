import { useState, useCallback, useRef } from 'react';
import { getProvider, describeProviderReadiness } from '../models/index.js';
import type { ChatMessage } from '../models/index.js';
import { useI18n } from '../../i18n';

export interface TerminalAiResult {
  suggestion: string | null;
  error: string | null;
}

export function useTerminalAi() {
  const { t } = useI18n();
  const [isThinking, setIsThinking] = useState(false);
  const lastOutputRef = useRef<string>('');

  const setLastOutput = useCallback((output: string) => {
    lastOutputRef.current = output;
  }, []);

  const suggestCommand = useCallback(async (
    userQuery: string,
    terminalOutput: string,
  ): Promise<TerminalAiResult> => {
    const readiness = describeProviderReadiness(undefined, t);
    if (!readiness.ready) {
      return { suggestion: null, error: readiness.reason ?? 'No model available' };
    }

    setIsThinking(true);
    try {
      const provider = getProvider(t);
      const context = terminalOutput ? `\n\nRecent terminal output:\n\`\`\`\n${terminalOutput.slice(-1000)}\n\`\`\`` : '';
      const userMsg: ChatMessage = {
        id: `term-${Date.now()}`,
        role: 'user',
        content: `You are a terminal assistant. Suggest a shell command to accomplish the user's request. Return ONLY the command, no explanation, no markdown fences.${context}\n\nRequest: ${userQuery}`,
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
      return { suggestion: cleaned, error: null };
    } catch (err) {
      return { suggestion: null, error: err instanceof Error ? err.message : 'Failed' };
    } finally {
      setIsThinking(false);
    }
  }, [t]);

  const explainOutput = useCallback(async (
    terminalOutput: string,
  ): Promise<TerminalAiResult> => {
    const readiness = describeProviderReadiness(undefined, t);
    if (!readiness.ready) {
      return { suggestion: null, error: readiness.reason ?? 'No model available' };
    }

    setIsThinking(true);
    try {
      const provider = getProvider(t);
      const userMsg: ChatMessage = {
        id: `term-explain-${Date.now()}`,
        role: 'user',
        content: `Explain this terminal output briefly. If there's an error, explain what went wrong and how to fix it. Keep it under 3 sentences.\n\n\`\`\`\n${terminalOutput.slice(-2000)}\n\`\`\``,
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

      return { suggestion: accumulated.trim(), error: null };
    } catch (err) {
      return { suggestion: null, error: err instanceof Error ? err.message : 'Failed' };
    } finally {
      setIsThinking(false);
    }
  }, [t]);

  return { suggestCommand, explainOutput, setLastOutput, isThinking };
}
