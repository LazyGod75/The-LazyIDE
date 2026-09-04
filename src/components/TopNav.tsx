/* TopNav — shared 64px header for the redesigned shell (D2).

   Replaces the left SpacesRail as the app's primary navigation: logo +
   wordmark ("Lazy / <Space>"), segmented pill nav (Cockpit/Code/Brain/Team
   + a settings gear), the Cmd-K command-bar pill (opens CommandPalette),
   the credits badge (AccountChip, restyled chrome only — same real
   billing data/popover), and the violet "+ Lancer un agent" CTA (opens
   the new-mission flow via the same signal the command palette's
   "Nouvelle mission" entry already uses — see CommandPalette.tsx's
   runItem: setActiveSpace('agents') + requestNewMission()).

   This is the ONE header shared by every redesigned screen (Cockpit, Code,
   Team) — later waves must not fork it per-space.
*/

import type { SpaceId } from '../app/AppContext';
import { usePaletteContext } from './palette/PaletteContext';
import { useAgentsUiContext } from './agents/agentsUiContext';
import { useI18n } from '../i18n';
import { useUpdateStore } from '../lib/updateStore';
import { emit } from '../lib/bus';
import { AccountChip } from './AccountChip';

const isMacPlatform = typeof navigator !== 'undefined' && navigator.platform.toUpperCase().includes('MAC');

// Fixed brand violet — independent of the user's chosen theme accent (see
// SettingsSpace.tsx's AppearanceTab ACCENT_PRESETS/setAccent, which can
// repoint var(--color-accent) elsewhere). Same convention SpacesRail.tsx's
// own mission-count badge already follows for this exact reason. Ported
// from SpacesRail.tsx:160-181 (that component is no longer mounted, kept
// unmodified — see AUTOUPDATE-SPEC.md B.4), reduced to a plain dot (no
// count) per the update-available indicator's own spec.
const UPDATE_DOT_COLOR = '#7C5CFF';
const UPDATE_DOT_SIZE = 7;

interface NavPillItem {
  id: SpaceId;
  labelKey: string;
}

// Team pill is live — the Team space ships role-derived Solo/Lead/Member
// views plus GitHub-backed brain + canvas sharing (see AppShell.tsx).
const NAV_PILL_ITEMS: NavPillItem[] = [
  { id: 'agents', labelKey: 'nav.cockpit' },
  { id: 'code', labelKey: 'nav.code' },
  { id: 'brain', labelKey: 'nav.brain' },
  { id: 'team', labelKey: 'nav.team' },
];

// The wordmark's " / <Space>" suffix and the segmented pill labels share
// the same nav.* keys. Every SpaceId is covered (not just the ones with a
// visible pill) so navigating via the palette/shortcuts to a space with no
// header pill (terminals, review, home, models, account) never leaves the
// wordmark suffix blank.
const WORDMARK_LABEL_KEYS: Record<SpaceId, string> = {
  home: 'nav.home',
  code: 'nav.code',
  agents: 'nav.cockpit',
  brain: 'nav.brain',
  review: 'nav.review',
  terminals: 'nav.terminals',
  models: 'nav.models',
  settings: 'nav.settings',
  account: 'nav.settings',
  team: 'nav.team',
  bots: 'nav.bots',
};

const SETTINGS_GROUP: readonly SpaceId[] = ['settings', 'account', 'models'];

interface TopNavProps {
  activeSpace: SpaceId;
  onSpaceChange: (space: SpaceId) => void;
}

function Logo() {
  return (
    <div
      style={{
        width: 34,
        height: 34,
        borderRadius: 10,
        background: 'var(--color-accent)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      <span style={{ fontWeight: 700, fontSize: 17, color: '#fff', fontFamily: 'var(--font-ui)' }}>L</span>
    </div>
  );
}

interface NavPillProps {
  label: string;
  isActive: boolean;
  onClick: () => void;
  title?: string;
  ariaLabel?: string;
  showUpdateDot?: boolean;
  testId?: string;
}

function NavPill({ label, isActive, onClick, title, ariaLabel, showUpdateDot, testId }: NavPillProps) {
  return (
    <button
      data-testid={testId}
      onClick={onClick}
      title={title}
      aria-label={ariaLabel}
      aria-current={isActive ? 'page' : undefined}
      style={{
        background: isActive ? 'var(--color-accent)' : 'transparent',
        color: isActive ? '#fff' : 'rgba(255,255,255,0.6)',
        fontWeight: isActive ? 600 : 500,
        fontSize: 14,
        padding: '5px 14px',
        borderRadius: 8,
        border: 'none',
        cursor: 'pointer',
        fontFamily: 'inherit',
        opacity: isActive ? 1 : 0.85,
        transition: 'background 0.15s, color 0.15s, opacity 0.15s',
        whiteSpace: 'nowrap',
      }}
      onMouseEnter={(e) => {
        if (isActive) return;
        const el = e.currentTarget as HTMLButtonElement;
        el.style.opacity = '1';
        el.style.background = 'rgba(255,255,255,0.06)';
      }}
      onMouseLeave={(e) => {
        if (isActive) return;
        const el = e.currentTarget as HTMLButtonElement;
        el.style.opacity = '0.85';
        el.style.background = 'transparent';
      }}
    >
      {showUpdateDot ? (
        <span style={{ position: 'relative', display: 'inline-flex' }}>
          {label}
          <span
            aria-hidden="true"
            data-testid="settings-update-dot"
            style={{
              position: 'absolute',
              top: -3,
              right: -7,
              width: UPDATE_DOT_SIZE,
              height: UPDATE_DOT_SIZE,
              borderRadius: '50%',
              background: UPDATE_DOT_COLOR,
            }}
          />
        </span>
      ) : (
        label
      )}
    </button>
  );
}

export function TopNav({ activeSpace, onSpaceChange }: TopNavProps) {
  const { t } = useI18n();
  const { openPalette } = usePaletteContext();
  const { requestNewMission } = useAgentsUiContext();
  const { phase: updatePhase } = useUpdateStore();

  const wordmarkSuffix = t(WORDMARK_LABEL_KEYS[activeSpace]);
  const hasUpdateDot = updatePhase === 'available' || updatePhase === 'staged';

  function handleLaunchAgent() {
    // Same wiring as the command palette's "Nouvelle mission" entry
    // (CommandPalette.tsx's runItem, cmd-new-mission): switch to the
    // Cockpit and request the new-mission modal via agentsUiContext, which
    // AgentsSpace's own effect picks up and opens for real.
    onSpaceChange('agents');
    requestNewMission();
  }

  return (
    <header
      style={{
        height: 64,
        background: 'var(--color-panel)',
        borderBottom: '1px solid var(--color-border)',
        display: 'flex',
        alignItems: 'center',
        gap: 20,
        padding: '0 28px',
        flexShrink: 0,
        fontFamily: 'var(--font-ui)',
      }}
    >
      {/* Logo + wordmark */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 11, flexShrink: 0 }}>
        <Logo />
        <span style={{ fontWeight: 700, fontSize: 18, color: 'var(--color-text)', whiteSpace: 'nowrap' }}>
          Lazy
          <span style={{ fontWeight: 400, opacity: 0.5 }}> / {wordmarkSuffix}</span>
        </span>
      </div>

      {/* Segmented nav */}
      <nav
        aria-label={t('nav.spaces')}
        style={{
          display: 'flex',
          gap: 4,
          background: 'rgba(255,255,255,0.05)',
          borderRadius: 10,
          padding: 4,
          flexShrink: 0,
        }}
      >
        {NAV_PILL_ITEMS.map((item) => (
          <NavPill
            key={item.id}
            testId={`nav-pill-${item.id}`}
            label={t(item.labelKey)}
            isActive={activeSpace === item.id}
            onClick={() => {
              // "Take me home" fix (severe usability trap, real user
              // report 2026-08-14): re-clicking the Cockpit pill WHILE
              // already on it used to be a pure no-op (onSpaceChange to the
              // space it's already on does nothing) — including the state
              // where Command mode had swallowed its own mode toggle
              // entirely (see CockpitLeftRail.tsx's new always-present rail
              // toggle for the structural fix). Only fires on a genuine
              // re-click of the CURRENTLY active Cockpit pill, never on
              // first navigation INTO the cockpit — arriving from another
              // space must never silently discard whatever mode the user
              // was already in.
              if (item.id === 'agents' && activeSpace === 'agents') {
                emit('cockpit:resetMode', undefined);
              }
              onSpaceChange(item.id);
            }}
          />
        ))}
        {/* Accessibility fix (real user report, 2026-08-14): this pill's only
            visible content is the gear glyph "⚙" — with no aria-label it
            was announced verbatim as that single character, not as
            "Réglages"/"Settings". `title` alone never fixes this: the
            accname computation only falls back to `title` when there is NO
            text content at all, and "⚙" IS text content, so `title` was
            being silently ignored by assistive tech the whole time. A real
            aria-label is now ALWAYS set — the update-available variant
            (settings.update.navBadgeAriaLabel) still takes priority over
            the plain one when a dot is showing, same precedence as before,
            just no longer leaving the no-dot case with nothing. */}
        <NavPill
          testId="nav-pill-settings"
          label="⚙"
          title={t('nav.settings')}
          ariaLabel={hasUpdateDot ? t('settings.update.navBadgeAriaLabel') : t('nav.settings')}
          isActive={SETTINGS_GROUP.includes(activeSpace)}
          onClick={() => onSpaceChange('settings')}
          showUpdateDot={hasUpdateDot}
        />
      </nav>

      {/* Command bar — opens the CommandPalette */}
      <div
        role="button"
        tabIndex={0}
        aria-label={t('omnibar.openPalette')}
        onClick={openPalette}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openPalette();
          }
        }}
        style={{
          flex: 1,
          maxWidth: 420,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          background: 'rgba(255,255,255,0.05)',
          border: '1px solid rgba(255,255,255,0.07)',
          borderRadius: 10,
          padding: '7px 14px',
          cursor: 'pointer',
          minWidth: 0,
          transition: 'border-color 0.15s, background 0.15s',
        }}
        onMouseEnter={(e) => {
          const el = e.currentTarget as HTMLDivElement;
          el.style.borderColor = 'rgba(124,92,255,0.35)';
          el.style.background = 'rgba(255,255,255,0.07)';
        }}
        onMouseLeave={(e) => {
          const el = e.currentTarget as HTMLDivElement;
          el.style.borderColor = 'rgba(255,255,255,0.07)';
          el.style.background = 'rgba(255,255,255,0.05)';
        }}
      >
        <span
          style={{
            fontSize: 13.5,
            color: 'var(--color-text-disabled)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {isMacPlatform ? '⌘K' : 'Ctrl+K'} — {t('nav.commandBar')}
        </span>
      </div>

      {/* Right group: credits badge + launch CTA */}
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
        <AccountChip />
        <button
          data-primary="true"
          onClick={handleLaunchAgent}
          style={{
            padding: '7px 16px',
            borderRadius: 10,
            background: 'var(--color-accent)',
            color: '#fff',
            fontSize: 14.5,
            fontWeight: 700,
            border: 'none',
            cursor: 'pointer',
            fontFamily: 'inherit',
            whiteSpace: 'nowrap',
            transition: 'background 0.15s',
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background = 'var(--color-accent-hover)';
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background = 'var(--color-accent)';
          }}
        >
          {t('nav.launchAgent')}
        </button>
      </div>
    </header>
  );
}
