/* codeLiveFiles.ts — honest "which files are agents on right now" slice
   for the Code sidebar. Only real fleet diffFiles that findFileActivity
   matches — never a guessed path. Review/run/question/failed all surface,
   so a file in review is visible without expanding a collapsed project. */

import type { FleetProject } from './fleetMissions.js';
import {
  findFileActivity,
  basenameOf,
  type FileActivity,
  type FileActivityKind,
} from './codeFileActivity.js';
import { joinPath } from '../paths.js';

const KIND_RANK: Record<FileActivityKind, number> = {
  question: 0,
  failed: 1,
  review: 2,
  run: 3,
};

export interface CodeLiveFile {
  absPath: string;
  relPath: string;
  filename: string;
  projectName: string;
  activity: FileActivity;
}

function normalizeRel(reference: string): string {
  return reference.replace(/\\/g, '/').replace(/^\/+/, '');
}

function collectProjectLiveFiles(project: FleetProject, seen: Set<string>, out: CodeLiveFile[]): void {
  for (const mission of project.missions) {
    for (const diff of mission.diffFiles ?? []) {
      const filename = basenameOf(diff.filename);
      const relPath = normalizeRel(diff.filename);
      const activity = findFileActivity(relPath, filename, project.missions);
      if (!activity) continue;
      const key = `${project.root}::${relPath}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        absPath: joinPath(project.root, relPath),
        relPath,
        filename,
        projectName: project.name,
        activity,
      });
    }
  }
}

/** Unique files currently touched by the fleet, urgent kinds first. */
export function collectCodeLiveFiles(fleetProjects: readonly FleetProject[]): CodeLiveFile[] {
  const out: CodeLiveFile[] = [];
  const seen = new Set<string>();
  for (const project of fleetProjects) {
    collectProjectLiveFiles(project, seen, out);
  }
  out.sort((a, b) => KIND_RANK[a.activity.kind] - KIND_RANK[b.activity.kind]);
  return out;
}
