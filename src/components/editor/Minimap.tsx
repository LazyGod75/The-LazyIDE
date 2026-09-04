import { useEffect, useRef } from 'react';

interface MinimapProps {
  content: string;
  onScroll?: (line: number) => void;
}

export function Minimap({ content, onScroll }: MinimapProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const lines = content.split('\n');
    const lineHeight = 2;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = 80 * dpr;
    canvas.height = Math.max(lines.length * lineHeight, 1) * dpr;
    ctx.scale(dpr, dpr);

    const logicalWidth = 80;
    const logicalHeight = lines.length * lineHeight;

    ctx.fillStyle = '#0E0E12';
    ctx.fillRect(0, 0, logicalWidth, logicalHeight);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const indent = line.match(/^\s*/)?.[0].length ?? 0;
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Color based on content type
      let color = 'rgba(255,255,255,0.30)';
      if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
        color = 'rgba(124,92,255,0.28)';
      } else if (trimmed.startsWith('import') || trimmed.startsWith('export')) {
        color = 'rgba(79,195,247,0.30)';
      } else if (trimmed.startsWith('function') || trimmed.startsWith('const') || trimmed.startsWith('class')) {
        color = 'rgba(255,199,107,0.32)';
      }

      const x = Math.min(indent * 1.2, logicalWidth * 0.6);
      const lineW = Math.min(trimmed.length * 1.0, logicalWidth - x - 2);
      ctx.fillStyle = color;
      ctx.fillRect(x, i * lineHeight, lineW, lineHeight - 0.5);
    }
  }, [content]);

  return (
    <canvas
      ref={canvasRef}
      width={80}
      style={{
        // Explicit CSS width is REQUIRED: without it, the canvas keeps its
        // intrinsic aspect ratio (bitmap 80 x lineCount*2). Combined with
        // height:100% the browser computes a width of ~(viewportHeight*80/bitmapH),
        // which balloons to ~1100px. With flexShrink:0 that canvas then starves
        // the editor column to width:0 — CodeMirror can't measure and renders the
        // file as upscaled blurry gray bars. Pinning width keeps the minimap 80px.
        width: 80,
        height: '100%',
        background: '#0E0E12',
        borderLeft: '1px solid rgba(255,255,255,0.05)',
        cursor: 'pointer',
        flexShrink: 0,
      }}
      onClick={e => {
        const rect = e.currentTarget.getBoundingClientRect();
        const y = e.clientY - rect.top;
        const line = Math.floor(y / 2) + 1;
        onScroll?.(line);
      }}
    />
  );
}
