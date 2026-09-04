/* artifacts.ts — Evidence/artifact persistence per mission.
   Stores full transcripts, diffs, verdicts, metrics, and brain context
   so missions can be reviewed and compared after completion.

   Inspired by Millrace's run artifacts concept — adapted for Lazy's
   .lazy/ directory convention.
*/

import { getPlatform } from '../platform/index.js';
import { joinPath } from '../paths.js';
import type { Mission, JudgeVerdict, AgentMetrics, ActionEvent } from '../agents/types.js';
import type { CompiledPlan } from './stageContract.js';
import type { LearningInsight } from './learningLoop.js';

// ── Types ─────────────────────────────────────────────────────────

export interface MissionArtifacts {
  missionId: string;
  createdAt: string;
  transcript: ActionEvent[];
  diffSnippet: string[];
  diffFiles: Mission['diffFiles'];
  judgeVerdict?: JudgeVerdict;
  agentMetrics?: AgentMetrics;
  brainCitations: Mission['brainCitations'];
  compiledPlan?: CompiledPlan;
  learningInsights?: LearningInsight[];
}

// ── Persistence ───────────────────────────────────────────────────

const ARTIFACTS_DIR = '.lazy/artifacts';

function artifactPath(missionId: string): string {
  const safeId = missionId.replace(/[^a-zA-Z0-9\-_]/g, '-');
  return `${ARTIFACTS_DIR}/${safeId}.json`;
}

// ── Public API ────────────────────────────────────────────────────

export async function saveArtifacts(
  repoPath: string,
  mission: Mission,
  extras?: { compiledPlan?: CompiledPlan; learningInsights?: LearningInsight[] },
): Promise<void> {
  const platform = getPlatform();
  if (!platform || !platform.fs) return;

  const artifacts: MissionArtifacts = {
    missionId: mission.id,
    createdAt: new Date().toISOString(),
    transcript: mission.actionTimeline ?? [],
    diffSnippet: mission.diffSnippet ?? [],
    diffFiles: mission.diffFiles,
    judgeVerdict: mission.judgeVerdict,
    agentMetrics: mission.agentMetrics,
    brainCitations: mission.brainCitations,
    compiledPlan: extras?.compiledPlan,
    learningInsights: extras?.learningInsights,
  };

  try {
    // joinPath (not a hardcoded '/') — repoPath is typically Rust's own
    // canonicalize() output (verbatim '\\?\'-prefixed on Windows); joining
    // with a literal '/' produced the mixed-separator string that made the
    // Rust fs commands reject this as "outside project root" even though
    // '.lazy/artifacts' existed on disk. See paths.ts's header comment.
    await platform.fs.createDir(joinPath(repoPath, ARTIFACTS_DIR));
    await platform.fs.writeFile(
      joinPath(repoPath, artifactPath(mission.id)),
      JSON.stringify(artifacts, null, 2),
    );
  } catch (err) {
    console.warn('[artifacts] Failed to save:', err);
  }
}

export async function loadArtifacts(repoPath: string, missionId: string): Promise<MissionArtifacts | null> {
  const platform = getPlatform();
  if (!platform || !platform.fs) return null;

  try {
    const raw = await platform.fs.readFile(joinPath(repoPath, artifactPath(missionId)));
    return JSON.parse(raw) as MissionArtifacts;
  } catch {
    return null;
  }
}

export async function listArtifacts(repoPath: string): Promise<string[]> {
  const platform = getPlatform();
  if (!platform || !platform.fs) return [];

  try {
    const entries = await platform.fs.readDir(joinPath(repoPath, ARTIFACTS_DIR));
    return entries
      .filter((e) => e.name.endsWith('.json') && !e.isDir)
      .map((e) => e.name.replace('.json', ''));
  } catch {
    return [];
  }
}
