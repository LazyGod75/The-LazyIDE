/* Ambient declarations for @novnc/novnc (no published types; the package's
   exports map resolves the root to core/rfb.js). Only the tiny RFB surface
   desktopViewer.ts uses is typed here. */
declare module '@novnc/novnc' {
  export interface NovncRfb {
    viewOnly: boolean;
    scaleViewport: boolean;
    disconnect(): void;
  }
  const RFB: new (
    target: Element,
    urlOrChannel: string,
    options?: { credentials?: Record<string, string>; shared?: boolean; wsProtocols?: string[] },
  ) => NovncRfb;
  export default RFB;
}
