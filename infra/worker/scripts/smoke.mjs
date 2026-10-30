// Real requests against a running proxy (the deployed Worker, or `wrangler dev` with a local D1): the config
// says shared reports are on, a report sent by one install is read back by another, a repeat is dropped, a
// report without the location check and an out of range price are refused, another site is refused. Uses a
// reserved test station id (test:smoke-...) so the reports are easy to delete afterwards.
// Usage: node scripts/smoke.mjs <proxy URL> [allowed origin]
const base = new URL(process.argv[2] ?? 'http://127.0.0.1:8787/');
const origin = process.argv[3] ?? 'https://altecbx.github.io';
const station = `test:smoke-${Date.now().toString(36)}`;
const failures = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures.push(what); };
const call = async (path, init = {}) => {
  const res = await fetch(new URL(path, base), { ...init, headers: { Origin: origin, 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const report = (install, extra = {}) => call('v1/price-reports', { method: 'POST', body: JSON.stringify({ stationId: station, grade: 'R', price: 3.333, payment: 'credit', install, near: true, ...extra }) });

const cfg = await call('v1/config');
check(cfg.status === 200 && cfg.body?.community === true, `config: shared reports on (${JSON.stringify(cfg.body)})`);
const a = await report('smoke-install-a-0001', { }, );
check(a.status === 200 && a.body?.ok && !a.body.duplicate, `install A reports: ${JSON.stringify(a.body)}`);
check((await report('smoke-install-a-0001')).body?.duplicate === true, 'the same report again is dropped');
const b = await report('smoke-install-b-0002', { price: 3.299, payment: 'cash' });
check(b.status === 200 && b.body?.ok, `install B reports a cash price: ${JSON.stringify(b.body)}`);
check((await report('smoke-install-c-0003', { near: false })).status === 403, 'a report without the location check is refused');
check((await report('smoke-install-c-0003', { price: 31 })).status === 422, 'an out of range price is refused');
const other = await fetch(new URL(`v1/price-reports?stations=${station}`, base), { headers: { Origin: 'https://other.example' } });
check(other.status === 403, 'another site is refused');
// A lookup with a query no one asked before reaches the database (answers are cached for a minute).
const read = await call(`v1/price-reports?stations=${encodeURIComponent(station)},test:none-${Date.now()}`, { headers: { 'Content-Type': 'text/plain' } });
const prices = (read.body?.reports ?? []).map((r) => `${r.price} ${r.payment} ${r.source?.name}`).sort();
check(read.status === 200 && prices.length === 2 && prices[0] === '3.299 cash ExitAtlas drivers' && prices[1] === '3.333 credit ExitAtlas drivers',
  `another install reads both reports: ${JSON.stringify(prices)}`);
check(new Set((read.body?.reports ?? []).map((r) => r.reporter)).size === 2, 'the two reporters show as different, unlinkable ids');
console.log(`test station: ${station}`);
if (failures.length) process.exit(1);
