import { useState, useEffect, useCallback } from 'react';
import { getPlatform } from '../platform/index.js';

export interface LazyRules {
  rules: string | null;
  /** Which file supplied the rules (for UI transparency). */
  sourceFile: string | null;
  loading: boolean;
  reload: () => void;
}

/**
 * Standard onboarding files, in priority order (first match wins). This is
 * the G1 interop fix: users coming from Cursor/Claude Code already have
 * .cursorrules / CLAUDE.md / AGENTS.md — Lazy must read them so the agent
 * starts every session informed (harness artifact #1).
 *
 * Priority: AGENTS.md > CLAUDE.md > .cursorrules > .lazyrules > variants.
 */
export const RULES_FILES = [
  'AGENTS.md',
  'CLAUDE.md',
  '.cursorrules',
  '.lazyrules',
  '.lazyrules.md',
  'LAZYRULES',
  'LAZYRULES.md',
] as const;

export function useLazyRules(projectRoot: string | null): LazyRules {
  const [rules, setRules] = useState<string | null>(null);
  const [sourceFile, setSourceFile] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const platform = getPlatform();

  const loadRules = useCallback(async () => {
    if (!projectRoot) {
      setRules(null);
      setSourceFile(null);
      return;
    }
    setLoading(true);
    try {
      for (const name of RULES_FILES) {
        const filePath = `${projectRoot}/${name}`.replace(/\\/g, '/');
        try {
          const content = await platform.fs.readFile(filePath);
          if (content && content.trim()) {
            setRules(content.trim());
            setSourceFile(name);
            setLoading(false);
            return;
          }
        } catch { /* file not found, try next */ }
      }
      setRules(null);
      setSourceFile(null);
    } catch {
      setRules(null);
      setSourceFile(null);
    } finally {
      setLoading(false);
    }
  }, [projectRoot, platform]);

  useEffect(() => {
    loadRules();
  }, [loadRules]);

  return { rules, sourceFile, loading, reload: loadRules };
}

export function buildRulesSystemPrompt(rules: string | null, sourceFile?: string | null): string {
  if (!rules) return '';
  const label = sourceFile ? ` (${sourceFile})` : '';
  return `\n\n## Project Rules${label}\nFollow these project-specific rules:\n\n${rules}\n`;
}

