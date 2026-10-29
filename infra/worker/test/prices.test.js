import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHandler, config } from '../src/index.js';
import { SCHEMA, REPORT_LIMITS } from '../src/prices.js';

// Shared gas price reports on an in-memory SQLite database with D1's calling shape. Prices are SIMULATED.
const ORIGIN = 'https://altecbx.github.io';
const NOW = Date.UTC(2026, 9, 29, 15, 0);

function d1() {
  const sql = new DatabaseSync(':memory:');
  sql.exec(SCHEMA);
  const stmt = (q, args = []) => ({
    bind: (...a) => stmt(q, a),
    first: async () => sql.prepare(q).get(...args) ?? null,
    all: async () => ({ results: sql.prepare(q).all(...args) }),
    run: async () => ({ meta: { changes: Number(sql.prepare(q).run(...args).changes) } }),
  });
  return {
    sql,
    prepare: (q) => stmt(q),
    batch: async (list) => {
      sql.exec('BEGIN');
      try { const out = []; for (const s of list) out.push(await s.run()); sql.exec('COMMIT'); return out; } catch (e) { sql.exec('ROLLBACK'); throw e; }
    },
  };
}
const env = (extra = {}) => ({ ALLOWED_ORIGINS: ORIGIN, CLIENT_SALT: 's', PRICES_DB: d1(), ...extra });
const report = (over = {}) => ({ stationId: 'osm:n1', grade: 'R', price: 3.099, payment: 'credit', install: 'install-aaaa', near: true, ...over });
const post = (body, { ip = '203.0.113.5', raw } = {}) => new Request('https://proxy.test/v1/price-reports', {
  method: 'POST', body: raw ?? JSON.stringify(body), headers: { Origin: ORIGIN, 'CF-Connecting-IP': ip, 'Content-Type': 'application/json' },
});
const get = (stations) => new Request(`https://proxy.test/v1/price-reports?stations=${encodeURIComponent(stations)}`, { headers: { Origin: ORIGIN } });
const clock = (ms) => { let t = ms; return { now: () => t, set: (v) => { t = v; } }; };
const neverFetch = (calls) => async (url) => { calls.push(String(url)); throw new Error('no network in this test'); };

test('a report is checked, stored without position or IP, and read back with its source and time', async () => {
  const calls = [];
  const handle = createHandler({ fetchImpl: neverFetch(calls), now: () => NOW });
  const e = env();
  const res = await handle(post(report()), e);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
  const row = e.PRICES_DB.sql.prepare('SELECT * FROM reports').get();
  assert.deepEqual(Object.keys(row).sort(), ['client', 'grade', 'id', 'member', 'payment', 'price', 'reported_at', 'reporter', 'station']);
  assert.ok(!JSON.stringify(row).includes('203.0.113') && !JSON.stringify(row).includes('install-aaaa'), 'only hashes are kept');
  const out = await (await handle(get('osm:n1,osm:n2'), e)).json();
  assert.equal(out.reports.length, 1);
  const r = out.reports[0];
  assert.deepEqual({ stationId: r.stationId, grade: r.grade, price: r.price, payment: r.payment, member: r.member, reportedAt: r.reportedAt, currency: r.currency },
    { stationId: 'osm:n1', grade: 'R', price: 3.099, payment: 'credit', member: false, reportedAt: NOW / 1000, currency: 'USD' });
  assert.deepEqual(r.source, { id: 'community', name: 'ExitAtlas drivers', kind: 'community' });
  assert.equal(calls.length, 0, 'no paid or outside service is called');
});

test('the published reporter id differs from station to station', async () => {
  const handle = createHandler({ now: () => NOW });
  const e = env();
  await handle(post(report()), e);
  await handle(post(report({ stationId: 'osm:n2' })), e);
  const out = await (await handle(get('osm:n1,osm:n2'), e)).json();
  assert.equal(out.reports.length, 2);
  assert.notEqual(out.reports[0].reporter, out.reports[1].reporter);
});

test('reports without a location check, bad prices, grades or ids are refused', async () => {
  const handle = createHandler({ now: () => NOW });
  const e = env();
  const status = async (body, opts) => (await handle(post(body, opts), e)).status;
  assert.equal(await status(report({ near: false })), 403);
  assert.equal(await status(report({ near: 'yes' })), 403);
  assert.equal(await status(report({ install: 'x' })), 400);
  assert.equal(await status(report({ price: 0.99 })), 422);
  assert.equal(await status(report({ price: 31 })), 422);
  assert.equal(await status(report({ grade: 'E85' })), 422);
  assert.equal(await status(report({ payment: 'check' })), 422);
  assert.equal(await status(null, { raw: 'not json' }), 400);
  assert.equal(await status(null, { raw: JSON.stringify({ ...report(), pad: 'x'.repeat(3000) }) }), 413);
  assert.equal(e.PRICES_DB.sql.prepare('SELECT COUNT(*) AS n FROM reports').get().n, 0);
});

test('repeats are dropped and a correction within 30 minutes replaces the reporter\'s own report', async () => {
  const c = clock(NOW);
  const handle = createHandler({ now: c.now });
  const e = env();
  const count = () => e.PRICES_DB.sql.prepare('SELECT COUNT(*) AS n FROM reports').get().n;
  await handle(post(report()), e);
  c.set(NOW + 60_000);
  assert.equal((await (await handle(post(report()), e)).json()).duplicate, true);
  assert.equal(count(), 1);
  c.set(NOW + 5 * 60_000);
  assert.equal((await (await handle(post(report({ price: 3.199 })), e)).json()).corrected, true);
  assert.equal(count(), 1);
  assert.equal(e.PRICES_DB.sql.prepare('SELECT price FROM reports').get().price, 3.199);
  // The same price from another driver confirms it instead of repeating it.
  await handle(post(report({ price: 3.199, install: 'install-bbbb' }), { ip: '198.51.100.9' }), e);
  assert.equal(count(), 2);
  // Cash and credit are separate prices.
  await handle(post(report({ price: 3.099, payment: 'cash' })), e);
  assert.equal(count(), 3);
});

test('a price far from three or more current reports by others is refused', async () => {
  const handle = createHandler({ now: () => NOW });
  const e = env();
  for (const [i, p] of [3.09, 3.1, 3.11].entries()) {
    assert.equal((await handle(post(report({ price: p, install: `install-000${i}` }), { ip: `198.51.100.${i}` }), e)).status, 200);
  }
  const far = await handle(post(report({ price: 3.99, install: 'install-9999' }), { ip: '198.51.100.50' }), e);
  assert.equal(far.status, 422);
  assert.match((await far.json()).error, /far from the other current reports/);
  assert.equal((await handle(post(report({ price: 3.29, install: 'install-9999' }), { ip: '198.51.100.50' }), e)).status, 200);
});

test('daily budgets: per client, per install and for everyone; refused instead of exceeding the free plan', async () => {
  const handle = createHandler({ now: () => NOW });
  const e = env({ DAILY_PRICE_REPORTS: '3', CLIENT_DAILY_PRICE_REPORTS: '2' });
  const send = (station, ip, install = `install-${ip}`) => handle(post(report({ stationId: station, install }), { ip }), e);
  assert.equal((await send('osm:a', '1.1.1.1')).status, 200);
  assert.equal((await send('osm:b', '1.1.1.1')).status, 200);
  const third = await send('osm:c', '1.1.1.1');
  assert.equal(third.status, 429);
  assert.match((await third.json()).error, /your daily report limit/);
  // A new install id from the same address is still the same client.
  assert.equal((await send('osm:c', '1.1.1.1', 'install-fresh')).status, 429);
  assert.equal((await send('osm:c', '2.2.2.2')).status, 200);
  const everyone = await send('osm:d', '3.3.3.3');
  assert.equal(everyone.status, 429);
  assert.match((await everyone.json()).error, /budget for everyone is used up; it resets at midnight UTC/);
  // The next UTC day starts over.
  const next = createHandler({ now: () => NOW + 86_400_000 });
  assert.equal((await next(post(report({ stationId: 'osm:d', install: 'install-3.3.3.3' }), { ip: '3.3.3.3' }), e)).status, 200);
  const keys = e.PRICES_DB.sql.prepare('SELECT key FROM counters').all().map((r) => r.key).join(' ');
  assert.ok(!/1\.1\.1\.1|install-/.test(keys), 'counters hold hashes only');
});

test('lookups have a budget and limits on stations per request', async () => {
  const handle = createHandler({ now: () => NOW });
  const e = env({ DAILY_PRICE_READS: '2' });
  assert.equal((await handle(get('osm:a'), e)).status, 200);
  assert.equal((await handle(get('osm:b'), e)).status, 200);
  assert.equal((await handle(get('osm:c'), e)).status, 429);
  assert.equal((await handle(get(''), env())).status, 400);
  const many = Array.from({ length: REPORT_LIMITS.stationsPerRead + 1 }, (_, i) => `osm:n${i}`).join(',');
  assert.equal((await handle(get(many), env())).status, 400);
});

test('reports older than 7 days are deleted and never returned', async () => {
  const c = clock(NOW);
  const handle = createHandler({ now: c.now });
  const e = env();
  await handle(post(report()), e);
  c.set(NOW + 6 * 86_400_000);
  assert.equal((await (await handle(get('osm:n1'), e)).json()).reports.length, 1);
  c.set(NOW + 7 * 86_400_000 + 60_000);
  assert.equal((await (await handle(get('osm:n1'), e)).json()).reports.length, 0);
  await handle(post(report({ stationId: 'osm:n2' })), e);
  assert.equal(e.PRICES_DB.sql.prepare("SELECT COUNT(*) AS n FROM reports WHERE station = 'osm:n1'").get().n, 0);
});

test('off without a database, switchable off, and a database at its free limit means unavailable, not empty', async () => {
  const handle = createHandler({ now: () => NOW });
  assert.equal((await handle(get('osm:n1'), env({ PRICES_DB: undefined }))).status, 503);
  assert.equal(config(env()).community, true);
  assert.equal(config(env({ DISABLED: 'community' })).community, false);
  assert.equal((await handle(post(report()), env({ DISABLED: 'community' }))).status, 503);
  const exhausted = { prepare: () => { throw new Error('D1_ERROR: Exceeded maximum rows read for the day'); }, batch: async () => { throw new Error('D1_ERROR'); } };
  for (const req of [get('osm:n1'), post(report())]) {
    const res = await handle(req, env({ PRICES_DB: exhausted }));
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /unavailable right now/);
  }
});
