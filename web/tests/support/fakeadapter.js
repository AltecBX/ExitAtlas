// A SIMULATED Web Bluetooth OBD2 adapter (ELM327 or BlueDriver style) for the car connection tests: it speaks the
// adapters' wire formats to the real CarLink class. Nothing here was recorded from a car.
import { CarLink, BLUEDRIVER } from '../../js/app/carlink.js';
import { bluedriverCodec } from '../../js/engine/obd.js';
export { CarLink };
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Char extends EventTarget {
  constructor(props, onWrite) { super(); this.properties = props; this.onWrite = onWrite; }
  async startNotifications() { return this; }
  async writeValueWithoutResponse(b) { if (this.failWrite) { const e = this.failWrite(); if (e) throw e; } this.onWrite?.(new Uint8Array(b)); }
  async readValue() { return new DataView(new ArrayBuffer(1)); }
  notify(bytes) { const ev = new Event('characteristicvaluechanged'); Object.defineProperty(ev, 'target', { value: { value: new DataView(Uint8Array.from(bytes).buffer) } }); this.dispatchEvent(ev); }
}

/// answer(cmd) -> string (without '>') | { text, delay } | null (never answers)
export function makeAdapter({ kind = 'elm', answer, latency = 5, sameObjects = false }) {
  const sent = [];
  let pending = '';
  const dev = new EventTarget();
  dev.name = kind === 'bluedriver' ? 'BlueDriver' : 'OBDLink CX';
  let notifyChar, writeChar;
  const reply = (text) => {
    if (!dev.gatt.connected) return;
    let bytes = new TextEncoder().encode(`${text}\r>`);
    if (kind === 'bluedriver') bytes = bluedriverCodec(bytes);
    for (let i = 0; i < bytes.length; i += 20) notifyChar.notify(bytes.slice(i, i + 20));
  };
  const onWrite = (b) => {
    const plain = kind === 'bluedriver' ? bluedriverCodec(b) : b;
    pending += new TextDecoder().decode(plain);
    let i;
    while ((i = pending.indexOf('\r')) >= 0) {
      const cmd = pending.slice(0, i); pending = pending.slice(i + 1);
      sent.push({ t: Date.now(), cmd });
      const a = answer(cmd, sent.length);
      if (a == null) continue;
      const { text, delay } = typeof a === 'string' ? { text: a, delay: latency } : a;
      setTimeout(() => reply(text), delay);
    }
  };
  const build = () => {
    if (kind === 'bluedriver') {
      writeChar = new Char({ writeWithoutResponse: true, notify: true }, onWrite);     // Rx
      notifyChar = new Char({ notify: true, writeWithoutResponse: true }, () => {});   // Tx (acks)
    } else {
      notifyChar = new Char({ notify: true });
      writeChar = new Char({ writeWithoutResponse: true }, onWrite);
    }
  };
  build();
  const api = {};
  const server = {
    async getPrimaryService(u) {
      const id = typeof u === 'number' ? u : String(u);
      if (kind === 'bluedriver' && id === BLUEDRIVER.service) return { async getCharacteristic(c) { if (c === BLUEDRIVER.rx) return writeChar; if (c === BLUEDRIVER.tx) return notifyChar; throw new Error('no char'); } };
      if (kind === 'bluedriver' && id === BLUEDRIVER.pairService) return { async getCharacteristic() { return new Char({}); } };
      if (kind === 'elm' && (id === 0xfff0)) return { async getCharacteristics() { return [notifyChar, writeChar]; } };
      throw new Error('no service');
    },
  };
  dev.gatt = { connected: false, async connect() { dev.gatt.connected = true; if (!sameObjects) { build(); api.writeChar = writeChar; api.notifyChar = notifyChar; } return server; }, disconnect() { if (dev.gatt.connected) { dev.gatt.connected = false; dev.dispatchEvent(new Event('gattserverdisconnected')); } } };
  const bluetooth = { async requestDevice() { return dev; } };
  Object.assign(api, { bluetooth, dev, sent, drop: () => { dev.gatt.connected = false; dev.dispatchEvent(new Event('gattserverdisconnected')); }, writeChar, notifyChar });
  return api;
}

/// A simple car: Mode 01 values by PID (hex string of data bytes), ELM (echo) or bare.
export function carAnswers({ kind = 'elm', pids, extra = () => undefined }) {
  const mask = (base) => { const b = [0, 0, 0, 0]; for (const p of Object.keys(pids).map((x) => parseInt(x, 16))) { const i = p - base - 1; if (i >= 0 && i < 32) b[i >> 3] |= 0x80 >> (i & 7); } return b.map((x) => x.toString(16).padStart(2, '0').toUpperCase()).join(''); };
  return (cmd, n) => {
    const x = extra(cmd, n); if (x !== undefined) return x;
    if (/^AT|^LM/.test(cmd)) return cmd === 'ATI' ? 'ELM327 v1.5' : cmd === 'LMI' ? 'OSAPI v3.16\rOK' : cmd === 'LMDP' ? '6\rOK' : cmd === 'ATDP' ? 'AUTO, ISO 15765-4 (CAN 11/500)' : cmd === 'ATRV' ? '12.6V' : 'OK';
    const m = cmd.match(/^01([0-9A-F]{2})$/);
    if (m) {
      const pid = parseInt(m[1], 16);
      let data = pid % 0x20 === 0 ? mask(pid) : pids[m[1]];
      if (data == null) return 'NO DATA';
      if (typeof data === 'function') data = data();
      return kind === 'bluedriver' ? data.match(/../g).join(' ') + ' ' : `41${m[1]}${data}`;
    }
    return 'NO DATA';
  };
}
