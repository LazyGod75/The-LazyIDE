/* paletteItems.ts — static command definitions and file-tree helpers.
   Separated from the main component to keep file sizes manageable.
*/

import type { SpaceId } from '../../app/AppContext';
import { basename, stripVerbatimPrefix } from '../../lib/paths';
import { findOwningProject, type ProjectLike } from '../../lib/agents/projectForPath';
import { relativeToRoot } from '../editor/codespace/fileTree';
import {
  HomeIcon, CodeIcon, BotIcon, BrainIcon, TerminalIcon, CpuIcon, SettingsIcon,
  type IconComponent,
} from '../icons';

// ── Item kinds ────────────────────────────────────────────────────

export type PaletteItemKind = 'file' | 'command' | 'brain' | 'agent';

export interface PaletteItem {
  id: string;
  kind: PaletteItemKind;
  label: string;
  hint?: string;        // small grey text on the right
  shortcut?: string;    // keyboard hint chip
  // Row icon: either a single typographic glyph (project convention — no
  // emoji, see CommandPalette's no-emoji rule) or one of the drawn icon
  // components from icons.tsx, reused here instead of a second icon set.
  icon: string | IconComponent;
  // Full absolute path (verbatim-prefix stripped), file rows only — kept
  // discoverable as a tooltip/title even though `hint` below now renders a
  // clean project-relative path instead of the full one (see buildFileItems).
  title?: string;
  // Action payload
  action: PaletteAction;
}

export type PaletteAction =
  | { type: 'openFile'; path: string; filename: string; content: string }
  // QA fix (B5): optional `tab` deep-links into a Settings sub-tab (e.g.
  // 'account' for Compte) — see the nav:navigateSpace bus event contract.
  | { type: 'switchSpace'; space: SpaceId; tab?: string }
  | { type: 'brainQuery'; query: string }
  | { type: 'brainNode'; nodeId: string; nodeName: string }
  | { type: 'agentLaunch'; query: string }
  | { type: 'openFolder' }
  // QA fix (B7): real billing actions (Stripe checkout/portal), same
  // plumbing AccountChip's popover uses — see paletteBilling.ts.
  // 'topup'/'upgradeProPlus' open the account popover (nav:openAccountPopover)
  // rather than firing a checkout directly — both now need an in-popover
  // amount picker / two-step confirm, so the palette just surfaces them.
  | { type: 'billing'; billingAction: 'upgradePro' | 'topup' | 'manage' | 'upgradeProPlus' }
  // B23: dispatched via the editor:* bus events CenterEditor.tsx already
  // owns (see bus.ts's comment on those events) — real fs/rename/spawn
  // actions, never a placeholder.
  | { type: 'newFile' }
  | { type: 'renameActiveFile' }
  | { type: 'formatDocument' }
  | { type: 'placeholder'; label: string };

// ── Section labels ────────────────────────────────────────────────

export type SectionId = 'files' | 'commands' | 'brain' | 'agents';

export interface Section {
  id: SectionId;
  label: string;
}

// i18n note: SECTIONS/COMMAND_ITEMS used to be plain module-level constants
// with hardcoded French labels — this file had no i18n wiring at all. They
// are now builder functions taking the `t` function from useI18n(), same
// convention as buildBillingCommandItems (paletteBilling.ts).
export function buildSections(t: (key: string, params?: Record<string, string | number>) => string): Section[] {
  return [
    { id: 'files',    label: t('palette.section.files') },
    { id: 'commands', label: t('palette.section.commands') },
    { id: 'brain',    label: t('palette.section.brain') },
    { id: 'agents',   label: t('palette.section.agents') },
  ];
}

// ── Static command items ──────────────────────────────────────────

// QA fix (2026-08-15): every row here used to carry a `hint` that was just
// the row's own category, one word ("space"/"espace", "project"/"projet"…)
// — pure noise duplicating the kind badge PaletteRow already renders on the
// right (KIND_LABELS), and since it rendered directly under the label with
// no framing, it read like a broken string interpolation ("Aller à :
// Agents espace" — see palette QA report). Dropped rather than reworded:
// the badge alone already tells the user "this is a command". Same fix
// applied to the always-present brain-query/agent-launch rows in
// CommandPalette.tsx's buildAllItems, whose hardcoded (non-localized)
// 'Brain'/'Agent' hints were the exact same duplicate-of-the-badge shape.
export function buildCommandItems(t: (key: string, params?: Record<string, string | number>) => string): PaletteItem[] {
  return [
    // Navigation commands — icons reuse the drawn components from
    // icons.tsx (project convention: no emoji, no second icon set) instead
    // of the mixed emoji/ASCII glyphs this row set used to render.
    { id: 'cmd-home',      kind: 'command', label: t('palette.command.goToHome'),      icon: HomeIcon,     action: { type: 'switchSpace', space: 'home' } },
    { id: 'cmd-code',      kind: 'command', label: t('palette.command.goToCode'),      icon: CodeIcon,     action: { type: 'switchSpace', space: 'code' } },
    { id: 'cmd-agents',    kind: 'command', label: t('palette.command.goToAgents'),    icon: BotIcon,      action: { type: 'switchSpace', space: 'agents' } },
    { id: 'cmd-brain',     kind: 'command', label: t('palette.command.goToBrain'),     icon: BrainIcon,    action: { type: 'switchSpace', space: 'brain' } },
    { id: 'cmd-terminals', kind: 'command', label: t('palette.command.goToTerminals'), icon: TerminalIcon, action: { type: 'switchSpace', space: 'terminals' } },
    { id: 'cmd-models',    kind: 'command', label: t('palette.command.goToModels'),    icon: CpuIcon,      action: { type: 'switchSpace', space: 'models' } },
    // QA fix (B5): lands on the Compte tab (deep-link via the `tab` param) —
    // that's the sub-page most "Réglages" palette searches were actually
    // after (billing/account), same destination as AccountPopover's
    // "Créer une équipe" entry.
    { id: 'cmd-settings',  kind: 'command', label: t('palette.command.goToSettings'),  icon: SettingsIcon, action: { type: 'switchSpace', space: 'settings', tab: 'account' } },
    // Action commands. No FolderIcon exists in icons.tsx for "open folder" —
    // rather than inventing a new icon, it falls back to a typographic
    // glyph matching the style of its '+' / '✎' / '≡' neighbours below.
    { id: 'cmd-open-folder',  kind: 'command', label: t('palette.command.openFolder'),  icon: '▢', action: { type: 'openFolder' } },
    { id: 'cmd-new-mission', kind: 'command', label: t('palette.command.newMission'),   icon: '+',  action: { type: 'switchSpace', space: 'agents' } },
    { id: 'cmd-new-term',    kind: 'command', label: t('palette.command.newTerminal'),  icon: '+',  action: { type: 'switchSpace', space: 'terminals' } },
    // QA fix (B4): "Basculer le thème" was a no-op placeholder (no real theme
    // system exists — B3 wired a single accent-color picker, not a full
    // theme). Removed rather than left as dead UI.
    // B23: real actions, not placeholders: dispatched via bus events
    // CenterEditor.tsx handles against the real FileSystem.
    { id: 'cmd-new-file',    kind: 'command', label: t('palette.command.newFile'),         icon: '+',  action: { type: 'newFile' } },
    { id: 'cmd-rename-file', kind: 'command', label: t('palette.command.renameFile'),      icon: '✎',  action: { type: 'renameActiveFile' } },
    { id: 'cmd-format-doc',  kind: 'command', label: t('palette.command.formatDocument'),  icon: '≡',  action: { type: 'formatDocument' } },
  ];
}

// ── File items builder ────────────────────────────────────────────

export interface FileEntry {
  path: string;
  filename: string;
  content: string;
}

/**
 * Builds file rows with a clean, project-relative `hint` instead of the
 * full absolute path — same treatment BreadcrumbBar.tsx's breadcrumbSegments
 * applies to the editor breadcrumb (commit 39dba51): when `f.path` is owned
 * by one of `openProjects` (findOwningProject, projectForPath.ts), the hint
 * is "<project name>/<path relative to project root>" (relativeToRoot,
 * fileTree.ts); otherwise it degrades gracefully to the verbatim-prefix-
 * stripped absolute path rather than leaking the raw `\\?\` form. The full
 * absolute path stays discoverable via `title` (rendered as the row's
 * tooltip by PaletteRow) regardless of which branch is taken.
 */
export function buildFileItems(files: FileEntry[], openProjects: readonly ProjectLike[]): PaletteItem[] {
  return files.map(f => {
    const fullPath = stripVerbatimPrefix(f.path);
    const owner = findOwningProject(f.path, openProjects);
    const hint = owner
      ? `${basename(owner.root)}/${relativeToRoot(owner.root, f.path)}`
      : fullPath;
    return {
      id: `file:${f.path}`,
      kind: 'file' as PaletteItemKind,
      label: f.filename,
      hint,
      title: fullPath,
      icon: getFileIcon(f.filename),
      action: { type: 'openFile' as const, path: f.path, filename: f.filename, content: f.content },
    };
  });
}

function getFileIcon(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const icons: Record<string, string> = {
    ts: '⬡', tsx: '⬡', js: '⬡', jsx: '⬡',
    md: '≡', json: '{}', css: '◈', rs: '⚙', py: '⬡',
  };
  return icons[ext] ?? '◻';
}
