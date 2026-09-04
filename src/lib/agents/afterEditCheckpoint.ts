/* afterEditCheckpoint — undo checkpoint notice after a write.

   edit_file/multi_edit/write_file already snapshot the previous bytes on
   undoStack (files.ts). This only TELLS the model when that snapshot
   exists — never invents a checkpoint id, never claims undo for a newly
   created file that had no prior content.
*/

const EDIT_ACTIONS = new Set(['write_file', 'edit_file', 'multi_edit']);

export interface AfterEditCheckpointOpts {
  action: string;
  observation: string;
  files?: string[];
  hasCheckpoint: (path: string) => boolean;
}

export function appendAfterEditCheckpoint(opts: AfterEditCheckpointOpts): string {
  if (!EDIT_ACTIONS.has(opts.action)) return opts.observation;
  if (opts.observation.startsWith('ERROR:')) return opts.observation;
  const files = (opts.files ?? []).filter((path) => path && opts.hasCheckpoint(path));
  if (files.length === 0) return opts.observation;
  const listed = files.join(', ');
  return `${opts.observation}\n\nCheckpoint saved — call undo_edit on ${listed} to revert.`;
}
