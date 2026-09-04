/* SpacesRail — far-left navigation (72px wide).
   Logo, nav items, bottom items (Models, Settings, Avatar).
   Active item gets violet indicator bar + bg tint.
*/

import { useState, useRef, useEffect, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { SpaceId } from '../app/AppContext';
import { useAppContext } from '../app/AppContext';
import type { ProjectEntry } from '../app/AppContext';
import { projectIdFromRoot } from '../lib/journal/projectId';
import { subscribeJournalMissions } from '../lib/agents/journalMissionsFeed';
import { basename, stripVerbatimPrefix } from '../lib/paths';
import { useI18n } from '../i18n';
import { emit } from '../lib/bus';
import { useAuth } from '../lib/auth';
import { useToast, useToastSafe } from './ui';
import { openExternal } from '../lib/platform/openExternal';
import { useDismissable } from './common/useDismissable';
import { HomeIcon, CodeIcon, BotIcon, BrainIcon, GitBranchIcon, TerminalIcon, CpuIcon, SettingsIcon, SparklesIcon, UsersIcon, type IconComponent } from './icons';

// ── Types ─────────────────────────────────────────────────────────

interface NavItem {
  id: SpaceId;
  icon: IconComponent;
  label: string;
  /** Overrides `label` as the button's accessible name when set. Currently
   *  only the 'agents' item needs this — see NAV_ITEM_KEYS' ariaLabelKey
   *  comment for why. */
  ariaLabel?: string;
  badge?: number;
}

interface SpacesRailProps {
  activeSpace: SpaceId;
  agentCount: number;
  onSpaceChange: (space: SpaceId) => void;
  /** Show the Team nav item only when the user has an active team subscription. */
  showTeamTab: boolean;
}

// ── Constants ─────────────────────────────────────────────────────

interface NavItemKey {
  id: SpaceId;
  icon: IconComponent;
  labelKey: string;
  ariaLabelKey?: string;
}

/** ariaLabelKey is only set for 'agents': its visible label ("Agents")
 *  collides with the Agents space's own "Roster" subheader tab
 *  (key agents.subheader.view.roster) once both are translated — in every
 *  locale but en, that tab's label is just the localized word for "Agents"
 *  again, so a screen reader sees two different controls both named
 *  "Agents". nav.agents.ariaLabel gives THIS rail item a distinct
 *  accessible name (visible text is untouched) so the two no longer
 *  collide, without touching the subheader tab's own component. */
const NAV_ITEM_KEYS: NavItemKey[] = [
  { id: 'home',      icon: HomeIcon,      labelKey: 'nav.home' },
  { id: 'code',      icon: CodeIcon,      labelKey: 'nav.code' },
  { id: 'agents',    icon: BotIcon,       labelKey: 'nav.agents', ariaLabelKey: 'nav.agents.ariaLabel' },
  { id: 'brain',     icon: BrainIcon,     labelKey: 'nav.brain' },
  { id: 'review',    icon: GitBranchIcon, labelKey: 'nav.review' },
  { id: 'terminals', icon: TerminalIcon,  labelKey: 'nav.terminals' },
];

const TEAM_NAV_ITEM: NavItemKey = {
  id: 'team',
  icon: UsersIcon,
  labelKey: 'nav.team',
};

// ── Sub-components ────────────────────────────────────────────────

function Logo() {
  return (
    <div
      style={{
        width: 40,
        height: 40,
        background: 'linear-gradient(135deg, #7C5CFF, #9D7FFF)',
        borderRadius: 10,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 18,
        marginBottom: 20,
        boxShadow: '0 4px 16px rgba(124,92,255,0.35)',
        flexShrink: 0,
      }}
    >
      <SparklesIcon size={18} color="#fff" />
    </div>
  );
}

function NavItemButton({
  item,
  isActive,
  badge,
  onClick,
}: {
  item: NavItem;
  isActive: boolean;
  badge?: number;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={item.ariaLabel ?? item.label}
      aria-current={isActive ? 'page' : undefined}
      data-tooltip={item.label}
      style={{
        width: '100%',
        background: isActive ? 'rgba(124,92,255,0.12)' : 'transparent',
        border: 'none',
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: '10px 0',
        gap: 3,
        position: 'relative',
        color: isActive ? '#A78BFF' : 'rgba(255,255,255,0.35)',
        transition: 'color 0.15s, background 0.15s',
        borderRadius: 4,
      }}
      onMouseEnter={e => {
        if (!isActive) {
          (e.currentTarget as HTMLButtonElement).style.color = 'rgba(255,255,255,0.6)';
          (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.04)';
        }
      }}
      onMouseLeave={e => {
        if (!isActive) {
          (e.currentTarget as HTMLButtonElement).style.color = 'rgba(255,255,255,0.35)';
          (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
        }
      }}
    >
      {/* Active indicator bar */}
      {isActive && (
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: '50%',
            transform: 'translateY(-50%)',
            width: 3,
            height: 28,
            background: '#7C5CFF',
            borderRadius: '0 3px 3px 0',
          }}
        />
      )}

      {/* Icon with optional badge */}
      <div style={{ position: 'relative', display: 'inline-flex' }}>
        <item.icon size={16} />
        {badge !== undefined && badge > 0 && (
          <span
            style={{
              position: 'absolute',
              top: -5,
              right: -8,
              background: '#7C5CFF',
              color: '#fff',
              fontSize: 8,
              fontWeight: 700,
              borderRadius: 8,
              padding: '1px 4px',
              lineHeight: 1.4,
            }}
          >
            {badge}
          </span>
        )}
      </div>

      {/* Label */}
      <span
        style={{
          fontSize: 9,
          letterSpacing: '0.04em',
          fontWeight: isActive ? 600 : 500,
          textTransform: 'uppercase',
          fontFamily: 'inherit',
        }}
      >
        {item.label}
      </span>
    </button>
  );
}

function BottomItem({ icon: Icon, label, isActive, onClick }: { icon: IconComponent; label: string; isActive?: boolean; onClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        width: '100%',
        background: isActive ? 'rgba(124,92,255,0.12)' : 'transparent',
        border: 'none',
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: '8px 0',
        gap: 3,
        color: isActive ? '#A78BFF' : 'rgba(255,255,255,0.25)',
        position: 'relative',
      }}
    >
      {isActive && (
        <div style={{
          position: 'absolute', left: 0, top: '50%', transform: 'translateY(-50%)',
          width: 3, height: 22, background: '#7C5CFF', borderRadius: '0 3px 3px 0',
        }} />
      )}
      <Icon size={15} />
      <span style={{ fontSize: 9, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
        {label}
      </span>
    </button>
  );
}

// ── PROJECTS section (T0.9) ──────────────────────────────────────

/** Small inline "+" glyph — kept local (not added to ./icons, out of scope
 *  for this task) but mirrors icons.tsx's own SVG conventions (24x24
 *  viewBox, currentColor stroke, round caps/joins) for visual consistency. */
function PlusIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

/**
 * Reads the shared `journal_missions_current` feed (journalMissionsFeed.ts
 * — was its own independent 5s poller directly invoking the command; see
 * that module's header for why) and returns a map of journal `project_id`
 * -> count of missions currently `'running'`, for the PROJECTS section's
 * status dots. Disabled (returns an empty map, never subscribes) outside
 * Tauri.
 */
function useRunningMissionCounts(enabled: boolean): Record<string, number> {
  const [counts, setCounts] = useState<Record<string, number>>({});

  useEffect(() => {
    if (!enabled) return;
    return subscribeJournalMissions((rows) => {
      const next: Record<string, number> = {};
      for (const row of rows) {
        if (row.status !== 'running') continue;
        next[row.project_id] = (next[row.project_id] ?? 0) + 1;
      }
      setCounts(next);
    });
  }, [enabled]);

  return counts;
}

export function ProjectItemButton({
  project,
  isActive,
  hasRunning,
  onClick,
}: {
  project: ProjectEntry;
  isActive: boolean;
  hasRunning: boolean;
  onClick: () => void;
}) {
  const label = basename(project.root);
  return (
    <button
      onClick={onClick}
      aria-label={label}
      aria-current={isActive ? 'page' : undefined}
      // Display only — strip the Windows \\?\ verbatim prefix so the
      // tooltip shows a normal path; the stored project.root value (used
      // for onClick/routing elsewhere) is never touched. See paths.ts's
      // module header for why worktree/project roots arrive verbatim-
      // prefixed on Windows.
      data-tooltip={stripVerbatimPrefix(project.root)}
      style={{
        width: '100%',
        background: isActive ? 'rgba(124,92,255,0.12)' : 'transparent',
        border: 'none',
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: '6px 4px',
        gap: 3,
        position: 'relative',
        color: isActive ? '#A78BFF' : 'rgba(255,255,255,0.4)',
        borderRadius: 4,
      }}
      onMouseEnter={e => {
        if (!isActive) (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.04)';
      }}
      onMouseLeave={e => {
        if (!isActive) (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
      }}
    >
      {isActive && (
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: '50%',
            transform: 'translateY(-50%)',
            width: 3,
            height: 22,
            background: '#7C5CFF',
            borderRadius: '0 3px 3px 0',
          }}
        />
      )}

      <div
        style={{
          position: 'relative',
          display: 'inline-flex',
          width: 22,
          height: 22,
          borderRadius: 6,
          alignItems: 'center',
          justifyContent: 'center',
          background: isActive ? 'rgba(124,92,255,0.25)' : 'rgba(255,255,255,0.08)',
          fontSize: 11,
          fontWeight: 700,
        }}
      >
        {label.slice(0, 1).toUpperCase() || '?'}
        {hasRunning && (
          <span
            style={{
              position: 'absolute',
              top: -2,
              right: -2,
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: '#34D399',
              border: '1.5px solid var(--color-panel)',
            }}
          />
        )}
      </div>

      <span
        style={{
          fontSize: 8,
          letterSpacing: '0.02em',
          fontWeight: isActive ? 600 : 500,
          maxWidth: 64,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </span>
    </button>
  );
}

function ProjectsSection({ label, addLabel }: { label: string; addLabel: string }) {
  const { t } = useI18n();
  const { platform, openProjects, activeProjectId, switchProject, openProject } = useAppContext();
  const runningCounts = useRunningMissionCounts(platform.name === 'tauri');
  const toast = useToastSafe();

  function handleAdd() {
    openProject().catch((error: unknown) => {
      console.error('ProjectsSection: openProject failed', error);
    });
  }

  /** err-1 fix (silent-failure audit): a failed switch used to leave NO
   *  trace — no log, no visual feedback, nothing. The target project is by
   *  construction already open (this handler only fires for entries already
   *  in `openProjects`), so a toast telling the user the switch itself
   *  failed is always the right message here, never a "project not found"
   *  case. Nominal (successful) path is unchanged. */
  function handleSwitchFailure(project: ProjectEntry, error: unknown) {
    console.error('ProjectsSection: switchProject failed', { projectId: project.id, error });
    toast(t('rail.projects.switchFailed', { name: basename(project.root) }), 'error');
  }

  return (
    <div
      role="group"
      aria-label={label}
      style={{
        width: '100%',
        marginTop: 8,
        paddingTop: 8,
        borderTop: '1px solid rgba(255,255,255,0.07)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 2,
      }}
    >
      {openProjects.map((project) => (
        <ProjectItemButton
          key={project.id}
          project={project}
          isActive={project.id === activeProjectId}
          hasRunning={(runningCounts[projectIdFromRoot(project.root)] ?? 0) > 0}
          onClick={() => {
            if (project.id !== activeProjectId) {
              switchProject(project.id).catch((error: unknown) => handleSwitchFailure(project, error));
            }
          }}
        />
      ))}

      <button
        onClick={handleAdd}
        aria-label={addLabel}
        data-tooltip={addLabel}
        style={{
          width: 24,
          height: 24,
          marginTop: 2,
          borderRadius: 6,
          border: '1px dashed rgba(255,255,255,0.25)',
          background: 'transparent',
          color: 'rgba(255,255,255,0.4)',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
        onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(124,92,255,0.5)'; (e.currentTarget as HTMLButtonElement).style.color = '#A78BFF'; }}
        onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(255,255,255,0.25)'; (e.currentTarget as HTMLButtonElement).style.color = 'rgba(255,255,255,0.4)'; }}
      >
        <PlusIcon size={12} />
      </button>
    </div>
  );
}

const SITE_URL = 'https://gameon-industries.fr';

function AvatarPopover({
  anchorRect,
  onClose,
  userEmail,
  onSignOut,
  onSettings,
  onOpenLegal,
  triggerRef,
}: {
  anchorRect: DOMRect;
  onClose: () => void;
  userEmail: string | null;
  onSignOut: () => void;
  onSettings: () => void;
  onOpenLegal: (page: 'terms' | 'privacy' | 'legal-notice') => void;
  /** Ref to the avatar toggle button — ignored by the outside-pointerdown
   *  handler so re-clicking that same button closes this popover instead of
   *  closing-then-reopening it (this popover is portaled to
   *  `document.body`, so the naive listener sees the button as "outside").
   *  See useDismissable.ts's header comment for the exact race this
   *  prevents. */
  triggerRef?: RefObject<HTMLElement | null>;
}) {
  const { t } = useI18n();
  const ref = useDismissable<HTMLDivElement>({
    open: true,
    onClose,
    ignoreRefs: triggerRef ? [triggerRef] : undefined,
  });

  const width = 240;
  const style: React.CSSProperties = {
    position: 'fixed',
    bottom: window.innerHeight - anchorRect.top + 8,
    left: anchorRect.left,
    width,
  };

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={t('avatar.menu.ariaLabel')}
      style={{
        ...style,
        background: '#1C1C2A',
        border: '1px solid rgba(124,92,255,0.3)',
        borderRadius: 10,
        boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
        zIndex: 1000,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'inherit',
      }}
    >
      {/* User info header */}
      <div style={{ padding: '12px 14px', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'rgba(255,255,255,0.85)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {userEmail ?? t('avatar.menu.notSignedIn')}
        </div>
      </div>

      {/* Menu items */}
      <div style={{ padding: 6, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <MenuItem label={t('avatar.menu.settings')} onClick={onSettings} />
      </div>

      {/* Legal section */}
      <div style={{ borderTop: '1px solid rgba(255,255,255,0.07)', padding: 6, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <div style={{ fontSize: 10, fontWeight: 600, color: 'rgba(255,255,255,0.3)', textTransform: 'uppercase', letterSpacing: '0.05em', padding: '4px 8px 2px' }}>
          {t('avatar.menu.legal')}
        </div>
        <MenuItem label={t('avatar.menu.terms')} onClick={() => onOpenLegal('terms')} />
        <MenuItem label={t('avatar.menu.privacy')} onClick={() => onOpenLegal('privacy')} />
        <MenuItem label={t('avatar.menu.legalNotice')} onClick={() => onOpenLegal('legal-notice')} />
      </div>

      {/* Sign out */}
      <div style={{ borderTop: '1px solid rgba(255,255,255,0.07)', padding: 6 }}>
        {userEmail ? (
          <MenuItem label={t('avatar.menu.signOut')} onClick={onSignOut} danger />
        ) : (
          <MenuItem label={t('avatar.menu.signIn')} onClick={onSettings} primary />
        )}
      </div>
    </div>,
    document.body,
  );
}

function MenuItem({ icon, label, onClick, danger, primary }: {
  icon?: string;
  label: string;
  onClick: () => void;
  danger?: boolean;
  primary?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      role="menuitem"
      style={{
        background: 'none',
        border: 'none',
        color: danger ? '#F87171' : primary ? '#A78BFF' : 'rgba(255,255,255,0.6)',
        fontSize: 12,
        fontFamily: 'inherit',
        cursor: 'pointer',
        padding: '7px 8px',
        textAlign: 'left',
        borderRadius: 6,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        transition: 'background 0.15s, color 0.15s',
        width: '100%',
      }}
      onMouseEnter={e => {
        const el = e.currentTarget as HTMLButtonElement;
        el.style.background = danger ? 'rgba(248,113,113,0.1)' : primary ? 'rgba(124,92,255,0.12)' : 'rgba(255,255,255,0.06)';
        el.style.color = danger ? '#FCA5A5' : primary ? '#C4B5FD' : 'rgba(255,255,255,0.85)';
      }}
      onMouseLeave={e => {
        const el = e.currentTarget as HTMLButtonElement;
        el.style.background = 'none';
        el.style.color = danger ? '#F87171' : primary ? '#A78BFF' : 'rgba(255,255,255,0.6)';
      }}
    >
      {icon && <span style={{ fontSize: 13, flexShrink: 0, opacity: 0.7 }}>{icon}</span>}
      <span>{label}</span>
    </button>
  );
}

function Avatar() {
  const { t, locale } = useI18n();
  const { user, signOut } = useAuth();
  const { toast } = useToast();
  const ref = useRef<HTMLButtonElement>(null);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);

  function toggle() {
    if (anchorRect) {
      setAnchorRect(null);
    } else if (ref.current) {
      setAnchorRect(ref.current.getBoundingClientRect());
    }
  }

  async function handleSignOut() {
    setAnchorRect(null);
    await signOut();
    toast(t('settings.auth.signedOut'), 'info');
  }

  function goToSettings() {
    setAnchorRect(null);
    emit('nav:navigateSpace', 'settings');
  }

  function openLegal(page: 'terms' | 'privacy' | 'legal-notice') {
    setAnchorRect(null);
    // openExternal now throws on genuine failure (see openExternal.ts) instead
    // of silently no-op'ing — catch here so a rare failure doesn't surface as
    // an unhandled promise rejection for this fire-and-forget footer link.
    openExternal(`${SITE_URL}/${locale}/${page}`).catch((error: unknown) => {
      console.error('openLegal: failed to open external URL', error);
    });
  }

  const initial = user?.email?.[0]?.toUpperCase() ?? '?';

  return (
    <>
      <button
        ref={ref}
        onClick={toggle}
        aria-label={t('avatar.menu.ariaLabel')}
        aria-haspopup="menu"
        aria-expanded={!!anchorRect}
        style={{
          width: 32,
          height: 32,
          borderRadius: '50%',
          background: 'linear-gradient(135deg,#4F46E5,#7C5CFF)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 13,
          fontWeight: 700,
          color: '#fff',
          marginTop: 10,
          cursor: 'pointer',
          border: 'none',
          fontFamily: 'inherit',
          transition: 'box-shadow 0.15s',
        }}
        onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.boxShadow = '0 0 0 2px rgba(124,92,255,0.4)'; }}
        onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.boxShadow = anchorRect ? '0 0 0 2px rgba(124,92,255,0.4)' : 'none'; }}
      >
        {initial}
      </button>

      {anchorRect && (
        <AvatarPopover
          anchorRect={anchorRect}
          onClose={() => setAnchorRect(null)}
          userEmail={user?.email ?? null}
          onSignOut={handleSignOut}
          onSettings={goToSettings}
          onOpenLegal={openLegal}
          triggerRef={ref}
        />
      )}
    </>
  );
}

// ── SpacesRail ────────────────────────────────────────────────────

export function SpacesRail({ activeSpace, agentCount, onSpaceChange, showTeamTab }: SpacesRailProps) {
  const { t } = useI18n();
  const navItemKeys = showTeamTab
    ? [...NAV_ITEM_KEYS, TEAM_NAV_ITEM]
    : NAV_ITEM_KEYS;
  const navItems: NavItem[] = navItemKeys.map((item) => ({
    ...item,
    label: t(item.labelKey),
    ariaLabel: item.ariaLabelKey ? t(item.ariaLabelKey) : undefined,
  }));
  return (
    <nav
      aria-label={t('nav.spaces')}
      style={{
        width: 76,
        background: 'var(--color-panel)',
        borderRight: '1px solid var(--color-border-2)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: '12px 0',
        flexShrink: 0,
      }}
    >
      <Logo />

      {/* Main nav items */}
      {navItems.map(item => (
        <NavItemButton
          key={item.id}
          item={item}
          isActive={activeSpace === item.id}
          badge={item.id === 'agents' ? agentCount : undefined}
          onClick={() => onSpaceChange(item.id)}
        />
      ))}

      {/* Multi-project switcher: open projects + "+" to register another */}
      <ProjectsSection label={t('rail.projects.title')} addLabel={t('rail.projects.add')} />

      {/* Push bottom items to bottom */}
      <div style={{ flex: 1 }} />

      <BottomItem icon={CpuIcon} label={t('nav.models')} isActive={activeSpace === 'models'} onClick={() => onSpaceChange('models')} />
      <BottomItem icon={SettingsIcon} label={t('nav.settings')} isActive={activeSpace === 'settings'} onClick={() => onSpaceChange('settings')} />
      <Avatar />
    </nav>
  );
}
