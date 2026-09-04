/**
 * `lazy brain search "<q>"` and `lazy brain recall "<q>"` commands.
 * Thin wrappers around the lazybrain CLI.
 */

import process from 'node:process';
import { type Command } from 'commander';
import { resolveBrainPath } from '../lib/paths.js';
import { brainSearch, brainRecall } from '../lib/brain.js';

export function registerBrain(program: Command): void {
  const brain = program
    .command('brain')
    .description('Brain operations (search, recall)');

  brain
    .command('search <query>')
    .description('Search the project brain (FTS + semantic)')
    .option('--top <n>', 'Max results', '5')
    .action((query: string, opts: { top: string }) => {
      const brainPath = resolveBrainPath(process.cwd());
      const result = brainSearch(brainPath, query, Number(opts.top));
      process.stdout.write(result);
      process.stdout.write('\n');
    });

  brain
    .command('recall <query>')
    .description('Recall context for a query (inject-context turn mode, stripped for LLM injection)')
    .action((query: string) => {
      const brainPath = resolveBrainPath(process.cwd());
      const result = brainRecall(brainPath, query);
      process.stdout.write(result);
      process.stdout.write('\n');
    });
}
