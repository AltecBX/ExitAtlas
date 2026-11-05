// The car connection in a real browser, with a SIMULATED OBD2 adapter standing in for the Web Bluetooth API
// (navigator.bluetooth, which Chrome has and Safari gets from the beacio extension). The simulated adapter answers
// in the ELM327's documented answer format, split into 20 byte notifications like a Bluetooth LE adapter; it is
// not a recording of a real adapter or car. Checks: without Web Bluetooth the Fuel sheet says what it takes; with
// it, Connect car reads the fuel level, the range becomes fuel level x tank size x mpg (Jerry's 911 Turbo S, chosen
// in the picker) and says it is from the car; a field typed in Settings survives car updates;
// a dropped adapter is shown with its time and reconnects; a car without the fuel level PID says so and leaves the
// range alone; the check engine light shows; and a SIMULATED BlueDriver (unofficial) the same way.
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
    // Diagnostics: the evaporative system test not complete yet (D bit 2).
    if (cmd === '0101') return opts.diag ? '410182076504' : opts.checkEngine ? '410182076500' : '410100076500';
    if (cmd === 'ATDP') return 'AUTO, ISO 15765-4 (CAN 11/500)';
    // Live data (SIMULATED values, SAE J1979 formulas): rpm 992, 65 km/h (40 mph), coolant 50 °C (122 °F), load 50.2%,
    // MAP 101 kPa, intake 6 °C (43 °F), throttle 16.1%, baro 101 kPa, 12.588 V, outside 27 °C (81 °F), oil 40 °C (104 °F).
    const live = { '0104': '410480', '0105': '41055A', '010B': '410B65', '010C': '410C0F80', '010D': '410D41', '010F': '410F2E',
      '0111': '411129', '0133': '413365', '0142': '4142312C', '0146': '414643', '015C': '415C50' };
    if (opts.diag && live[cmd]) return live[cmd];
    // Several PIDs in one request (CAN, ELM327 format): the mode once, each PID with its data; over 7 bytes the
    // answer comes as numbered frames after a byte count. A PID without an answer is left out.
    if (opts.diag && /^01([0-9A-F]{2}){2,6}$/.test(cmd)) {
      const parts = cmd.slice(2).match(/../g).map((p) => live[`01${p}`]?.slice(2)).filter(Boolean);
      if (!parts.length) return 'NO DATA';
      const hex = `41${parts.join('')}`;
      const n = hex.length / 2;
      if (n <= 7) return hex;
      const frames = [hex.slice(0, 12)];
      for (let i = 12; i < hex.length; i += 14) frames.push(hex.slice(i, i + 14).padEnd(14, '0'));
      return [n.toString(16).toUpperCase().padStart(3, '0'), ...frames.map((f, i) => `${(i % 16).toString(16).toUpperCase()}:${f}`)].join('\r');
    }
    if (opts.diag && cmd === '0140') return '414044000010';
    if (opts.diag && cmd === '0103') return 'NO DATA';
    if (opts.diag && cmd === '03') return '430201330420';
    if (opts.diag && cmd === '07') return '4700';
    if (opts.diag && cmd === '0A') return '4A00';
    if (opts.diag && cmd === '0900') return '490054400000';
    if (opts.diag && cmd === '0902') return '014\r0:490201575030\r1:4142324139344D\r2:53313233343536';
    if (opts.diag && cmd === '090A') return '017\r0:490A0145434D\r1:002D456E67696E\r2:65436F6E74726F\r3:6C000000000000';
    return opts.diag ? 'NO DATA' : '?';
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

/// A SIMULATED BlueDriver, as github.com/sjalkote/bluedriver-reverse-engineering and Silicon Labs' BGX docs describe
/// it (not a recording): the Xpress Streaming Service, XOR 0x26 on every byte but CR and ">", Fast Ack flow control
/// (nothing is sent before the app writes its buffer size to Tx, and nothing after a fragment until the app
/// acknowledges it), answers with data bytes only, and NO DATA to everything once an AT command arrives.
function simulatedBlueDriver(opts) {
  const S = { service: '331a36f5-2459-45ea-9d95-6142f0c4b307', rx: 'a9da6040-0823-4995-94ec-9ce41ca28833', tx: 'a73e9a10-628f-4494-a099-12efaf72258f',
    mode: '75a9f022-af03-4e41-b4bc-9de90a47d50b', pairService: '169b52a0-b7fd-40da-998c-dd9238327e55', pair: '12e868e7-c926-4906-96c8-a7ee81d4b1b3' };
  const codec = (b) => Uint8Array.from(b, (x) => (x === 0x0d || x === 0x3e ? x : x ^ 0x26));
  const enc = new TextEncoder(), dec = new TextDecoder();
  let spoiled = false, credit = false, waitingAck = false, paired = false;
  const queue = [];
  const answer = (cmd) => {
    if (spoiled) return 'NO DATA';
    if (cmd === 'LMI') return 'OSAPI v2.60';
    if (cmd === 'LMDP') return 'AUTO, ISO 15765-4 (CAN 11/500)';
    if (/^LM/.test(cmd)) return 'OK';
    if (cmd === '0100') return 'BE 3E B8 11 ';
    if (cmd === '0120') return 'A0 07 B0 11 ';
    if (cmd === '012F') return '9A ';
    if (cmd === '0101') return '00 07 65 00 ';
    if (cmd === '0142') return '31 2C ';
    return '?';
  };
  class Characteristic extends EventTarget {
    constructor(uuid, properties) { super(); this.uuid = uuid; this.properties = properties; this.value = null; this.on = false; }
    async startNotifications() { if (!paired) window.__pairedBy = window.__pairedBy ?? 'notifications'; paired = true; this.on = true; return this; }
  }
  const rx = new Characteristic(S.rx, { write: true, writeWithoutResponse: true, notify: true });
  const tx = new Characteristic(S.tx, { notify: true, indicate: true, writeWithoutResponse: true });
  const mode = new Characteristic(S.mode, { read: true, write: true, notify: true });
  const notify = (ch, bytes) => { ch.value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); ch.dispatchEvent(new Event('characteristicvaluechanged')); };
  const pump = () => {
    if (!credit || waitingAck || !queue.length || !tx.on) return;
    const part = queue.shift();
    waitingAck = true;
    setTimeout(() => notify(tx, part), 3);
  };
  tx.writeValueWithoutResponse = async (bytes) => {
    const b = [...new Uint8Array(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength ?? bytes.length)];
    window.__control.push(b.map((x) => x.toString(16).padStart(2, '0')).join(' '));
    if (b[0] === 0x00) { credit = true; pump(); }
    if (b[0] === 0x01) { waitingAck = false; pump(); }
  };
  let pending = '';
  rx.writeValueWithoutResponse = async (bytes) => {
    pending += dec.decode(codec(new Uint8Array(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength ?? bytes.length)));
    let i;
    while ((i = pending.indexOf('\r')) >= 0) {
      const cmd = pending.slice(0, i).trim();
      pending = pending.slice(i + 1);
      window.__sent.push(cmd);
      if (/^AT/i.test(cmd)) spoiled = true;
      setTimeout(() => notify(rx, new Uint8Array([0x01, 0x01, 0x00])), 1);
      // Answers come in two or more fragments.
      const reply = codec(enc.encode(`${answer(cmd)}\r\r>`));
      for (let k = 0; k < reply.length; k += 7) queue.push(reply.slice(k, k + 7));
      pump();
    }
  };
  const streaming = { getCharacteristic: async (u) => ({ [S.rx]: rx, [S.tx]: tx, [S.mode]: mode })[u] ?? Promise.reject(new DOMException('no such characteristic', 'NotFoundError')) };
  const pairing = { getCharacteristic: async (u) => (u === S.pair ? { readValue: async () => { window.__pairedBy = window.__pairedBy ?? 'read'; paired = true; return new DataView(new Uint8Array([1, 2, 3, 4]).buffer); } } : Promise.reject(new DOMException('no', 'NotFoundError'))) };
  const device = new EventTarget();
  device.name = 'BlueDriver';
  device.gatt = {
    connected: false,
    connect: async () => { device.gatt.connected = true; return { getPrimaryService: async (u) => (u === S.service ? streaming : u === S.pairService ? pairing : Promise.reject(new DOMException('no such service', 'NotFoundError'))) }; },
    disconnect: () => { device.gatt.connected = false; device.dispatchEvent(new Event('gattserverdisconnected')); },
  };
  window.__sent = []; window.__control = [];
  Object.defineProperty(navigator, 'bluetooth', { configurable: true, value: { requestDevice: async (o) => { window.__requestOptions = o; return device; } } });
}

async function open({ bluetooth = null, bluedriver = null, scheme = 'light', homeScreen = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: SHOTS ? 2 : 1, isMobile: true, hasTouch: true, colorScheme: scheme, serviceWorkers: 'block',
    ...(homeScreen ? { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148' } : {}) });
  const page = await ctx.newPage();
  // A Home Screen web app on iPhone: navigator.standalone is true there.
  if (homeScreen) await page.addInitScript(() => Object.defineProperty(navigator, 'standalone', { get: () => true }));
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  if (bluetooth) await page.addInitScript(simulatedAdapter, bluetooth);
  if (bluedriver) await page.addInitScript(simulatedBlueDriver, bluedriver);
  await page.route((u) => u.protocol === 'https:', (r) => r.fulfill({ status: 503, body: '' }));
  await page.goto(`${base}?demo=120`);
  await page.waitForSelector('.nav-view, .focus-view', { timeout: 60000 });
  await page.evaluate(() => document.querySelector('[data-act="tab"][data-arg="ahead"]')?.click());
  await page.waitForTimeout(600);
  await page.evaluate(() => document.querySelector('[data-act="sheet"][data-arg="fuel"]')?.click());
  await page.waitForSelector('#sheet.open [data-form="fuel"]', { timeout: 10000 });
  // Jerry's car, chosen in the picker from the fuel sheet as a driver does (and saved in the profile): the 2021
  // Porsche 911 Turbo S, EPA 20 mpg highway, 17.6 gallon tank (Porsche press specs, in vehicles.json).
  await page.click('#sheet [data-act="vehicle"]');
  await page.waitForFunction(() => window.exitAtlas.vehicles?.years?.['2021']?.Porsche, null, { timeout: 30000 });
  await page.evaluate(() => {
    const a = window.exitAtlas;
    const i = a.vehicles.years['2021'].Porsche['911'].findIndex((x) => /^911 Turbo S ·/.test(x[0]));
    a.vehiclePick = { year: '2021', make: 'Porsche', model: '911', version: String(i), tank: null };
  });
  // Redraw the picker with that choice (as picking in the menus does), then Use this vehicle.
  await page.evaluate(() => { const b = document.createElement('button'); b.dataset.act = 'vehicle-tank'; b.dataset.arg = ''; document.body.append(b); b.click(); b.remove(); });
  await page.waitForSelector('#sheet [data-act="vehicle-save"]', { timeout: 10000 });
  await page.click('#sheet [data-act="vehicle-save"]');
  await page.waitForTimeout(500);
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
  if (!/Bluetooth is not available in this browser/.test(help ?? '')) fail(`the help does not say why there is no Connect car: ${help}`);
  // Choosing the vehicle from the fuel sheet (open() did) came back to it, where the range and Connect car are.
  const after = await page.evaluate(() => ({ sheet: window.exitAtlas.sheet?.kind ?? null, v: window.exitAtlas.settings.vehicle }));
  if (after.sheet !== 'fuel') fail(`after Use this vehicle the open sheet is ${after.sheet}, not the fuel sheet`);
  if (after.v?.model !== '911' || after.v?.tankGallons !== 17.6 || after.v?.hwy !== 20) fail(`vehicle saved: ${JSON.stringify(after.v)}`);
  if (SHOTS) {
    await page.evaluate(() => document.querySelector('#sheet [data-testid="car-help"]').scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(SHOTS, 'car-help.png') });
  }
  if (errors.length) fail(`page errors: ${errors.join(' | ')}`);
  await ctx.close();
}

// 1b. The Home Screen web app on iPhone: Safari extensions do not run there, so the car connects in Safari; the row
// says so and offers Open in Safari and Copy address.
{
  const fail = (m) => failures.push(`Home Screen app: ${m}`);
  const { ctx, page, errors } = await open({ homeScreen: true });
  const help = await text(page, '#sheet [data-testid="car-help-homescreen"]');
  if (!/Connect your car in Safari/.test(help ?? '') || !/Home Screen/.test(help ?? '') || !/beacio/.test(help ?? '')) fail(`help: ${help}`);
  if (/works only with its own app/.test(help ?? '')) fail('the old BlueDriver line is back');
  const href = await page.getAttribute('#sheet [data-testid="open-in-safari"]', 'href');
  if (!/^x-safari-http:\/\/127\.0\.0\.1:\d+\/web\/index\.html$/.test(href ?? '')) fail(`Open in Safari link: ${href}`);
  if (!(await page.$('#sheet [data-act="copy-address"]'))) fail('no Copy address');
  if (await page.$('#sheet [data-testid="car-help"]')) fail('the plain Bluetooth help shows too');
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
  // 60.4% of 17.6 gallons at 20 mpg is 212.6 miles.
  if (f?.source !== 'car' || Math.abs(f.rangeMeters / 1609.344 - 212.58) > 0.2 || f.percent !== 60.4) fail(`range from the car: ${JSON.stringify(f)} (before ${JSON.stringify(before)})`);
  const label = await text(page, '#sheet [data-testid="range-car"]');
  if (!/From your car: 60\.4% fuel/.test(label ?? '')) fail(`range label: ${label}`);
  // 212.6 miles, less what the simulated drive covered since (the sheet redraws a moment after a tap).
  const dte = Number(await page.inputValue('#sheet input[name="dte"]'));
  if (!(dte >= 210 && dte <= 213)) fail(`Range now field: ${dte}`);
  const cel = await text(page, '#sheet [data-testid="car-check-engine"]');
  if (!/Check engine light is on \(2 stored codes\)/.test(cel ?? '')) fail(`check engine: ${cel}`);
  if (SHOTS) {
    await page.evaluate(() => document.querySelector('#sheet [data-testid="car-row"]').scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(SHOTS, 'car-connected.png') });
  }
  // Settings shows the car too, in whole percents (no age that changes every few seconds).
  await page.evaluate(() => { document.querySelector('[data-act="close-sheet"]')?.click(); document.querySelector('#settings-btn')?.click(); });
  await page.waitForTimeout(500);
  const inSettings = await text(page, '#view [data-testid="car-row"]');
  if (!/Car connected/.test(inSettings ?? '') || !/Fuel 60%/.test(inSettings ?? '') || /ago/.test(inSettings ?? '')) fail(`Settings car row: ${inSettings}`);
  // A car update while a Settings field is typed in keeps the entry; leaving the field saves it and redraws.
  await page.evaluate(() => document.querySelector('#view [data-act="mpg-basis"][data-arg="custom"]')?.click());
  await page.waitForSelector('#view input[data-set="customMpg"]', { timeout: 5000 }).catch(() => {});
  await page.focus('#view input[data-set="customMpg"]');
  await page.keyboard.type('17');
  await page.evaluate(() => { const c = window.exitAtlas.car; c.voltage = 13.4; c.changed(); });
  await page.waitForTimeout(600);
  const typing = await page.inputValue('#view input[data-set="customMpg"]').catch(() => null);
  if (typing !== '17') fail(`a car update wiped the mpg being typed in Settings (${typing})`);
  await page.evaluate(() => document.activeElement?.blur());
  await page.waitForTimeout(500);
  const saved = await page.evaluate(() => window.exitAtlas.settings.customMpg);
  const redrawn = await text(page, '#view [data-testid="car-row"]');
  if (Number(saved) !== 17) fail(`the mpg was not saved after leaving the field (${saved})`);
  if (!/13\.4 V/.test(redrawn ?? '')) fail(`Settings did not catch up after the field was left: ${redrawn}`);
  await page.evaluate(() => document.querySelector('#view [data-act="mpg-basis"][data-arg="highway"]')?.click());
  await page.evaluate(() => document.querySelector('[data-act="tab"][data-arg="ahead"]')?.click());
  await page.waitForTimeout(300);
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

// 5. Car diagnostics (SIMULATED adapter): every item the car lists, with the SAE formulas; one listed item that does
// not answer is flagged; trouble codes; readiness; VIN and control unit name; the session log copies.
{
  const fail = (m) => failures.push(`diagnostics: ${m}`);
  const { ctx, page, errors } = await open({ bluetooth: { fuelPID: true, checkEngine: true, diag: true } });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.click('#sheet [data-act="car-connect"]:not([data-arg])');
  await page.waitForSelector('#sheet [data-act="car-details"]', { timeout: 20000 });
  await page.click('#sheet [data-act="car-details"]');
  await page.waitForSelector('#sheet [data-testid="car-live"]');
  await page.click('#sheet [data-testid="car-live"]');
  await page.waitForFunction(() => /992/.test(document.querySelector('#sheet [data-key="010C"]')?.textContent ?? ''), null, { timeout: 20000 }).catch(() => {});
  const rows = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#sheet .car-item')].map((r) => [r.dataset.key, r.textContent.replace(/\s+/g, ' ').trim()])));
  const want = { '010C': /992 rpm/, '010D': /40 mph/, '0105': /122 °F/, '0104': /50\.2 %/, '015C': /104 °F/, '0142': /12\.59 V/, '0146': /81 °F/ };
  for (const [k, re] of Object.entries(want)) if (!re.test(rows[k] ?? '')) fail(`${k}: ${rows[k]}`);
  if (!/no answer/.test(rows['0103'] ?? '')) fail(`a listed item that does not answer is not flagged: ${rows['0103']}`);
  if (!/min .* max .* avg/.test(rows['010C'] ?? '')) fail(`no min, max, average: ${rows['010C']}`);
  const notListed = await text(page, '#sheet details.facilities summary');
  if (!/Not reported by this car \(\d+\)/.test(notListed ?? '')) fail(`not reported list: ${notListed}`);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'car-live.png') });
  await page.click('#sheet [data-testid="car-live"]');
  // Codes and readiness.
  await page.click('#sheet [data-act="car-tab"][data-arg="codes"]');
  await page.click('#sheet [data-testid="car-read-codes"]');
  await page.waitForSelector('#sheet [data-testid="dtc"]', { timeout: 15000 }).catch(() => {});
  const codes = await page.evaluate(() => [...document.querySelectorAll('#sheet [data-testid="dtc"]')].map((d) => d.textContent.trim()));
  if (codes.join() !== 'P0133,P0420') fail(`codes: ${codes.join()}`);
  const codesText = await text(page, '#sheet .stack');
  if (!/Readiness monitors/.test(codesText ?? '') || !/Evaporative system Not ready/.test(codesText ?? '')) fail(`readiness: ${codesText?.slice(0, 400)}`);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'car-codes.png') });
  // Vehicle information.
  await page.click('#sheet [data-act="car-tab"][data-arg="info"]');
  await page.click('#sheet [data-testid="car-read-info"]');
  await page.waitForFunction(() => /WP0AB2A94MS123456/.test(document.querySelector('#sheet .stack')?.textContent ?? ''), null, { timeout: 15000 }).catch(() => {});
  const info = await text(page, '#sheet .stack');
  if (!/WP0AB2A94MS123456/.test(info ?? '') || !/ECM-EngineControl/.test(info ?? '') || !/ISO 15765-4/.test(info ?? '')) fail(`vehicle information: ${info?.slice(0, 500)}`);
  // The log: copied with its header and the raw requests and answers.
  await page.click('#sheet [data-act="car-tab"][data-arg="log"]');
  await page.click('#sheet [data-testid="car-log-copy"]');
  await page.waitForTimeout(300);
  const copied = await page.evaluate(() => navigator.clipboard.readText()).catch((e) => `clipboard: ${e.message}`);
  if (!/ExitAtlas car session log/.test(copied) || !/> 012F \| 30 31 32 46 0d/.test(copied) || !/< 412F9A/.test(copied) || !/Mode 01 PIDs listed: .*2f/.test(copied)) fail(`log: ${copied.slice(0, 600)}`);
  // Closing the screen stops live data.
  await page.click('#sheet [data-act="car-tab"][data-arg="live"]');
  await page.click('#sheet [data-testid="car-live"]');
  await page.waitForTimeout(500);
  await page.evaluate(() => document.querySelector('[data-act="close-sheet"]')?.click());
  await page.waitForTimeout(300);
  if (await page.evaluate(() => window.exitAtlas.car.live.on)) fail('live data kept running after the screen closed');
  if (errors.length) fail(`page errors: ${errors.join(' | ')}`);
  await ctx.close();
}

// 6. Live data stage 3 (SIMULATED adapter): several items per request, pinned dashboard, one item's chart, an
// alert limit, a recording with its CSV and playback; live data keeps running with the screen closed while it
// watches a limit.
{
  const fail = (m) => failures.push(`stage 3: ${m}`);
  const { ctx, page, errors } = await open({ bluetooth: { fuelPID: true, checkEngine: true, diag: true } });
  await page.click('#sheet [data-act="car-connect"]:not([data-arg])');
  await page.waitForSelector('#sheet [data-act="car-details"]', { timeout: 20000 });
  await page.click('#sheet [data-act="car-details"]');
  await page.click('#sheet [data-testid="car-live"]');
  await page.waitForFunction(() => /up to 6 items per request/.test(document.querySelector('#sheet [data-testid="car-rate"]')?.textContent ?? ''), null, { timeout: 20000 }).catch(() => {});
  const rate = await text(page, '#sheet [data-testid="car-rate"]');
  if (!/readings a second .* up to 6 items per request/.test(rate ?? '')) fail(`rate line: ${rate}`);
  const log1 = await page.evaluate(() => window.exitAtlas.car.exportLog());
  if (!/several items per request: yes/.test(log1)) fail('the multi request probe is not in the log');
  if (!/> 01(0[0-9A-F]|[1-9A-F][0-9A-F]){3,}/.test(log1)) fail('no request for several items in the log');
  // Values read through several-item requests (numbered frames included) match the single-item ones.
  const rpm = await text(page, '#sheet .car-item[data-key="010C"] .car-val');
  const oil = await text(page, '#sheet .car-item[data-key="015C"] .car-val');
  if (!/992/.test(rpm ?? '') || !/104/.test(oil ?? '')) fail(`values through several-item requests: rpm ${rpm}, oil ${oil}`);
  // Pin two items: the dashboard tiles.
  await page.click('#sheet .car-item[data-key="010C"] [data-act="car-pin"]');
  await page.click('#sheet .car-item[data-key="0105"] [data-act="car-pin"]');
  await page.waitForTimeout(600);
  const tiles = await page.evaluate(() => [...document.querySelectorAll('#sheet [data-testid="car-tile"]')].map((t) => t.textContent.replace(/\s+/g, ' ').trim()));
  if (tiles.length !== 2 || !/992 rpm/.test(tiles[0]) || !/122 °F/.test(tiles[1])) fail(`tiles: ${JSON.stringify(tiles)}`);
  const kept = await page.evaluate(() => JSON.parse(localStorage.getItem('ea.carPrefs') ?? '{}').pinned);
  if (JSON.stringify(kept) !== '["010C","0105"]') fail(`pins not kept on the device: ${JSON.stringify(kept)}`);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'car-dashboard.png') });
  // Pinned only: reads just those (and fuel now and then).
  await page.click('#sheet [data-testid="car-only-pinned"]');
  await page.waitForTimeout(1500);
  const pinnedLog = await page.evaluate(() => window.exitAtlas.car.log.slice(-30).filter((l) => l.dir === '>').map((l) => l.text));
  // Every PID in every Mode 01 request is a pinned one or the fuel level.
  const asked = pinnedLog.filter((t) => /^01([0-9A-F]{2})+$/.test(t)).flatMap((t) => t.slice(2).match(/../g));
  if (!asked.length || asked.some((p) => !['0C', '05', '2F'].includes(p))) fail(`pinned only read other items: ${pinnedLog.join(' ')}`);
  await page.click('#sheet [data-testid="car-only-pinned"]');
  // One item: chart, touch readout, alert limit.
  await page.click('#sheet [data-testid="car-tile"][data-key="010C"]');
  await page.waitForSelector('#sheet [data-testid="car-detail"] .car-chart svg', { timeout: 10000 });
  const box = await page.locator('#sheet .car-chart svg').boundingBox();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.5);
  const readout = await text(page, '#sheet .car-chart-readout');
  await page.mouse.up();
  if (!/992 rpm/.test(readout ?? '')) fail(`chart readout: ${readout}`);
  await page.fill('#sheet [data-testid="car-alert-high"]', '900');
  await page.click('#sheet [data-testid="car-alert-save"]');
  await page.waitForSelector('#sheet [data-testid="car-alert-on"]', { timeout: 10000 }).catch(() => {});
  const banner = await text(page, '#sheet [data-testid="car-alert-on"]');
  if (!/Engine speed high.*992 rpm.*limit 900/.test(banner ?? '')) fail(`alert banner: ${banner}`);
  const toastText = await text(page, '#toast');
  if (!/Engine speed high/.test(toastText ?? '') && !/Alert limits saved/.test(toastText ?? '')) fail(`alert toast: ${toastText}`);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'car-detail.png') });
  // Closing the screen while a limit is watched keeps live data on, and says so in Settings.
  await page.evaluate(() => document.querySelector('[data-act="close-sheet"]')?.click());
  await page.waitForTimeout(800);
  if (!(await page.evaluate(() => window.exitAtlas.car.live.on))) fail('live data stopped although an alert limit is watched');
  // Open the screen again the way the Diagnostics button does.
  await page.evaluate(() => { const b = document.createElement('button'); b.dataset.act = 'car-details'; document.body.appendChild(b); b.click(); b.remove(); });
  await page.waitForSelector('#sheet [data-testid="car-live"]', { timeout: 5000 }).catch(() => fail('Diagnostics did not open again'));
  // Clear the limit (from the item), then record.
  await page.click('#sheet [data-testid="car-tile"][data-key="010C"]').catch(() => {});
  await page.click('#sheet [data-act="car-alert-clear"]').catch(() => fail('no Clear for the alert limit'));
  await page.click('#sheet [data-testid="car-detail-back"]');
  await page.click('#sheet [data-testid="car-rec-start"]');
  await page.waitForTimeout(2500);
  await page.click('#sheet [data-testid="car-rec-stop"]');
  await page.click('#sheet [data-act="car-tab"][data-arg="rec"]');
  await page.waitForSelector('#sheet [data-testid="car-recording"]', { timeout: 10000 }).catch(() => {});
  const recs = await page.evaluate(() => [...document.querySelectorAll('#sheet [data-testid="car-recording"]')].map((r) => r.textContent.replace(/\s+/g, ' ').trim()));
  if (recs.length !== 1 || !/[1-9][\d,]* readings/.test(recs[0])) fail(`recordings: ${JSON.stringify(recs)}`);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'car-record.png') });
  // CSV: downloaded (no file sharing in this browser), one row per reading in the units shown.
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }).catch(() => null), page.click('#sheet [data-testid="car-rec-csv"]')]);
  const csv = download ? await readFile(await download.path(), 'utf8') : '';
  const lines = csv.trim().split('\n');
  if (lines[0] !== 'time,elapsed_s,pid,sensor,value,unit' || !lines.some((l) => /,0C,Engine speed,992,rpm$/.test(l)) || !lines.some((l) => /,05,Coolant temperature,122,°F$/.test(l))) fail(`CSV: ${csv.slice(0, 300)}`);
  if (download && !/^ExitAtlas_car_\d{4}-\d\d-\d\d_\d{4}\.csv$/.test(download.suggestedFilename())) fail(`CSV name: ${download.suggestedFilename()}`);
  // Playback: the recording drives the dashboard and the items, with live data off.
  await page.click('#sheet [data-testid="car-rec-play"]');
  await page.waitForSelector('#sheet [data-testid="car-playback"]', { timeout: 10000 }).catch(() => {});
  // The screen holds still for a moment after a tap, then follows the playback.
  await page.waitForFunction(() => /992 rpm/.test(document.querySelector('#sheet [data-testid="car-tile"]')?.textContent ?? ''), null, { timeout: 8000 }).catch(() => {});
  const pbTiles = await page.evaluate(() => [...document.querySelectorAll('#sheet [data-testid="car-tile"]')].map((t) => t.textContent.replace(/\s+/g, ' ').trim()));
  if (!pbTiles.length || !/992 rpm/.test(pbTiles[0])) fail(`playback tiles: ${JSON.stringify(pbTiles)}`);
  if (await page.evaluate(() => window.exitAtlas.car.live.on)) fail('live data still on during playback');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'car-playback.png') });
  await page.click('#sheet [data-testid="car-pb-stop"]');
  if (await page.$('#sheet [data-testid="car-playback"]')) fail('playback did not stop');
  // Recordings persist on the device (IndexedDB) across a reload.
  await page.reload();
  const kept2 = await page.evaluate(async () => (await new Promise((res) => { const r = indexedDB.open('exitatlas-car'); r.onsuccess = () => { const tx = r.result.transaction('meta').objectStore('meta').getAll(); tx.onsuccess = () => res(tx.result.length); }; r.onerror = () => res(-1); })));
  if (kept2 !== 1) fail(`recordings after a reload: ${kept2}`);
  if (errors.length) fail(`page errors: ${errors.join(' | ')}`);
  await ctx.close();
}

// 4. BlueDriver (SIMULATED, unofficial): found by its streaming service, its own setup in order and never an AT
// command, Fast Ack flow control (buffer size first, every fragment acknowledged), the fuel level, voltage from
// PID 42, labeled unofficial.
{
  const fail = (m) => failures.push(`BlueDriver: ${m}`);
  const { ctx, page, errors } = await open({ bluedriver: {} });
  await page.click('#sheet [data-act="car-connect"]:not([data-arg])');
  await page.waitForFunction(() => /60\.4%/.test(document.querySelector('#sheet [data-testid="car-fuel"]')?.textContent ?? ''), null, { timeout: 20000 }).catch(() => {});
  const opts = await page.evaluate(() => window.__requestOptions);
  if (!opts?.optionalServices?.includes('331a36f5-2459-45ea-9d95-6142f0c4b307') || !opts.filters?.some((f) => f.namePrefix === 'BlueDriv')) fail(`picker options: ${JSON.stringify(opts)}`);
  const sent = await page.evaluate(() => window.__sent);
  if (sent.slice(0, 9).join() !== 'LMI,LMD,LML0,LMI,LMD,LMDP,LMI,LMX1,LMX0') fail(`setup: ${sent.join()}`);
  if (sent.some((c) => /^AT/i.test(c))) fail(`an AT command was sent: ${sent.join()}`);
  if (!sent.includes('012F') || !sent.includes('0142')) fail(`requests: ${sent.join()}`);
  const control = await page.evaluate(() => window.__control);
  if (control[0] !== '00 ff 7f' || !control.slice(1).every((c) => /^01 0[1-7] 00$/.test(c))) fail(`flow control: ${control.slice(0, 6).join(' | ')}`);
  const row = await text(page, '#sheet [data-testid="car-row"]');
  if (!/Fuel 60\.4%/.test(row ?? '') || !/BlueDriver, unofficial/.test(row ?? '') || !/Battery 12\.6 V/.test(row ?? '') || !/OSAPI v2\.60/.test(row ?? '')) fail(`car row: ${row}`);
  const f = await page.evaluate(() => window.exitAtlas.fuel);
  if (f?.source !== 'car' || f.percent !== 60.4) fail(`range from the car: ${JSON.stringify(f)}`);
  if (SHOTS) {
    await page.evaluate(() => document.querySelector('#sheet [data-testid="car-row"]').scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(SHOTS, 'car-bluedriver.png') });
  }
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
