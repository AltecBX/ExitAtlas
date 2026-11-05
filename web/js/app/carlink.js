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
import { MASK_PIDS, NOT_LIVE, PIDS01, channelsFor, toUS } from '../engine/obdpids.js';
import { roundPIDs, batches, multiCommand, parseMulti, alertState, MULTI_MAX, SLOW_EVERY } from '../engine/obdlive.js';
import { parseDTCs, parseVIN, parseInfoText, answerBytes, readiness } from '../engine/obddiag.js';

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
  /// The screen is redrawn at most this often (ms) while live data streams.
  liveRedraw: 400,
});

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
    /// The session log: every request and answer, raw and readable, kept across drops (copy it after a failure).
    this.log = []; this.logStart = Date.now();
    this.reset();
  }

  reset() {
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
    this.supported = null; this.supported09 = null; this.monitorBytes = null; this.dtc = null; this.info = null;
    this.protocol = null; this.deviceInfo = null;
    /// Live data: on, and per channel key { value, t, min, max, sum, n, history }; per PID 'ok' or 'noData'.
    /// multi: PIDs per request (null until probed, 1 for one at a time); rate: readings and requests a second.
    this.live = { on: false, values: new Map(), status: new Map(), cycleMs: null, requests: 0, startedAt: null, round: 0, multi: null,
      multiFailures: 0, rate: null };
    this.write = null; this.control = null; this.kind = null; this.waiting = null; this.buffer = ''; this.queue = Promise.resolve();
    this.stopTimers();
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

  /// Opens the device picker and connects. Must be called from a tap (browsers require a user gesture). `any`
  /// lists every Bluetooth device, for an adapter that advertises neither a known name nor its service.
  async connect({ any = false } = {}) {
    if (!this.available) return;
    const optionalServices = [BLUEDRIVER.service, ...UART_SERVICES.map((u) => u.service), BLUEDRIVER.pairService, 0x180a];
    const options = any ? { acceptAllDevices: true, optionalServices }
      : { filters: [BLUEDRIVER.service, ...UART_SERVICES.map((u) => u.service)].map((s) => ({ services: [s] })).concat(NAME_PREFIXES.map((namePrefix) => ({ namePrefix }))), optionalServices };
    let device;
    try {
      device = await this.bluetooth.requestDevice(options);
    } catch (e) {
      // Closing the picker is not an error.
      if (e?.name !== 'NotFoundError' && e?.name !== 'AbortError') { this.state = 'error'; this.problem = `Bluetooth: ${e?.message ?? e}`; this.changed(); }
      return;
    }
    this.reset();
    this.log = []; this.logStart = Date.now();
    this.device = device;
    this.name = device.name || 'OBD2 adapter';
    this.logLine('i', `picked ${this.name}${any ? ' (all devices)' : ''}`);
    device.addEventListener?.('gattserverdisconnected', () => this.lost());
    await this.open();
  }

  /// Connects to the chosen adapter (again, after a drop) and starts reading.
  async open() {
    this.state = 'connecting'; this.problem = null; this.changed();
    try {
      const server = await this.device.gatt.connect();
      const { notify, write, kind, control, mode } = await this.findSerial(server);
      this.kind = kind;
      this.logLine('i', `serial: ${kind}`);
      this.deviceInfo = await this.readDeviceInfo(server);
      if (kind === 'bluedriver' && !/bluedriv/i.test(this.name ?? '')) this.name = `BlueDriver ${this.name ?? ''}`.trim();
      this.write = write;
      this.control = control ?? null;
      this.buffer = ''; this.queue = Promise.resolve(); this.waiting = null;
      notify.addEventListener('characteristicvaluechanged', (e) => this.received(e.target.value));
      if (kind === 'bluedriver') {
        await this.openBlueDriver(server, { notify, write, mode });
      } else {
        await notify.startNotifications();
        for (const c of SETUP_COMMANDS) await this.send(c);
        this.identity = parseIdentity(await this.send('ATI'));
      }
      this.logLine('i', `identity: ${this.identity ?? 'none'}`);
      this.state = 'connected'; this.tries = 0; this.disconnectedAt = null;
      this.changed();
      await this.findPIDs();
      this.startTimers();
      if (this.wantLive && !this.live.on) this.startLive();
    } catch (e) {
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
      await write.startNotifications();
      await notify.startNotifications();
      if (mode) await mode.startNotifications().catch(() => {});
    };
    const pair = async () => {
      try {
        const svc = await server.getPrimaryService(BLUEDRIVER.pairService);
        const v = await (await svc.getCharacteristic(BLUEDRIVER.pairCharacteristic)).readValue();
        this.logLine('i', 'pairing characteristic read', new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
      } catch (e) { this.logLine('i', `pairing characteristic: ${e?.message ?? e}`); }
    };
    try { await subscribe(); await pair(); } catch (e) { this.logLine('i', `notifications before pairing: ${e?.message ?? e}`); await pair(); await subscribe(); }
    write.addEventListener('characteristicvaluechanged', (e) => {
      const v = e.target.value;
      this.logLine('~', 'rx flow control', new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
    });
    // Fast Ack: our buffer, 0x7FFF bytes (little endian).
    await this.control.writeValueWithoutResponse(new Uint8Array([0x00, 0xff, 0x7f]));
    let id = null;
    for (const c of BLUEDRIVER_SETUP) {
      const answer = await this.send(c);
      if (c === 'LMI' && !id) id = parseIdentity(answer);
      if (c === 'LMDP') this.protocol = answer.replace(/[\r>]+/g, ' ').trim() || null;
    }
    this.identity = id;
  }

  /// The adapter's serial service and its notify and write characteristics: the BlueDriver's Xpress Streaming
  /// Service first, then the ELM327 serial services.
  async findSerial(server) {
    try {
      const svc = await server.getPrimaryService(BLUEDRIVER.service);
      const rx = await svc.getCharacteristic(BLUEDRIVER.rx);
      const tx = await svc.getCharacteristic(BLUEDRIVER.tx);
      const mode = await svc.getCharacteristic(BLUEDRIVER.mode).catch(() => null);
      return { kind: 'bluedriver', write: rx, notify: tx, control: tx, mode };
    } catch { /* not a BlueDriver */ }
    for (const u of UART_SERVICES) {
      let service;
      try { service = await server.getPrimaryService(u.service); } catch { continue; }
      let list = null;
      try { list = typeof service.getCharacteristics === 'function' ? await service.getCharacteristics() : null; } catch { list = null; }
      if (list?.length) {
        const notify = list.find((c) => c.properties?.notify || c.properties?.indicate);
        const write = list.find((c) => c.properties?.writeWithoutResponse || c.properties?.write);
        if (notify && write) return { kind: 'elm', notify, write };
      }
      try {
        return { kind: 'elm', notify: await service.getCharacteristic(u.notify), write: await service.getCharacteristic(u.write) };
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
      const n = view.byteLength;
      this.control?.writeValueWithoutResponse(new Uint8Array([0x01, n & 0xff, n >> 8])).catch(() => {});
    }
    const fragment = new TextDecoder().decode(bytes);
    this.logLine('<', fragment, new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
    this.buffer += fragment;
    const end = this.buffer.indexOf('>');
    if (end < 0 || !this.waiting) return;
    const text = this.buffer.slice(0, end);
    this.buffer = this.buffer.slice(end + 1);
    const w = this.waiting;
    this.waiting = null;
    clearTimeout(w.timer);
    w.resolve(text);
  }

  /// Sends one command and resolves with the adapter's answer (one at a time; the adapter takes no queue).
  send(cmd, timeout = CAR_RULES.commandTimeout) {
    const run = async () => {
      if (!this.write) throw new Error('not connected');
      const answer = new Promise((resolve, reject) => {
        this.waiting = { resolve, timer: setTimeout(() => { this.waiting = null; reject(new Error(`no answer to ${cmd}`)); }, timeout) };
      });
      const plain = new TextEncoder().encode(`${cmd}\r`);
      const bytes = this.kind === 'bluedriver' ? bluedriverCodec(plain) : plain;
      this.logLine('>', cmd, bytes);
      this.live.requests++;
      const useNoResponse = typeof this.write.writeValueWithoutResponse === 'function' && this.write.properties?.writeWithoutResponse !== false;
      for (let i = 0; i < bytes.length; i += CAR_RULES.chunk) {
        const part = bytes.slice(i, i + CAR_RULES.chunk);
        if (useNoResponse) await this.write.writeValueWithoutResponse(part);
        else if (typeof this.write.writeValueWithResponse === 'function') await this.write.writeValueWithResponse(part);
        else await this.write.writeValue(part);
      }
      return answer;
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
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
      for (let pid = base + 1; pid <= base + 32; pid++) if (supports(r.bytes, base, pid)) listed.add(pid);
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
      const svc = await server.getPrimaryService(0x180a);
      const out = {};
      for (const [key, uuid] of [['manufacturer', 0x2a29], ['model', 0x2a24], ['firmware', 0x2a26], ['hardware', 0x2a27], ['software', 0x2a28]]) {
        try {
          const v = await (await svc.getCharacteristic(uuid)).readValue();
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
    if (!m.problem && m.bytes.length >= 1) {
      Object.assign(this, monitorStatus(m.bytes));
      if (m.bytes.length >= 4) this.monitorBytes = m.bytes.slice(0, 4);
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
    this.liveLoop();
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

  async liveLoop() {
    while (this.live.on && this.state === 'connected') {
      if (!this.supported) await this.findPIDs().catch(() => {});
      const all = this.livePIDs();
      if (!all.length) { await new Promise((r) => setTimeout(r, 1000)); continue; }
      if (this.live.multi === null && this.live.round > 0) await this.probeMulti().catch(() => { this.live.multi = 1; });
      const round = this.live.round++;
      const only = this.prefs.onlyPinned ? this.pinnedPIDs() : null;
      const pids = roundPIDs(all, round, { only });
      // Reading only the pinned items: the fuel level still every few rounds, for the range.
      if (only?.size && this.supportsFuel && round % SLOW_EVERY === 0 && !pids.includes(PIDS.fuelLevel.pid)) pids.push(PIDS.fuelLevel.pid);
      const t0 = performance.now();
      const req0 = this.live.requests;
      let readings = 0;
      for (const group of batches(pids, this.live.multi ?? 1)) {
        if (!this.live.on || this.state !== 'connected') break;
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
    this.live.on = false;
    this.changed();
  }

  /// One PID: returns the number of PIDs read (0 or 1).
  async readLive(pid) {
    const bare = { bare: this.kind === 'bluedriver' };
    const r = parseAnswer(await this.send(command(pid)), pid, 1, bare);
    if (r.problem) { this.live.status.set(pid, r.problem); return 0; }
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
    if (!v) { v = { channel, value: null, t: null, min: null, max: null, sum: 0, n: 0, history: [] }; this.live.values.set(channel.key, v); }
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
    if (this.waiting) { clearTimeout(this.waiting.timer); this.waiting = null; }
    this.write = null;
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
