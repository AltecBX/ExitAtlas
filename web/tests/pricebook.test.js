// The driver's price reports on the device and shared reports from the owner's server (app/pricebook.js).
// Prices are SIMULATED.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PriceBook } from '../js/app/pricebook.js';

const memoryStore = () => {
  const m = new Map();
  return { map: m, get: (k, f = null) => (m.has(k) ? JSON.parse(m.get(k)) : f), set: (k, v) => { m.set(k, JSON.stringify(v)); return true; } };
};
const T0 = Date.UTC(2026, 9, 29, 15, 0);
const report = (over = {}) => ({ stationId: 'way/1', grade: 'R', price: 3.099, payment: 'credit', member: false, stationName: 'Shell', place: 'Exit 209', ...over });

test('own reports work without a server: saved, checked, corrected, deleted, never with a position', async () => {
  let now = T0;
  const store = memoryStore();
  const calls = [];
  const book = new PriceBook({ store, now: () => now, fetchImpl: async (u) => { calls.push(String(u)); throw new Error('no network'); } });
  const a = await book.report({ ...report(), lat: 30.1, lon: -81.6 });
  assert.equal(a.ok, true);
  assert.equal(a.shared, null);
  const stored = JSON.parse(store.map.get('ea.priceReports'));
  assert.equal(stored.length, 1);
  assert.ok(!('lat' in stored[0]) && !('source' in stored[0]));
  assert.deepEqual(book.records('way/1').map((r) => [r.price, r.source.kind]), [[3.099, 'own']]);
  // The same price again is the same report; a new price within 30 minutes corrects it.
  now += 60_000;
  assert.equal((await book.report(report())).duplicate, true);
  now += 5 * 60_000;
  await book.report(report({ price: 3.199 }));
  assert.deepEqual(book.own().map((r) => r.price), [3.199]);
  // Bad input is refused with reasons.
  assert.deepEqual((await book.report(report({ price: 31 }))).problems, ['price out of range']);
  assert.deepEqual((await book.report(report({ grade: 'E85' }))).problems, ['grade']);
  // Expired after 7 days.
  now += 8 * 86_400_000;
  assert.equal(book.own().length, 0);
  now = T0 + 10 * 60_000;
  book.remove(book.own()[0].id);
  assert.equal(book.own().length, 0);
  assert.equal(calls.length, 0, 'nothing is sent without shared reports on');
});

test('own reports can be left out of comparisons with the switch', async () => {
  const book = new PriceBook({ store: memoryStore(), now: () => T0, sources: () => ({ own: false, shared: false }) });
  await book.report(report());
  assert.equal(book.own().length, 1);
  assert.equal(book.records('way/1').length, 0);
});

test('shared reports: off by default, sent only after the location check, read back without the own copy', async () => {
  const store = memoryStore();
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push({ url: String(url), init });
    if (init?.method === 'POST') return { ok: true, status: 200, json: async () => ({ ok: true, id: 'srv1' }) };
    return { ok: true, status: 200, json: async () => ({ reports: [
      { id: 'srv1', stationId: 'way/1', grade: 'R', price: 3.099, payment: 'credit', member: false, reportedAt: T0 / 1000, reporter: 'aaa', source: {} },
      { id: 'srv2', stationId: 'way/1', grade: 'R', price: 3.089, payment: 'credit', member: false, reportedAt: T0 / 1000 - 60, reporter: 'bbb', source: {} },
      { id: 'bad', stationId: 'way/1', grade: 'R', price: 99, payment: 'credit', member: false, reportedAt: T0 / 1000, reporter: 'ccc' },
    ] }) };
  };
  let shared = false;
  const book = new PriceBook({ store, now: () => T0, getProxy: () => new URL('https://proxy.example/'), sources: () => ({ own: true, shared }), fetchImpl });
  assert.equal(book.sharedOn, false);
  assert.equal(await book.loadShared(['way/1']), false);
  assert.equal(sent.length, 0);
  shared = true;
  const notNear = await book.report(report(), { share: true, near: false });
  assert.match(notNear.shared, /location check/);
  assert.equal(sent.length, 0, 'not sent without the location check');
  const near = await book.report(report({ price: 3.109 }), { share: true, near: true });
  assert.equal(near.shared, 'sent');
  const body = JSON.parse(sent[0].init.body);
  assert.deepEqual(Object.keys(body).sort(), ['grade', 'install', 'member', 'near', 'payment', 'price', 'stationId']);
  assert.equal(body.install.length, 24);
  assert.equal(await book.loadShared(['way/1']), true);
  const rec = book.records('way/1');
  assert.deepEqual(rec.map((r) => r.id).sort(), [book.own()[0].id, 'srv2'], 'the shared copy of my report and the bad price are left out');
  assert.equal(rec.find((r) => r.id === 'srv2').source.kind, 'community');
  // Asked again only after a few minutes.
  assert.equal(await book.loadShared(['way/1']), false);
});

test('a failed shared lookup is "unavailable", never an empty answer', async () => {
  let now = T0;
  const book = new PriceBook({ store: memoryStore(), now: () => now, getProxy: () => new URL('https://proxy.example/'), sources: () => ({ own: true, shared: true }),
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({ error: 'shared price reports are unavailable right now' }) }) });
  assert.equal(book.sharedState, 'ok');
  assert.equal(await book.loadShared(['way/1']), false);
  assert.equal(book.sharedState, 'unavailable');
  assert.match(book.sharedError.message, /unavailable right now/);
  now += 10 * 60_000;
  assert.equal(book.sharedState, 'ok');
});

test('simulated demo prices are never stored', async () => {
  const store = memoryStore();
  const book = new PriceBook({ store, now: () => T0 });
  book.simulated = [{ id: 'sim:1', stationId: 'way/1', grade: 'R', price: 3.0, payment: 'credit', member: false, reportedAt: T0 / 1000, source: { kind: 'simulated' } }];
  assert.equal(book.records('way/1').length, 1);
  assert.equal(store.map.has('ea.priceReports'), false);
});
