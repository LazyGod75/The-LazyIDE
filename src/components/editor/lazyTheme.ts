import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import type { Extension } from '@codemirror/state';

const baseTheme = EditorView.theme(
  {
    '&': {
      background: '#0E0E12',
      color: '#D5D8E0',
      height: '100%',
    },
    '.cm-content': {
      // Integer physical px at fractional DPR (12 * 1.25 = 15.0) avoids the
      // sub-pixel glyph smear WebView2 produces at 12.5px (-> 15.625). Consolas
      // is a well-hinted Windows fallback because JetBrains Mono is not bundled.
      fontFamily: "'JetBrains Mono', Consolas, 'Courier New', monospace",
      fontSize: '12px',
      color: '#D5D8E0',
      caretColor: '#7C5CFF',
    },
    '.cm-cursor': {
      borderLeftColor: '#7C5CFF',
    },
    '.cm-gutters': {
      background: '#0E0E12',
      border: 'none',
      color: 'rgba(255,255,255,0.2)',
    },
    '.cm-activeLineGutter': {
      background: 'rgba(255,255,255,0.03)',
    },
    '.cm-activeLine': {
      background: 'rgba(255,255,255,0.03)',
    },
    '.cm-selectionBackground, ::selection': {
      background: 'rgba(124,92,255,0.25) !important',
    },
    '.cm-focused .cm-selectionBackground': {
      background: 'rgba(124,92,255,0.25)',
    },
    '.cm-scroller': {
      overflow: 'auto',
      // Grayscale anti-aliasing instead of sub-pixel: crisper mono glyphs in WebView2.
      WebkitFontSmoothing: 'antialiased',
    },
    '.cm-matchingBracket': {
      background: 'rgba(124,92,255,0.2)',
      outline: '1px solid rgba(124,92,255,0.5)',
    },
  },
  { dark: true }
);

const highlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: '#C792EA' },
  { tag: tags.controlKeyword, color: '#C792EA' },
  { tag: tags.operatorKeyword, color: '#C792EA' },
  { tag: tags.definitionKeyword, color: '#C792EA' },
  { tag: tags.moduleKeyword, color: '#C792EA' },
  { tag: tags.string, color: '#C3E88D' },
  { tag: tags.special(tags.string), color: '#C3E88D' },
  { tag: tags.comment, color: '#5A6172', fontStyle: 'italic' },
  { tag: tags.lineComment, color: '#5A6172', fontStyle: 'italic' },
  { tag: tags.blockComment, color: '#5A6172', fontStyle: 'italic' },
  { tag: tags.function(tags.variableName), color: '#82AAFF' },
  { tag: tags.function(tags.propertyName), color: '#82AAFF' },
  { tag: tags.definition(tags.function(tags.variableName)), color: '#82AAFF' },
  { tag: tags.number, color: '#FFC76B' },
  { tag: tags.bool, color: '#FFC76B' },
  { tag: tags.null, color: '#FFC76B' },
  { tag: tags.typeName, color: '#82AAFF' },
  { tag: tags.className, color: '#82AAFF' },
  { tag: tags.propertyName, color: '#D5D8E0' },
  { tag: tags.operator, color: '#89DDFF' },
  { tag: tags.punctuation, color: '#D5D8E0' },
  { tag: tags.variableName, color: '#D5D8E0' },
  { tag: tags.self, color: '#C792EA' },
  { tag: tags.attributeName, color: '#FFC76B' },
  { tag: tags.attributeValue, color: '#C3E88D' },
  { tag: tags.tagName, color: '#F07178' },
]);

export const lazyTheme: Extension[] = [baseTheme, syntaxHighlighting(highlightStyle)];
