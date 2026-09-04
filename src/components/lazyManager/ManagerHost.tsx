/* ManagerHost — the ONE place LazyManager is ever mounted. See
   managerHostRegistry.tsx's header comment for the full root-cause writeup
   and the reasoning behind portalling instead of duplicating instances or
   conditionally mounting per space.

   Mounted exactly once, at the AppShell root (a sibling of SpacesLayer, not
   inside any per-space keep-alive slot — see AppShell.tsx), for the app's
   entire session. Owns the single LazyManagerStoreProvider + LazyManager
   pair and portals LazyManager's rendered DOM into whichever registered
   host (cockpit's ManagerOverlay or CodeSpace's docked rail) is currently
   the active space.

   IMPORTANT: `createPortal`'s own `container` argument is a STABLE node
   (`portalNode` below), created once and NEVER swapped across renders —
   confirmed empirically (a failing round-trip test) that React does NOT
   reliably preserve the portalled subtree's component state when a portal's
   `container` argument changes identity between renders; whether that
   counts as a remount internally or not, LazyManager's own local state
   (composer draft, ...) was observed reset. Swapping which HOST a fixed
   portal node lives inside is instead done with a plain, React-independent
   `container.appendChild(portalNode)` in a layout effect — moving an
   already-attached DOM node via `appendChild` only relocates it (the
   browser does not destroy/recreate its subtree), and since `createPortal`
   is always called with the SAME `portalNode` reference, React never sees
   a container change at all and has no reason to touch the subtree. */

import { useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { LazyManager } from './LazyManager';
import { LazyManagerStoreProvider } from './lazyManagerStore';
import { useManagerHostEntry, type ManagerHostId } from './managerHostRegistry';

export interface ManagerHostProps {
  /** The manager host id matching the currently active space ('agents' ->
   *  'cockpit', 'code' -> 'code'), or null while neither is active. Passed
   *  in (rather than read from AppContext directly) so this component
   *  stays testable without the full app provider tree — see AppShell.tsx
   *  for the real mapping. */
  activeHostId: ManagerHostId | null;
}

function createPortalNode(): HTMLDivElement {
  const node = document.createElement('div');
  // Fills whatever host container it's currently appended into — matches
  // the flex:1/minHeight:0 every host container itself is styled with (see
  // ManagerOverlay.tsx / CodeSpace.tsx).
  node.style.display = 'flex';
  node.style.flexDirection = 'column';
  node.style.flex = '1';
  node.style.minHeight = '0';
  node.style.width = '100%';
  node.style.height = '100%';
  return node;
}

export function ManagerHost({ activeHostId }: ManagerHostProps) {
  const entry = useManagerHostEntry(activeHostId);
  // Lazy useState initializer — runs exactly once, on mount, for the app's
  // whole session (this component itself never unmounts, see AppShell.tsx).
  const [portalNode] = useState(createPortalNode);

  // Whether ANY host has EVER registered a container — sticky (never goes
  // back to false) so LazyManager, once mounted, is never torn down again
  // just because the active space briefly has no manager host (e.g. the
  // user is on 'brain'/'settings', or cockpit is momentarily collapsed).
  // Before the FIRST registration, LazyManager stays fully unmounted —
  // preserving the pre-fix behavior of not paying for its effects (bus
  // subscriptions, timers, polling) until the user has actually opened
  // Cockpit or Code at least once in the session.
  const [hasEverHadHost, setHasEverHadHost] = useState(false);

  // Relocates the (React-opaque) portalNode into whichever host container
  // is currently active. No cleanup/removeChild needed: `appendChild`
  // itself detaches `portalNode` from its previous parent (a DOM node can
  // only have one), so the NEXT active container's effect run is what
  // performs the move — an explicit removeChild here would only add a
  // redundant detach-then-reattach on every entry change, including a
  // same-container re-registration.
  useLayoutEffect(() => {
    if (!entry?.container) return;
    entry.container.appendChild(portalNode);
    if (!hasEverHadHost) setHasEverHadHost(true); // eslint-disable-line react-hooks/set-state-in-effect -- sticky "seen a host" latch, mirrors SpacesLayer's own setMountedSpaces pattern in AppShell.tsx
  }, [entry?.container, portalNode, hasEverHadHost]);

  if (!hasEverHadHost) return null;

  // LazyManager mounts once, into portalNode, for the rest of the app's
  // session. While no host is currently active, portalNode simply sits
  // detached from the document — invisible, but its React subtree (and
  // LazyManager's own local state, e.g. the composer draft) stays alive,
  // ready to be re-attached the instant a host registers again.
  // Provider lives INSIDE the portal so it shares the same React subtree
  // as LazyManager. Wrapping createPortal from the outside used to look
  // correct in the fiber stack (LazyManager child of Provider) while
  // still throwing "useLazyManagerStore must be inside …" after Vite
  // HMR split the context object identity — same class of bug as
  // ToastContext.ts.
  return createPortal(
    <LazyManagerStoreProvider>
      <LazyManager {...(entry?.props ?? {})} />
    </LazyManagerStoreProvider>,
    portalNode,
  );
}
