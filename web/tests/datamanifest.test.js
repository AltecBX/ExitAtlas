import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { validateManifest, chooseManifest, candidates, fileURL, loadVerified, usedManifest, SUPPORTED_SCHEMA } from '../js/engine/datamanifest.js';

const dataDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../App/ExitAtlas/Resources/Data');
const bundled = JSON.parse(readFileSync(path.join(dataDir, 'manifest.json'), 'utf8'));
const sha = (bytes) => createHash('sha256').update(Buffer.from(bytes)).digest('hex');
const base = new URL('https://example.test/Data/');

test('the bundled manifest matches every data file (rerun build_manifest.py after changing data)', () => {
  validateManifest(bundled);
  for (const name of ['states.eab', 'timezones.eab', 'interstates.eax', 'corridors.eac', 'restareas.json', 'discover.json', 'vehicles.json']) {
    const f = bundled.files[name];
    assert.ok(f, `${name} is listed`);
    const bytes = readFileSync(path.join(dataDir, name));
    assert.equal(f.bytes, bytes.length, `${name} size`);
    assert.equal(f.sha256, sha(bytes), `${name} hash`);
    assert.ok(f.source && f.license, `${name} carries its source and license`);
  }
  const lines = Object.keys(bundled.files).sort().map((n) => `${n} ${bundled.files[n].sha256}\n`).join('');
  assert.equal(bundled.content, sha(Buffer.from(lines)));
});

// Two versions of a small file, as a server would publish them.
const v1 = new TextEncoder().encode('{"meta":{"kind":"x"},"items":[1]}');
const v2 = new TextEncoder().encode('{"meta":{"kind":"x"},"items":[1,2]}');
const entry = (bytes) => ({ bytes: bytes.byteLength, sha256: sha(bytes), required: false });
const manifest = (version, bytes, schema = 1) => ({ kind: 'manifest', schema, version, content: 'c', files: { 'x.json': entry(bytes) } });
const io = (served, dropped = []) => ({
  fetchBytes: async (url) => {
    const body = served[url.href];
    if (!body) throw new Error('HTTP 404');
    return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
  },
  digestHex: async (b) => sha(new Uint8Array(b)),
  dropCached: async (url) => { dropped.push(url.href); },
});
const parse = (b) => JSON.parse(new TextDecoder().decode(b));

test('manifests this app cannot read, or older than the last good one, are not used', () => {
  assert.throws(() => validateManifest(manifest(1, v1, SUPPORTED_SCHEMA + 1)), /newer than this app reads/);
  assert.throws(() => validateManifest({ ...manifest(1, v1), files: { 'x.json': { bytes: 3, sha256: 'abc' } } }), /incomplete/);
  const old = manifest(202601010000, v1), cur = manifest(202610280000, v2);
  assert.equal(chooseManifest(cur, old).manifest, cur);
  assert.equal(chooseManifest(cur, old).fallback, old);
  // A stale copy (cache or server rollback) never replaces newer data that already worked.
  assert.equal(chooseManifest(old, cur).manifest, cur);
  // Unreadable or missing: keep using the last good one.
  assert.equal(chooseManifest(manifest(202612010000, v1, 9), cur).manifest, cur);
  assert.equal(chooseManifest(null, cur).manifest, cur);
  assert.equal(chooseManifest(null, null).manifest, null);
});

test('an update loads the new version when it checks out', async () => {
  const { manifest: m, fallback } = chooseManifest(manifest(2, v2), manifest(1, v1));
  const served = { [fileURL('x.json', m.files['x.json'], base).href]: v2, [fileURL('x.json', fallback.files['x.json'], base).href]: v1 };
  const r = await loadVerified('x.json', candidates('x.json', m, fallback), base, io(served), parse);
  assert.deepEqual(r.value.items, [1, 2]);
  assert.equal(r.rolledBack, false);
});

test('a corrupted, truncated or unreadable update rolls back to the last good version', async () => {
  const { manifest: m, fallback } = chooseManifest(manifest(2, v2), manifest(1, v1));
  const newURL = fileURL('x.json', m.files['x.json'], base).href, oldURL = fileURL('x.json', fallback.files['x.json'], base).href;
  const corrupted = new Uint8Array(v2); corrupted[5] ^= 1;
  for (const [bad, why] of [[corrupted, 'hash'], [v2.slice(0, 10), 'size'], [undefined, 'missing']]) {
    const dropped = [];
    const r = await loadVerified('x.json', candidates('x.json', m, fallback), base, io({ [newURL]: bad, [oldURL]: v1 }, dropped), parse);
    assert.deepEqual(r.value.items, [1], why);
    assert.equal(r.rolledBack, true, why);
    assert.deepEqual(dropped, [newURL], `${why}: the bad copy leaves the offline cache`);
    // The version that loaded is what gets remembered as last good.
    assert.equal(usedManifest(m, { 'x.json': r.entry }).files['x.json'].sha256, sha(v1));
  }
  // The file matches its hash but this app cannot parse it: also back to the old version.
  const r = await loadVerified('x.json', candidates('x.json', m, fallback), base, io({ [newURL]: v2, [oldURL]: v1 }),
    (b) => { const j = parse(b); if (j.items.length > 1) throw new Error('unknown format'); return j; });
  assert.equal(r.rolledBack, true);
});

test('with no good version left the load fails with every reason', async () => {
  const m = manifest(2, v2);
  await assert.rejects(loadVerified('x.json', candidates('x.json', m, null), base, io({}), parse), /x\.json: HTTP 404/);
  await assert.rejects(loadVerified('y.json', candidates('y.json', m, null), base, io({}), parse), /not in the data manifest/);
});

test('without Web Crypto only the size is checked', async () => {
  const m = manifest(2, v2);
  const r = await loadVerified('x.json', candidates('x.json', m, null), base,
    { ...io({ [fileURL('x.json', m.files['x.json'], base).href]: v2 }), digestHex: async () => null }, parse);
  assert.deepEqual(r.value.items, [1, 2]);
});
