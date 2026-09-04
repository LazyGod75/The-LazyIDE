/* desktopViewer.ts — live noVNC desktop viewer for a Solari Agent Computer VM.

   The Solari desktop SDK ships a browser viewer helper (mountDesktop) but it
   imports the OLD @novnc path ('lib/rfb.js'); current @novnc v1.7 lives at
   'core/rfb.js'. We mount the RFB client directly (dynamic import → the heavy
   noVNC bundle is only pulled when the user actually opens the live desktop).
*/

export interface LiveDesktopViewer {
  disconnect(): void;
}

/** Mount a live noVNC RFB client into `target`, connecting to `streamUrl`
 *  (wss://…/stream/:id from the Agent Computer's desktop.streamUrl). Resolves
 *  once the client is constructed; the connection proceeds asynchronously. */
export async function mountLiveDesktop(
  target: HTMLElement,
  streamUrl: string,
  opts: { viewOnly?: boolean; scaleViewport?: boolean } = {},
): Promise<LiveDesktopViewer> {
  // noVNC ships no types; its exports map resolves the package root to
  // core/rfb.js. Cast through unknown — we only touch a tiny RFB surface.
  const mod = (await import('@novnc/novnc')) as unknown as {
    default: new (
      target: Element,
      urlOrChannel: string,
      options?: { credentials?: Record<string, string>; shared?: boolean; wsProtocols?: string[] },
    ) => { viewOnly: boolean; scaleViewport: boolean; disconnect(): void };
  };
  const { default: RFB } = mod;
  // noVNC's RFB constructor takes (target: Element, url, options) and creates
  // its own <canvas> inside the target element.
  const rfb = new RFB(target, streamUrl, { wsProtocols: [] }) as {
    viewOnly: boolean;
    scaleViewport: boolean;
    disconnect(): void;
  };
  rfb.viewOnly = opts.viewOnly !== false; // bots are watched; takeover is via desktop tools
  rfb.scaleViewport = opts.scaleViewport ?? true;
  return {
    disconnect: () => {
      try {
        rfb.disconnect();
      } catch {
        // already torn down
      }
    },
  };
}
