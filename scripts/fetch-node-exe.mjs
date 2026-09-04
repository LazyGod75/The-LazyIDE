#!/usr/bin/env node
/**
 * Downloads node.exe (win32-x64, v20 LTS) from the official Node.js distribution
 * and places it at src-tauri/resources/node.exe for Tauri bundling.
 *
 * This script runs on any OS; it downloads the win32-x64 binary specifically.
 * Skip if node.exe is already present.
 */

import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import https from 'node:https';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DEST = join(ROOT, 'src-tauri', 'resources', 'node.exe');

// Node.js 20 LTS win32-x64 standalone binary
const NODE_VERSION = '20.12.2';
const NODE_URL = `https://nodejs.org/dist/v${NODE_VERSION}/win-x64/node.exe`;

if (existsSync(DEST)) {
  console.log(`node.exe already exists at ${DEST} — skipping download`);
  process.exit(0);
}

mkdirSync(join(ROOT, 'src-tauri', 'resources'), { recursive: true });

console.log(`Downloading node v${NODE_VERSION} win32-x64...`);
console.log(`  From : ${NODE_URL}`);
console.log(`  To   : ${DEST}`);

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    let received = 0;

    function request(u) {
      https.get(u, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          // Follow redirect
          return request(res.headers.location);
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${u}`));
          return;
        }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        res.on('data', (chunk) => {
          received += chunk.length;
          if (total > 0) {
            const pct = ((received / total) * 100).toFixed(1);
            process.stdout.write(`\r  ${pct}% (${(received / 1024 / 1024).toFixed(1)} MB)`);
          }
        });
        res.pipe(file);
        file.on('finish', () => {
          file.close();
          process.stdout.write('\n');
          resolve();
        });
      }).on('error', reject);
    }

    request(url);
    file.on('error', reject);
  });
}

try {
  await download(NODE_URL, DEST);
  console.log('Done.');
} catch (err) {
  console.error('Download failed:', err.message);
  process.exit(1);
}
