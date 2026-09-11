/* accessSettings — persistence of the user's provider/model preferences.

   Extracted into its own module so that managedProvider.ts can import it
   without creating a circular dependency with index.ts.

   index.ts re-exports everything here, so existing callers are unaffected.
*/

import type { ReasoningEffort } from './openrouterCatalog.js';
import type { CavemanIntensity } from '../compression/types.js';
import type { OutputStyleSelectionEntry } from '../assistant/outputStyles.js';
import type { ByokProvider } from './byokProviders.js';

export type { ByokProvider } from './byokProviders.js';
export type AccessMode = 'cli' | 'byok' | 'pro' | 'local';
export type CliTool = 'claude' | 'codex' | 'devin';

export interface AccessSettings {
  /** Which access mode is selected. Undefined = auto-detect. */
  accessMode?: AccessMode;
  /** Which CLI tool to use when accessMode === 'cli'. Default: 'claude'. */
  cliTool?: CliTool;
  /** Preferred model id (used across all modes when set).
      When accessMode === 'pro', this must be an OpenRouter catalog id
      (e.g. 'anthropic/claude-sonnet-5'). For other modes it is a native
      provider id (e.g. 'claude-sonnet-5'). */
  model?: string;
  /** Which BYOK provider when accessMode === 'byok'. Default: 'anthropic'. */
  byokProvider?: ByokProvider;
  /** Reasoning effort sent to the OpenRouter proxy when accessMode === 'pro'
      and the selected model supports reasoning. Default: 'medium'. */
  reasoningEffort?: ReasoningEffort;
  /** Enable web search plugin for requests when the model supports it. */
  webSearch?: boolean;
  /** Enable response healing plugin for JSON repair. */
  responseHealing?: boolean;
  /** Enable Caveman prose compression before sending to the LLM. Default: false. */
  compressionEnabled?: boolean;
  /** Caveman compression intensity. Default: 'full'. */
  compressionIntensity?: CavemanIntensity;
  /** Selected output styles to inject into the system prompt. */
  outputStyles?: OutputStyleSelectionEntry[];
}

const LS_ACCESS_KEY = 'lazy.accessSettings';

export function loadAccessSettings(): AccessSettings {
  try {
    const raw = localStorage.getItem(LS_ACCESS_KEY);
    if (raw) return JSON.parse(raw) as AccessSettings;
  } catch {
    // localStorage unavailable or invalid JSON — fall through
  }
  return {};
}

export function saveAccessSettings(settings: AccessSettings): void {
  try {
    localStorage.setItem(LS_ACCESS_KEY, JSON.stringify(settings));
  } catch {
    // localStorage unavailable — silently ignore
  }
}
