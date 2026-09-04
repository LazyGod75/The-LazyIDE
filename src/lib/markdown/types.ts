/* Markdown AST types — shared between the block parser, the inline
   tokenizer, and the React renderer (MarkdownRenderer.tsx).

   Deliberately NOT a full CommonMark AST: this covers exactly the feature
   set the app's two markdown surfaces need (assistant chat answers, the
   editor's .md file preview) — see parseMarkdown.ts's doc comment for the
   supported subset and documented simplifications. */

export type TableAlign = 'left' | 'center' | 'right' | null;

export type InlineNode =
  | { type: 'text'; value: string }
  | { type: 'code'; value: string }
  | { type: 'strong'; children: InlineNode[] }
  | { type: 'em'; children: InlineNode[] }
  | { type: 'link'; href: string; children: InlineNode[] }
  /** #node-id style brain citation ref — rendered as a CitationChip by
   *  callers that pass a `renderCitation` override (see MarkdownRenderer). */
  | { type: 'citation'; ref: string }
  /** Hard line break (line ending in "  " or "\") inside a paragraph. */
  | { type: 'break' };

export interface ListItemNode {
  children: BlockNode[];
}

export type BlockNode =
  | { type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; children: InlineNode[] }
  | { type: 'paragraph'; children: InlineNode[] }
  | {
      type: 'code';
      language: string;
      /** Explicit target file, present ONLY when the fence's own info
       *  string names one (e.g. "```tsx src/components/Foo.tsx") — see
       *  parseFenceInfo.ts. Never inferred from surrounding prose. */
      targetPath?: string;
      value: string;
    }
  | { type: 'list'; ordered: boolean; start?: number; items: ListItemNode[] }
  | { type: 'blockquote'; children: BlockNode[] }
  | {
      type: 'table';
      align: TableAlign[];
      header: InlineNode[][];
      rows: InlineNode[][][];
    }
  | { type: 'hr' };
