/* Helpers shared across more than one tool-handler domain module.
   Extracted from toolRuntime.ts as part of the executeTool split. */

import { joinPath } from '../../paths.js';

export function resolvePath(rootPath: string, relativePath: string): string {
  const rel = relativePath.replace(/^\.\//, '').replace(/^\//, '');
  return joinPath(rootPath, rel);
}
