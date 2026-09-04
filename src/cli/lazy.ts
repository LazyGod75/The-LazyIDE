#!/usr/bin/env node
/**
 * Lazy CLI — headless entry point.
 *
 * Commands:
 *   lazy ask "<question>"            Brain-fused Q&A via Claude subscription
 *   lazy agent "<task>"              Autonomous Claude agent in a git worktree
 *   lazy brain search "<q>"          FTS search of the project brain
 *   lazy brain recall "<q>"          inject-context recall for LLM injection
 *
 * The CLI uses the SAME backends as the Lazy IDE GUI:
 *   - claude CLI (subscription auth, no API key) for model calls
 *   - lazybrain CLI for all brain operations
 *   - git CLI for worktree management
 *
 * Brain location: <cwd>/.lazybrain/brain (or LAZYBRAIN_BRAIN_PATH env var).
 */

import { Command } from 'commander';
import { registerAsk } from './commands/ask.js';
import { registerAgent } from './commands/agent.js';
import { registerBench } from './commands/bench.js';
import { registerOrchestrate } from './commands/orchestrate.js';
import { registerBrain } from './commands/brain.js';

// Injected at build time by scripts/build-cli.mjs via esbuild `define`, from
// package.json's "version" field (single source of truth: keeps `lazy --version`
// in sync with the product version). Undefined when running unbundled (e.g.
// `tsc`/`ts-node` in dev), so fall back to a dev marker.
declare const __LAZY_CLI_VERSION__: string;
const VERSION = typeof __LAZY_CLI_VERSION__ !== 'undefined' ? __LAZY_CLI_VERSION__ : '0.0.0-dev';

const program = new Command();

program
  .name('lazy')
  .description('Lazy IDE — headless CLI (brain + agent + ask)')
  .version(VERSION);

registerAsk(program);
registerAgent(program);
registerBench(program);
registerOrchestrate(program);
registerBrain(program);

program.parse(process.argv);
