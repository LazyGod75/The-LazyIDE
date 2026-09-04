/**
 * `lazy ask "<question>"` command.
 *
 * 1. Ensure project brain exists (lazybrain init if absent).
 * 2. Recall relevant context (inject-context turn mode).
 * 3. Build prompt: system + recalled context + question.
 * 4. Call claude CLI, stream answer to stdout.
 * 5. Capture Q&A as an episodic neuron in the brain.
 */

import process from 'node:process';
import { type Command } from 'commander';
import { resolveBrainPath } from '../lib/paths.js';
import { ensureBrainInit, brainRecall, brainStoreHtml } from '../lib/brain.js';
import { spawnClaude } from '../lib/claude.js';
import { buildNeuronHtml } from '../lib/neuron.js';

// NOTE: Claude Code CLI with a large system prefix triggers extended thinking
// and may suppress text output. Keep the prompt minimal — just the question
// optionally prepended with a brief brain context section.
const CONTEXT_HEADER = '[Brain context from LazyBrain project memory]';
const CONTEXT_FOOTER = '[End of brain context]';

export function registerAsk(program: Command): void {
  program
    .command('ask <question>')
    .description('Ask a question, answered using project brain context + Claude (subscription)')
    .option('--model <model>', 'Claude model alias (haiku/sonnet/opus)', 'haiku')
    .option('--backend <backend>', 'Model backend: claude|codex|key', 'claude')
    .option('--no-brain', 'Skip brain recall (raw LLM answer)')
    .action(async (question: string, opts: { model: string; backend: string; brain: boolean }) => {
      const cwd = process.cwd();
      const brainPath = resolveBrainPath(cwd);

      // 1. Ensure brain
      try {
        ensureBrainInit(brainPath);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[brain] init warning: ${msg}\n`);
      }

      // 2. Recall context
      let context = '';
      if (opts.brain !== false) {
        try {
          context = brainRecall(brainPath, question);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`[brain] recall warning: ${msg}\n`);
        }
      }

      // 3. Build prompt: keep minimal so Claude Code CLI doesn't suppress output.
      // Brain context (when present) is prepended as a lightweight header.
      const prompt = context
        ? `${CONTEXT_HEADER}\n${context}\n${CONTEXT_FOOTER}\n\n${question}`
        : question;

      // 4. Stream answer
      let answer = '';
      try {
        await spawnClaude(
          prompt,
          (chunk) => {
            process.stdout.write(chunk);
            answer += chunk;
          },
          { model: opts.model },
        );
        process.stdout.write('\n');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`\n[error] Claude call failed: ${msg}\n`);
        process.exit(1);
      }

      // 5. Capture Q&A into brain
      const html = buildNeuronHtml({
        kind: 'episodic',
        title: `CLI ask: ${question.slice(0, 60)}`,
        text: `Q: ${question}\n\nA: ${answer.slice(0, 800)}`,
        tags: ['cli', 'ask', 'lazy-cli'],
        source: 'lazy-cli:ask',
      });

      try {
        brainStoreHtml(brainPath, html);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[brain] store warning: ${msg}\n`);
      }
    });
}
