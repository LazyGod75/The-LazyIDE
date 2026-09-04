import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { closeDb } from '../indexer/fts.js';
import { batchesDir, knowledgeNodesDir, metaDir, notesDir } from '../store/paths.js';
import { brainRoot } from '../store/paths.js';
import { getConfig } from '../util/config.js';
import { getLogger } from '../util/logger.js';
import { isProcessAlive, pingDaemon, readDaemonPid, readDaemonPort } from './daemon.js';

/**
 * Return true when a LazyBrain daemon is currently running (pid alive + /health ping).
 * This is a best-effort check: if we cannot determine the answer we return false
 * so we never block a wipe due to a stale lock file.
 */
async function isDaemonRunning(): Promise<boolean> {
  const port = readDaemonPort();
  const pid = readDaemonPid();
  if (!port || !pid) return false;
  if (!isProcessAlive(pid)) return false;
  return await pingDaemon(port, 500);
}

/**
 * Produce a dry-run summary of what wipe would delete.
 */
function buildDryRunSummary(cfg: ReturnType<typeof getConfig>): string {
  const notes = notesDir();
  let noteCount = 0;
  if (existsSync(notes)) {
    for (const partition of readdirSync(notes)) {
      const partPath = join(notes, partition);
      try {
        noteCount += readdirSync(partPath).filter((f) => f.endsWith('.html')).length;
      } catch {
        // ignore unreadable dirs
      }
    }
  }
  const dirs = [batchesDir(), metaDir(), join(brainRoot(), 'clusters'), cfg.cachePath].filter((d) =>
    existsSync(d),
  );
  return `Would delete: ${noteCount} notes, ${dirs.length} dirs (batches, meta, clusters, cache), cache at ${cfg.cachePath}.\nRe-run with --yes to confirm.`;
}

/**
 * Delete a file or directory with exponential backoff on Windows EBUSY/EPERM locks.
 * Retries 3 times (10ms, 50ms, 100ms), then falls back to truncating the file.
 * Returns true on success, false if the file could not be removed (but was truncated).
 */
function deleteWithRetry(filePath: string): boolean {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (statSync(filePath).isDirectory()) {
        rmSync(filePath, { recursive: true, force: true });
      } else {
        unlinkSync(filePath);
      }
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const isLocked = code === 'EBUSY' || code === 'EPERM';
      if (!isLocked) throw err;
      if (attempt < 2) {
        // Busy-wait with increasing delays: 10ms, 50ms
        const ms = 10 * 5 ** attempt;
        const until = Date.now() + ms;
        while (Date.now() < until) {
          /* busy wait */
        }
      }
    }
  }
  // Final fallback: truncate the file so the next DB open works on a blank slate
  try {
    writeFileSync(filePath, '');
    return true;
  } catch {
    return false;
  }
}

export interface WipeOptions {
  pretty?: boolean;
  /** Must be explicitly set to true to perform deletion (guards against accidental wipes). */
  yes?: boolean;
}

export interface WipeReport {
  notesDeleted: number;
  knowledgeNodesDeleted: number;
  artifactsDeleted: number;
  cacheDeleted: number;
  errors: string[];
}

export async function runWipe(opts: WipeOptions): Promise<WipeReport> {
  const log = getLogger();
  const cfg = getConfig();

  // Guard: refuse when a daemon is running (it would keep serving stale data).
  if (await isDaemonRunning()) {
    const msg = 'A LazyBrain daemon is running — stop it first: lazybrain daemon stop';
    log.warn(msg);
    throw new Error(msg);
  }

  // Guard: require explicit --yes flag.
  if (!opts.yes) {
    const summary = buildDryRunSummary(cfg);
    process.stdout.write(`${summary}\n`);
    const exitErr = new Error('Wipe aborted: re-run with --yes to confirm.');
    (exitErr as NodeJS.ErrnoException).code = 'WIPE_NO_CONFIRM';
    throw exitErr;
  }
  const report: WipeReport = {
    notesDeleted: 0,
    knowledgeNodesDeleted: 0,
    artifactsDeleted: 0,
    cacheDeleted: 0,
    errors: [],
  };

  const notesPath = notesDir();
  if (existsSync(notesPath)) {
    const partitions = readdirSync(notesPath).filter((d) => {
      const full = join(notesPath, d);
      try {
        return readdirSync(full).length >= 0;
      } catch {
        return false;
      }
    });
    for (const partition of partitions) {
      const partPath = join(notesPath, partition);
      try {
        const files = readdirSync(partPath).filter((f) => f.endsWith('.html'));
        for (const file of files) {
          unlinkSync(join(partPath, file));
          report.notesDeleted++;
        }
        try {
          rmSync(partPath, { recursive: true, force: true });
        } catch {
          // partition dir may already be gone — ignore
        }
      } catch (err) {
        report.errors.push(`${partition}: ${(err as Error).message}`);
      }
    }
  }

  // Also wipe knowledge-nodes/ directory (hierarchy nodes)
  const knDir = knowledgeNodesDir();
  if (existsSync(knDir)) {
    try {
      const files = readdirSync(knDir).filter((f) => f.endsWith('.html'));
      for (const file of files) {
        try {
          unlinkSync(join(knDir, file));
          report.knowledgeNodesDeleted++;
        } catch (err) {
          report.errors.push(`knowledge-nodes/${file}: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      report.errors.push(`knowledge-nodes: ${(err as Error).message}`);
    }
  }

  // Delete batches/ directory
  const batchesPath = batchesDir();
  if (existsSync(batchesPath)) {
    try {
      rmSync(batchesPath, { recursive: true, force: true });
      report.artifactsDeleted++;
    } catch (err) {
      report.errors.push(`batches: ${(err as Error).message}`);
    }
  }

  // Delete meta/ directory
  const metaPath = metaDir();
  if (existsSync(metaPath)) {
    try {
      rmSync(metaPath, { recursive: true, force: true });
      report.artifactsDeleted++;
    } catch (err) {
      report.errors.push(`meta: ${(err as Error).message}`);
    }
  }

  // Delete clusters/ directory
  const root = brainRoot();
  const clustersPath = join(root, 'clusters');
  if (existsSync(clustersPath)) {
    try {
      rmSync(clustersPath, { recursive: true, force: true });
      report.artifactsDeleted++;
    } catch (err) {
      report.errors.push(`clusters: ${(err as Error).message}`);
    }
  }

  // Delete brain-level artifact files: _index.html, _user-profile.html, graph.html, graph.txt
  const brainArtifacts = ['_index.html', '_user-profile.html', 'graph.html', 'graph.txt'];
  for (const artifact of brainArtifacts) {
    const artifactPath = join(root, artifact);
    if (existsSync(artifactPath)) {
      try {
        unlinkSync(artifactPath);
        report.artifactsDeleted++;
      } catch (err) {
        report.errors.push(`${artifact}: ${(err as Error).message}`);
      }
    }
  }

  // Recreate empty notes/ directory so subsequent dream does not fail on mkdir
  if (!existsSync(notesPath)) {
    try {
      mkdirSync(notesPath, { recursive: true });
    } catch (err) {
      report.errors.push(`notes dir recreate: ${(err as Error).message}`);
    }
  }

  // Close the SQLite database before deleting cache files to release the lock.
  closeDb();

  const cacheDir = cfg.cachePath;
  if (existsSync(cacheDir)) {
    const files = readdirSync(cacheDir);
    for (const file of files) {
      const filePath = join(cacheDir, file);
      try {
        const deleted = deleteWithRetry(filePath);
        if (deleted) {
          report.cacheDeleted++;
        } else {
          report.errors.push(`cache/${file}: locked — could not delete (truncated instead)`);
        }
      } catch (err) {
        report.errors.push(`cache/${file}: ${(err as Error).message}`);
      }
    }
  }

  log.info(
    report,
    'wipe complete — conversation fingerprints reset; the next dream will reprocess all conversations',
  );
  return report;
}
