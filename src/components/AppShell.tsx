/* AppShell — root layout: TopNav + SpacesLayer (the active space's content)
   under a <main>, plus the CommandPalette overlay.
   Reads active space from AppContext and renders the correct space.
   Includes PaletteProvider + AgentsUiProvider + ToastProvider + global
   shortcuts (command palette open/close, space switching) registered via
   src/lib/shortcuts.
*/

import { lazy, Suspense, useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { initSeedProgressListener } from '../lib/brain/seedProgressStore';
import { useAppContext } from '../app/AppContext';
import { useI18n } from '../i18n';
import type { SpaceId } from '../app/AppContext';
import type { SettingsTab } from '../spaces/SettingsSpace';
import { TopNav } from './TopNav';
import { SpaceErrorBoundary } from './SpaceErrorBoundary';
import { RootErrorBoundary } from './RootErrorBoundary';
// HomeSpace stays in the initial chunk for fast first paint.
import { HomeSpace } from '../spaces/HomeSpace';
import { PaletteProvider, usePaletteContext } from './palette/PaletteContext';
import { CommandPalette } from './palette/CommandPalette';
import { AgentsUiProvider } from './agents/agentsUiContext';
import { AgentsStoreProvider } from './agents/agentsStore';
import { BotsStoreProvider } from './agents/botsStore';
import { BotBootService } from './agents/BotBootService';
import { BotApprovalPanel } from './agents/BotApprovalPanel';
import { BotVmHost } from './agents/BotVmHost';
import { AssistantStoreProvider } from './assistant/assistantStore';
import { ToastProvider } from './ui/Toast';
import { UpdaterService } from './updater/UpdaterService';
import { StartupRecoveryCheck } from './startup/StartupRecoveryCheck';
import { MemoryPressureIndicator } from './MemoryPressureIndicator';
import { useMemoryPressureReservedHeight } from './memoryPressureReservedHeight';
import { OnboardingModal } from './onboarding/OnboardingModal';
import { useOnboarding } from './onboarding/useOnboarding';
import { Spinner, useToast } from './ui';
import { useAuth } from '../lib/auth';
import { SubscriptionProvider } from '../lib/billing';
import { setActiveTeamSnapshot } from '../lib/features';
import { ActiveTeamProvider, useActiveTeamContext } from '../lib/teams/ActiveTeamContext';
import { shortcutRegistry, useShortcut, SHORTCUT_PRIORITY } from '../lib/shortcuts';
import { ManagerHost } from './lazyManager/ManagerHost';
import { ManagerHostRegistryProvider, type ManagerHostId } from './lazyManager/managerHostRegistry';
import { scheduleLazySpacePrefetch } from './prefetchLazySpaces';

// Space switching table: Mod+1-6 and Mod+Shift+E/B/A. Registered directly
// on the shortcut registry (not via useShortcut) since it's a fixed table of
// combos and React hooks cannot be called from a loop — see AppShellInner.
//
// D2 redesign: Cockpit (agents) is now the home/first-paint space and the
// top nav's segmented pills are Cockpit/Code/Brain/Team/Settings, so
// Mod+1..5 mirror that order. Review left the nav/shortcuts entirely (it's
// absorbed into Cockpit decision cards + Code's diff drawer in a later
// wave) — 'review' stays in the SpaceId union and SpaceContent's switch so
// it's still reachable programmatically, just not bound to a shortcut.
// Terminals keeps its own slot (Mod+6) — reachable via palette + shortcut
// only, no header pill (per D2).
const SPACE_DIGIT_MAP: Record<string, SpaceId> = {
  '1': 'agents', '2': 'code', '3': 'brain',
  '4': 'team', '5': 'settings', '6': 'terminals',
};
const SPACE_SHIFT_MAP: Record<string, SpaceId> = {
  e: 'code', b: 'brain', a: 'agents',
};

/** Maps the active SpaceId to the manager host it owns (see
 *  managerHostRegistry.tsx) — 'agents' hosts Cockpit's ManagerOverlay,
 *  'code' hosts CodeSpace's docked rail. Every other space has no manager
 *  host at all, so <ManagerHost> renders nothing while one of those is
 *  active (there is nowhere for it to portal into — same as before this
 *  fix, when neither host rendered LazyManager unless mounted). */
function managerHostIdForSpace(space: SpaceId): ManagerHostId | null {
  if (space === 'agents') return 'cockpit';
  if (space === 'code') return 'code';
  return null;
}

// Heavy spaces — lazy-loaded on first visit so the shell starts fast.
const CodeSpace     = lazy(() => import('../spaces/CodeSpace').then((m) => ({ default: m.CodeSpace })));
const AgentsSpace   = lazy(() => import('../spaces/AgentsSpace').then((m) => ({ default: m.AgentsSpace })));
const BrainSpace    = lazy(() => import('../spaces/BrainSpace').then((m) => ({ default: m.BrainSpace })));
const ReviewSpace   = lazy(() => import('../spaces/ReviewSpace').then((m) => ({ default: m.ReviewSpace })));
const TerminalsSpace = lazy(() => import('../spaces/TerminalsSpace').then((m) => ({ default: m.TerminalsSpace })));
const SettingsSpace = lazy(() => import('../spaces/SettingsSpace').then((m) => ({ default: m.SettingsSpace })));
const TeamSpace     = lazy(() => import('../spaces/TeamSpace').then((m) => ({ default: m.TeamSpace })));

// Shared fallback for space-level Suspense boundaries.
function SpaceFallback() {
  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--color-bg)',
      }}
    >
      <Spinner size={24} color="#7C5CFF" />
    </div>
  );
}

// ── Space renderer (keep-alive: mounted-once, shown/hidden via CSS) ────
//
// PERF FIX: this used to be a single <ActiveSpace> that keyed its wrapper
// div on `space`, so switching spaces unmounted the previous space and
// mounted a fresh instance of the new one EVERY time — not just on first
// visit. Each space's own "on mount" data effects (BrainSpace's graph/
// health/brain-info fetches, HomeSpace's missions load, etc.) therefore
// re-ran on every single nav, not just the first. SpacesLayer instead
// keeps every space that has ever been active mounted permanently (in a
// stable, key-by-id list) and toggles visibility with `display`, so
// switching back to a space reuses its existing instance — cached data,
// scroll position, in-progress edits, and its own live-refresh listeners
// (e.g. BrainSpace's brain://updated / project://changed subscriptions)
// all survive, and still fire normally since the component never actually
// unmounts. This mirrors TerminalsSpace's own established pattern for its
// tabs ("render all sessions, show/hide via display to preserve PTY
// state" — see TerminalsSpace.tsx).
//
// Each space keeps its own Suspense boundary (rather than one shared
// boundary around the whole layer) so a first-time visit to a brand-new
// lazy space only shows that one slot's fallback — it can never yank
// already-mounted sibling spaces off-screen while their sibling is still
// loading its chunk.

interface SpaceContentProps {
  space: SpaceId;
  showTeamTab: boolean;
  /** QA fix (B5): the Settings sub-tab requested by the last navigation
   *  (set by setActiveSpace's `tab` param or a nav:navigateSpace bus event
   *  carrying one) — overrides each settings-ish SpaceId's own default tab
   *  so a deep-link (e.g. AccountPopover's "Créer une équipe" or the
   *  palette's "Aller à : Réglages") lands on the intended sub-tab (Compte)
   *  instead of always falling back to General. Passed down as a prop
   *  (rather than read via useAppContext() here) so SpaceContent stays
   *  usable without an AppProvider — see AppShell.test.tsx, which renders
   *  SpacesLayer standalone. */
  settingsInitialTab: string | null;
}

function accountAuthMode(tab?: string | null): 'signin' | 'signup' | undefined {
  if (tab === 'signin' || tab === 'signup') return tab;
  return undefined;
}

function SpaceContent({ space, showTeamTab, settingsInitialTab }: SpaceContentProps) {
  switch (space) {
    case 'code':      return <SpaceErrorBoundary name="Code"><CodeSpace /></SpaceErrorBoundary>;
    case 'agents':    return <SpaceErrorBoundary name="Agents"><AgentsSpace /></SpaceErrorBoundary>;
    case 'brain':     return <SpaceErrorBoundary name="Brain"><BrainSpace /></SpaceErrorBoundary>;
    case 'review':    return <SpaceErrorBoundary name="Review"><ReviewSpace /></SpaceErrorBoundary>;
    case 'home':      return <SpaceErrorBoundary name="Home"><HomeSpace /></SpaceErrorBoundary>;
    case 'models':    return <SpaceErrorBoundary name="Models"><SettingsSpace initialTab={(settingsInitialTab as SettingsTab) ?? 'models'} /></SpaceErrorBoundary>;
    case 'settings':  return <SpaceErrorBoundary name="Settings"><SettingsSpace initialTab={(settingsInitialTab as SettingsTab) ?? 'general'} /></SpaceErrorBoundary>;
    case 'account': {
      const authMode = accountAuthMode(settingsInitialTab);
      const tab: SettingsTab = authMode ? 'account' : ((settingsInitialTab as SettingsTab | undefined) ?? 'account');
      return <SpaceErrorBoundary name="Account"><SettingsSpace initialTab={tab} initialAuthMode={authMode} /></SpaceErrorBoundary>;
    }
    case 'terminals': return <SpaceErrorBoundary name="Terminals"><TerminalsSpace /></SpaceErrorBoundary>;
    case 'team':      return showTeamTab ? <SpaceErrorBoundary name="Team"><TeamSpace /></SpaceErrorBoundary> : null;
    default:          return null;
  }
}

interface SpaceSlotProps {
  space: SpaceId;
  isActive: boolean;
  showTeamTab: boolean;
  /** QA fix (B5) — see SpaceContentProps. Optional so existing callers
   *  (AppShell.test.tsx's direct SpacesLayer render) keep compiling
   *  unchanged; absent means "no deep-link requested". */
  settingsInitialTab?: string | null;
  /** Skip the enter animation — used for the space shown at the very first
      paint, so cold start never pays an extra ~180ms fade delay. */
  skipEnterAnimation: boolean;
}

function SpaceSlot({ space, isActive, showTeamTab, settingsInitialTab, skipEnterAnimation }: SpaceSlotProps) {
  // No key here: this div is created ONCE (when the space is first added
  // to SpacesLayer's mounted list, see below) and never recreated while
  // switching between spaces, so a plain unconditional className is
  // enough — CSS animations only (re)play when the element is newly
  // inserted or the animation-bearing class newly starts applying, never
  // on a re-render of an already-mounted node whose className didn't
  // change. That gives every space its enter fade exactly once, on its
  // own first visit, and an instant (no remount, no re-animation) toggle
  // on every visit after that.
  return (
    <div
      className={skipEnterAnimation ? undefined : 'space-enter'}
      style={{
        flex: 1,
        display: isActive ? 'flex' : 'none',
        overflow: 'hidden',
        minHeight: 0,
      }}
    >
      <SpaceContent space={space} showTeamTab={showTeamTab} settingsInitialTab={settingsInitialTab ?? null} />
    </div>
  );
}

interface SpacesLayerProps {
  activeSpace: SpaceId;
  showTeamTab: boolean;
  /** QA fix (B5) — see SpaceContentProps. Optional, defaults to no
   *  deep-link, so existing callers (AppShell.test.tsx) are unaffected. */
  settingsInitialTab?: string | null;
}

// Exported (only) so the keep-alive mechanism can be unit-tested in
// isolation — see src/__tests__/AppShell.test.tsx — without needing to
// stand up AppShell's full provider tree (auth/billing/teams/onboarding).
export function SpacesLayer({ activeSpace, showTeamTab, settingsInitialTab }: SpacesLayerProps) {
  // The space shown at the very first paint — its slot never animates in.
  // Plain state (not a ref) purely because its initial value is captured
  // once and then only ever READ during render — refs are for values
  // mutated outside render, and reading `.current` during render is
  // itself a lint violation (react-hooks/refs).
  const [initialSpace] = useState(activeSpace);

  // Every space that has ever been active, in first-visited order. Grows
  // over time; spaces are never removed (there are only 9 possible SpaceId
  // values, so keeping all of them mounted for a session's lifetime is
  // cheap — and each one's own heavy work is already gated appropriately,
  // e.g. BrainGraph3D's render loop pauses via IntersectionObserver
  // whenever its canvas isn't actually visible).
  const [mountedSpaces, setMountedSpaces] = useState<readonly SpaceId[]>(() => [activeSpace]);

  useEffect(() => {
    setMountedSpaces((prev) => (prev.includes(activeSpace) ? prev : [...prev, activeSpace])); // eslint-disable-line react-hooks/set-state-in-effect
  }, [activeSpace]);

  // Guarantees the newly active space renders on the SAME tick it becomes
  // active (no one-frame blank gap waiting for the effect above to commit).
  const renderedSpaces = mountedSpaces.includes(activeSpace)
    ? mountedSpaces
    : [...mountedSpaces, activeSpace];

  return (
    <>
      {renderedSpaces.map((id) => (
        <Suspense key={id} fallback={<SpaceFallback />}>
          <SpaceSlot
            space={id}
            isActive={id === activeSpace}
            showTeamTab={showTeamTab}
            settingsInitialTab={settingsInitialTab}
            skipEnterAnimation={id === initialSpace}
          />
        </Suspense>
      ))}
    </>
  );
}

/** Payload shape for the Rust 'agent://scheduled-run' event — mirrors
 *  agent.rs's spawn_scheduler `serde_json::json!` literal verbatim. */
interface ScheduledRunEvent {
  missionId: string;
  agentName: string;
  agentId: string;
  scheduledAt: string;
}

/**
 * Subscribes to 'agent://scheduled-run' for the whole app session and
 * toasts a discrete notification on receipt. Exported (mirrors
 * seedProgressStore.ts's initSeedProgressListener) so this can be unit
 * tested without mounting AppShellInner's full provider tree — see
 * AppShellScheduledRun.test.ts.
 */
export function watchScheduledAgentRuns(
  toast: (message: string, type?: 'success' | 'error' | 'info' | 'warning', duration?: number) => void,
  t: (key: string, params?: Record<string, string | number>) => string,
): Promise<() => void> {
  return listen<ScheduledRunEvent>('agent://scheduled-run', (event) => {
    toast(t('agents.notification.scheduledRun', { name: event.payload.agentName }), 'info', 4000);
  });
}

// ── AppShellInner — needs palette context ─────────────────────────

function AppShellInner() {
  const { activeSpace, setActiveSpace, settingsInitialTab } = useAppContext();
  const { isOpen, openPalette, closePalette } = usePaletteContext();
  const { hasActiveTeam } = useActiveTeamContext();
  const { toast } = useToast();
  const { t } = useI18n();

  useEffect(() => scheduleLazySpacePrefetch(), []);

  // QA fix (bottom-left overlap): MemoryPressureIndicator (mounted once,
  // fixed-position, in AppShell below) covers whatever a space renders in
  // its bottom-left corner — Brain's cluster filter list, Cockpit's
  // FluxFooter — since it floats independently of layout. Reserving its
  // footprint here, once, as <main>'s paddingBottom shrinks every space's
  // content box so the pill always lands on empty background instead of on
  // top of real rows, without any individual space needing to know the
  // pill exists. See memoryPressureReservedHeight.ts's own doc comment for
  // the reserved-height math.
  const reservedBottomPadding = useMemoryPressureReservedHeight();

  // Teams are LIVE (real git transport + GitHub OAuth device flow + shared
  // canvas). The Team tab always shows: a user with no org yet lands on
  // SoloView (create/join/invite), a member lands on their role-derived
  // Lead/Member view. Team capture/search dispatch stays gated on the
  // runtime teamsActive() entitlement, never on this visibility flag.
  const showTeamTab = true;

  // Publish the live org-entitlement signal into the module-level runtime
  // snapshot (src/lib/features.ts) so non-React consumers — capture.ts's
  // dispatch() and unifiedEntitlement.ts's isTeamContext — can read the
  // SAME entitlement synchronously, without duplicating the Supabase
  // active/trialing + membership check. hasActiveTeam is already
  // fail-closed (false while loading or on error, see useActiveTeam.ts),
  // so mirroring it verbatim keeps that guarantee. Same push-on-settle
  // pattern as useSubscription.ts's setPlanTier effect.
  useEffect(() => {
    setActiveTeamSnapshot(hasActiveTeam);
  }, [hasActiveTeam]);

  // Start the team brain sync daemon (pull/push/outbox) once the user has
  // an active team; stop it when they don't. The daemon itself is
  // best-effort and fail-closed on teamsActive() — see syncDaemon.ts.
  useEffect(() => {
    if (!hasActiveTeam) return;
    let stop: (() => void) | null = null;
    let cancelled = false;
    void import('../lib/teams/syncDaemon').then((mod) => {
      if (cancelled) return;
      stop = mod.startSyncDaemon();
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [hasActiveTeam]);

  // Global Mod+K / Mod+P — toggle the command palette.
  //
  // Mod+K is also EditorPane's inline-edit shortcut. Both register on the
  // same combo through the shared registry; EditorPane's registration uses
  // SHORTCUT_PRIORITY.SCOPED (only eligible while the CodeMirror view has
  // focus) so it deterministically wins over this GLOBAL-tier registration
  // whenever both are eligible — see EditorPane.tsx. This listener no
  // longer needs to guess at the editor's DOM structure
  // (`event.target.closest('.cm-editor')`, removed) to avoid stealing the
  // shortcut while editing code.
  const togglePalette = () => {
    if (isOpen) closePalette();
    else openPalette();
  };
  useShortcut({ id: 'palette.toggleK', combo: 'Mod+K', priority: SHORTCUT_PRIORITY.GLOBAL }, togglePalette);
  useShortcut({ id: 'palette.toggleP', combo: 'Mod+P', priority: SHORTCUT_PRIORITY.GLOBAL }, togglePalette);

  // Space switching: Mod+1-6 and Mod+Shift+E/G/B/A.
  useEffect(() => {
    const unsubscribers = [
      ...Object.entries(SPACE_DIGIT_MAP).map(([digit, space]) =>
        shortcutRegistry.register({
          id: `space.switch.${space}`,
          combo: `Mod+${digit}`,
          handler: () => setActiveSpace(space),
        }),
      ),
      ...Object.entries(SPACE_SHIFT_MAP).map(([key, space]) =>
        shortcutRegistry.register({
          id: `space.switchShift.${space}`,
          combo: `Mod+Shift+${key}`,
          handler: () => setActiveSpace(space),
        }),
      ),
    ];

    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, [setActiveSpace]);

  // Scheduled agent runs (agent.rs's cron scheduler thread) are entirely
  // Rust-initiated — no TS launch call ever registers the per-mission
  // agent://step|done|error/{id} listeners runtime.ts sets up for a
  // normally-launched mission, since TS never learns the mission id in
  // advance. 'agent://scheduled-run' is the one signal that DOES reach TS
  // (fired alongside the sibling events, see agent.rs's spawn_scheduler),
  // so without this listener the user had no live indication a routine had
  // fired at all. A discrete toast — the same visible-notification
  // mechanism already used for mission lifecycle events elsewhere (see
  // agentsStore.tsx's own toast(t('agents.notification.*...)) calls) —
  // rather than a new notification system.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void watchScheduledAgentRuns(toast, t).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [toast, t]);

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        background: 'var(--color-bg)',
        fontFamily: 'var(--font-ui)',
      }}
    >
      {/* Top header — shared nav across every redesigned space (D2) */}
      <TopNav activeSpace={activeSpace} onSpaceChange={setActiveSpace} />

      {/* ManagerHostRegistryProvider wraps BOTH SpacesLayer (so Cockpit's
          ManagerOverlay and CodeSpace can register their DOM container +
          live props) AND <ManagerHost> (so it can read whichever entry is
          active) — see managerHostRegistry.tsx's header comment for the
          double-mount bug this closes: SpacesLayer intentionally keeps
          every visited space mounted (display:none) for state
          preservation, so ManagerOverlay and CodeSpace used to each
          instantiate their OWN LazyManager, and once both spaces had been
          visited both stayed alive at once, both running every effect
          LazyManager owns. <ManagerHost> is the single mount point;
          rendered as a sibling of SpacesLayer (NOT inside any per-space
          keep-alive slot) so it survives every space switch untouched. */}
      <ManagerHostRegistryProvider>
        <main
          style={{
            flex: 1,
            display: 'flex',
            overflow: 'hidden',
            minHeight: 0,
            paddingBottom: reservedBottomPadding,
            transition: 'padding-bottom 0.2s ease',
          }}
        >
          <SpacesLayer activeSpace={activeSpace} showTeamTab={showTeamTab} settingsInitialTab={settingsInitialTab} />
        </main>
        <ManagerHost activeHostId={managerHostIdForSpace(activeSpace)} />
      </ManagerHostRegistryProvider>

      {/* Command Palette overlay */}
      <CommandPalette isOpen={isOpen} onClose={closePalette} />
    </div>
  );
}

// ── BillingSync — provides the live subscription to the whole shell.
//
// Mounts at app root (inside AuthGate) so useSubscription() runs once and
// setManagedAvailability() is called immediately after sign-in — before the user
// ever opens Settings. Without this the hook only ran inside SettingsSpace
// (lazy-loaded, never mounted on startup), so _managedActive stayed false and the
// assistant badge showed 'Pro · non configuré'.
//
// It also exposes the subscription state via SubscriptionProvider so consumers
// (e.g. the Omnibar AccountChip) read the same fetch instead of duplicating it.

function BillingSync({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  return (
    <SubscriptionProvider user={user}>
      <ActiveTeamProvider user={user}>
        {children}
      </ActiveTeamProvider>
    </SubscriptionProvider>
  );
}

// ── AppShell — wraps with PaletteProvider + AgentsUiProvider + ToastProvider ─────

export function AppShell() {
  const { showOnboarding, completeOnboarding, userEmail, isNewAccount } = useOnboarding();

  // Global brain seed-progress listener — subscribed ONCE for the entire
  // app session, here rather than inside BrainSpace (lazy-loaded, only
  // mounted once the user first visits the Brain tab) or BrainSetupStep
  // (onboarding-only, unmounted once the wizard closes). A seed can be
  // kicked off during onboarding, before the Brain tab has ever been
  // visited — subscribing at the true app root is the only way no
  // brain://seed-progress event is ever missed regardless of navigation.
  // See src/lib/brain/seedProgressStore.ts's module doc comment.
  useEffect(() => initSeedProgressListener(), []);

  // RootErrorBoundary is the last-resort, app-wide catch: SpacesRail,
  // Omnibar, CommandPalette, UpdaterService and OnboardingModal all
  // render OUTSIDE the per-space SpaceErrorBoundary (see SpacesLayer
  // above), so a throw during their render previously had no ancestor
  // boundary at all — React would unmount the whole tree and the webview
  // went fully white with no recovery path. See RootErrorBoundary.tsx.
  return (
    <RootErrorBoundary>
      <ToastProvider>
        <AgentsUiProvider>
          <PaletteProvider>
            <BillingSync>
              <UpdaterService />
              <StartupRecoveryCheck />
              <BotApprovalPanel />
              <BotVmHost />
              <MemoryPressureIndicator />
              <AgentsStoreProvider>
                {/* BotBootService moved INSIDE the provider: it now threads
                    the store's addMission into the bot routine scheduler so
                    routine-fired runs are REAL, visible missions (see
                    BotBootService.tsx). */}
                <BotBootService />
                <BotsStoreProvider>
                  <AssistantStoreProvider>
                    <AppShellInner />
                    {showOnboarding && (
                      <OnboardingModal
                        onComplete={completeOnboarding}
                        userEmail={userEmail}
                        isNewAccount={isNewAccount}
                      />
                    )}
                  </AssistantStoreProvider>
                </BotsStoreProvider>
              </AgentsStoreProvider>
            </BillingSync>
          </PaletteProvider>
        </AgentsUiProvider>
      </ToastProvider>
    </RootErrorBoundary>
  );
}
