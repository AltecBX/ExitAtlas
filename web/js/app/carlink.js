// The car connection: an OBD2 adapter with Bluetooth LE that speaks the ELM327 command set, through the standard
// Web Bluetooth API (Chrome on Android and computers; on iPhone, Safari with the free beacio extension, formerly
// WebBLE, which installs navigator.bluetooth on secure pages: https://beacio.com/docs.html). It reads the fuel
// tank level the car reports (OBD2 PID 2F), the check engine light and the adapter's battery voltage. Nothing is
// stored or sent anywhere; the fuel level becomes the range the fuel planner uses (main.js carChanged).
//
// Not BlueDriver: its sensor only works with its own app, and its protocol is not published.
import { SETUP_COMMANDS, PIDS, command, parseAnswer, readPID, supports, monitorStatus, parseVoltage, parseIdentity,
  steadyFuel, PROBLEM_TEXT } from '../engine/obd.js';

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

/// Names OBD2 adapters advertise, for the device picker (adapters do not always advertise their service).
const NAME_PREFIXES = ['OBD', 'OBDLink', 'vLinker', 'VLINK', 'V-LINK', 'IOS-Vlink', 'Android-Vlink', 'Vgate', 'Veepeak', 'VEEPEAK', 'ELM', 'iCar'];

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
});

export class CarLink {
  constructor({ bluetooth = globalThis.navigator?.bluetooth, onChange = () => {}, clock = () => Date.now() / 1000 } = {}) {
    this.bluetooth = bluetooth;
    this.onChange = onChange;
    this.clock = clock;
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
    this.write = null; this.waiting = null; this.buffer = ''; this.queue = Promise.resolve();
    this.stopTimers();
  }

  /// Web Bluetooth is there (Chrome, or Safari with beacio).
  get available() { return typeof this.bluetooth?.requestDevice === 'function'; }

  /// The fuel level when it is current, else null.
  get freshFuel() { return this.fuel != null && this.clock() - this.fuelAt <= CAR_RULES.freshSeconds ? this.fuel : null; }

  changed() { try { this.onChange(this); } catch { /* the view's problem */ } }

  /// Opens the device picker and connects. Must be called from a tap (browsers require a user gesture). `any`
  /// lists every Bluetooth device, for an adapter that advertises neither a known name nor its service.
  async connect({ any = false } = {}) {
    if (!this.available) return;
    const optionalServices = UART_SERVICES.map((u) => u.service);
    const options = any ? { acceptAllDevices: true, optionalServices }
      : { filters: [...optionalServices.map((s) => ({ services: [s] })), ...NAME_PREFIXES.map((namePrefix) => ({ namePrefix }))], optionalServices };
    let device;
    try {
      device = await this.bluetooth.requestDevice(options);
    } catch (e) {
      // Closing the picker is not an error.
      if (e?.name !== 'NotFoundError' && e?.name !== 'AbortError') { this.state = 'error'; this.problem = `Bluetooth: ${e?.message ?? e}`; this.changed(); }
      return;
    }
    this.reset();
    this.device = device;
    this.name = device.name || 'OBD2 adapter';
    device.addEventListener?.('gattserverdisconnected', () => this.lost());
    await this.open();
  }

  /// Connects to the chosen adapter (again, after a drop) and starts reading.
  async open() {
    this.state = 'connecting'; this.problem = null; this.changed();
    try {
      const server = await this.device.gatt.connect();
      const { notify, write } = await this.findSerial(server);
      this.write = write;
      this.buffer = ''; this.queue = Promise.resolve(); this.waiting = null;
      notify.addEventListener('characteristicvaluechanged', (e) => this.received(e.target.value));
      await notify.startNotifications();
      for (const c of SETUP_COMMANDS) await this.send(c);
      this.identity = parseIdentity(await this.send('ATI'));
      this.state = 'connected'; this.tries = 0; this.disconnectedAt = null;
      this.changed();
      await this.findPIDs();
      this.startTimers();
    } catch (e) {
      if (this.state === 'disconnected') return;
      this.state = 'error';
      this.problem = e?.problem ? PROBLEM_TEXT[e.problem] : `Could not talk to the adapter: ${e?.message ?? e}`;
      this.changed();
      try { this.device?.gatt?.disconnect(); } catch { /* already gone */ }
    }
  }

  /// The adapter's serial service and its notify and write characteristics.
  async findSerial(server) {
    for (const u of UART_SERVICES) {
      let service;
      try { service = await server.getPrimaryService(u.service); } catch { continue; }
      let list = null;
      try { list = typeof service.getCharacteristics === 'function' ? await service.getCharacteristics() : null; } catch { list = null; }
      if (list?.length) {
        const notify = list.find((c) => c.properties?.notify || c.properties?.indicate);
        const write = list.find((c) => c.properties?.writeWithoutResponse || c.properties?.write);
        if (notify && write) return { notify, write };
      }
      try {
        return { notify: await service.getCharacteristic(u.notify), write: await service.getCharacteristic(u.write) };
      } catch { /* try the next service */ }
    }
    throw new Error('no OBD2 serial service found. The adapter may not be ELM327 compatible');
  }

  /// Text from the adapter: an answer is complete at ">".
  received(view) {
    this.buffer += new TextDecoder().decode(view);
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
      const bytes = new TextEncoder().encode(`${cmd}\r`);
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

  /// Which PIDs the car reports. The first request makes the adapter search for the car's protocol.
  async findPIDs() {
    const first = parseAnswer(await this.send(command(PIDS.supported01.pid), CAR_RULES.searchTimeout), PIDS.supported01.pid);
    if (first.problem) {
      // Ignition off or no answer: say so, and try again on the next round.
      this.supportsFuel = null;
      this.problem = PROBLEM_TEXT[first.problem];
      this.changed();
      return;
    }
    let fuel = false;
    if (supports(first.bytes, 0x00, 0x20)) {
      const second = parseAnswer(await this.send(command(PIDS.supported21.pid)), PIDS.supported21.pid);
      fuel = !second.problem && supports(second.bytes, 0x20, PIDS.fuelLevel.pid);
    }
    this.supportsFuel = fuel;
    this.problem = fuel ? null : PROBLEM_TEXT.noFuelPID;
    this.changed();
    await this.readStatus();
    if (fuel) await this.readFuel();
  }

  async readFuel() {
    const r = readPID('fuelLevel', await this.send(command(PIDS.fuelLevel.pid)));
    if (r.problem) { if (r.problem === 'noEngine') this.problem = PROBLEM_TEXT.noEngine; this.changed(); return; }
    const now = this.clock();
    this.readings.push({ t: now, percent: r.value });
    this.readings = this.readings.filter((x) => now - x.t <= 120);
    this.fuel = steadyFuel(this.readings, now);
    this.fuelAt = now;
    this.problem = null;
    this.changed();
  }

  async readStatus() {
    const m = parseAnswer(await this.send(command(PIDS.monitor.pid)), PIDS.monitor.pid);
    if (!m.problem && m.bytes.length >= 1) Object.assign(this, monitorStatus(m.bytes));
    this.voltage = parseVoltage(await this.send('ATRV'));
    this.changed();
  }

  startTimers() {
    this.stopTimers();
    let tick = 0;
    this.timer = setInterval(() => {
      if (this.state !== 'connected' || this.busy) return;
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
    this.reset();
    try { d?.gatt?.disconnect(); } catch { /* already gone */ }
    this.changed();
  }
}
