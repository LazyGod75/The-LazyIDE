/* ShortcutsPanel.tsx — the canvas's keyboard-shortcuts overlay (W2b, spec
   §5). Opened via the `?` shortcut (wired in useCanvasKeyboard.ts) and the
   toolbar's keyboard icon-button. `SHORTCUT_GROUPS` is exported as plain
   data specifically so it can be diffed against `useCanvasKeyboard.ts`'s
   real keydown map in a test (task's own instruction: "content must match
   reality — read the keydown map you refactored and list exactly those") —
   every entry here corresponds to an actual branch in that hook, nothing
   aspirational or planned-but-not-shipped.
*/

import { useEffect, useRef } from 'react';
import { Panel } from '@xyflow/react';
import { useI18n } from '../../../i18n';

export interface ShortcutEntry {
  /** Literal key-combo label (e.g. 'O', 'Tab', 'Ctrl+C') — same across every
   *  locale, rendered verbatim. Use `keysKey` instead when the label itself
   *  is a word that needs translating (e.g. "Molette"/"Wheel"). */
  keys: string;
  /** i18n key for a key-combo label that isn't locale-neutral (mouse/
   *  trackpad gesture names, "Maj"/"Suppr"/"Échap" — French words baked
   *  into `keys` until this 2026-08 i18n pass). When set, this takes
   *  precedence over `keys` at render time. */
  keysKey?: string;
  descriptionKey: string;
}

export interface ShortcutGroup {
  titleKey: string;
  entries: ShortcutEntry[];
}

/**
 * R11 — the navigation group's first few rows describe whichever wheel
 * scheme is ACTUALLY active (CanvasPrefs.wheelMode, CanvasView.tsx's own
 * `<ReactFlow>` prop swap) rather than a single hardcoded scheme, so the
 * panel never lies about what the wheel currently does. `'zoom'` (the R11
 * default — David's own explicit expectation) reads "wheel zooms"; `'scroll'`
 * (the opt-in toggle, R1b's earlier trackpad-first scheme) reads "wheel
 * pans, ctrl+wheel/pinch zooms" — both variants share every entry AFTER the
 * wheel-specific ones (left-drag pan, middle-drag pan, shift+drag select,
 * Ctrl+1/0/+/-/K), which never change regardless of wheelMode.
 *
 * fix/canvas-navigation — n8n/Flowise scheme (the regression fix): plain
 * left-click-drag now PANS (was marquee-select-only, the dead-pan root
 * cause — see CanvasView.tsx's own `<ReactFlow>` prop comment), and marquee
 * selection moved to Shift+drag (RF's own `selectionKeyCode` default). The
 * old undiscoverable "hold Space to pan" escape hatch is gone — drag pans
 * without any modifier now, so it's no longer needed.
 */
function buildNavigationEntries(wheelMode: 'zoom' | 'scroll'): ShortcutEntry[] {
  const wheelEntries: ShortcutEntry[] =
    wheelMode === 'zoom'
      ? [
          { keys: '', keysKey: 'canvas.shortcuts.keys.wheel', descriptionKey: 'canvas.shortcuts.wheelZoom' },
          { keys: '', keysKey: 'canvas.shortcuts.keys.pinchTrackpad', descriptionKey: 'canvas.shortcuts.zoomPinch' },
        ]
      : [
          { keys: '', keysKey: 'canvas.shortcuts.keys.twoFingerWheel', descriptionKey: 'canvas.shortcuts.panScroll' },
          { keys: '', keysKey: 'canvas.shortcuts.keys.ctrlWheelPinch', descriptionKey: 'canvas.shortcuts.zoomPinch' },
        ];
  return [
    ...wheelEntries,
    { keys: '', keysKey: 'canvas.shortcuts.keys.leftDrag', descriptionKey: 'canvas.shortcuts.leftDragPan' },
    { keys: '', keysKey: 'canvas.shortcuts.keys.middleDrag', descriptionKey: 'canvas.shortcuts.middleDragPan' },
    { keys: '', keysKey: 'canvas.shortcuts.keys.shiftLeftDrag', descriptionKey: 'canvas.shortcuts.shiftDragSelect' },
    { keys: 'Ctrl+1', descriptionKey: 'canvas.toolbar.fit' },
    { keys: 'Ctrl+0', descriptionKey: 'canvas.shortcuts.resetZoom' },
    { keys: 'Ctrl+ / Ctrl-', descriptionKey: 'canvas.shortcuts.zoomInOut' },
    { keys: '', keysKey: 'canvas.shortcuts.keys.shiftF', descriptionKey: 'canvas.toolbar.zoomToSelection' },
    { keys: 'Ctrl+K', descriptionKey: 'canvas.shortcuts.openCommandBar' },
  ];
}

/** Every group/entry here corresponds 1:1 to a real branch in
 *  `useCanvasKeyboard.ts`'s keydown handler — kept in the same order the
 *  hook checks them, grouped by the task's own taxonomy (Navigation /
 *  Édition / Sélection / Modes). i18n (W5a sweep): plain data exported for
 *  the ShortcutsPanel.test.ts diff-against-reality check (module header),
 *  so entries carry i18n KEYS (not translated text) — same key-returning
 *  convention as chainValidation.ts's `reasonKey` — resolved via `t()` at
 *  render time below.
 *
 *  R11 — `buildShortcutGroups(wheelMode)` is the real, DYNAMIC source of
 *  truth the component below renders; `SHORTCUT_GROUPS` (this constant)
 *  stays exported as `buildShortcutGroups('zoom')` — the new default —
 *  purely for backward compatibility with existing callers/tests that
 *  import the static array directly (shortcutsPanel.test.ts's own
 *  diff-against-reality check). */
export function buildShortcutGroups(wheelMode: 'zoom' | 'scroll' = 'zoom'): ShortcutGroup[] {
  return [
    {
      titleKey: 'canvas.shortcuts.group.navigation',
      entries: buildNavigationEntries(wheelMode),
    },
    ...NON_NAVIGATION_GROUPS,
  ];
}

const NON_NAVIGATION_GROUPS: ShortcutGroup[] = [
  {
    titleKey: 'canvas.shortcuts.group.inspection',
    entries: [
      { keys: 'O', descriptionKey: 'canvas.shortcuts.openSelectedMission' },
      { keys: 'L', descriptionKey: 'canvas.shortcuts.logsSelectedMission' },
      { keys: 'D', descriptionKey: 'canvas.shortcuts.diffSelectedMission' },
      { keys: 'H', descriptionKey: 'canvas.shortcuts.historySelectedMission' },
    ],
  },
  {
    titleKey: 'canvas.shortcuts.group.editing',
    entries: [
      { keys: 'Tab', descriptionKey: 'canvas.shortcuts.togglePalette' },
      { keys: 'N', descriptionKey: 'canvas.shortcuts.newNote' },
      { keys: 'Ctrl+C', descriptionKey: 'canvas.shortcuts.copySelection' },
      { keys: 'Ctrl+V', descriptionKey: 'canvas.shortcuts.pasteAtCursor' },
      { keys: 'Ctrl+D', descriptionKey: 'canvas.shortcuts.duplicateSelection' },
      { keys: '', keysKey: 'canvas.shortcuts.keys.deleteBackspace', descriptionKey: 'canvas.shortcuts.deleteSelection' },
      { keys: 'Ctrl+L', descriptionKey: 'canvas.shortcuts.autoLayout' },
    ],
  },
  {
    titleKey: 'canvas.shortcuts.group.selection',
    entries: [{ keys: '', keysKey: 'canvas.shortcuts.keys.escape', descriptionKey: 'canvas.shortcuts.escapeAction' }],
  },
  {
    titleKey: 'canvas.shortcuts.group.modes',
    entries: [
      { keys: 'Ctrl+Z', descriptionKey: 'canvas.toolbar.undo' },
      { keys: '', keysKey: 'canvas.shortcuts.keys.ctrlShiftZCtrlY', descriptionKey: 'canvas.toolbar.redo' },
      { keys: '?', descriptionKey: 'canvas.shortcuts.showPanel' },
    ],
  },
];

export const SHORTCUT_GROUPS: ShortcutGroup[] = buildShortcutGroups('zoom');

export interface ShortcutsPanelProps {
  open: boolean;
  onClose: () => void;
  /** R11 — which wheel scheme's shortcuts to describe (CanvasPrefs.wheelMode,
   *  CanvasView.tsx's own prop swap). Defaults to `'zoom'` (the new default
   *  scheme) so every pre-existing caller/test that doesn't pass this yet
   *  keeps rendering the same content it always has. */
  wheelMode?: 'zoom' | 'scroll';
}

export function ShortcutsPanel({ open, onClose, wheelMode = 'zoom' }: ShortcutsPanelProps) {
  const { t } = useI18n();
  const groups = buildShortcutGroups(wheelMode);

  // Escape closes the panel (a11y sweep, W5a) — same "own window listener,
  // active only while open" shape as CanvasContextMenu.tsx's identical
  // pattern.
  //
  // `onClose` stabilized via ref (2026-08-15, same fix as
  // useDismissable.ts's own doc comment describes in full): it's a fresh
  // lambda from the caller on every render, and putting it directly in
  // this effect's deps meant the `window` listener was torn down and
  // reinstalled on every unrelated re-render while the panel stayed open,
  // not just on open/close — risking a real Escape landing in the gap and
  // being silently dropped. The effect below now depends only on `open`.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    function handleKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') onCloseRef.current();
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open]);

  if (!open) return null;

  return (
    <Panel position="bottom-right">
      <div
        data-testid="canvas-shortcuts-panel"
        role="dialog"
        aria-label={t('canvas.shortcuts.title')}
        style={{
          width: 300,
          maxHeight: 420,
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          padding: '12px 14px',
          borderRadius: 10,
          background: 'var(--color-panel-2)',
          border: '1px solid rgba(255,255,255,0.14)',
          boxShadow: '2px 2px 0 rgba(0,0,0,0.35)',
          fontFamily: 'var(--font-ui)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--color-text)' }}>
            {t('canvas.shortcuts.title')}
          </span>
          <button
            type="button"
            data-testid="canvas-shortcuts-close"
            onClick={onClose}
            aria-label={t('canvas.shortcuts.close')}
            style={{
              width: 20,
              height: 20,
              borderRadius: 5,
              border: 'none',
              background: 'transparent',
              color: 'var(--color-text-disabled)',
              cursor: 'pointer',
              fontSize: 13,
            }}
          >
            ×
          </button>
        </div>

        {groups.map((group) => (
          <div key={group.titleKey} data-testid={`canvas-shortcuts-group-${group.titleKey}`}>
            <div
              style={{
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: 0.6,
                textTransform: 'uppercase',
                color: 'var(--color-text-disabled)',
                marginBottom: 4,
              }}
            >
              {t(group.titleKey)}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              {group.entries.map((entry) => (
                <div key={entry.keysKey ?? entry.keys} style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  <span
                    style={{
                      flexShrink: 0,
                      minWidth: 96,
                      fontFamily: 'var(--font-mono)',
                      fontSize: 10.5,
                      fontWeight: 700,
                      color: 'var(--color-accent)',
                    }}
                  >
                    {entry.keysKey ? t(entry.keysKey) : entry.keys}
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>{t(entry.descriptionKey)}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}

/** Inline SVG keyboard glyph for the toolbar's icon-button — never an emoji
 *  icon prop (design-system convention, see chrome/nodeChrome.tsx's
 *  TypeGlyph header). */
export function ShortcutsIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.5" y="4" width="13" height="8.5" rx="1.6" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M4 6.6h.01M6.4 6.6h.01M8.8 6.6h.01M11.2 6.6h.01M4 9h.01M6.4 9h5.2M11.2 9h.01"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
