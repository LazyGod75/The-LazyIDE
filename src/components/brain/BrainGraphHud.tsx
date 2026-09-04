/* Cinematic HUD over the Brain graph pane only — vignette, scan, hex,
   corners, ring. Pointer-events none so orbit / canvas drag still work. */

import './brain-hud.css';

export function BrainGraphHud() {
  return (
    <div className="brain-fx" aria-hidden>
      <div className="brain-vignette" />
      <div className="brain-scan" />
      <div className="brain-hex" />
      <span className="brain-corner brain-corner-tl" />
      <span className="brain-corner brain-corner-tr" />
      <span className="brain-corner brain-corner-bl" />
      <span className="brain-corner brain-corner-br" />
      <div className="brain-ring" />
    </div>
  );
}
