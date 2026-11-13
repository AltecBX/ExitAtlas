// The car connection: an OBD2 adapter with Bluetooth LE that speaks the ELM327 command set, through the standard
// Web Bluetooth API (Chrome on Android and computers; on iPhone, Safari with the free beacio extension, formerly
// WebBLE, which installs navigator.bluetooth on secure pages: https://beacio.com/docs.html). It reads the fuel
// tank level the car reports (OBD2 PID 2F), the check engine light and the adapter's battery voltage. Nothing is
// stored or sent anywhere; the fuel level becomes the range the fuel planner uses (main.js carChanged).
//
// BlueDriver too, unofficially (Jerry's decision, Nov 5 2026; BlueDriver supports only its own app): its sensor is a
// Silicon Labs BGX module, whose Xpress Streaming Service and flow control Silicon Labs documents
// (docs.silabs.com/gecko-os/1/bgx/1.0/ble-services), carrying ELM327 style requests with BlueDriver's own setup and
// byte scramble (engine/obd.js BLUEDRIVER_SETUP, bluedriverCodec).
import { SETUP_COMMANDS, BLUEDRIVER_SETUP, PIDS, command, parseAnswer, readPID, supports, monitorStatus, parseVoltage,
  parseIdentity, steadyFuel, bluedriverCodec, PROBLEM_TEXT } from '../engine/obd.js';
import { MASK_PIDS, NOT_LIVE, PIDS01, channelsFor, obdbChannels, toUS } from '../engine/obdpids.js';
import { mode22Data } from '../engine/obdb.js';
import { roundPIDs, batches, multiCommand, parseMulti, alertState, MULTI_MAX, SLOW_EVERY } from '../engine/obdlive.js';
import { parseDTCs, parseVIN, parseInfoText, answerBytes, answerLines, readiness } from '../engine/obddiag.js';

/// Bluetooth LE serial services OBD2 adapters use, with their notify and write characteristics. FFF0 (FFF1
/// notify, FFF2 write) is documented for the OBDLink CX (support.obdlink.com, "OBDLink CX adapter notes") and
/// used by many ELM327 adapters; FFE0 (FFE1 both ways) is the HM-10 style serial service; 18F0 is listed by
/// community ELM327 code. Characteristics are discovered when the browser can list them; the pairs are the
/// fallback.
export const UART_SERVICES = Object.freeze([
  { service: 0xfff0, notify: 0xfff1, write: 0xfff2 },
  { service: 0xffe0, notify: 0xffe1, write: 0xffe1 },
  { service: 0x18f0, notify: 0x2af0, write: 0x2af1 },
]);

/// The BlueDriver's Bluetooth: Silicon Labs' Xpress Streaming Service. Peripheral Rx takes the requests (write
/// without response) and notifies flow control; Peripheral Tx notifies the answers and takes flow control writes;
/// Mode notifies status. Silicon Labs' Fast Ack flow control: the app writes its buffer size to Tx (00 FF 7F) and,
/// for every answer fragment, the bytes it freed (01 <count> 00); without them the sensor stops after one fragment.
/// The Xpress services are always encrypted: reading the pairing characteristic (another service, as the sensor
/// shows it) makes the phone pair (Just Works, no code).
export const BLUEDRIVER = Object.freeze({
  service: '331a36f5-2459-45ea-9d95-6142f0c4b307',
  rx: 'a9da6040-0823-4995-94ec-9ce41ca28833',
  tx: 'a73e9a10-628f-4494-a099-12efaf72258f',
  mode: '75a9f022-af03-4e41-b4bc-9de90a47d50b',
  pairService: '169b52a0-b7fd-40da-998c-dd9238327e55',
  pairCharacteristic: '12e868e7-c926-4906-96c8-a7ee81d4b1b3',
  names: ['BlueDriv', 'LSB2-'],
});

/// Names OBD2 adapters advertise, for the device picker (adapters do not always advertise their service).
const NAME_PREFIXES = ['OBD', 'OBDLink', 'vLinker', 'VLINK', 'V-LINK', 'IOS-Vlink', 'Android-Vlink', 'Vgate', 'Veepeak', 'VEEPEAK', 'ELM', 'iCar', ...BLUEDRIVER.names];

export const CAR_RULES = Object.freeze({
  /// Seconds between fuel level reads, monitor status and voltage reads.
  fuelEvery: 5, statusEvery: 60,
  /// Command time limits (ms): the first request searches for the car's protocol and can take several seconds.
  commandTimeout: 4000, searchTimeout: 15000,
  /// A pause between two readings longer than this is not counted into a sensor's update interval (ms).
  gapMs: 10000,
  /// After a request with no answer, the longest wait for its late answer before the next request goes out (ms).
  settleMs: 2000,
  /// A request that answered with no data or an error is asked again this often (ms), not on every pass.
  retryFailedMs: 15000,
  /// Bytes per write (the smallest Bluetooth LE payload; the CX takes more but does not queue writes).
  chunk: 20,
  /// Reconnect tries after an unintended disconnect, seconds apart.
  reconnectAfter: [3, 10, 30],
  /// A fuel reading older than this is not "now".
  freshSeconds: 60,
  /// Lines kept in the session log, and live samples kept per sensor for its chart.
  logLines: 4000, history: 1200,
  /// Readings a recording holds at most (about 4 hours at 25 a second), and how often (s) one is saved as it runs.
  recordCap: 360000, autosaveEvery: 60,
  /// Answers to a request for several items that cannot be split before going back to one item per request.
  multiFailures: 3,
  /// Milliseconds between Bluetooth operations: beacio on iPhone limits how many a page may make ("Rate limit
  /// exceeded — too many BLE requests" after about 25 in under half a second, Jerry's BlueDriver log, Nov 6 2026);
  /// browsers with their own Web Bluetooth have no such limit. On that error the gap doubles (up to bleGapMax) and
  /// the operation is tried again after bleRetryPause ms, up to bleRetries times.
  bleGapIOS: 60, bleGapMax: 1000, bleRetryPause: 1500, bleRetries: 6,
  /// Fast Ack: fragments that arrive within this many ms are acknowledged in one write.
  ackBatchMs: 30,
  /// The screen is redrawn at most this often (ms) while live data streams.
  liveRedraw: 400,
});

/// What to do after a failed device list, from the error beacio or the browser gave (beacio's codes and recovery
/// steps: @beacio/core 2.2.0 README and beacio.com/docs Troubleshooting).
/// ELM327 protocol numbers (ELM327 data sheet, "SP h" and "DPN"); the BlueDriver's LMDP answers with the number
/// and OK ("6\rOK" on Jerry's 2021 911, Nov 6 2026).
const PROTOCOLS = Object.freeze({ 0: 'Automatic', 1: 'SAE J1850 PWM (41.6 kbaud)', 2: 'SAE J1850 VPW (10.4 kbaud)',
  3: 'ISO 9141-2 (5 baud init)', 4: 'ISO 14230-4 KWP (5 baud init)', 5: 'ISO 14230-4 KWP (fast init)',
  6: 'ISO 15765-4 CAN (11 bit ID, 500 kbaud)', 7: 'ISO 15765-4 CAN (29 bit ID, 500 kbaud)', 8: 'ISO 15765-4 CAN (11 bit ID, 250 kbaud)',
  9: 'ISO 15765-4 CAN (29 bit ID, 250 kbaud)', A: 'SAE J1939 CAN (29 bit ID, 250 kbaud)', B: 'User CAN 1', C: 'User CAN 2' });

export function protocolName(answer) {
  const first = String(answer ?? '').split(/[\r\n>]+/).map((t) => t.trim()).filter((t) => t && !/^OK$/i.test(t))[0] ?? '';
  const n = first.match(/^A?([0-9A-C])$/i);
  if (n) { const name = PROTOCOLS[n[1].toUpperCase()]; return name ? `${name}, protocol ${n[1].toUpperCase()}` : first; }
  return first || null;
}

export function pickerHint(e) {
  const m = `${e?.name ?? ''} ${e?.message ?? ''}`;
  if (/not enabled|activation|not active|starting up|setup/i.test(m))
    return 'beacio is not allowed on this site yet: tap the page menu at the left of the address bar, beacio, Allow on Every Website, then reload and tap Connect car.';
  if (/timed? ?out|timeout/i.test(m))
    return 'Open the beacio app once and allow Bluetooth; in Safari allow beacio on every website; unplug the adapter for 5 seconds, close its own app, reload, then tap Connect car and pick it within a few seconds.';
  if (/NotFoundError|no .*device/i.test(m))
    return 'No adapter was found: plug it in with the ignition on, close its own app, then try "Show all Bluetooth devices".';
  if (/Security|gesture/i.test(m)) return 'Tap Connect car again (Bluetooth needs a tap).';
  if (/NotAllowed|denied|permission/i.test(m)) return 'Allow Bluetooth for beacio: iPhone Settings, Privacy & Security, Bluetooth.';
  return 'Copy the connection log and send it.';
}

export class CarLink {
  constructor({ bluetooth = globalThis.navigator?.bluetooth, onChange = () => {}, onAlert = () => {}, onRecorded = () => {}, clock = () => Date.now() / 1000 } = {}) {
    this.bluetooth = bluetooth;
    this.onChange = onChange;
    this.onAlert = onAlert;
    this.onRecorded = onRecorded;
    this.clock = clock;
    /// The driver's choices (main.js keeps them on this device): pinned channel keys, alert limits per channel key
    /// in the units shown ({ low, high }), and whether live data reads only the pinned items.
    this.prefs = { pinned: [], alerts: {}, onlyPinned: false };
    /// The recording under way: { id, startedAt, endedAt, vehicle, adapter, channels, samples: [[ms, key, value]] }.
    this.rec = null;
    /// Live data was started and not stopped by the driver: it starts again after a reconnect.
    this.wantLive = false;
    this.alertStates = new Map();
    /// The Bluetooth pacer (ble()): the gap between operations, and when the next one may start.
    const ios = /iPhone|iPad|iPod/.test(globalThis.navigator?.userAgent ?? '');
    this.bleGap = ios ? CAR_RULES.bleGapIOS : 0;
    this.bleNext = 0;
    /// The session log: every request and answer, raw and readable, kept across drops (copy it after a failure).
    this.log = []; this.logStart = Date.now();
    this.reset();
  }

  reset() {
    // A connection being opened, a request in the air and the live loop all belong to the old connection.
    this.openGen = (this.openGen ?? 0) + 1;
    this.liveGen = (this.liveGen ?? 0) + 1;
    if (this.waiting || this.settling) this.abandon('disconnected');
    this.unlisten?.();
    /// idle | connecting | connected | disconnected | error
    this.state = 'idle';
    this.device = null; this.name = null; this.identity = null;
    this.problem = null;
    this.supportsFuel = null;
    this.readings = [];
    this.fuel = null; this.fuelAt = null;
    this.checkEngine = null; this.codes = null; this.voltage = null;
    this.disconnectedAt = null;
    this.tries = 0;
    /// Discovery and diagnostics: the Mode 01 PIDs the car lists, Mode 09 ones, readiness bytes, trouble codes,
    /// vehicle information, the adapter's own details.
    this.supported = null; this.supported09 = null; this.monitorBytes = null; this.monitorByUnit = null; this.dtc = null; this.info = null;
    this.protocol = null; this.deviceInfo = null;
    /// Live data: on, and per channel key { value, t, min, max, sum, n, history }; per PID 'ok' or 'noData'.
    /// multi: PIDs per request (null until probed, 1 for one at a time); rate: readings and requests a second.
    this.live = { on: false, values: new Map(), status: new Map(), cycleMs: null, requests: 0, startedAt: null, round: 0, multi: null,
      multiFailures: 0, rate: null, latency: null, answers: 0, timeouts: 0, lastRead: new Map(), fails: new Map(), passes: 0 };
    /// Porsche manufacturer data (Mode 22): each request's last result by key ('ok', 'noData', 'refused',
    /// 'several', 'shared', 'error'), and the module header the adapter is set to (ELM327 only).
    this.enhanced = { results: new Map(), header: null };
    this.write = null; this.control = null; this.kind = null; this.waiting = null; this.buffer = ''; this.queue = Promise.resolve();
    this.late = false; this.settling = null;
    this.unacked = 0; clearTimeout(this.ackTimer); this.ackTimer = null;
    this.stopTimers();
  }

  /// Listeners added to the device and its characteristics are removed again (unlisten: all, on reset;
  /// unlistenSerial: the characteristics', before each open).
  unlistenSerial() {
    for (const [target, type, fn] of this.heardSerial ?? []) { try { target.removeEventListener?.(type, fn); } catch { /* gone */ } }
    this.heardSerial = [];
  }

  unlisten() {
    this.unlistenSerial();
    for (const [target, type, fn] of this.heard ?? []) { try { target.removeEventListener?.(type, fn); } catch { /* gone */ } }
    this.heard = [];
  }

  /// Web Bluetooth is there (Chrome, or Safari with beacio).
  get available() { return typeof this.bluetooth?.requestDevice === 'function'; }

  /// The fuel level when it is current, else null.
  get freshFuel() { return this.fuel != null && this.clock() - this.fuelAt <= CAR_RULES.freshSeconds ? this.fuel : null; }

  changed() { this.lastChanged = Date.now(); try { this.onChange(this); } catch { /* the view's problem */ } }

  /// While live data streams, the screen is told at most every CAR_RULES.liveRedraw ms.
  changedSoon() {
    if (Date.now() - (this.lastChanged ?? 0) >= CAR_RULES.liveRedraw) { this.changed(); return; }
    if (this.soon) return;
    this.soon = setTimeout(() => { this.soon = null; this.changed(); }, CAR_RULES.liveRedraw);
  }

  /// One log line: direction (> sent, < received, ~ flow control, i information, ! problem), text, raw bytes.
  logLine(dir, text, bytes = null) {
    const hex = bytes ? Array.from(bytes, (x) => x.toString(16).padStart(2, '0')).join(' ') : '';
    this.log.push({ t: Date.now() - this.logStart, dir, text: String(text ?? '').replace(/\r/g, '\\r'), hex });
    if (this.log.length > CAR_RULES.logLines) this.log.splice(0, this.log.length - CAR_RULES.logLines);
  }

  /// The session log as text, with what was connected, for sending to whoever reads it.
  exportLog(header = '') {
    const head = [`ExitAtlas car session log, ${new Date(this.logStart).toISOString()}`, header,
      `Adapter: ${this.name ?? 'none'} (${this.kind ?? 'unknown'})${this.identity ? `, ${this.identity}` : ''}`,
      this.deviceInfo ? `Device information: ${JSON.stringify(this.deviceInfo)}` : '', this.protocol ? `Protocol: ${this.protocol}` : '',
      this.supported ? `Mode 01 PIDs listed: ${[...this.supported].map((p) => p.toString(16).padStart(2, '0')).join(' ')}` : '',
      'Columns: ms since start, direction (> sent, < received, ~ flow control, i info, ! problem), text | raw bytes on the wire', '']
      .filter((l) => l !== '');
    return [...head, ...this.log.map((l) => `${String(l.t).padStart(8)} ${l.dir} ${l.text}${l.hex ? ` | ${l.hex}` : ''}`)].join('\n');
  }

  /// Every Bluetooth operation goes through here, spaced bleGap ms apart (slots are taken in call order, so
  /// operations started together still go one gap apart). A rate limit error slows the pace and tries again.
  async ble(fn, what) {
    for (let attempt = 0; ; attempt++) {
      const now = performance.now();
      const start = Math.max(now, this.bleNext);
      this.bleNext = start + this.bleGap;
      if (start > now) await new Promise((r) => setTimeout(r, start - now));
      try {
        return await fn();
      } catch (e) {
        if (!/rate limit/i.test(e?.message ?? '') || attempt >= CAR_RULES.bleRetries) throw e;
        this.bleGap = Math.min(CAR_RULES.bleGapMax, Math.max(this.bleGap * 2, 50));
        this.logLine('!', `${what}: ${e.message}; now ${this.bleGap} ms between Bluetooth requests, trying again in ${CAR_RULES.bleRetryPause / 1000} s`);
        await new Promise((r) => setTimeout(r, CAR_RULES.bleRetryPause));
        this.bleNext = performance.now();
      }
    }
  }

  /// Opens the device picker and connects. Must be called from a tap (browsers require a user gesture). `any`
  /// lists every Bluetooth device, for an adapter that advertises neither a known name nor its service.
  async connect({ any = false } = {}) {
    if (!this.available || this.picking) return;
    // Services as full UUID strings (the standard allows 16 bit numbers too; strings leave nothing to an
    // implementation's alias handling).
    const full = (u) => (typeof u === 'number' ? `0000${u.toString(16).padStart(4, '0')}-0000-1000-8000-00805f9b34fb` : u);
    const optionalServices = [BLUEDRIVER.service, ...UART_SERVICES.map((u) => u.service), BLUEDRIVER.pairService, 0x180a].map(full);
    const options = any ? { acceptAllDevices: true, optionalServices }
      : { filters: [BLUEDRIVER.service, ...UART_SERVICES.map((u) => u.service)].map((s) => ({ services: [full(s)] })).concat(NAME_PREFIXES.map((namePrefix) => ({ namePrefix }))), optionalServices };
    // The device list is open until the driver picks or it gives up: one request at a time, shown on screen, and
    // every attempt in the log (kept until a device is picked), so a failure can be copied with its details.
    this.picking = { any, at: Date.now() };
    this.problem = null;
    this.logLine('i', `--- Connect car${any ? ' (all devices)' : ''}: device list requested (${navigator?.userAgent ?? 'unknown browser'})`);
    this.changed();
    let device;
    try {
      device = await this.bluetooth.requestDevice(options);
    } catch (e) {
      const secs = ((Date.now() - this.picking.at) / 1000).toFixed(1);
      this.picking = null;
      this.logLine('!', `device list: ${e?.name ?? 'Error'}: ${e?.message ?? e} after ${secs} s`);
      // Closing the picker is not an error. beacio also reports its own setup problems as NotFoundError ("User has
      // not enabled Web Bluetooth for this origin", "Beacio activation timed out": @beacio/core 2.2.0), so only a
      // cancel stays quiet; everything else is shown with what to do.
      const cancelled = e?.name === 'AbortError' || (e?.name === 'NotFoundError' && /cancel/i.test(e?.message ?? ''));
      if (cancelled) this.problem = null;
      else { this.state = 'error'; this.problem = `Bluetooth: ${e?.message ?? e} (${e?.name ?? 'Error'} after ${secs} s). ${pickerHint(e)}`; }
      this.changed();
      return;
    }
    this.picking = null;
    const tries = this.log;
    this.reset();
    this.log = tries.slice(-50); this.logStart = Date.now();
    this.device = device;
    this.name = device.name || 'OBD2 adapter';
    this.logLine('i', `picked ${this.name}${any ? ' (all devices)' : ''}`);
    this.onGattLost = () => { if (this.device === device) this.lost(); };
    device.addEventListener?.('gattserverdisconnected', this.onGattLost);
    this.heard.push([device, 'gattserverdisconnected', this.onGattLost]);
    await this.open();
  }

  /// Connects to the chosen adapter (again, after a drop) and starts reading.
  async open() {
    // A newer open, or a disconnect by the driver, makes this one stale: it then changes nothing.
    const gen = ++this.openGen;
    const stale = () => gen !== this.openGen;
    this.state = 'connecting'; this.problem = null; this.changed();
    try {
      const server = await this.ble(() => this.device.gatt.connect(), 'connect');
      if (stale()) return;
      const { notify, write, kind, control, mode } = await this.findSerial(server);
      if (stale()) return;
      this.kind = kind;
      this.logLine('i', `serial: ${kind}`);
      const deviceInfo = await this.readDeviceInfo(server);
      if (stale()) return;
      this.deviceInfo = deviceInfo;
      if (kind === 'bluedriver' && !/bluedriv/i.test(this.name ?? '')) this.name = `BlueDriver ${this.name ?? ''}`.trim();
      this.write = write;
      this.control = control ?? null;
      this.buffer = ''; this.queue = Promise.resolve(); this.waiting = null; this.late = false;
      // The adapter was reset by the reconnect: it is no longer pointed at one module.
      this.enhanced.header = null;
      // One listener per characteristic, whatever the number of reconnects (a platform may hand back the same
      // object, and two listeners would take every answer twice).
      this.unlistenSerial();
      const onValue = (e) => { if (gen === this.openGen) this.received(e.target.value); };
      notify.addEventListener('characteristicvaluechanged', onValue);
      this.heardSerial.push([notify, 'characteristicvaluechanged', onValue]);
      if (kind === 'bluedriver') {
        await this.openBlueDriver(server, { notify, write, mode });
      } else {
        await this.ble(() => notify.startNotifications(), 'notifications');
        for (const c of SETUP_COMMANDS) await this.send(c);
        this.identity = parseIdentity(await this.send('ATI'));
      }
      if (stale()) return;
      this.logLine('i', `identity: ${this.identity ?? 'none'}`);
      this.state = 'connected'; this.tries = 0; this.disconnectedAt = null;
      this.changed();
      await this.findPIDs();
      if (stale()) return;
      this.startTimers();
      if (this.wantLive && !this.live.on) this.startLive();
    } catch (e) {
      if (stale()) return;
      this.logLine('!', `open failed: ${e?.message ?? e}`);
      if (this.state === 'disconnected') return;
      this.state = 'error';
      this.problem = e?.problem ? PROBLEM_TEXT[e.problem] : `Could not talk to the adapter: ${e?.message ?? e}`;
      this.changed();
      try { this.device?.gatt?.disconnect(); } catch { /* already gone */ }
    }
  }

  /// BlueDriver: notifications on Rx (flow control), Tx (answers) and Mode, the pairing read, the buffer size, then
  /// its own setup (no AT commands). Notifications first, as its own app does; if the phone refuses them before
  /// pairing, pair and try again.
  async openBlueDriver(server, { notify, write, mode }) {
    const subscribe = async () => {
      await this.ble(() => write.startNotifications(), 'Rx notifications');
      await this.ble(() => notify.startNotifications(), 'Tx notifications');
      if (mode) await this.ble(() => mode.startNotifications(), 'Mode notifications').catch(() => {});
    };
    const pair = async () => {
      try {
        const svc = await this.ble(() => server.getPrimaryService(BLUEDRIVER.pairService), 'pairing service');
        const ch = await this.ble(() => svc.getCharacteristic(BLUEDRIVER.pairCharacteristic), 'pairing characteristic');
        const v = await this.ble(() => ch.readValue(), 'pairing read');
        this.logLine('i', 'pairing characteristic read', new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
      } catch (e) { this.logLine('i', `pairing characteristic: ${e?.message ?? e}`); }
    };
    try { await subscribe(); await pair(); } catch (e) { this.logLine('i', `notifications before pairing: ${e?.message ?? e}`); await pair(); await subscribe(); }
    const onFlow = (e) => {
      const v = e.target.value;
      this.logLine('~', 'rx flow control', new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
    };
    write.addEventListener('characteristicvaluechanged', onFlow);
    this.heardSerial.push([write, 'characteristicvaluechanged', onFlow]);
    // Fast Ack: our buffer, 0x7FFF bytes (little endian).
    await this.ble(() => this.control.writeValueWithoutResponse(new Uint8Array([0x00, 0xff, 0x7f])), 'buffer size');
    let id = null;
    for (const c of BLUEDRIVER_SETUP) {
      const answer = await this.send(c);
      if (c === 'LMI' && !id) id = parseIdentity(answer);
      if (c === 'LMDP') this.protocol = protocolName(answer);
    }
    this.identity = id;
  }

  /// The adapter's serial service and its notify and write characteristics: the BlueDriver's Xpress Streaming
  /// Service first, then the ELM327 serial services.
  async findSerial(server) {
    try {
      const svc = await this.ble(() => server.getPrimaryService(BLUEDRIVER.service), 'BlueDriver service');
      const rx = await this.ble(() => svc.getCharacteristic(BLUEDRIVER.rx), 'Rx');
      const tx = await this.ble(() => svc.getCharacteristic(BLUEDRIVER.tx), 'Tx');
      const mode = await this.ble(() => svc.getCharacteristic(BLUEDRIVER.mode), 'Mode').catch(() => null);
      return { kind: 'bluedriver', write: rx, notify: tx, control: tx, mode };
    } catch { /* not a BlueDriver */ }
    for (const u of UART_SERVICES) {
      let service;
      try { service = await this.ble(() => server.getPrimaryService(u.service), 'serial service'); } catch { continue; }
      let list = null;
      try { list = typeof service.getCharacteristics === 'function' ? await this.ble(() => service.getCharacteristics(), 'characteristics') : null; } catch { list = null; }
      if (list?.length) {
        const notify = list.find((c) => c.properties?.notify || c.properties?.indicate);
        const write = list.find((c) => c.properties?.writeWithoutResponse || c.properties?.write);
        if (notify && write) return { kind: 'elm', notify, write };
      }
      try {
        return { kind: 'elm', notify: await this.ble(() => service.getCharacteristic(u.notify), 'notify'), write: await this.ble(() => service.getCharacteristic(u.write), 'write') };
      } catch { /* try the next service */ }
    }
    throw new Error('no OBD2 serial service found. The adapter may not be ELM327 compatible');
  }

  /// Text from the adapter: an answer is complete at ">". A BlueDriver's bytes are unscrambled, and each fragment
  /// is acknowledged (Fast Ack: bytes freed, little endian) so the next one comes.
  received(view) {
    let bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    if (this.kind === 'bluedriver') {
      bytes = bluedriverCodec(bytes);
      // Fast Ack: the bytes we have taken, 16 bit little endian. Fragments that arrive together are acknowledged in
      // one write, so a several fragment answer costs one Bluetooth request, not one per fragment.
      this.unacked = (this.unacked ?? 0) + view.byteLength;
      if (!this.ackTimer) this.ackTimer = setTimeout(() => this.flushAck(), CAR_RULES.ackBatchMs);
      // The answer is complete: acknowledge now, before the next request goes out. In Jerry's log (Nov 6) each
      // request took about 220 ms with the acknowledgement after the next request, against about 100 ms when it
      // came first, so the sensor appears to wait for it.
      if (bytes.includes(0x3e)) this.flushAck();
    }
    const fragment = new TextDecoder().decode(bytes);
    this.logLine('<', fragment, new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
    this.buffer += fragment;
    const end = this.buffer.indexOf('>');
    if (end < 0) return;
    const w = this.waiting;
    if (!w || w.done) {
      // A complete answer nobody waits for (it came after its time limit): dropped, never kept for the next request.
      this.buffer = this.buffer.slice(this.buffer.lastIndexOf('>') + 1);
      this.logLine('!', 'late answer dropped');
      this.late = false;
      this.settling?.();
      return;
    }
    const text = this.buffer.slice(0, end);
    this.buffer = this.buffer.slice(end + 1);
    this.waiting = null;
    w.done = true;
    clearTimeout(w.timer);
    w.resolve(text);
  }

  /// Fast Ack: the bytes taken since the last acknowledgement, in one write.
  flushAck() {
    clearTimeout(this.ackTimer); this.ackTimer = null;
    const n = Math.min(this.unacked ?? 0, 0xffff);
    if (!n) return;
    this.unacked -= n;
    const control = this.control;
    if (control) this.ble(() => control.writeValueWithoutResponse(new Uint8Array([0x01, n & 0xff, n >> 8])), 'Fast Ack').catch(() => {});
  }

  /// Sends one command and resolves with the adapter's answer (one at a time; the adapter takes no queue).
  /// An answer belongs to the request before it only by order, so the order must never slip: text left from an
  /// earlier request is thrown away before a request goes out, the time limit starts once the request is on the
  /// air, and after a request that got no answer (or failed halfway) the next one waits until that late answer has
  /// come or the line has been quiet, so a late answer is never taken for the next request's.
  send(cmd, timeout = CAR_RULES.commandTimeout) {
    const run = async () => {
      if (!this.write) throw new Error('not connected');
      // An ELM327 left pointed at one module by a Porsche request: back to every module before a standard request.
      if (this.kind === 'elm' && this.enhanced.header && this.enhanced.header !== '7DF' && !/^(AT|22)/i.test(cmd)) {
        await this.exchange('ATSH7DF', CAR_RULES.commandTimeout);
        this.enhanced.header = '7DF';
      }
      return this.exchange(cmd, timeout);
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  /// One request and its answer. Only send() calls it, one at a time.
  async exchange(cmd, timeout) {
    if (!this.write) throw new Error('not connected');
    if (this.late) await this.settle();
    if (!this.write) throw new Error('not connected');
    this.buffer = '';
    const w = { cmd, done: false, timer: null, resolve: null, reject: null };
    const answer = new Promise((resolve, reject) => { w.resolve = resolve; w.reject = reject; });
    answer.catch(() => {}); // a rejection is always handled below; this keeps an early one from being "unhandled"
    this.waiting = w;
    let started = performance.now();
    try {
      const plain = new TextEncoder().encode(`${cmd}\r`);
      const bytes = this.kind === 'bluedriver' ? bluedriverCodec(plain) : plain;
      this.logLine('>', cmd, bytes);
      this.live.requests++;
      const useNoResponse = typeof this.write.writeValueWithoutResponse === 'function' && this.write.properties?.writeWithoutResponse !== false;
      for (let i = 0; i < bytes.length; i += CAR_RULES.chunk) {
        const part = bytes.slice(i, i + CAR_RULES.chunk);
        const wr = this.write;
        if (!wr) throw new Error('adapter disconnected');
        if (useNoResponse) await this.ble(() => wr.writeValueWithoutResponse(part), `write ${cmd}`);
        else if (typeof wr.writeValueWithResponse === 'function') await this.ble(() => wr.writeValueWithResponse(part), `write ${cmd}`);
        else await this.ble(() => wr.writeValue(part), `write ${cmd}`);
        if (i === 0) started = performance.now();
      }
    } catch (e) {
      // Part of the request may have gone out: whatever comes back is not the next request's answer.
      if (this.waiting === w) this.waiting = null;
      if (!w.done) { w.done = true; this.late = true; }
      throw e;
    }
    if (!w.done) {
      w.timer = setTimeout(() => {
        if (w.done) return;
        w.done = true;
        if (this.waiting === w) this.waiting = null;
        this.late = true;
        w.reject(new Error(`no answer to ${cmd}`));
      }, timeout);
    }
    // Time from the request on the air to the whole answer, and answers that never came (dropped).
    try {
      const text = await answer;
      const ms = performance.now() - started;
      this.live.answers++;
      this.live.latency = this.live.latency == null ? ms : this.live.latency * 0.8 + ms * 0.2;
      return text;
    } catch (e) {
      this.live.timeouts++;
      throw e;
    }
  }

  /// After a request that got no answer: waits for its late answer (the adapter's ">"), at most settleMs, so that
  /// answer cannot be taken for the next request's.
  settle() {
    return new Promise((resolve) => {
      const done = () => { clearTimeout(timer); this.settling = null; this.late = false; this.buffer = ''; resolve(); };
      const timer = setTimeout(done, CAR_RULES.settleMs);
      this.settling = done;
    });
  }

  /// Ends the request in the air with an error (the adapter dropped, or the driver disconnected), so whatever was
  /// waiting for it carries on instead of hanging.
  abandon(reason) {
    const w = this.waiting;
    this.waiting = null;
    if (w && !w.done) { w.done = true; clearTimeout(w.timer); w.reject(new Error(reason)); }
    this.settling?.();
    this.late = false;
  }

  /// Which PIDs the car reports: every "supported PIDs" mask in turn (00, 20, ... E0), each listing the next 32
  /// and whether the next mask exists. The first request makes the adapter search for the car's protocol.
  async findPIDs() {
    const bare = { bare: this.kind === 'bluedriver' };
    const listed = new Set();
    for (const base of MASK_PIDS) {
      if (base !== 0 && !listed.has(base)) break;
      const r = parseAnswer(await this.send(command(base), base === 0 ? CAR_RULES.searchTimeout : CAR_RULES.commandTimeout), base, 1, bare);
      if (r.problem) {
        if (base === 0) {
          // Ignition off or no answer: say so, and try again on the next round.
          this.supportsFuel = null;
          this.problem = PROBLEM_TEXT[r.problem];
          this.logLine('!', `no PID list: ${r.problem}`);
          this.changed();
          return;
        }
        break;
      }
      // Every control unit that answers lists its own PIDs (the engine many, the transmission a few): the car
      // offers what any of them lists.
      for (const bytes of r.all ?? [r.bytes]) {
        if (bytes.length < 4) continue;
        for (let pid = base + 1; pid <= base + 32; pid++) if (supports(bytes, base, pid)) listed.add(pid);
      }
    }
    this.supported = listed;
    this.logLine('i', `Mode 01 PIDs listed: ${[...listed].map((p) => p.toString(16).padStart(2, '0')).join(' ')}`);
    const fuel = listed.has(PIDS.fuelLevel.pid);
    this.supportsFuel = fuel;
    this.problem = fuel ? null : PROBLEM_TEXT.noFuelPID;
    if (this.kind !== 'bluedriver') {
      // The protocol the adapter found (the BlueDriver said it in its setup, LMDP).
      try { this.protocol = (await this.send('ATDP')).replace(/[\r>]+/g, ' ').trim() || null; } catch { /* not answered */ }
    }
    this.changed();
    await this.readStatus();
    if (fuel) await this.readFuel();
  }

  /// The adapter's own name and firmware (Bluetooth Device Information service), when it shows them.
  async readDeviceInfo(server) {
    try {
      const svc = await this.ble(() => server.getPrimaryService(0x180a), 'device information');
      const out = {};
      for (const [key, uuid] of [['manufacturer', 0x2a29], ['model', 0x2a24], ['firmware', 0x2a26], ['hardware', 0x2a27], ['software', 0x2a28]]) {
        try {
          const ch = await this.ble(() => svc.getCharacteristic(uuid), key);
          const v = await this.ble(() => ch.readValue(), key);
          out[key] = new TextDecoder().decode(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)).replace(/\0/g, '').trim();
        } catch { /* not offered */ }
      }
      this.logLine('i', `device information: ${JSON.stringify(out)}`);
      return Object.keys(out).length ? out : null;
    } catch {
      return null;
    }
  }

  /// A new fuel level reading (from the fuel timer or live data): the median of the last 90 s is the one shown.
  noteFuel(percent) {
    const now = this.clock();
    this.readings.push({ t: now, percent });
    this.readings = this.readings.filter((x) => now - x.t <= 120);
    this.fuel = steadyFuel(this.readings, now);
    this.fuelAt = now;
  }

  async readFuel() {
    const r = readPID('fuelLevel', await this.send(command(PIDS.fuelLevel.pid)), { bare: this.kind === 'bluedriver' });
    if (r.problem) { if (r.problem === 'noEngine') this.problem = PROBLEM_TEXT.noEngine; this.changed(); return; }
    this.noteFuel(r.value);
    this.problem = null;
    this.changed();
  }

  async readStatus() {
    const bare = { bare: this.kind === 'bluedriver' };
    const m = parseAnswer(await this.send(command(PIDS.monitor.pid)), PIDS.monitor.pid, 1, bare);
    if (!m.problem && m.bytes.length >= 4) {
      // Several control units answer 01 01 in turn (Jerry's 911: "00 07 E4 00" then "00 04 00 00"), and a bare
      // answer does not say which one: each is kept by the monitors it supports. The light is on when any says so,
      // stored codes add up, and the readiness shown is the unit with the most monitors (the engine's).
      this.monitorByUnit = this.monitorByUnit ?? new Map();
      for (const unit of (m.all ?? [m.bytes]).filter((x) => x.length >= 4)) {
        const b = unit.slice(0, 4);
        this.monitorByUnit.set(`${b[1] & 0x0f}:${b[2]}`, b);
      }
      const all = [...this.monitorByUnit.values()];
      const bits = (x) => { let n = 0; for (let v = x; v; v >>= 1) n += v & 1; return n; };
      this.monitorBytes = all.reduce((best, x) => (bits(x[1] & 0x07) + bits(x[2]) > bits(best[1] & 0x07) + bits(best[2]) ? x : best));
      this.checkEngine = all.some((x) => x[0] & 0x80);
      this.codes = all.reduce((sum, x) => sum + (x[0] & 0x7f), 0);
    } else if (!m.problem && m.bytes.length >= 1) {
      Object.assign(this, monitorStatus(m.bytes));
    }
    // The BlueDriver answers ATRV with NO DATA (and AT commands upset it): the control module voltage instead.
    if (this.kind === 'bluedriver') {
      const v = readPID('voltage', await this.send(command(PIDS.voltage.pid)), bare);
      this.voltage = v.problem ? null : v.value;
    } else {
      this.voltage = parseVoltage(await this.send('ATRV'));
    }
    this.changed();
  }

  /// Readiness monitors from the last monitor status (PID 01 01), or null.
  get monitors() { return this.monitorBytes ? readiness(this.monitorBytes) : null; }

  /// Trouble codes: stored (Mode 03), pending (07) and permanent (0A). Read only: codes are never cleared here.
  async readCodes() {
    if (this.state !== 'connected') return;
    this.dtc = { ...(this.dtc ?? {}), busy: true };
    this.changed();
    const out = {};
    for (const [mode, key] of [[0x03, 'stored'], [0x07, 'pending'], [0x0a, 'permanent']]) {
      try {
        out[key] = parseDTCs(await this.send(mode.toString(16).padStart(2, '0').toUpperCase(), 8000), mode);
      } catch (e) {
        out[key] = { problem: 'unreadable' };
        this.logLine('!', `mode ${mode.toString(16)}: ${e?.message ?? e}`);
      }
    }
    await this.readStatus().catch(() => {});
    this.dtc = { ...out, at: this.clock(), busy: false };
    this.changed();
  }

  /// Vehicle information (Mode 09): which items the car lists, the VIN, calibration IDs, calibration verification
  /// numbers and ECU names.
  async readInfo() {
    if (this.state !== 'connected') return;
    this.info = { ...(this.info ?? {}), busy: true };
    this.changed();
    const bare = { bare: this.kind === 'bluedriver' };
    const info = { at: this.clock() };
    try {
      const m = parseAnswer(await this.send('0900', 8000), 0x00, 9, bare);
      this.supported09 = m.problem ? null : new Set([...Array(32).keys()].map((i) => i + 1).filter((pid) => supports(m.bytes, 0x00, pid)));
      const has = (pid) => !this.supported09 || this.supported09.has(pid);
      if (has(0x02)) info.vin = parseVIN(await this.send('0902', 8000));
      if (has(0x04)) info.calibration = parseInfoText(await this.send('0904', 8000), 0x04);
      if (has(0x06)) {
        let b = answerBytes(await this.send('0906', 8000));
        if (b[0] === 0x49 && b[1] === 0x06) b = b.slice(2);
        if (b.length % 4 === 1) b = b.slice(1);
        info.cvn = b.length ? [...Array(Math.floor(b.length / 4)).keys()].map((i) => b.slice(4 * i, 4 * i + 4).map((x) => x.toString(16).toUpperCase().padStart(2, '0')).join('')).join(', ') : null;
      }
      if (has(0x0a)) info.ecu = parseInfoText(await this.send('090A', 8000), 0x0a);
    } catch (e) {
      this.logLine('!', `vehicle information: ${e?.message ?? e}`);
      info.problem = String(e?.message ?? e);
    }
    this.info = { ...info, busy: false };
    this.changed();
  }

  /// Live data: every PID the car lists (except the masks and status ones), one request at a time, as fast as the
  /// car answers. Each channel keeps its value, minimum, maximum, average and a trend.
  livePIDs() {
    return this.supported ? [...this.supported].filter((p) => !NOT_LIVE.has(p)).sort((a, b) => a - b) : [];
  }

  startLive() {
    if (this.live.on || this.state !== 'connected') return;
    this.live.on = true;
    this.wantLive = true;
    this.live.startedAt = Date.now();
    this.logLine('i', 'live data on');
    this.changed();
    // A loop from before a stop may still be waiting for its last answer: only the newest loop goes on.
    this.liveLoop(++this.liveGen);
  }

  /// The driver stops live data (a recording stops with it).
  stopLive() {
    this.wantLive = false;
    if (this.rec) this.stopRecording('live data stopped');
    if (!this.live.on) return;
    this.live.on = false;
    this.alertStates.clear();
    this.logLine('i', 'live data off');
    this.changed();
  }

  /// Live data set aside for a moment (the Porsche probe needs the adapter to itself): the loop ends, a recording
  /// and the driver's wish for live data stay. startLive() carries on.
  pauseLive() {
    if (!this.live.on) return;
    this.live.on = false;
    this.liveGen++;
    this.logLine('i', 'live data paused');
    this.changed();
  }

  /// Live data keeps running with its screen closed: a recording, or alert limits to watch.
  get watching() { return Boolean(this.rec) || Object.keys(this.prefs.alerts ?? {}).length > 0; }

  /// The PIDs of the pinned items.
  pinnedPIDs() {
    return new Set((this.prefs.pinned ?? []).map((k) => parseInt(String(k).slice(2, 4), 16)).filter((p) => this.supported?.has(p)));
  }

  /// Whether the adapter answers a request for several PIDs at once, checked on this car after the first round with
  /// three PIDs that answered one at a time (a listed PID that never answers must not count against it).
  /// Only the ELM327 on CAN: older buses do not allow it, and the BlueDriver's answers (data bytes only, no PID)
  /// could not be split.
  async probeMulti() {
    const can = /15765|CAN/i.test(this.protocol ?? '');
    if (this.kind !== 'elm' || !can) {
      this.live.multi = 1;
      this.logLine('i', `one item per request (${this.kind === 'bluedriver' ? 'BlueDriver answers carry no PID to split by' : 'not a CAN car or protocol unknown'})`);
      return;
    }
    const pick = this.livePIDs().filter((p) => PIDS01.has(p) && this.live.status.get(p) === 'ok').slice(0, 3);
    if (pick.length < 2) { this.live.multi = 1; return; }
    const m = parseMulti(await this.send(multiCommand(pick)), pick);
    const ok = Boolean(m) && pick.every((p) => m.has(p));
    this.live.multi = ok ? MULTI_MAX : 1;
    this.logLine('i', ok ? `several items per request: yes, up to ${MULTI_MAX}` : 'several items per request: no, one at a time');
  }

  /// What the screen needs (the cockpit sets it): [{ id, kind: '01', pid } | { id, kind: '22', req }, period ms].
  /// With a plan, live data reads only those, each when due: period 0 every pass (engine speed, boost, throttle),
  /// longer periods for slow ones (temperatures, fuel level). Without one, every PID the car lists.
  setPlan(plan) { this.plan = plan?.length ? plan : null; }

  async planRound(alive = () => this.live.on && this.state === 'connected') {
    const now = performance.now();
    const last = this.live.lastRead;
    // An item that failed twice in a row (no data, or no answer) is asked again every retryFailedMs, not on
    // every pass: each such request costs a whole answer time and would slow every other gauge. One miss is
    // asked again at once.
    const fails = this.live.fails;
    const periodOf = (p) => ((fails.get(p.id) ?? 0) >= 2 ? Math.max(p.period, CAR_RULES.retryFailedMs) : p.period);
    const note = (id, ok) => { if (ok) fails.delete(id); else fails.set(id, (fails.get(id) ?? 0) + 1); };
    const due = this.plan.filter((p) => now - (last.get(p.id) ?? -1e9) >= periodOf(p))
      .sort((a, b) => (a.period - b.period) || ((last.get(a.id) ?? 0) - (last.get(b.id) ?? 0)));
    if (!due.length) {
      const wait = Math.min(...this.plan.map((p) => periodOf(p) - (now - (last.get(p.id) ?? 0))));
      await new Promise((r) => setTimeout(r, Math.max(20, Math.min(wait, 500))));
      return 0;
    }
    let readings = 0;
    const pids = due.filter((p) => p.kind === '01').map((p) => p.pid);
    for (const group of batches(pids, this.live.multi ?? 1)) {
      if (!alive()) return readings;
      try { readings += group.length > 1 ? await this.readLiveMany(group) : await this.readLive(group[0]); } catch (e) {
        for (const pid of group) this.live.status.set(pid, 'error');
        this.logLine('!', `PID ${group.map((x) => x.toString(16)).join(' ')}: ${e?.message ?? e}`);
      }
      for (const pid of group) { last.set(`01:${pid}`, performance.now()); note(`01:${pid}`, this.live.status.get(pid) === 'ok'); }
      this.changedSoon();
    }
    for (const p of due.filter((x) => x.kind === '22')) {
      if (!alive()) return readings;
      let ok = false;
      try { const n = await this.readEnhanced(p.req); readings += n; ok = n > 0; } catch (e) { this.logLine('!', `${p.req.key}: ${e?.message ?? e}`); }
      note(p.id, ok);
      last.set(p.id, performance.now());
      this.changedSoon();
    }
    return readings;
  }

  async liveLoop(gen) {
    const alive = () => this.live.on && gen === this.liveGen && this.state === 'connected';
    while (alive()) {
      if (!this.supported) await this.findPIDs().catch(() => {});
      if (!alive()) break;
      // Several PIDs per request: checked once per connection, with or without a plan (after the first pass, so
      // it is tried on PIDs that answered).
      if (this.live.multi === null && (this.live.round > 0 || this.live.passes > 0)) await this.probeMulti().catch(() => { this.live.multi = 1; });
      if (this.plan) {
        const t0 = performance.now(); const req0 = this.live.requests;
        const readings = await this.planRound(alive);
        this.live.passes = (this.live.passes ?? 0) + 1;
        const ms = performance.now() - t0;
        if (readings && ms > 0) {
          const now = { readings: (readings * 1000) / ms, requests: ((this.live.requests - req0) * 1000) / ms };
          const was = this.live.rate;
          this.live.rate = was ? { readings: was.readings * 0.7 + now.readings * 0.3, requests: was.requests * 0.7 + now.requests * 0.3 } : now;
        }
        continue;
      }
      const all = this.livePIDs();
      if (!all.length) { await new Promise((r) => setTimeout(r, 1000)); continue; }
      const round = this.live.round++;
      const only = this.prefs.onlyPinned ? this.pinnedPIDs() : null;
      const pids = roundPIDs(all, round, { only });
      // Reading only the pinned items: the fuel level still every few rounds, for the range.
      if (only?.size && this.supportsFuel && round % SLOW_EVERY === 0 && !pids.includes(PIDS.fuelLevel.pid)) pids.push(PIDS.fuelLevel.pid);
      const t0 = performance.now();
      const req0 = this.live.requests;
      let readings = 0;
      for (const group of batches(pids, this.live.multi ?? 1)) {
        if (!alive()) break;
        try { readings += group.length > 1 ? await this.readLiveMany(group) : await this.readLive(group[0]); } catch (e) {
          for (const pid of group) this.live.status.set(pid, 'error');
          this.logLine('!', `PID ${group.map((p) => p.toString(16)).join(' ')}: ${e?.message ?? e}`);
        }
        this.changedSoon();
      }
      const ms = performance.now() - t0;
      if (round % SLOW_EVERY === 0) this.live.cycleMs = ms;
      if (ms > 0) {
        const now = { readings: (readings * 1000) / ms, requests: ((this.live.requests - req0) * 1000) / ms };
        const was = this.live.rate;
        this.live.rate = was ? { readings: was.readings * 0.7 + now.readings * 0.3, requests: was.requests * 0.7 + now.requests * 0.3 } : now;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    // A newer loop owns live.on now; only the current one switches it off (the link dropped).
    if (gen !== this.liveGen) return;
    this.live.on = false;
    this.changed();
  }

  /// Porsche manufacturer data: the channels of a Mode 22 request (engine/obdb.js porscheRequests), Experimental.
  enhancedChannels(req) {
    const ix = this.enhancedIndex;
    if (!ix) return [];
    return obdbChannels(req.command, { keyPrefix: `22${req.hdr}${req.did}`, group: 'Porsche (experimental)', unitOf: ix.unitOf, decode: ix.decode,
      source: req.unconfirmed ? 'porsche-unconfirmed' : 'porsche' }).map((c) => ({ ...c, req: req.key }));
  }

  /// One Mode 22 request. The ELM327 is pointed at the module first (ATSH); the BlueDriver sends to every module
  /// at once (its own header command is not known), so a DID that more than one module has is not read through it:
  /// its answer could not be told apart. Returns the number of signals read.
  async readEnhanced(req) {
    const set = (status) => {
      const was = this.enhanced.results.get(req.key);
      this.enhanced.results.set(req.key, status);
      if (was !== status) this.onEnhanced?.(req.key, status);
      return 0;
    };
    if (this.kind === 'bluedriver' && req.shared) return set('shared');
    if (this.kind === 'elm' && this.enhanced.header !== req.hdr) {
      await this.send(`ATSH${req.hdr}`);
      this.enhanced.header = req.hdr;
    }
    const text = await this.send(`22${req.did}`);
    if (/NO ?DATA/i.test(text)) return set('noData');
    const r = mode22Data(answerLines(text), req.did, { requireEcho: this.kind === 'elm' });
    if (r.problem) return set(r.problem);
    const t = Date.now();
    let n = 0;
    for (const c of this.enhancedChannels(req)) {
      const value = c.f(r.bytes);
      if (value !== null && value !== undefined) { this.record(c, value, t); n++; }
    }
    set(n ? 'ok' : 'unreadable');
    return n;
  }

  /// Tries Porsche requests one by one (the driver starts it; read only), each result kept and reported.
  async probeEnhanced(reqs, onProgress = () => {}) {
    this.probing = { done: 0, total: reqs.length, ok: 0 };
    this.logLine('i', `--- Porsche data probe: ${reqs.length} requests (Mode 22, read only)`);
    for (const req of reqs) {
      if (this.state !== 'connected' || !this.probing) break;
      let n = 0;
      try { n = await this.readEnhanced(req); } catch (e) { this.enhanced.results.set(req.key, 'error'); this.logLine('!', `${req.key}: ${e?.message ?? e}`); }
      this.probing.done++; if (n) this.probing.ok++;
      onProgress(this.probing);
      this.changedSoon();
    }
    const done = this.probing;
    this.probing = null;
    this.logLine('i', `--- Porsche data probe done: ${done?.ok ?? 0} of ${done?.total ?? 0} answered`);
    this.changed();
    return done;
  }

  /// One PID: returns the number of PIDs read (0 or 1).
  async readLive(pid) {
    const bare = { bare: this.kind === 'bluedriver' };
    const r = parseAnswer(await this.send(command(pid)), pid, 1, bare);
    if (r.problem) { this.live.status.set(pid, r.problem); return 0; }
    // A BlueDriver answer is the data bytes alone, with nothing that says which PID it answers. For the classic
    // PIDs (below 60), whose length is fixed, an answer of another length is not this PID's: not decoded.
    const want = pid < 0x60 ? PIDS01.get(pid)?.bytes : null;
    if (bare.bare && want && r.bytes.length !== want) {
      this.live.status.set(pid, 'unreadable');
      this.logLine('!', `PID ${pid.toString(16)}: ${r.bytes.length} data bytes, expected ${want}; not used`);
      return 0;
    }
    this.apply(pid, r.bytes, Date.now());
    return 1;
  }

  /// Several PIDs in one request. An answer that cannot be split is read again one PID at a time; after a few,
  /// one PID per request from then on.
  async readLiveMany(group) {
    const m = parseMulti(await this.send(multiCommand(group)), group);
    if (!m) {
      if (++this.live.multiFailures >= CAR_RULES.multiFailures) {
        this.live.multi = 1;
        this.logLine('!', 'answers to several items could not be split: one item per request from now on');
      }
      let n = 0;
      for (const pid of group) n += await this.readLive(pid);
      return n;
    }
    const t = Date.now();
    for (const pid of group) {
      const bytes = m.get(pid);
      if (bytes) this.apply(pid, bytes, t);
      else this.live.status.set(pid, 'noData');
    }
    return m.size;
  }

  /// A PID's data bytes become its channels' readings (and the fuel level and voltage the rest of the app uses).
  apply(pid, bytes, t) {
    this.live.status.set(pid, 'ok');
    const need = PIDS01.get(pid)?.bytes ?? 1;
    for (const c of channelsFor(pid)) {
      const value = c.raw ? c.f(bytes) : bytes.length >= need ? c.f(bytes) : null;
      this.record(c, value, t);
    }
    if (pid === PIDS.fuelLevel.pid && bytes.length >= 1) this.noteFuel(PIDS.fuelLevel.decode(bytes));
    if (pid === PIDS.voltage.pid && bytes.length >= 2) this.voltage = PIDS.voltage.decode(bytes);
  }

  /// Recording: every reading from now on, kept on this device (main.js saves it as it runs and when it stops).
  startRecording(meta = {}) {
    if (this.rec) return this.rec;
    const now = Date.now();
    this.rec = { id: `rec-${now}`, startedAt: now, endedAt: null, vehicle: meta.vehicle ?? null, adapter: this.name, channels: {}, samples: [] };
    this.logLine('i', 'recording on');
    if (!this.live.on) this.startLive();
    this.changed();
    return this.rec;
  }

  stopRecording(reason = '') {
    const r = this.rec;
    if (!r) return null;
    r.endedAt = Date.now();
    this.rec = null;
    this.logLine('i', `recording off${reason ? ` (${reason})` : ''}: ${r.samples.length} readings`);
    try { this.onRecorded(r, reason); } catch { /* the app's problem */ }
    this.changed();
    return r;
  }

  /// One sample for a channel: the value, minimum, maximum, average (numbers) and the trend.
  record(channel, value, t) {
    let v = this.live.values.get(channel.key);
    if (!v) { v = { channel, value: null, t: null, min: null, max: null, sum: 0, n: 0, history: [], dt: null }; this.live.values.set(channel.key, v); }
    // Update interval (ms), smoothed: the rate a gauge really refreshes at.
    // A long gap (the screen was closed, the car was off) is a pause, not this gauge's refresh rate.
    if (v.t != null && t > v.t && t - v.t <= CAR_RULES.gapMs) v.dt = v.dt == null ? t - v.t : v.dt * 0.8 + (t - v.t) * 0.2;
    v.value = value; v.t = t;
    if (typeof value === 'number' && Number.isFinite(value)) {
      v.min = v.min === null ? value : Math.min(v.min, value);
      v.max = v.max === null ? value : Math.max(v.max, value);
      v.sum += value; v.n++;
      v.history.push([t, value]);
      if (v.history.length > CAR_RULES.history) v.history.splice(0, v.history.length - CAR_RULES.history);
    }
    if (this.rec && value !== null && value !== undefined) {
      const rec = this.rec;
      if (!rec.channels[channel.key]) rec.channels[channel.key] = { pid: channel.pid, name: channel.name, unit: channel.unit };
      rec.samples.push([t - rec.startedAt, channel.key, value]);
      if (rec.samples.length >= CAR_RULES.recordCap) this.stopRecording('full');
    }
    const rule = this.prefs.alerts?.[channel.key];
    if (rule && typeof value === 'number') {
      const [shown, unit] = toUS(value, channel.unit);
      const was = this.alertStates.get(channel.key) ?? null;
      const now = alertState(shown, rule, was);
      if (now !== was) {
        this.alertStates.set(channel.key, now);
        if (now) {
          this.logLine('!', `alert: ${channel.name} ${now} at ${shown.toFixed(2)} ${unit} (limit ${now === 'high' ? rule.high : rule.low})`);
          try { this.onAlert({ channel, state: now, value: shown, unit, rule }); } catch { /* the app's problem */ }
        }
      }
    }
  }

  /// Clears minimum, maximum, average and trends (live values stay).
  resetStats() {
    for (const v of this.live.values.values()) { v.min = v.max = v.value; v.sum = typeof v.value === 'number' ? v.value : 0; v.n = typeof v.value === 'number' ? 1 : 0; v.history = []; }
    this.changed();
  }

  startTimers() {
    this.stopTimers();
    let tick = 0;
    this.timer = setInterval(() => {
      if (this.state !== 'connected' || this.busy || this.live.on) return;
      tick += CAR_RULES.fuelEvery;
      this.busy = true;
      const job = this.supportsFuel === null ? this.findPIDs()
        : (tick % CAR_RULES.statusEvery === 0 ? this.readStatus() : Promise.resolve()).then(() => (this.supportsFuel ? this.readFuel() : null));
      job.catch(() => {}).finally(() => { this.busy = false; });
    }, CAR_RULES.fuelEvery * 1000);
  }

  stopTimers() {
    clearInterval(this.timer); this.timer = null;
    clearTimeout(this.retryTimer); this.retryTimer = null;
    this.busy = false;
  }

  /// The adapter dropped (car off, out of range, phone locked): keep the last reading with its time, and try to
  /// reconnect a few times without the picker.
  lost() {
    if (this.state === 'idle') return;
    this.stopTimers();
    this.logLine('!', 'adapter disconnected');
    this.write = null;
    this.abandon('adapter disconnected');
    this.state = 'disconnected';
    this.disconnectedAt = this.clock();
    this.changed();
    const wait = CAR_RULES.reconnectAfter[this.tries];
    if (wait == null || !this.device) return;
    this.tries++;
    this.retryTimer = setTimeout(() => { if (this.state === 'disconnected') this.open(); }, wait * 1000);
  }

  /// The driver disconnects: no reconnect.
  disconnect() {
    const d = this.device;
    this.wantLive = false;
    if (this.rec) this.stopRecording('disconnected');
    this.reset();
    try { d?.gatt?.disconnect(); } catch { /* already gone */ }
    this.changed();
  }
}
