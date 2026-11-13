// Security rules of the page (index.html) that code elsewhere must keep: the Content Security Policy forbids inline
// event handlers (the usual way injected markup runs script), plugins, a base tag, plain http data and script from
// other hosts, and nothing in the app relies on those, on javascript: links or on eval.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const web = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, web), 'utf8');
const html = read('index.html');
const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1] ?? '';
const sources = ['js/app', 'js/engine'].flatMap((d) => readdirSync(new URL(`${d}/`, web)).filter((f) => f.endsWith('.js')).map((f) => `${d}/${f}`));

test('the policy: no inline handlers, no plugins, no base, https data, no foreign script hosts but the Census lookup', () => {
  const d = Object.fromEntries(csp.split(';').map((x) => x.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));
  assert.ok(d['default-src'].includes("'self'") && !d['default-src'].includes('https:') && !d['default-src'].includes('*'));
  assert.deepEqual(d['script-src-attr'], ["'none'"]);
  assert.ok(!d['script-src'].includes('https:') && !d['script-src'].includes('*'));
  assert.deepEqual(d['script-src'].filter((x) => x.startsWith('http')), ['https://geocoding.geo.census.gov']);
  // No hash or nonce: either would switch 'unsafe-inline' off and with it a Safari extension's own script element.
  assert.ok(!d['script-src'].some((x) => /^'(sha\d+|nonce)-/.test(x)));
  assert.deepEqual(d['object-src'], ["'none'"]);
  assert.deepEqual(d['base-uri'], ["'none'"]);
  assert.ok(d['connect-src'].includes('https:') && !d['connect-src'].includes('http:') && !d['connect-src'].includes('*'));
  assert.ok(d['worker-src'].includes('blob:')); // the map library's worker
});

test('the Census address frame has one inline script and no inline handler', () => {
  const src = read('js/app/services.js');
  assert.ok(/export const CENSUS_FRAME_SCRIPT = /.test(src));
  assert.equal((src.match(/<script>/g) ?? []).length, 1, 'no other inline script');
});

test('nothing the policy forbids: no inline event handlers, javascript: links, eval or document.write', () => {
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(html), 'index.html has no inline script');
  assert.ok(!/\son[a-z]+\s*=/.test(html), 'index.html has no inline handler');
  for (const f of sources) {
    const s = read(f);
    assert.ok(!/\son(click|error|load|input|change|submit|focus|blur|key\w+|pointer\w+|touch\w+|mouse\w+)\s*=\s*["'`$\\]/.test(s), `${f}: inline event handler in a template`);
    assert.ok(!/javascript:/i.test(s), `${f}: javascript: URL`);
    assert.ok(!/\beval\(|new Function\(|document\.write\(/.test(s), `${f}: eval, Function or document.write`);
  }
});

test('every link that opens a new tab cuts the opener', () => {
  for (const f of [...sources, 'index.html']) {
    for (const tag of read(f).match(/<a\b[^>]*target="_blank"[^>]*>/g) ?? []) assert.ok(/rel="noopener/.test(tag), `${f}: ${tag.slice(0, 80)}`);
  }
});
