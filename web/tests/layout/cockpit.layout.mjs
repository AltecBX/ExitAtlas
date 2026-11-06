// The cockpit in a real browser at iPhone 16 Pro Max size (932 x 430 landscape, 430 x 932 portrait), fed by a
// SIMULATED ELM327 adapter (ELM327 answer format; the PID list is the one Jerry's 2021 911 Turbo S reported on Nov 6
// 2026; every value is SIMULATED). Checks: each gauge shows the car's reading in US units, calculated gauges say so,
// gauges without data say why and never show a number; the scanner is asked only for what is on screen; Porsche
// data is off until enabled, then probed (read only) and shown as Experimental; modes, themes, custom layouts saved
// per vehicle; needles follow readings; no page errors.
// Run: node web/tests/layout/cockpit.layout.mjs   (needs Playwright with Chromium; CI installs it)
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SHOTS = process.env.SHOTS || null;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml' };
const server = http.createServer(async (req, res) => {
  const file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
  try { res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' }).end(await readFile(file)); } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/web/index.html`;
const failures = [];
const browser = await chromium.launch();

/// SIMULATED ELM327 adapter on a car that lists Jerry's PIDs. Values: 2,500 rpm, 65 km/h, coolant 90 °C, oil 95 °C,
/// baro 101 kPa, boost sensor A 180 kPa (commanded 190), 3rd gear, lambda 1.000, torque 40% of 900 Nm, 12.9 V.
/// Porsche Mode 22: engine oil pressure (7E0 1503) answers 0x4100 / 416 = 40.0 psi; the transmission refuses 38BF.
function simulatedCar() {
  const enc = new TextEncoder(), dec = new TextDecoder();
  let header = '7DF';
  const live = { '0C': '2710', '0D': '41', '05': '82', '5C': '87', '33': '65', '42': '3264', '2F': '7F', '04': '66', '11': '33', '49': '26',
    '0E': '90', '06': '80', '07': '82', '08': '7E', '09': '80', '34': '80008000', '38': '7FF08000', '44': '8000', '62': 'A5', '63': '0384',
    '46': '43', 'A4': '0330' + '0C80', '0F': '50' };
  const masks = { '00': 'BF9CA893', '20': '8007B119', '40': 'FED08511', '60': '61098201', '80': '0204000D', 'A0': '14000000' };
  const answer = (cmd) => {
    if (/^AT(D|E0|L0|S0|H0|SP0)$/.test(cmd)) return 'OK';
    if (cmd === 'ATI') return 'ELM327 v1.5';
    if (cmd === 'ATRV') return '12.9V';
    if (cmd === 'ATDP') return 'AUTO, ISO 15765-4 (CAN 11/500)';
    if (cmd.startsWith('ATSH')) { header = cmd.slice(4); return 'OK'; }
    if (/^01(00|20|40|60|80|A0)$/.test(cmd)) return `41${cmd.slice(2)}${masks[cmd.slice(2)]}`;
    if (cmd === '0101') return '410100076500';
    if (cmd === '0170') return '00C\r0:41700317C016\r1:80000000000000';
    if (/^01[0-9A-F]{2}$/.test(cmd) && live[cmd.slice(2)]) return `41${cmd.slice(2)}${live[cmd.slice(2)]}`;
    if (cmd === '221503') return header === '7E0' ? '62150341 00'.replace(' ', '') : 'NO DATA';
    if (cmd === '2238BF') return '7F2231';
    if (/^22/.test(cmd)) return 'NO DATA';
    return /^0[1-9A]/.test(cmd) ? 'NO DATA' : '?';
  };
  class Characteristic extends EventTarget { constructor(p) { super(); this.properties = p; } async startNotifications() { return this; } }
  const notify = new Characteristic({ notify: true });
  const write = new Characteristic({ write: true, writeWithoutResponse: true });
  let pending = '';
  write.writeValueWithoutResponse = async (bytes) => {
    pending += dec.decode(bytes);
    let i;
    while ((i = pending.indexOf('\r')) >= 0) {
      const cmd = pending.slice(0, i).trim();
      pending = pending.slice(i + 1);
      window.__sent.push(cmd);
      const reply = enc.encode(`${answer(cmd)}\r\r>`);
      for (let k = 0; k < reply.length; k += 20) {
        const part = reply.slice(k, k + 20);
        setTimeout(() => { notify.value = new DataView(part.buffer, part.byteOffset, part.byteLength); notify.dispatchEvent(new Event('characteristicvaluechanged')); }, 8);
      }
    }
  };
  const service = { getCharacteristic: async (u) => (u === 0xfff1 ? notify : u === 0xfff2 ? write : Promise.reject(new DOMException('no', 'NotFoundError'))) };
  const device = new EventTarget();
  device.name = 'OBDLink CX (SIMULATED)';
  device.gatt = { connected: false, connect: async () => { device.gatt.connected = true; return { getPrimaryService: async (u) => (u === 0xfff0 ? service : Promise.reject(new DOMException('no', 'NotFoundError'))) }; }, disconnect: () => {} };
  window.__sent = [];
  Object.defineProperty(navigator, 'bluetooth', { configurable: true, value: { requestDevice: async () => device } });
}

const text = (page, sel) => page.evaluate((s) => document.querySelector(s)?.textContent.replace(/\s+/g, ' ').trim() ?? null, sel);
const gauge = (page, id) => page.evaluate((g) => {
  const el = document.querySelector(`#cockpit [data-gauge="${g}"]`);
  if (!el) return null;
  const v = el.querySelector('[data-r="value"]')?.textContent;
  const needle = el.querySelector('[data-r="needle"]')?.getAttribute('transform');
  return { value: v, status: el.dataset.status, zone: el.dataset.zone, text: el.textContent.replace(/\s+/g, ' ').trim(), needle };
}, id);

async function open(viewport) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: SHOTS ? 2 : 1, isMobile: true, hasTouch: true, colorScheme: 'dark', serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(simulatedCar);
  await page.route((u) => u.protocol === 'https:', (r) => r.fulfill({ status: 503, body: '' }));
  await page.goto(`${base}?demo=120`);
  await page.waitForSelector('.nav-view, .focus-view', { timeout: 60000 });
  // Jerry's car in the profile (the vehicle picker is tested in carlink.layout.mjs).
  await page.evaluate(() => { const a = window.exitAtlas; a.settings.vehicle = { ...(a.settings.vehicle ?? {}), year: '2021', make: 'Porsche', model: '911', tankGallons: 17.6, mpg: 20 }; });
  return { ctx, page, errors };
}
const cells = (page, sel) => page.evaluate((s) => [...document.querySelectorAll(`${s} tr`)].map((tr) => [...tr.children].map((td) => td.textContent.replace(/\s+/g, ' ').trim()).join('|')), sel);
const click = (page, act, arg) => page.evaluate(([a, g]) => { const b = document.createElement('button'); b.dataset.act = a; if (g != null) b.dataset.arg = g; document.body.append(b); b.click(); b.remove(); }, [act, arg]);

{
  const fail = (m) => failures.push(`landscape: ${m}`);
  const { ctx, page, errors } = await open({ width: 932, height: 430 });
  // The cockpit before the car is connected: no numbers, says why.
  await click(page, 'cockpit-open');
  await page.waitForSelector('#cockpit:not([hidden]) [data-gauge="rpm"]');
  if (!/Not connected/.test(await text(page, '#cockpit [data-r="banner"]') ?? '')) fail('no "not connected" banner');
  const before = await gauge(page, 'rpm');
  if (before.value !== '–') fail(`rpm shows a value before connecting: ${before.value}`);
  await click(page, 'ck-close');
  // Connect, then the cockpit.
  await click(page, 'car-connect');
  await page.waitForFunction(() => window.exitAtlas.car.state === 'connected' && window.exitAtlas.car.supported, null, { timeout: 20000 });
  await click(page, 'cockpit-open');
  await page.waitForFunction(() => /2,500/.test(document.querySelector('#cockpit [data-gauge="rpm"] [data-r="value"]')?.textContent ?? ''), null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const g = {};
  for (const id of ['rpm', 'speed', 'boost', 'gear', 'oilTemp', 'oilPressure', 'coolant', 'pdkTemp']) g[id] = await gauge(page, id);
  if (g.rpm?.value !== '2,500' || g.rpm.status !== 'live') fail(`rpm: ${JSON.stringify(g.rpm)}`);
  if (g.speed?.value !== '40' || g.speed.status !== 'live') fail(`speed (65 km/h = 40 mph): ${JSON.stringify(g.speed)}`);
  // Boost: (180 - 101) kPa = 11.5 psi, calculated, with its target (190 - 101 = 12.9 psi).
  if (g.boost?.value !== '11.5' || !/CALC/.test(g.boost.text) || !/target 12\.9 psi/.test(g.boost.text)) fail(`boost: ${JSON.stringify(g.boost)}`);
  if (g.gear?.value !== '3') fail(`gear: ${JSON.stringify(g.gear)}`);
  if (g.oilTemp?.value !== '203') fail(`oil temp (95 °C = 203 °F): ${JSON.stringify(g.oilTemp)}`);
  if (g.coolant?.value !== '194') fail(`coolant (90 °C = 194 °F): ${JSON.stringify(g.coolant)}`);
  if (g.oilPressure?.value !== '–' || g.oilPressure.status !== 'notProbed' || !/EXP/.test(g.oilPressure.text)) fail(`oil pressure before Porsche data: ${JSON.stringify(g.oilPressure)}`);
  // The needle sits at 2,500 of 8,000 rpm: -120 + 240 x 2500/8000 = -45 degrees.
  const angle = Number(/rotate\((-?[\d.]+)/.exec(g.rpm?.needle ?? '')?.[1]);
  if (!(Math.abs(angle + 45) < 1.5)) fail(`rpm needle: ${g.rpm?.needle}`);
  // Only what is on screen is asked for: no ambient temperature (0146) in Driving mode.
  const plan = await page.evaluate(() => window.exitAtlas.car.plan.map((p) => p.id));
  if (plan.includes('01:70')) fail(`plan has 0146: ${plan}`);
  if (!plan.includes('01:12') || !plan.includes('01:112') || !plan.includes('01:51')) fail(`plan: ${plan}`);
  const link = await text(page, '#cockpit [data-r="link"]');
  if (!/req\/s · \d+ ms · 0 dropped/.test(link ?? '')) fail(`link: ${link}`);
  if (!/Peak boost 11\.5 psi · 2,500 rpm · 40 mph/.test(await text(page, '#cockpit [data-r="peaks"]') ?? '')) fail(`peaks: ${await text(page, '#cockpit [data-r="peaks"]')}`);
  // The grid fits the screen without scrolling.
  const fit = await page.evaluate(() => { const gr = document.querySelector('#cockpit .ck-grid'); return { sh: gr.scrollHeight, ch: gr.clientHeight, sw: gr.scrollWidth, cw: gr.clientWidth }; });
  if (fit.sh > fit.ch + 2 || fit.sw > fit.cw + 2) fail(`Driving does not fit 932 x 430: ${JSON.stringify(fit)}`);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'cockpit-drive-landscape.png') });

  // Porsche data: probe (read only), then oil pressure shows, Experimental; the refused PDK temperature says so.
  await click(page, 'ck-panel', 'settings');
  await click(page, 'ck-probe', 'cockpit');
  await page.waitForFunction(() => !window.exitAtlas.car.probing && window.exitAtlas.car.enhanced.results.size > 0, null, { timeout: 30000 }).catch(() => {});
  await click(page, 'ck-panel', '');
  await page.waitForFunction(() => /40\.0|40/.test(document.querySelector('#cockpit [data-gauge="oilPressure"] [data-r="value"]')?.textContent ?? ''), null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1200);
  const op = await gauge(page, 'oilPressure');
  if (op?.value !== '40' || op.status !== 'live' || !/EXP/.test(op.text)) fail(`oil pressure after the probe: ${JSON.stringify(op)}`);
  const pdk = await gauge(page, 'pdkTemp');
  if (pdk?.value !== '–' || pdk.status !== 'unsupported') fail(`PDK temp refused: ${JSON.stringify(pdk)}`);
  const sent = await page.evaluate(() => window.__sent);
  if (!sent.includes('ATSH7E0') || !sent.includes('221503')) fail(`Porsche requests: ${sent.filter((c) => /^(22|ATSH)/.test(c)).join(' ')}`);
  if (sent.some((c) => /^(2E|31|27|10|11|14|04)/.test(c))) fail(`a write, routine, security, session or clear request was sent: ${sent.join(' ')}`);
  const kept = await page.evaluate(() => JSON.parse(localStorage.getItem('ea.carPorsche') ?? '{}'));
  if (kept['2021 Porsche 911']?.['22:7E0:1503'] !== 'ok') fail(`probe results not kept: ${JSON.stringify(kept)}`);

  // Performance and Engine health.
  await click(page, 'ck-mode', 'performance');
  await page.waitForTimeout(1800);
  const tq = await gauge(page, 'torque');
  // Torque: 0xA5 - 125 = 40% of 900 Nm = 360 Nm = 266 lb·ft, calculated.
  if (tq?.value !== '266' || !/CALC/.test(tq.text)) fail(`torque: ${JSON.stringify(tq)}`);
  const afr = await gauge(page, 'afr');
  if (afr?.value !== '14.7' || !/CALC/.test(afr.text)) fail(`AFR (lambda 1.000 x 14.7): ${JSON.stringify(afr)}`);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'cockpit-performance-landscape.png') });
  await click(page, 'ck-mode', 'health');
  await page.waitForTimeout(1500);
  const st = await gauge(page, 'stft1');
  if (st?.value !== '0.0' && st?.value !== '0') fail(`STFT B1: ${JSON.stringify(st)}`);
  const v = await gauge(page, 'voltage');
  if (v?.value !== '12.9') fail(`voltage (0x3264 = 12.9 V): ${JSON.stringify(v)}`);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'cockpit-health-landscape.png') });

  // Custom: copy Driving, edit, add any sensor, saved per vehicle across a reload.
  await click(page, 'ck-mode', 'drive');
  await click(page, 'ck-copy-mode');
  await click(page, 'ck-remove', 'pdkTemp');
  await click(page, 'ck-size', 'boost');            // M -> L
  await click(page, 'ck-move', 'gear:-1');
  await click(page, 'ck-add-gauge', '0146');         // outside air temperature, any reported sensor
  await page.waitForTimeout(1500);
  const custom = await page.evaluate(() => window.exitAtlas.cockpitSettings.custom);
  if (custom.some((x) => x.id === 'pdkTemp') || custom.find((x) => x.id === 'boost')?.size !== 'L' || custom.at(-1)?.id !== '0146') fail(`custom: ${JSON.stringify(custom)}`);
  const amb = await gauge(page, '0146');
  if (amb?.value !== '81' && amb?.value !== '80.6') fail(`outside air as a gauge (27 °C): ${JSON.stringify(amb)}`);
  await click(page, 'ck-theme', 'chrono');
  if (!(await page.evaluate(() => document.getElementById('cockpit').classList.contains('theme-chrono')))) fail('theme');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'cockpit-custom-chrono.png') });
  await page.reload();
  await page.waitForSelector('.nav-view, .focus-view', { timeout: 60000 });
  await page.evaluate(() => { const a = window.exitAtlas; a.settings.vehicle = { ...(a.settings.vehicle ?? {}), year: '2021', make: 'Porsche', model: '911' }; });
  await click(page, 'cockpit-open');
  const after = await page.evaluate(() => ({ mode: window.exitAtlas.cockpitSettings.mode, theme: window.exitAtlas.cockpitSettings.theme, n: window.exitAtlas.cockpitSettings.custom.length }));
  if (after.mode !== 'custom' || after.theme !== 'chrono' || after.n !== custom.length) fail(`not restored after a reload: ${JSON.stringify(after)}`);
  if (errors.length) fail(`page errors: ${errors.join(' | ')}`);
  await ctx.close();
}

{
  const fail = (m) => failures.push(`portrait: ${m}`);
  const { ctx, page, errors } = await open({ width: 430, height: 932 });
  await click(page, 'car-connect');
  await page.waitForFunction(() => window.exitAtlas.car.state === 'connected' && window.exitAtlas.car.supported, null, { timeout: 20000 });
  await click(page, 'cockpit-open');
  await page.waitForTimeout(2500);
  const fit = await page.evaluate(() => { const gr = document.querySelector('#cockpit .ck-grid'); return { sh: gr.scrollHeight, ch: gr.clientHeight, sw: gr.scrollWidth, cw: gr.clientWidth }; });
  if (fit.sh > fit.ch + 2 || fit.sw > fit.cw + 2) fail(`Driving does not fit 430 x 932: ${JSON.stringify(fit)}`);
  const rpm = await gauge(page, 'rpm');
  if (rpm?.value !== '2,500') fail(`rpm: ${JSON.stringify(rpm)}`);
  // Closing the cockpit stops live data (nothing recorded, no alert limits).
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'cockpit-drive-portrait.png') });
  await click(page, 'ck-close');
  await page.waitForTimeout(400);
  if (await page.evaluate(() => window.exitAtlas.car.live.on || window.exitAtlas.car.plan)) fail('live data or the plan kept running after the cockpit closed');
  if (errors.length) fail(`page errors: ${errors.join(' | ')}`);
  await ctx.close();
}

{
  // Sensors, charts, recording from the cockpit, JSON, summary and comparison.
  const fail = (m) => failures.push(`sensors and sessions: ${m}`);
  const { ctx, page, errors } = await open({ width: 430, height: 932 });
  await click(page, 'car-connect');
  await page.waitForFunction(() => window.exitAtlas.car.state === 'connected' && window.exitAtlas.car.supported, null, { timeout: 20000 });
  // Two short recordings from the cockpit.
  await click(page, 'cockpit-open');
  for (let i = 0; i < 2; i++) {
    await click(page, 'ck-rec');
    await page.waitForTimeout(1800);
    await click(page, 'ck-rec');
    await page.waitForTimeout(600);
  }
  await click(page, 'ck-close');
  await click(page, 'car-details');
  await page.waitForSelector('#sheet [data-act="car-tab"][data-arg="sensors"]', { timeout: 10000 });
  await click(page, 'car-tab', 'sensors');
  await page.waitForTimeout(400);
  const sensors = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#sheet [data-testid="car-sensor"]')].map((r) => [r.dataset.key, r.textContent.replace(/\s+/g, ' ').trim()])));
  if (!/Verified/.test(sensors['010C'] ?? '') || !/answering/.test(sensors['010C'] ?? '')) fail(`engine speed row: ${sensors['010C']}`);
  if (!/Standard/.test(sensors['0170_BP_A_ACT'] ?? '')) fail(`boost sensor row (OBDb, one source): ${sensors['0170_BP_A_ACT']}`);
  if (Object.keys(sensors).length < 50) fail(`only ${Object.keys(sensors).length} sensors listed`);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'car-sensors.png') });
  // Charts: two sensors on one chart.
  await click(page, 'car-tab', 'live');
  await click(page, 'car-live');
  await page.waitForTimeout(2500);
  await click(page, 'car-tab', 'charts');
  await click(page, 'car-chart-toggle', '010C');
  await click(page, 'car-chart-toggle', '0105');
  await page.waitForTimeout(300);
  const lines = await page.evaluate(() => document.querySelectorAll('#sheet [data-testid="car-mchart"] path[data-series]').length);
  if (lines !== 2) fail(`chart lines: ${lines}`);
  const legend = await cells(page, '#sheet [data-testid="car-mchart"] table');
  if (!legend.includes('Engine speed rpm|min 2500|max 2500|avg 2500') || !legend.includes('Coolant temperature °F|min 194|max 194|avg 194')) fail(`chart legend: ${legend}`);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'car-charts.png') });
  await click(page, 'car-live');
  // Recordings: JSON, summary, compare.
  await click(page, 'car-tab', 'rec');
  await page.waitForSelector('#sheet [data-testid="car-recording"]', { timeout: 10000 }).catch(() => {});
  const ids = await page.evaluate(() => [...document.querySelectorAll('#sheet [data-testid="car-recording"]')].map((r) => r.dataset.id));
  if (ids.length !== 2) fail(`recordings: ${ids.length}`);
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }).catch(() => null), click(page, 'car-rec-json', ids[0])]);
  const json = dl ? JSON.parse(await readFile(await dl.path(), 'utf8')) : null;
  if (json?.format !== 'exitatlas-car-recording' || !json.samples?.length || !json.channels?.['010C']) fail(`JSON: ${JSON.stringify(json)?.slice(0, 200)}`);
  await click(page, 'car-rec-summary', ids[0]);
  await page.waitForSelector('#sheet [data-testid="car-summary"] table', { timeout: 10000 }).catch(() => {});
  const sum = await text(page, '#sheet [data-testid="car-summary"]');
  const sumRows = await cells(page, '#sheet [data-testid="car-summary"] table');
  if (!/max 2,500 rpm/.test(sum ?? '') || !sumRows.includes('Engine speed rpm|2500|2500|2500') || !sumRows.includes('Transmission gear ratio ratio|3.200|3.200|3.200')) fail(`summary: ${sumRows}`);
  await click(page, 'car-rec-compare', ids[0]);
  await click(page, 'car-rec-compare', ids[1]);
  await page.waitForSelector('#sheet [data-testid="car-compare"] table', { timeout: 10000 }).catch(() => {});
  const cmp = await cells(page, '#sheet [data-testid="car-compare"] table');
  if (!cmp.includes('Engine speed rpm|2500|2500|2500|2500|0')) fail(`compare: ${cmp}`);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'car-compare.png'), fullPage: false });
  if (errors.length) fail(`page errors: ${errors.join(' | ')}`);
  await ctx.close();
}

await browser.close();
server.close();
if (failures.length) { console.log(failures.join('\n')); process.exit(1); }
console.log('Cockpit (SIMULATED adapter): every check passed');
