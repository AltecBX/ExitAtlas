// Car data recordings, kept on this device only (IndexedDB), never uploaded. A list of small summaries and the
// readings stored apart, so the list opens without loading every reading. Where IndexedDB is blocked (some private
// modes) recordings are kept in memory until the page closes, and the app says so.

const DB_NAME = 'exitatlas-car';
const VERSION = 1;

function promised(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export class RecordingStore {
  constructor() {
    this.memory = new Map();
    this.persistent = null; // true once IndexedDB opened, false when it cannot be used
    this.db = null;
  }

  async open() {
    if (this.db || this.persistent === false) return this.db;
    try {
      if (typeof indexedDB === 'undefined') throw new Error('no IndexedDB');
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('data')) db.createObjectStore('data', { keyPath: 'id' });
      };
      this.db = await promised(req);
      this.persistent = true;
    } catch {
      this.persistent = false;
      this.db = null;
    }
    return this.db;
  }

  /// The summary shown in the list.
  static summary(rec) {
    const last = rec.samples.length ? rec.samples[rec.samples.length - 1][0] : 0;
    return { id: rec.id, startedAt: rec.startedAt, duration: rec.endedAt ? rec.endedAt - rec.startedAt : last, samples: rec.samples.length,
      channels: Object.keys(rec.channels).length, vehicle: rec.vehicle ?? null, adapter: rec.adapter ?? null, done: Boolean(rec.endedAt) };
  }

  async save(rec) {
    const db = await this.open();
    if (!db) { this.memory.set(rec.id, structuredClone(rec)); return; }
    const tx = db.transaction(['meta', 'data'], 'readwrite');
    tx.objectStore('meta').put(RecordingStore.summary(rec));
    tx.objectStore('data').put(rec);
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
  }

  async list() {
    const db = await this.open();
    const all = db ? await promised(db.transaction('meta').objectStore('meta').getAll()) : [...this.memory.values()].map((r) => RecordingStore.summary(r));
    return all.sort((a, b) => b.startedAt - a.startedAt);
  }

  async load(id) {
    const db = await this.open();
    if (!db) return this.memory.get(id) ?? null;
    return (await promised(db.transaction('data').objectStore('data').get(id))) ?? null;
  }

  async remove(id) {
    const db = await this.open();
    if (!db) { this.memory.delete(id); return; }
    const tx = db.transaction(['meta', 'data'], 'readwrite');
    tx.objectStore('meta').delete(id);
    tx.objectStore('data').delete(id);
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
  }
}
