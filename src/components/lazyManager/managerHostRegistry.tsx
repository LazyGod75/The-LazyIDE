/* managerHostRegistry — the registration point that lets LazyManager have
   exactly ONE mounted instance for the app's whole session while still
   visually living inside two very different chrome pieces: the cockpit's
   floating ManagerOverlay and CodeSpace's docked right rail.

   ROOT CAUSE this exists to fix (measured live, see the PR this shipped
   with): SpacesLayer (AppShell.tsx) intentionally keeps every visited
   space mounted forever (display:none when inactive) so heavy state
   (terminal PTYs, editor tabs, ...) survives a space switch. ManagerOverlay
   (rendered inside the 'agents' space, via Cockpit.tsx) and CodeSpace (the
   'code' space) each used to instantiate their OWN
   `<LazyManagerStoreProvider><LazyManager /></LazyManagerStoreProvider>`
   directly. Once a user had visited BOTH spaces, both copies stayed
   mounted and fully live at once — one visible, one at 0x0 but still
   running every effect LazyManager owns (persistence writes, bus
   subscriptions, timers, polling), and duplicating
   `data-testid="manager-input"`/`manager-send` in the DOM (Playwright
   strict-mode violations; a driver reading the same reply twice).

   FIX: keep exactly one `<LazyManager>` React instance, mounted once by
   <ManagerHost> (managerHost.tsx) at the AppShell root — never inside a
   per-space keep-alive slot — and portal its rendered DOM into whichever
   host is the currently active space. ManagerOverlay/CodeSpace stop
   instantiating LazyManager themselves; they just register a DOM container
   (via the ref callback returned by useManagerHostSource) and their own
   live props (orchestrator vs. coder) into this registry. <ManagerHost>
   reads whichever entry matches the active space and portals into it.

   Why a portal instead of "only render LazyManager in whichever host is
   active" (i.e. two call sites, each conditionally rendering): that would
   still mount/unmount the SAME logical component across different parents
   on every space switch, resetting LazyManager's own local UI state (the
   composer draft `input`, the history-drawer open/closed flag, drag-resize
   width — see LazyManager.tsx's own useState calls) — a real regression
   given the component's stated design intent ("One panel, one header, one
   history, one composer" — LazyManager.tsx's header comment). A portal
   keeps the SAME component instance (same Fiber, same local state) and
   only moves which DOM node it paints into, so switching cockpit <-> code
   is now not just effect-safe but also state-preserving (an in-progress
   draft survives a space switch instead of being silently dropped).

   Why NOT React Context + useState for the registry itself: LazyManager
   props (`signals`, `onAnswerSignal`, ...) are cockpit-local values
   recomputed on every ManagerOverlay render. Pushing them into a React
   Context value via useState would re-render EVERY consumer (including the
   pushing component itself, since it also reads the context to get the
   register functions) on every push, and since the pushed object is a
   fresh literal every render, that would loop indefinitely. Instead this
   registry is a plain external store (no React state) that only notifies
   its own subscribers (useSyncExternalStore, used solely by <ManagerHost>)
   — pushing into it never re-renders the pushing component. */

import { createContext, useContext, useLayoutEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { LazyManagerProps } from './LazyManager';

export type ManagerHostId = 'cockpit' | 'code';

export interface ManagerHostEntry {
  container: HTMLDivElement | null;
  props: LazyManagerProps;
}

type Listener = () => void;

class ManagerHostRegistry {
  private readonly entries = new Map<ManagerHostId, ManagerHostEntry>();
  private readonly listeners = new Set<Listener>();

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  getEntry = (id: ManagerHostId): ManagerHostEntry | undefined => this.entries.get(id);

  setContainer(id: ManagerHostId, container: HTMLDivElement | null): void {
    const existing = this.entries.get(id);
    if (existing?.container === container) return;
    this.entries.set(id, { container, props: existing?.props ?? {} });
    this.notify();
  }

  setProps(id: ManagerHostId, props: LazyManagerProps): void {
    const existing = this.entries.get(id);
    this.entries.set(id, { container: existing?.container ?? null, props });
    this.notify();
  }
}

const ManagerHostRegistryContext = createContext<ManagerHostRegistry | null>(null);

/** Mounted once, wrapping both SpacesLayer (so ManagerOverlay/CodeSpace can
 *  register into it) and <ManagerHost> (so it can read the active entry) —
 *  see AppShell.tsx. */
export function ManagerHostRegistryProvider({ children }: { children: ReactNode }) {
  // Lazy useState initializer (not useRef + a render-time guard) — the
  // initializer function runs exactly once, on mount, without React's
  // react-hooks/refs rule flagging a ref read during render.
  const [registry] = useState(() => new ManagerHostRegistry());

  return (
    <ManagerHostRegistryContext.Provider value={registry}>
      {children}
    </ManagerHostRegistryContext.Provider>
  );
}

function useRegistry(): ManagerHostRegistry {
  const registry = useContext(ManagerHostRegistryContext);
  if (!registry) {
    throw new Error('managerHostRegistry: missing <ManagerHostRegistryProvider> ancestor');
  }
  return registry;
}

/** Used by ManagerOverlay (id='cockpit') and CodeSpace (id='code'): keeps
 *  this host's current LazyManager props fresh in the registry (a
 *  useLayoutEffect with no deps — intentionally runs every render, see the
 *  header comment for why this can't loop) and returns a ref callback to
 *  attach to the DOM container LazyManager should portal into when this
 *  host is the active one. */
export function useManagerHostSource(id: ManagerHostId, props: LazyManagerProps): (node: HTMLDivElement | null) => void {
  const registry = useRegistry();

  useLayoutEffect(() => {
    registry.setProps(id, props);
  });

  return useMemo(() => (node: HTMLDivElement | null) => registry.setContainer(id, node), [registry, id]);
}

/** Used by <ManagerHost>: subscribes to a single host id's live entry
 *  (container + props), re-rendering only when that specific entry's
 *  reference changes. `id === null` (no space with a manager host has ever
 *  been visited yet) always yields `undefined`. */
export function useManagerHostEntry(id: ManagerHostId | null): ManagerHostEntry | undefined {
  const registry = useRegistry();
  return useSyncExternalStore(registry.subscribe, () => (id ? registry.getEntry(id) : undefined));
}
