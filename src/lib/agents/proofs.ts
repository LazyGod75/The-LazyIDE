/* proofs.ts — Proof-of-work artifact storage + Done-gate helpers (spec §8, T1.4).

   Two producers feed this module's ProofArtifact[] output:
     - Native (claude-code/codex, runtime.ts): parseProofBlocks scrapes
       ```PROOF:<kind> fenced blocks out of the mission's final transcript
       text (the agent is instructed to print them — see runtime.ts's
       buildProofContractBlock, which documents the exact per-kind format).
     - Managed (Pro tier, managedAgent.ts): the `attach_proof` ReAct tool
       calls buildProofArtifact directly, once per artifact, with args the
       model supplied.

   Both producers converge on the same pure buildProofArtifact() for
   shaping/validating a kind + loosely-typed fields into a ProofArtifact —
   single source of truth for "what counts as a valid proof", never
   duplicated between the transcript parser and the tool handler.

   Storage: artifacts live under `<projectRoot>/.lazy/artifacts/<missionId>/`
   — the STABLE project root, never the mission's ephemeral worktree, since
   a worktree can be discarded (unmerged mission) or is otherwise separate
   from the main checkout; `.lazy/` is already gitignored (see the existing
   sibling convention in artifacts.ts's MissionArtifacts, which uses the
   same repoPath-rooted `.lazy/artifacts` directory for a different purpose
   — full-mission JSON snapshots vs. this file's per-proof evidence files).

   Done gate: hasRequiredProofs/missingProofKinds compare a mission's
   contract.proofs (the ASK, ProofRequirement[]) against its own proofs (the
   PRODUCED evidence, ProofArtifact[]) — consumed by approveGate.ts to block
   Done until every required kind has at least one matching artifact.
*/

import { getPlatform } from '../platform/index.js';
import { joinPath } from '../paths.js';
import type { Mission, ProofArtifact, ProofRequirement } from './types.js';

// ── Constants ─────────────────────────────────────────────────────

/** Runtime mirror of ProofArtifact['kind'] (types are erased at runtime) —
 *  single source of truth for the regex alternation in parseProofBlocks and
 *  reused by runtime.ts's buildProofContractBlock so the prompt's
 *  documented kinds can never drift from what this module actually parses. */
export const PROOF_KINDS = [
  'screenshot',
  'test_run',
  'e2e_recording',
  'command_output',
  'behavior_diff',
] as const;

function proofBlockTemplate(kind: ProofRequirement['kind']): string {
  switch (kind) {
    case 'screenshot':
      return '```PROOF:screenshot\npath: <path to an image file you already wrote to disk>\nlabel: <short label describing what it shows>\n```';
    case 'test_run':
      return '```PROOF:test_run\ncommand: <exact command you ran>\nexit_code: <integer exit code>\n<raw command output, verbatim>\n```';
    case 'e2e_recording':
      return '```PROOF:e2e_recording\npath: <path to a recording/video file you already wrote to disk>\n```';
    case 'command_output':
      return '```PROOF:command_output\ncommand: <exact command you ran>\n<raw command output, verbatim>\n```';
    case 'behavior_diff':
      return '```PROOF:behavior_diff\nbefore: <one-line description of the behavior before your change>\nafter: <one-line description of the behavior after your change>\n```';
    default:
      return '';
  }
}

/** Prompt section for native missions that require proofs. Empty when none. */
export function buildProofContractBlock(proofRequirements?: ProofRequirement[]): string {
  if (!proofRequirements || proofRequirements.length === 0) return '';
  const kinds = Array.from(new Set(proofRequirements.map((r) => r.kind))).filter((k) =>
    (PROOF_KINDS as readonly string[]).includes(k),
  );
  if (kinds.length === 0) return '';
  const templates = kinds.map(proofBlockTemplate).join('\n\n');
  return `PROOF CONTRACT — this mission requires proof of work before it can be marked Done. Before your final message ends, print one fenced block per required kind below, in EXACTLY this format:

${templates}

Print a real block for each required kind (${kinds.join(', ')}) reflecting work you actually did — never fabricate a result you didn't produce. If a required kind is test_run, a test command that fails or errors (e.g. no test script configured) still satisfies it — print it as PROOF:test_run with the real command (best-effort exit_code if the exact value is unclear) rather than substituting a different kind.

`;
}

const ARTIFACTS_ROOT = '.lazy/artifacts';

/** Sentinel `exitCode` for a `test_run` proof whose real exit code couldn't
 *  be determined/parsed (see buildProofArtifact's `test_run` case below) —
 *  distinguishable from any real process exit code (always >= 0). */
export const UNKNOWN_EXIT_CODE = -1;

/** Defensive cap on how many proof blocks a single transcript parse will
 *  ever collect — protects against a runaway or adversarial transcript
 *  producing unbounded parsing work or an unbounded proofs array. */
const MAX_PARSED_PROOFS = 10;

// ── Paths ─────────────────────────────────────────────────────────

/** Directory a mission's proof artifacts live under: `<projectRoot>/.lazy/artifacts/<missionId>/`. */
export function proofsDir(projectRoot: string, missionId: string): string {
  const safeId = missionId.replace(/[^a-zA-Z0-9\-_]/g, '-');
  return joinPath(projectRoot, ARTIFACTS_ROOT, safeId);
}

/**
 * Persists text content (e.g. captured command output) under a mission's
 * proof directory, creating it first. Returns the full path written, for
 * use as a ProofArtifact's `outputPath`.
 */
export async function storeProofText(
  projectRoot: string,
  missionId: string,
  filename: string,
  content: string,
): Promise<string> {
  const platform = getPlatform();
  const dir = proofsDir(projectRoot, missionId);
  const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '-');
  const filePath = joinPath(dir, safeFilename);

  await platform.fs.createDir(dir);
  await platform.fs.writeFile(filePath, content);
  return filePath;
}

// ── Pure construction (shared by both producers) ───────────────────

/** Loosely-typed input to buildProofArtifact — every field arrives as
 *  `unknown` because both producers source them from untrusted input
 *  (JSON.parse'd tool ARGS for the managed loop, regex-captured text
 *  fields for the native transcript parser). `outputPath` is the one
 *  field the CALLER must resolve before calling this (via storeProofText)
 *  for the two kinds that carry stored output — this function itself never
 *  touches disk. */
export interface ProofBuildInput {
  kind: string;
  path?: unknown;
  label?: unknown;
  command?: unknown;
  exitCode?: unknown;
  outputPath?: unknown;
  before?: unknown;
  after?: unknown;
  /** Fallback source for `after` when only a generic `content` field was
   *  supplied (managed tool's minimal arg shape) — see managedAgent.ts. */
  content?: unknown;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function toExitCode(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  const parsed = Number.parseInt(String(v ?? ''), 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Validates + shapes loosely-typed fields into a ProofArtifact. Returns
 * null (never throws) when the kind is unrecognized or required fields for
 * that kind are missing/malformed — a defensive boundary since both
 * producers ultimately trust agent-generated content.
 *
 * No I/O: for `test_run`/`command_output`, the caller must already have
 * written the captured output (storeProofText) and pass the resulting path
 * as `outputPath` — see parseProofBlocks below and managedAgent.ts's
 * attach_proof handler for the two call sites.
 */
export function buildProofArtifact(input: ProofBuildInput): ProofArtifact | null {
  switch (input.kind) {
    case 'screenshot': {
      const path = str(input.path);
      const label = str(input.label);
      return path && label ? { kind: 'screenshot', path, label } : null;
    }
    case 'e2e_recording': {
      const path = str(input.path);
      return path ? { kind: 'e2e_recording', path } : null;
    }
    case 'behavior_diff': {
      const before = str(input.before);
      const after = str(input.after) ?? str(input.content);
      return before && after ? { kind: 'behavior_diff', before, after } : null;
    }
    case 'test_run': {
      const command = str(input.command);
      const outputPath = str(input.outputPath);
      // exitCode is best-effort, NOT load-bearing for validity: a command
      // that errored before producing a clean process exit (e.g. an npm CLI
      // usage error like "Missing script") still legitimately satisfies the
      // test_run proof requirement — hasRequiredProofs only checks *kind*
      // coverage and never inspects exitCode (see its doc comment below).
      // Previously an absent/unparsable exitCode nulled the WHOLE artifact
      // here, silently discarding a genuinely-declared test_run and forcing
      // the caller to fall back to a different kind — the root cause of
      // run-12/M14's "Preuves manquantes : test_run" false block (a real
      // `npm test` attempt was declared but dropped, so the only proof that
      // survived was an unrelated command_output). Falling back to
      // UNKNOWN_EXIT_CODE instead of null keeps the declared kind intact.
      const exitCode = toExitCode(input.exitCode) ?? UNKNOWN_EXIT_CODE;
      return command && outputPath
        ? { kind: 'test_run', command, exitCode, outputPath }
        : null;
    }
    case 'command_output': {
      const command = str(input.command);
      const outputPath = str(input.outputPath);
      return command && outputPath ? { kind: 'command_output', command, outputPath } : null;
    }
    default:
      return null;
  }
}

// ── Native transcript parsing ──────────────────────────────────────

/**
 * Splits a PROOF:<kind> block's inner text into recognized `key: value`
 * header lines and a trailing free-form body (the raw captured output, for
 * test_run/command_output). Parsing stops at the first line that isn't a
 * recognized "word: value" header; a single blank line immediately after
 * the last header (the header/body separator) is consumed rather than kept
 * as part of the body.
 */
function splitProofFields(inner: string): { fields: Record<string, string>; body: string } {
  const lines = inner.split(/\r?\n/);
  const fields: Record<string, string> = {};
  let i = 0;
  for (; i < lines.length; i++) {
    const kv = /^([a-zA-Z_]+):[ \t]?(.*)$/.exec(lines[i]);
    if (!kv) break;
    fields[kv[1]] = kv[2].trim();
  }
  if (i < lines.length && lines[i].trim() === '') i += 1;
  return { fields, body: lines.slice(i).join('\n').trim() };
}

/**
 * Parses ```PROOF:<kind> … ``` fenced blocks out of a native mission's
 * final transcript text (spec §8's proof-of-work contract — see
 * instructed to print). Defensive by design: malformed/incomplete blocks
 * are silently skipped (never throws), and collection stops once
 * MAX_PARSED_PROOFS artifacts have been found.
 *
 * The transcript's text protocol uses snake_case `exit_code:` (a plain-text
 * key, not JSON) — bridged to buildProofArtifact's camelCase `exitCode`
 * field here, the one place that translation happens.
 *
 * test_run/command_output bodies (the raw captured output) are persisted
 * via storeProofText — the only side effect this function has, which is
 * why it's async and takes projectRoot/missionId.
 */
export async function parseProofBlocks(
  transcript: string,
  projectRoot: string,
  missionId: string,
): Promise<ProofArtifact[]> {
  if (!transcript) return [];

  const blockRe = new RegExp('```PROOF:(' + PROOF_KINDS.join('|') + ')\\r?\\n([\\s\\S]*?)```', 'g');
  const proofs: ProofArtifact[] = [];
  let fileCounter = 0;
  let match: RegExpExecArray | null;

  while (proofs.length < MAX_PARSED_PROOFS && (match = blockRe.exec(transcript)) !== null) {
    const kind = match[1];
    const { fields, body } = splitProofFields(match[2]);

    try {
      let outputPath: string | undefined;
      if (kind === 'test_run' || kind === 'command_output') {
        fileCounter += 1;
        outputPath = await storeProofText(projectRoot, missionId, `${kind}-${fileCounter}.txt`, body);
      }
      const artifact = buildProofArtifact({
        kind,
        path: fields.path,
        label: fields.label,
        command: fields.command,
        exitCode: fields.exit_code,
        before: fields.before,
        after: fields.after,
        outputPath,
      });
      if (artifact) proofs.push(artifact);
    } catch {
      // Storing this block's output failed — skip this block only, never
      // abort the rest of the parse.
    }
  }

  return proofs;
}

// ── Mutation ────────────────────────────────────────────────────────

/** Immutably appends `proof` to `mission.proofs`, returning a new Mission. */
export function addProof(mission: Mission, proof: ProofArtifact): Mission {
  return { ...mission, proofs: [...(mission.proofs ?? []), proof] };
}

// ── Done gate ─────────────────────────────────────────────────────

type GateMission = Pick<Mission, 'contract' | 'proofs'>;

/**
 * True when `mission` may enter Done with respect to the proof-of-work gate
 * (spec §8): no contract, or an empty contract.proofs list, exempts the
 * mission entirely; otherwise every required kind must have at least one
 * matching produced artifact (extra/unrequested kinds are fine — this only
 * checks coverage of what was asked for, not an exact match).
 */
export function hasRequiredProofs(mission: GateMission): boolean {
  const required = mission.contract?.proofs;
  if (!required || required.length === 0) return true;

  const produced = mission.proofs ?? [];
  return required.every((req) => produced.some((p) => p.kind === req.kind));
}

/** The required proof kinds `mission` is still missing (empty when the
 *  gate is satisfied or the mission carries no proof requirements at all). */
export function missingProofKinds(mission: GateMission): string[] {
  const required = mission.contract?.proofs;
  if (!required || required.length === 0) return [];

  const produced = mission.proofs ?? [];
  const missing = required
    .filter((req: ProofRequirement) => !produced.some((p) => p.kind === req.kind))
    .map((req) => req.kind);

  return Array.from(new Set(missing));
}
