// The service worker serves app files from one precached set per version (web/sw.js). The set must be the
// whole app, and APP_HASH must match the files: it is how browsers notice a deploy, how the worker refuses a
// set the host has only half updated, and the name of the version's cache. Stale, an update never arrives.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { WEB, appFiles, appHash, writtenHash } from './swhash.js';

const sw = readFileSync(path.join(WEB, 'sw.js'), 'utf8');
const files = appFiles(sw);

test('APP_HASH in sw.js matches the app files (after a change run: node web/tests/swhash.js --write)', () => {
  const hash = appHash(files);
  assert.equal(writtenHash(sw), hash, `web/sw.js needs const APP_HASH = '${hash}'; (node web/tests/swhash.js --write)`);
  assert.match(sw, /const CACHE = `exitatlas-v34-\$\{APP_HASH\.slice\(0, 12\)\}`;/, 'each version has its own cache');
});

test('the precached set is the whole app: the page, every module, its styles, font and icons', () => {
  for (const dir of ['js/app', 'js/engine']) {
    for (const f of readdirSync(path.join(WEB, dir)).filter((x) => x.endsWith('.js'))) assert.ok(files.includes(`${dir}/${f}`), `${dir}/${f} is precached`);
  }
  const page = readFileSync(path.join(WEB, 'index.html'), 'utf8');
  for (const [, href] of page.matchAll(/(?:href|src)="([^"#:]+)"/g)) assert.ok(files.includes(href), `${href} (from index.html) is precached`);
  assert.ok(files.includes('./') && files.includes('index.html'));
});
