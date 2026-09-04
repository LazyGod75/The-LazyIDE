/**
 * Populate a temp brain with the recall-budget corpus and serve it on 7700
 * so Vite's /_api proxy (and the Brain UI) can hit a real sidecar.
 * Measurement fixture — not the user's vault. Kill the process to stop.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { composeFileNeuron } from '../src/annotator/blocks/composers/file-neuron.js';
import { runInit } from '../src/commands/init.js';
import { runServe } from '../src/commands/serve.js';
import type { CodeNode } from '../src/graph/code-scanner.js';
import { indexNote } from '../src/indexer/fts.js';
import { readNote } from '../src/store/reader.js';
import { writeNote } from '../src/store/writer.js';
import { resetConfigForTests } from '../src/util/config.js';

const SHARED = 'rotateRefreshToken';
const FILE_COUNT = 40;

function makeNode(i: number): CodeNode {
  const name = `mod${String(i).padStart(2, '0')}`;
  return {
    id: `file:src/${name}.ts`,
    title: `src/${name}.ts`,
    type: 'file',
    filePath: `src/${name}.ts`,
    projectRoot: '/fixture-project',
    language: 'typescript',
    lineCount: 80 + i,
    imports: [],
    exports: [SHARED, `${name}Handler`, `${name}Schema`, `parse${name}`],
  };
}

const tmpDir = mkdtempSync(join(tmpdir(), 'lb-recall-serve-'));
process.env.LAZYBRAIN_BRAIN_PATH = join(tmpDir, '.lazybrain', 'brain');
process.env.LAZYBRAIN_CACHE_PATH = join(tmpDir, '.lazybrain', '_cache');
process.env.LAZYBRAIN_MODELS_PATH = join(tmpDir, '.lazybrain', '_no-models-here');
resetConfigForTests();
await runInit({ path: join(tmpDir, '.lazybrain', 'brain') });

for (const node of Array.from({ length: FILE_COUNT }, (_, i) => makeNode(i))) {
  const html = composeFileNeuron(node);
  const written = writeNote(html, { overwrite: true });
  indexNote(readNote(written.path));
}

const server = await runServe({ port: 7700, bind: '127.0.0.1' });
const addr = server.address();
const port = typeof addr === 'object' && addr ? addr.port : 7700;
process.stdout.write(`recall-fixture ready port=${port} notes=${FILE_COUNT} brain=${process.env.LAZYBRAIN_BRAIN_PATH}\n`);
