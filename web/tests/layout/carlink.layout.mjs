// The car connection in a real browser, with a SIMULATED OBD2 adapter standing in for the Web Bluetooth API
// (navigator.bluetooth, which Chrome has and Safari gets from the beacio extension). The simulated adapter answers
// in the ELM327's documented answer format, split into 20 byte notifications like a Bluetooth LE adapter; it is
// not a recording of a real adapter or car. Checks: without Web Bluetooth the Fuel sheet says what it takes; with
// it, Connect car reads the fuel level, the range becomes fuel level x tank size x mpg and says it is from the car;
// a dropped adapter is shown with its time and reconnects; a car without the fuel level PID says so and leaves the
// range alone; the check engine light shows.
// Run: node web/tests/layout/carlink.layout.mjs   (needs Playwright with Chromium; CI installs it)
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SHOTS = process.env.SHOTS || null;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.woff2': 'font/woff2', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml' };

const server = http.createServer(async (req, res) => {
  const file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
  try {
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' }).end(await readFile(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/web/index.html`;

const failures = [];
const browser = await chromium.launch();

/// The SIMULATED adapter, installed before the app's scripts as navigator.bluetooth.
function simulatedAdapter(opts) {
  const enc = new TextEncoder(), dec = new TextDecoder();
  const answer = (cmd) => {
    if (/^AT(D|E0|L0|S0|H0|SP0)$/.test(cmd)) return 'OK';
    if (cmd === 'ATI') return 'ELM327 v1.5';
    if (cmd === 'ATRV') return '12.6V';
    if (cmd === '0100') return 'SEARCHING...\r4100BE3EB811';
    if (cmd === '0120') return opts.fuelPID ? '4120A007B011' : '4120A005B011';
    if (cmd === '012F') return '412F9A';
    if (cmd === '0101') return opts.checkEngine ? '410182076500' : '410100076500';
    return '?';
  };
  class Characteristic extends EventTarget {
    constructor(uuid, properties) { super(); this.uuid = uuid; this.properties = properties; this.value = null; }
    async startNotifications() { return this; }
  }
  const notify = new Characteristic(0xfff1, { notify: true });
  const write = new Characteristic(0xfff2, { write: true, writeWithoutResponse: true });
  let pending = '', delay = 0;
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
        delay += 5;
        setTimeout(() => { notify.value = new DataView(part.buffer, part.byteOffset, part.byteLength); notify.dispatchEvent(new Event('characteristicvaluechanged')); delay = Math.max(0, delay - 5); }, delay);
      }
    }
  };
  const service = { getCharacteristic: async (u) => { if (u === 0xfff1) return notify; if (u === 0xfff2) return write; throw new DOMException('no such characteristic', 'NotFoundError'); } };
  const device = new EventTarget();
  device.name = 'OBDLink CX (SIMULATED)';
  device.gatt = {
    connected: false,
    connect: async () => { device.gatt.connected = true; return { getPrimaryService: async (u) => { if (u === 0xfff0) return service; throw new DOMException('no such service', 'NotFoundError'); } }; },
    disconnect: () => { device.gatt.connected = false; device.dispatchEvent(new Event('gattserverdisconnected')); },
  };
  window.__sent = [];
  window.__drop = () => { device.gatt.connected = false; device.dispatchEvent(new Event('gattserverdisconnected')); };
  Object.defineProperty(navigator, 'bluetooth', { configurable: true, value: { requestDevice: async (o) => { window.__requestOptions = o; return device; } } });
}

async function open({ bluetooth = null, scheme = 'light' } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: SHOTS ? 2 : 1, isMobile: true, hasTouch: true, colorScheme: scheme, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  if (bluetooth) await page.addInitScript(simulatedAdapter, bluetooth);
  await page.route((u) => u.protocol === 'https:', (r) => r.fulfill({ status: 503, body: '' }));
  await page.goto(`${base}?demo=120`);
  await page.waitForSelector('.nav-view, .focus-view', { timeout: 60000 });
  // A vehicle with a tank size and mpg (the SIMULATED test vehicle): 15 gallons at 30 mpg highway.
  await page.evaluate(() => {
    window.exitAtlas.settings.vehicle = { year: 2021, make: 'Test', model: 'Sedan', label: 'SIMULATED test vehicle', hwy: 30, comb: 26, city: 23, tankGallons: 15 };
    window.exitAtlas.settings.mpgBasis = 'highway';
    document.querySelector('[data-act="tab"][data-arg="ahead"]')?.click();
  });
  await page.waitForTimeout(600);
  await page.evaluate(() => document.querySelector('[data-act="sheet"][data-arg="fuel"]')?.click());
  await page.waitForSelector('#sheet.open [data-form="fuel"]', { timeout: 10000 });
  return { ctx, page, errors };
}

const text = (page, sel) => page.evaluate((s) => document.querySelector(s)?.textContent.replace(/\s+/g, ' ').trim() ?? null, sel);

// 1. No Web Bluetooth (Safari without the extension): what it takes, and no Connect button.
{
  const fail = (m) => failures.push(`no Web Bluetooth: ${m}`);
  const { ctx, page, errors } = await open();
  const help = await text(page, '#sheet [data-testid="car-help"]');
  if (!help || !/OBD2 adapter with Bluetooth LE/.test(help) || !/beacio/.test(help) || !/BlueDriver/.test(help)) fail(`help: ${help}`);
  if (await page.$('#sheet [data-act="car-connect"]')) fail('a Connect button shows without Web Bluetooth');
  if (SHOTS) {
    await page.evaluate(() => { const d = document.querySelector('#sheet [data-testid="car-help"]'); d.open = true; d.scrollIntoView({ block: 'center' }); });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(SHOTS, 'car-help.png') });
  }
  if (errors.length) fail(`page errors: ${errors.join(' | ')}`);
  await ctx.close();
}

// 2. Connect: the fuel level, the range from it, the label, the check engine light, a drop and the reconnect.
{
  const fail = (m) => failures.push(`connect: ${m}`);
  const { ctx, page, errors } = await open({ bluetooth: { fuelPID: true, checkEngine: true } });
  const before = await page.evaluate(() => window.exitAtlas.fuel);
  if (SHOTS) {
    await page.evaluate(() => document.querySelector('#sheet [data-testid="car-row"]').scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(SHOTS, 'car-connect.png') });
  }
  await page.click('#sheet [data-act="car-connect"]:not([data-arg])');
  await page.waitForFunction(() => /60\.4%/.test(document.querySelector('#sheet [data-testid="car-fuel"]')?.textContent ?? ''), null, { timeout: 15000 }).catch(() => {});
  const opts = await page.evaluate(() => window.__requestOptions);
  if (!opts?.filters?.some((f) => f.services?.includes(0xfff0)) || !opts.optionalServices?.includes(0xfff0)) fail(`picker options: ${JSON.stringify(opts)}`);
  const sent = await page.evaluate(() => window.__sent);
  if (sent.slice(0, 6).join() !== 'ATD,ATE0,ATL0,ATS0,ATH0,ATSP0') fail(`setup commands: ${sent.join()}`);
  const fuel = await text(page, '#sheet [data-testid="car-fuel"]');
  if (!/Fuel 60\.4%/.test(fuel ?? '')) fail(`fuel line: ${fuel}`);
  const f = await page.evaluate(() => window.exitAtlas.fuel);
  // 60.4% of 15 gallons at 30 mpg is 271.8 miles.
  if (f?.source !== 'car' || Math.abs(f.rangeMeters / 1609.344 - 271.76) > 0.2 || f.percent !== 60.4) fail(`range from the car: ${JSON.stringify(f)} (before ${JSON.stringify(before)})`);
  const label = await text(page, '#sheet [data-testid="range-car"]');
  if (!/From your car: 60\.4% fuel/.test(label ?? '')) fail(`range label: ${label}`);
  // 271.8 miles, less what the simulated drive covered since (the sheet redraws a moment after a tap).
  const dte = Number(await page.inputValue('#sheet input[name="dte"]'));
  if (!(dte >= 269 && dte <= 272)) fail(`Range now field: ${dte}`);
  const cel = await text(page, '#sheet [data-testid="car-check-engine"]');
  if (!/Check engine light is on \(2 stored codes\)/.test(cel ?? '')) fail(`check engine: ${cel}`);
  if (SHOTS) {
    await page.evaluate(() => document.querySelector('#sheet [data-testid="car-row"]').scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(SHOTS, 'car-connected.png') });
  }
  // The Drive card says where the range comes from.
  await page.evaluate(() => document.querySelector('[data-act="close-sheet"]')?.click());
  // The adapter drops: shown with its time; it reconnects without the picker.
  await page.evaluate(() => document.querySelector('[data-act="sheet"][data-arg="fuel"]')?.click());
  await page.waitForSelector('#sheet.open [data-testid="car-row"]');
  await page.evaluate(() => window.__drop());
  // The sheet redraws once no tap or scroll is recent (opening it scrolled it to the top), before the reconnect at 3 s.
  await page.waitForFunction(() => /Car disconnected/.test(document.querySelector('#sheet [data-testid="car-row"]')?.textContent ?? ''), null, { timeout: 2800 }).catch(() => {});
  const dropped = await text(page, '#sheet [data-testid="car-row"]');
  if (!/Car disconnected/.test(dropped ?? '')) fail(`after a drop: ${dropped}`);
  const kept = await page.evaluate(() => window.exitAtlas.fuel);
  if (kept?.source !== 'car') fail(`the range from the car was dropped: ${JSON.stringify(kept)}`);
  await page.waitForFunction(() => /Car connected/.test(document.querySelector('#sheet [data-testid="car-row"]')?.textContent ?? ''), null, { timeout: 15000 }).catch(() => {});
  const back = await text(page, '#sheet [data-testid="car-row"]');
  if (!/Car connected/.test(back ?? '')) fail(`no reconnect: ${back}`);
  // Disconnect: no reconnect.
  await page.click('#sheet [data-act="car-disconnect"]');
  await page.waitForTimeout(4000);
  const off = await page.evaluate(() => window.exitAtlas.car.state);
  if (off !== 'idle') fail(`after Disconnect the state is ${off}`);
  if (errors.length) fail(`page errors: ${errors.join(' | ')}`);
  await ctx.close();
}

// 3. A car that does not report its fuel level: said, and the entered range stays.
{
  const fail = (m) => failures.push(`no fuel PID: ${m}`);
  const { ctx, page, errors } = await open({ bluetooth: { fuelPID: false } });
  await page.fill('#sheet input[name="dte"]', '180');
  await page.click('#sheet [data-form="fuel"] button[type="submit"]');
  await page.click('#sheet [data-act="car-connect"]:not([data-arg])');
  await page.waitForSelector('#sheet [data-testid="car-problem"]', { timeout: 15000 }).catch(() => {});
  const problem = await text(page, '#sheet [data-testid="car-problem"]');
  if (!/does not report its fuel level/.test(problem ?? '')) fail(`problem: ${problem}`);
  const f = await page.evaluate(() => window.exitAtlas.fuel);
  if (f?.source !== 'dashboard' || Math.round(f.rangeMeters / 1609.344) !== 180) fail(`the entered range changed: ${JSON.stringify(f)}`);
  if (errors.length) fail(`page errors: ${errors.join(' | ')}`);
  await ctx.close();
}

await browser.close();
server.close();
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('Car connection (SIMULATED adapter): every check passed');
