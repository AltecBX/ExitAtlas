// Shared gas price reports from ExitAtlas drivers (docs/17), on Cloudflare D1 (Workers Free and D1 Free:
// no payment method, and a Free plan request or query over its limit fails instead of being billed). Off
// unless the owner binds a D1 database as PRICES_DB (README). The rules are the app's own
// (web/js/engine/gasprices.js); the server adds what a device cannot do alone:
//   - only reports with a location check at the station (the app sends near: true); the position is
//     never sent or stored
//   - daily budgets for everyone, per client (hashed IP) and per install (hashed random id), well under
//     the free limits, so a flood stops at the budget instead of the plan's limit
//   - repeats are dropped, corrections within 30 minutes replace the reporter's own report, and a price far
//     from the station's other current reports is refused
//   - reports expire after 7 days; nothing but the station, grade, price, payment kind and time is kept,
//     and the reporter id published is a hash of the install and the station, so one device's reports
//     cannot be linked from station to station
import { validateReport, PRICE_RULES, PRICE_GRADES } from '../../../web/js/engine/gasprices.js';

export const REPORT_LIMITS = Object.freeze({
  /// Reports accepted per day, everyone together, per client (hashed IP) and per install.
  daily: 2000,
  clientDaily: 20,
  installDaily: 20,
  /// Report lookups per day (not cached, so a new report reaches other drivers at once). With rowsPerRead
  /// that is at most 2.5 million rows read, half of D1 Free's 5 million a day.
  dailyReads: 5000,
  /// Lookups per day for one client (hashed IP), so one client cannot use up everyone's lookups.
  clientDailyReads: 600,
  /// Every this many lookups, reports and counters past their keep time are deleted (also on each accepted report).
  cleanEvery: 200,
  /// Current reports read for the outlier check, newest first.
  outlierRows: 60,
  /// Stations per lookup, and reports per answer.
  stationsPerRead: 50,
  rowsPerRead: 500,
  /// A price this far (dollars) from the median of three or more current reports for the station is refused.
  outlierDollars: 0.5,
});

const SOURCE = { id: 'community', name: 'ExitAtlas drivers', kind: 'community' };

const limit = (env, name, fallback) => {
  const v = Number(env[name]);
  return Number.isFinite(v) && v >= 0 && env[name] !== undefined && env[name] !== '' ? v : fallback;
};

/// One call counted on a D1 counter in a single statement (no read then write, so calls at the same moment
/// cannot both slip under a limit). Returns the count including this call.
export async function countCall(db, key, day) {
  const row = await db.prepare('INSERT INTO counters (key, day, n) VALUES (?, ?, 1) ON CONFLICT(key) DO UPDATE SET n = n + 1 RETURNING n')
    .bind(`${day}:${key}`, day).first();
  const n = Number(row?.n);
  if (!Number.isFinite(n)) throw new Error('counter unavailable');
  return n;
}

/// Counts against the day's budgets (D1 counters, deleted after two days), in the order given: put a client's
/// own limits first, so a client past its limit stops there and never uses up the budget everyone shares.
/// Returns {over: message} when one is used up, else {over: null, counts}.
export async function spend(db, keys, nowMs, day = new Date(nowMs).toISOString().slice(0, 10)) {
  const counts = [];
  for (const [k, max, message] of keys) {
    const n = await countCall(db, k, day);
    counts.push(n);
    if (max > 0 && n > max) return { over: message, counts };
  }
  return { over: null, counts };
}

/// Reads a request body as text, at most `max` bytes, whatever its Content-Length says. null when it is larger.
export async function readCapped(request, max) {
  if (Number(request.headers.get('Content-Length') ?? 0) > max) return null;
  const reader = request.body?.getReader?.();
  if (!reader) return '';
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.byteLength; }
  return new TextDecoder().decode(all);
}

const cleanup = (db, nowMs) => [
  db.prepare('DELETE FROM reports WHERE reported_at < ?').bind(Math.floor(nowMs / 1000) - PRICE_RULES.keepDays * 86400),
  db.prepare('DELETE FROM counters WHERE day < ?').bind(new Date(nowMs - 2 * 86400000).toISOString().slice(0, 10)),
];

/// POST /v1/price-reports {stationId, grade, price, payment, member, install, near}
export async function postReport(request, env, { nowMs, client, hash }) {
  const db = env.PRICES_DB;
  const text = await readCapped(request, 2048);
  if (text === null) return [413, { error: 'request too large' }];
  let body;
  try { body = JSON.parse(text); } catch { return [400, { error: 'expected JSON' }]; }
  if (body?.near !== true) return [403, { error: 'shared reports need a location check at the station' }];
  if (typeof body.install !== 'string' || body.install.length < 8 || body.install.length > 64) return [400, { error: 'install id missing' }];
  if (typeof body.stationId !== 'string' || body.stationId.length > 80) return [400, { error: 'station id missing' }];
  const now = Math.floor(nowMs / 1000);
  const check = validateReport({ stationId: body.stationId, grade: body.grade, price: body.price, payment: body.payment ?? null,
    member: Boolean(body.member), reportedAt: now }, { now });
  if (!check.ok) return [422, { error: `report refused: ${check.problems.join(', ')}` }];
  const r = check.record;
  const install = (await hash(`install:${body.install}`)).slice(0, 16);
  const { over } = await spend(db, [
    [`reports:c:${client}`, limit(env, 'CLIENT_DAILY_PRICE_REPORTS', REPORT_LIMITS.clientDaily), 'your daily report limit is used up'],
    [`reports:i:${install}`, limit(env, 'CLIENT_DAILY_PRICE_REPORTS', REPORT_LIMITS.installDaily), 'your daily report limit is used up'],
    ['reports', limit(env, 'DAILY_PRICE_REPORTS', REPORT_LIMITS.daily), 'the daily report budget for everyone is used up; it resets at midnight UTC'],
  ], nowMs);
  if (over) return [429, { error: over }];

  const since = now - PRICE_RULES.duplicateMinutes * 60;
  const mine = await db.prepare('SELECT id, price FROM reports WHERE reporter = ? AND station = ? AND grade = ? AND payment IS ? AND member = ? AND reported_at >= ?')
    .bind(install, r.stationId, r.grade, r.payment, r.member ? 1 : 0, since).first();
  if (mine && Math.abs(mine.price - r.price) < 0.0005) return [200, { ok: true, duplicate: true }];

  // The other current reports, one vote per client (its newest): an install id is the sender's own choice, so
  // several ids from one address must not outvote everyone else. This client's own reports do not count.
  const current = await db.prepare(`SELECT price, client FROM reports WHERE station = ? AND grade = ? AND member = ? AND reported_at >= ?
    AND reporter != ? AND client != ? ORDER BY reported_at DESC LIMIT ?`)
    .bind(r.stationId, r.grade, r.member ? 1 : 0, now - 86400, install, client, REPORT_LIMITS.outlierRows).all();
  const voted = new Set();
  const prices = (current.results ?? []).filter((x) => !voted.has(x.client) && voted.add(x.client)).map((x) => x.price).sort((a, b) => a - b);
  if (prices.length >= 3) {
    const median = prices[Math.floor(prices.length / 2)];
    if (Math.abs(r.price - median) > REPORT_LIMITS.outlierDollars) return [422, { error: 'report refused: far from the other current reports for this station' }];
  }
  const stmts = cleanup(db, nowMs);
  // A correction within 30 minutes replaces the reporter's own report.
  if (mine) stmts.push(db.prepare('DELETE FROM reports WHERE id = ?').bind(mine.id));
  const id = (await hash(`${install}:${r.stationId}:${r.grade}:${now}:${Math.random()}`)).slice(0, 20);
  stmts.push(db.prepare('INSERT INTO reports (id, station, grade, price, payment, member, reported_at, reporter, client) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, r.stationId, r.grade, r.price, r.payment, r.member ? 1 : 0, now, install, client));
  await db.batch(stmts);
  return [200, { ok: true, id, corrected: Boolean(mine) }];
}

/// GET /v1/price-reports?stations=a,b,c: reports of the last 7 days for up to 50 stations, newest first.
export async function getReports(url, env, { nowMs, hash, client = 'unknown' }) {
  const db = env.PRICES_DB;
  const ids = [...new Set((url.searchParams.get('stations') ?? '').split(',').map((s) => s.trim()).filter((s) => s && s.length <= 80))];
  if (!ids.length) return [400, { error: 'stations missing' }];
  if (ids.length > REPORT_LIMITS.stationsPerRead) return [400, { error: `at most ${REPORT_LIMITS.stationsPerRead} stations` }];
  const { over, counts } = await spend(db, [
    [`reads:c:${client}`, limit(env, 'CLIENT_DAILY_PRICE_READS', REPORT_LIMITS.clientDailyReads), 'your daily lookup limit is used up; it resets at midnight UTC'],
    ['reads', limit(env, 'DAILY_PRICE_READS', REPORT_LIMITS.dailyReads), 'the daily lookup budget is used up; it resets at midnight UTC'],
  ], nowMs);
  if (over) return [429, { error: over }];
  // Old reports and counters also go when nobody is reporting (they are never served past 7 days either way).
  if (counts[1] % REPORT_LIMITS.cleanEvery === 0) await db.batch(cleanup(db, nowMs));
  const now = Math.floor(nowMs / 1000);
  const rows = await db.prepare(`SELECT id, station, grade, price, payment, member, reported_at, reporter FROM reports
    WHERE station IN (${ids.map(() => '?').join(',')}) AND reported_at >= ? ORDER BY reported_at DESC LIMIT ?`)
    .bind(...ids, now - PRICE_RULES.keepDays * 86400, REPORT_LIMITS.rowsPerRead).all();
  const reports = await Promise.all((rows.results ?? []).filter((x) => PRICE_GRADES.includes(x.grade)).map(async (x) => ({
    id: x.id, stationId: x.station, grade: x.grade, price: x.price, currency: 'USD', payment: x.payment ?? null, member: Boolean(x.member),
    reportedAt: x.reported_at, reporter: (await hash(`${x.reporter}:${x.station}`)).slice(0, 12), source: SOURCE,
  })));
  return [200, { reports, source: SOURCE, generatedAt: now }];
}

/// The tables (also in infra/worker/schema.sql, for `wrangler d1 execute`).
export const SCHEMA = `CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY, station TEXT NOT NULL, grade TEXT NOT NULL, price REAL NOT NULL, payment TEXT,
  member INTEGER NOT NULL DEFAULT 0, reported_at INTEGER NOT NULL, reporter TEXT NOT NULL, client TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS reports_station ON reports (station, reported_at);
CREATE INDEX IF NOT EXISTS reports_time ON reports (reported_at);
CREATE TABLE IF NOT EXISTS counters (key TEXT PRIMARY KEY, day TEXT NOT NULL, n INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS counters_day ON counters (day);`;
