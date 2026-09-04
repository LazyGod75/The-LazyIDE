import { useCallback, useState } from 'react';
import { getProvider, describeProviderReadiness, getActiveModel } from '../models/index.js';
import type { ChatMessage } from '../models/index.js';
import { sanitizeModelCodeOutput } from './codeOutputSanitizer.js';
import { useI18n } from '../../i18n';

export interface AutoFixResult {
  fix: string | null;
  error: string | null;
}

export function useAutoFix() {
  const { t } = useI18n();
  const [isFixing, setIsFixing] = useState(false);

  const fixDiagnostic = useCallback(async (
    message: string,
    filename: string,
    language: string,
    surroundingCode: string,
  ): Promise<AutoFixResult> => {
    const readiness = describeProviderReadiness(undefined, t);
    if (!readiness.ready) {
      return { fix: null, error: readiness.reason ?? 'No model available' };
    }

    setIsFixing(true);
    try {
      const provider = getProvider(t);
      const userMsg: ChatMessage = {
        id: `autofix-${Date.now()}`,
        role: 'user',
        content: `Fix this ${language} error in ${filename}:\n\nError: ${message}\n\nCode context:\n\`\`\`${language}\n${surroundingCode}\n\`\`\`\n\nReturn ONLY the corrected code, no explanation, no narration, no markdown fences.`,
      };

      let accumulated = '';
      const stream = provider.streamChat({
        messages: [userMsg],
        // Resolved active model (not a hardcoded literal) — see getActiveModel()
        // for the fallback chain. A stale/inaccessible id here breaks the stream
        // outright (the CLI/BYOK/codex paths forward model.id as-is).
        model: getActiveModel(),
        // 'transform', NOT 'edit' — same HIGH-defect fix as InlineEditBar.tsx
        // (see ChatMode's doc comment in lib/models/types.ts). autoFix treats
        // the whole stream as literal replacement code, so it shares
        // InlineEditBar's exposure to agentic narration under 'edit' mode.
        mode: 'transform',
      });

      for await (const token of stream) {
        accumulated += token;
      }

      // Fail-safe: never surface narration as if it were the fix — see
      // codeOutputSanitizer.ts. ProblemsPanel only applies `result.fix` when
      // it is non-null, so this alone prevents narration from corrupting the
      // file once the user clicks "Fix".
      const sanitized = sanitizeModelCodeOutput(accumulated);
      if (!sanitized.ok) {
        return { fix: null, error: `${sanitized.reason} (backend: ${provider.label})` };
      }
      return { fix: sanitized.code, error: null };
    } catch (err) {
      return { fix: null, error: err instanceof Error ? err.message : 'Fix failed' };
    } finally {
      setIsFixing(false);
    }
  }, [t]);

  return { fixDiagnostic, isFixing };
}
