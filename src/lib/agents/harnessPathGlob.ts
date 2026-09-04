/* harnessPathGlob.ts — simple glob match for harness rule pathGlob.
   Extracted from harnessRules.ts (matchPathGlob cyclomatic complexity 15,
   ratchet ceiling 12). Same semantics, including Windows verbatim-prefix
   stripping so a `\\?\C:\...` worktree path still matches `src/**`. */

import { stripVerbatimPrefix } from '../paths.js';

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

type GlobStep = { gi: number; pi: number } | boolean;

function consumeGlobSeg(globSegs: string[], pathSegs: string[], gi: number, pi: number): GlobStep {
  if (globSegs[gi] === '**') {
    if (gi === globSegs.length - 1) return true;
    for (let k = pi; k < pathSegs.length; k++) {
      if (globSegs[gi + 1] === pathSegs[k]) return true;
    }
    return false;
  }
  if (globSegs[gi] === '*') {
    if (pathSegs[pi].length === 0) return false;
    return { gi: gi + 1, pi: pi + 1 };
  }
  if (!globSegs[gi].includes('*')) {
    if (globSegs[gi] !== pathSegs[pi]) return false;
    return { gi: gi + 1, pi: pi + 1 };
  }
  const re = new RegExp(`^${globSegs[gi].split('*').map(escapeRegex).join('.*')}$`);
  if (!re.test(pathSegs[pi])) return false;
  return { gi: gi + 1, pi: pi + 1 };
}

function matchGlobSegments(globSegs: string[], pathSegs: string[]): boolean {
  let gi = 0;
  let pi = 0;
  while (gi < globSegs.length && pi < pathSegs.length) {
    const step = consumeGlobSeg(globSegs, pathSegs, gi, pi);
    if (step === true) return true;
    if (step === false) return false;
    gi = step.gi;
    pi = step.pi;
  }
  return gi === globSegs.length && pi === pathSegs.length;
}

/** Match a simple glob (supports `**`, `*`, no braces) against a path. */
export function matchPathGlob(glob: string | undefined, path: string | undefined): boolean {
  if (!glob) return true;
  if (!path) return false;
  return matchGlobSegments(
    glob.replace(/\\/g, '/').split('/'),
    stripVerbatimPrefix(path).replace(/\\/g, '/').split('/'),
  );
}
