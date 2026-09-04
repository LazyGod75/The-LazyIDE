import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
/**
 * Pre-download WASM ONNX models so the first run isn't slow.
 *
 * Models:
 *   - Xenova/paraphrase-multilingual-mpnet-base-v2  (~290 MB quantized, multilingual embeddings)
 *   - Xenova/ms-marco-MiniLM-L-6-v2  (~90 MB quantized, cross-encoder)
 *
 * This script is the explicit user consent for downloading models.
 * It always enables remote downloads regardless of LAZYBRAIN_ALLOW_REMOTE_MODELS,
 * because running this script IS the opt-in action.
 */
import { env, pipeline } from '@huggingface/transformers';

const modelsPath = process.env.LAZYBRAIN_MODELS_PATH ?? join(homedir(), '.lazybrain', 'models');
if (!existsSync(modelsPath)) mkdirSync(modelsPath, { recursive: true });

env.cacheDir = modelsPath;
env.localModelPath = modelsPath;
// This script IS the explicit consent — always allow downloads here.
env.allowRemoteModels = true;
env.allowLocalModels = true;

async function main(): Promise<void> {
  console.log(`Downloading models into: ${modelsPath}`);
  console.log('1/2 — paraphrase-multilingual-mpnet-base-v2 (~290 MB, multilingual embeddings)');
  await pipeline('feature-extraction', 'Xenova/paraphrase-multilingual-mpnet-base-v2', { dtype: 'q8' });
  console.log('2/2 — ms-marco-MiniLM-L-6-v2 (~90 MB, cross-encoder)');
  await pipeline('text-classification', 'Xenova/ms-marco-MiniLM-L-6-v2', { dtype: 'q8' });
  console.log('Done.');
}

main().catch((err) => {
  console.error('Model download failed:', err);
  process.exit(1);
});
