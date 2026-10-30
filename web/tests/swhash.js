// APP_HASH in web/sw.js: SHA-256 over the app files the service worker precaches, one line per file
// ("file sha256", './' being index.html). The worker keeps a set only when it matches, and names its cache by it.
// After changing an app file: node web/tests/swhash.js --write
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SW = path.join(WEB, 'sw.js');

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/// The precached files listed in sw.js text.
export function appFiles(swText) {
  return [...swText.match(/const APP_FILES = \[([\s\S]*?)\];/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/// APP_HASH for these files; `read(file)` gives a file's bytes (by default from web/).
export function appHash(files, read = (f) => readFileSync(path.join(WEB, f === './' ? 'index.html' : f))) {
  return sha256(files.map((f) => `${f} ${sha256(read(f))}`).join('\n'));
}

/// The APP_HASH written in sw.js text.
export function writtenHash(swText) {
  return swText.match(/const APP_HASH = '([0-9a-f]{64})';/)?.[1] ?? null;
}

/// sw.js text with APP_HASH set to `hash`.
export function withHash(swText, hash) {
  return swText.replace(/const APP_HASH = '[0-9a-f]{64}';/, `const APP_HASH = '${hash}';`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const text = readFileSync(SW, 'utf8');
  const hash = appHash(appFiles(text));
  if (process.argv.includes('--write')) {
    writeFileSync(SW, withHash(text, hash));
    console.log(`web/sw.js APP_HASH = ${hash}`);
  } else {
    console.log(hash);
  }
}
