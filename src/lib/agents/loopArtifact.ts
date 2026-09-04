/* loopArtifact.ts — Generic versioned "frozen once" artifact storage (spec §4
   gate 1: "figé une seule fois (le gabarit visuel, le format, le ton)").

   Deliberately content-agnostic: `content` is `unknown` — a design template,
   a tone-of-voice brief, a JSON schema, anything a charter's first gate
   validates. Never a domain-specific shape (no "carousel", no "slide", no
   social-network field) — the whole point of this module is that ANY
   recurring regime can freeze ANY reusable artifact through the exact same
   primitive.

   Append-only by design: freezing a new version never edits or removes a
   previous one (an approved v1 stays inspectable even after v2 is frozen),
   and a consumer (loopScheduler.ts) always reads the CURRENT version without
   ever triggering regeneration — reading is a pure file read, no LLM call,
   no side effect.

   `ownerId` is deliberately NOT required to be a loop's own missionId: the
   founder's own spec note (§4 "Cycle de vie complet") says a ONE-TIME task
   can still freeze a reusable artifact even though it never gets a
   trial/validated/autonomous regime — so this store is keyed by whatever id
   produced the artifact (a single validation mission, or a loop's own id),
   and a loop only needs to carry a REFERENCE to that id — the canonical
   `LoopConfig.templateArtifactRef` (lib/agents/types.ts), resolved via
   loopEngine.ts's `artifactOwnerIdForLoop`.
*/

import { getPlatform } from '../platform/index.js';
import { joinPath } from '../paths.js';

const ARTIFACTS_DIR = '.lazy/loop-artifacts';

function safeOwnerId(ownerId: string): string {
  return ownerId.replace(/[^a-zA-Z0-9\-_]/g, '-');
}

function artifactPath(ownerId: string): string {
  return `${ARTIFACTS_DIR}/${safeOwnerId(ownerId)}.json`;
}

export interface LoopArtifactVersion {
  version: number;
  /** Caller-defined generic label for WHAT was frozen (e.g. "template",
   *  "tone", "schema") — never a fixed enum, so this never needs updating
   *  for a new domain. */
  kind: string;
  /** The frozen artifact itself — fully generic, never validated against a
   *  domain-specific shape here. */
  content: unknown;
  label?: string;
  createdAt: string;
}

interface LoopArtifactStore {
  ownerId: string;
  versions: LoopArtifactVersion[];
}

async function readStore(repoPath: string, ownerId: string): Promise<LoopArtifactStore> {
  const platform = getPlatform();
  if (!platform?.fs) return { ownerId, versions: [] };
  try {
    const raw = await platform.fs.readFile(joinPath(repoPath, artifactPath(ownerId)));
    return JSON.parse(raw) as LoopArtifactStore;
  } catch {
    return { ownerId, versions: [] };
  }
}

async function writeStore(repoPath: string, store: LoopArtifactStore): Promise<void> {
  const platform = getPlatform();
  if (!platform?.fs) return;
  try {
    await platform.fs.createDir(joinPath(repoPath, ARTIFACTS_DIR));
    await platform.fs.writeFile(joinPath(repoPath, artifactPath(store.ownerId)), JSON.stringify(store, null, 2));
  } catch (err) {
    console.warn('[loopArtifact] Failed to persist:', err);
  }
}

/**
 * Freezes a NEW version of an artifact (spec §4 gate 1) — the ONE mutating
 * call in this module, meant to be invoked exactly once per real validation
 * (never by the loop scheduler itself, never on a cadence). Always appends;
 * never overwrites a prior version, so `getLoopArtifactVersion` keeps
 * resolving old versions after a new one lands.
 */
export async function freezeLoopArtifact(
  repoPath: string,
  ownerId: string,
  kind: string,
  content: unknown,
  label?: string,
): Promise<LoopArtifactVersion> {
  const store = await readStore(repoPath, ownerId);
  const nextVersion = store.versions.reduce((max, v) => Math.max(max, v.version), 0) + 1;
  const entry: LoopArtifactVersion = {
    version: nextVersion,
    kind,
    content,
    label,
    createdAt: new Date().toISOString(),
  };
  const updated: LoopArtifactStore = { ownerId, versions: [...store.versions, entry] };
  await writeStore(repoPath, updated);
  return entry;
}

/** The most recently frozen version — what a loop consumes every iteration
 *  WITHOUT regenerating it (spec: "jamais régénéré à chaque tour"). `null`
 *  when nothing has ever been frozen under this owner id. */
export async function getCurrentLoopArtifact(repoPath: string, ownerId: string): Promise<LoopArtifactVersion | null> {
  const store = await readStore(repoPath, ownerId);
  if (store.versions.length === 0) return null;
  return store.versions.reduce((latest, v) => (v.version > latest.version ? v : latest));
}

/** A specific historical version, or `null` if it was never frozen. */
export async function getLoopArtifactVersion(
  repoPath: string,
  ownerId: string,
  version: number,
): Promise<LoopArtifactVersion | null> {
  const store = await readStore(repoPath, ownerId);
  return store.versions.find((v) => v.version === version) ?? null;
}

/** Every version ever frozen under this owner id, oldest first. */
export async function listLoopArtifactVersions(repoPath: string, ownerId: string): Promise<LoopArtifactVersion[]> {
  const store = await readStore(repoPath, ownerId);
  return [...store.versions].sort((a, b) => a.version - b.version);
}
