/* markdownStyles — shared visual styles for MarkdownRenderer's default
   (non-overridden) elements. Uses the app's design-system CSS custom
   properties (--color-*, --font-mono — see src/styles/design-system.css)
   so both consumers (assistant chat bubbles, the editor's .md preview)
   automatically match the rest of the dark theme, and stay in sync if the
   theme changes. Sizes are relative (em) so the SAME styles look right at
   the chat bubble's ~12px base and the file-preview's larger base. */

import type { CSSProperties } from 'react';
import type { TableAlign } from './types.js';

export const ROOT_STYLE: CSSProperties = {
  minWidth: 0,
};

export const PARAGRAPH_STYLE: CSSProperties = {
  margin: '0 0 0.6em 0',
  lineHeight: 1.6,
  overflowWrap: 'break-word',
  wordBreak: 'break-word',
};

export function headingStyle(level: 1 | 2 | 3 | 4 | 5 | 6): CSSProperties {
  const sizes: Record<number, string> = {
    1: '1.55em', 2: '1.35em', 3: '1.18em', 4: '1.05em', 5: '1em', 6: '0.95em',
  };
  return {
    color: 'var(--color-accent-light)',
    fontSize: sizes[level],
    fontWeight: 600,
    margin: level <= 2 ? '0.9em 0 0.5em' : '0.7em 0 0.4em',
    lineHeight: 1.35,
    overflowWrap: 'break-word',
    wordBreak: 'break-word',
  };
}

export const INLINE_CODE_STYLE: CSSProperties = {
  background: 'rgba(124,92,255,0.12)',
  color: 'var(--color-accent-light)',
  padding: '1px 5px',
  borderRadius: 3,
  fontFamily: 'var(--font-mono)',
  fontSize: '0.92em',
};

export const STRONG_STYLE: CSSProperties = {
  color: 'var(--color-text, #E6E8EF)',
  fontWeight: 700,
};

export const LINK_STYLE: CSSProperties = {
  color: 'var(--color-accent-light)',
  textDecoration: 'underline',
  textUnderlineOffset: 2,
  cursor: 'pointer',
};

export const HR_STYLE: CSSProperties = {
  border: 'none',
  borderTop: '1px solid var(--color-border)',
  margin: '0.9em 0',
};

export const BLOCKQUOTE_STYLE: CSSProperties = {
  borderLeft: '3px solid var(--color-accent-border, rgba(124,92,255,0.3))',
  paddingLeft: '0.8em',
  margin: '0.6em 0',
  color: 'rgba(255,255,255,0.6)',
};

export const UL_STYLE: CSSProperties = {
  margin: '0.3em 0 0.6em',
  paddingLeft: '1.4em',
  listStyleType: 'disc',
};

export const OL_STYLE: CSSProperties = {
  margin: '0.3em 0 0.6em',
  paddingLeft: '1.4em',
  listStyleType: 'decimal',
};

export const LI_STYLE: CSSProperties = {
  margin: '0.2em 0',
  lineHeight: 1.55,
  overflowWrap: 'break-word',
  wordBreak: 'break-word',
};

export const NESTED_LIST_STYLE: CSSProperties = {
  margin: '0.2em 0 0.2em',
};

export const TABLE_WRAP_STYLE: CSSProperties = {
  overflowX: 'auto',
  margin: '0.6em 0',
};

export const TABLE_STYLE: CSSProperties = {
  borderCollapse: 'collapse',
  fontSize: '0.95em',
  minWidth: '100%',
};

export const TR_ODD_STYLE: CSSProperties = {
  background: 'rgba(255,255,255,0.02)',
};

export function thStyle(align: TableAlign): CSSProperties {
  return {
    textAlign: align ?? 'left',
    padding: '5px 10px',
    borderBottom: '1px solid var(--color-border)',
    color: 'var(--color-accent-light)',
    fontWeight: 600,
    whiteSpace: 'nowrap',
  };
}

export function tdStyle(align: TableAlign): CSSProperties {
  return {
    textAlign: align ?? 'left',
    padding: '5px 10px',
    borderBottom: '1px solid var(--color-border-2, rgba(255,255,255,0.06))',
    verticalAlign: 'top',
  };
}

export const PRE_STYLE: CSSProperties = {
  margin: '0.6em 0',
  padding: '10px 12px',
  background: 'rgba(0,0,0,0.35)',
  border: '1px solid var(--color-border)',
  borderRadius: 6,
  overflowX: 'auto',
  fontSize: '0.92em',
  lineHeight: 1.6,
};

export const CODE_STYLE: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  color: 'var(--color-text-dim, #D5D8E0)',
  whiteSpace: 'pre',
};

export const FALLBACK_STYLE: CSSProperties = {
  whiteSpace: 'pre-wrap',
  overflowWrap: 'break-word',
  wordBreak: 'break-word',
};
