/* parseFenceInfo — parses a fenced code block's info string (the text on
   the opening ``` line, e.g. "tsx" or "tsx src/components/Foo.tsx") into a
   language tag and an OPTIONAL explicit target path.

   Single source of truth for what counts as a "genuine, unambiguous
   target" for a chat code block (see MessageList.tsx's Apply-gating rule,
   DEFECT 2). The target is populated ONLY when the model names a file
   directly on the fence's own line — never inferred by scanning the
   surrounding prose. A second token is only treated as a path when it
   looks like one (a dotted extension), so incidental fence hints some
   models emit (e.g. "```tsx {1,3}" line-highlight ranges) are never
   misread as a target.

   Shared by assistantStore.tsx's parseContent (the FIRST fenced block,
   extracted into ChatMessage.codeBlock) and parseMarkdown.ts (any
   additional fenced blocks rendered inline in the answer body), so both
   paths agree on exactly the same rule. */

export interface FenceInfo {
  language: string;
  targetPath?: string;
}

const PATH_LIKE_RE = /^[\w.\-/]+\.[A-Za-z0-9]{1,10}$/;

export function parseFenceInfo(info: string): FenceInfo {
  const trimmed = info.trim();
  if (!trimmed) return { language: 'plaintext' };

  const [language, ...rest] = trimmed.split(/\s+/);
  const candidate = rest.join(' ').trim();
  if (candidate && PATH_LIKE_RE.test(candidate)) {
    return { language, targetPath: candidate };
  }
  return { language };
}
