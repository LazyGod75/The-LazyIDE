/* Widened Brain surface for setup/import/publish UI.
   setConfig / importFromGithub / info are on the Tauri/web impls, not the
   shared Brain interface — callers cast through this type. */

import type { Brain } from '../platform/types';
import type { BrainInfo } from '../platform/tauri';

export type BrainScopeMode = 'project' | 'global' | 'custom';

export interface BrainSetConfigOptions {
  mode: BrainScopeMode;
  path?: string;
}

export interface BrainImportFromGithubOptions {
  url: string;
  dest: string;
}

export type BrainWithSetup = Brain & {
  info(): Promise<BrainInfo>;
  setConfig(opts: BrainSetConfigOptions): Promise<BrainInfo>;
  importFromGithub(opts: BrainImportFromGithubOptions): Promise<BrainInfo>;
};
