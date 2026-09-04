/* MarkdownPreview — read-only rendering of a .md file open in the editor.

   Reuses the shared MarkdownRenderer (see src/lib/markdown) — the same
   renderer the assistant chat uses for answers — so both surfaces agree on
   one implementation for headings/lists/tables/code/links, and this view
   gets link sanitization and no-dangerouslySetInnerHTML safety for free.
   No renderCodeBlock/renderCitation overrides: this is a plain file
   preview with no chat/apply context, so the renderer's defaults (a plain
   read-only code block, literal "#ref" text) are exactly right. */

import { MarkdownRenderer } from '../../lib/markdown';

interface MarkdownPreviewProps {
  content: string;
  filename: string;
}

export function MarkdownPreview({ content, filename }: MarkdownPreviewProps) {
  return (
    <div
      style={{
        flex: 1,
        overflowY: 'auto',
        background: '#0E0E12',
        padding: '20px 28px',
        fontFamily: "'Inter', -apple-system, sans-serif",
        color: '#D5D8E0',
        fontSize: 14,
        lineHeight: 1.6,
      }}
    >
      <div style={{ marginBottom: 16, fontSize: 11, color: 'rgba(255,255,255,0.3)' }}>
        Preview: {filename}
      </div>
      <MarkdownRenderer content={content} />
    </div>
  );
}
