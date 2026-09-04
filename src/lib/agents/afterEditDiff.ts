/* afterEditDiff — show-the-diff after a successful edit.

   After write_file/edit_file/multi_edit, append the real git diff of the
   touched files so the model sees what actually landed. Never invents a
   patch: empty / "No changes" / ERROR are omitted. Bounded: 3 files,
   1.5s each, 800 chars total.
*/

const EDIT_ACTIONS = new Set(['write_file', 'edit_file', 'multi_edit']);
const MAX_FILES = 3;
const MAX_CHARS = 800;
export const AFTER_EDIT_DIFF_TIMEOUT_MS = 1500;

export interface AfterEditDiffOpts {
  action: string;
  observation: string;
  files?: string[];
  diffFile: (path: string) => Promise<string>;
}

function isUsableDiff(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/^no changes$/i.test(t)) return false;
  if (t.startsWith('ERROR:')) return false;
  return true;
}

async function diffOne(
  path: string,
  diffFile: (path: string) => Promise<string>,
): Promise<string | null> {
  try {
    const result = await Promise.race([
      diffFile(path),
      new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), AFTER_EDIT_DIFF_TIMEOUT_MS);
      }),
    ]);
    if (result === null || !isUsableDiff(result)) return null;
    return result.trim();
  } catch {
    return null;
  }
}

async function collectDiffBlocks(
  files: string[],
  diffFile: (path: string) => Promise<string>,
): Promise<string[]> {
  const blocks: string[] = [];
  let used = 0;
  for (const path of files) {
    const text = await diffOne(path, diffFile);
    if (!text) continue;
    const block = `After-edit diff (${path}):\n${text}`;
    if (used + block.length > MAX_CHARS) break;
    blocks.push(block);
    used += block.length;
  }
  return blocks;
}

export async function appendAfterEditDiff(opts: AfterEditDiffOpts): Promise<string> {
  if (!EDIT_ACTIONS.has(opts.action)) return opts.observation;
  if (opts.observation.startsWith('ERROR:')) return opts.observation;
  const files = (opts.files ?? []).filter(Boolean).slice(0, MAX_FILES);
  if (files.length === 0) return opts.observation;
  const blocks = await collectDiffBlocks(files, opts.diffFile);
  if (blocks.length === 0) return opts.observation;
  return `${opts.observation}\n\n${blocks.join('\n\n')}`;
}
