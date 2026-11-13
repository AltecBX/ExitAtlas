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
    this.kept = null;       // where the last save went: 'device' or 'memory'
    this.lastError = null;
  }

  async open() {
    if (this.db || (this.persistent === false && typeof indexedDB === 'undefined')) return this.db;
    try {
      if (typeof indexedDB === 'undefined') throw new Error('no IndexedDB');
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('data')) db.createObjectStore('data', { keyPath: 'id' });
      };
      this.db = await promised(req);
      // The browser may close the connection (another tab upgrading, storage pressure): open again next time.
      this.db.onclose = () => { this.db = null; };
      this.db.onversionchange = () => { try { this.db?.close(); } catch { /* closed */ } this.db = null; };
      this.persistent = true;
    } catch {
      // Never opened: storage is blocked here. Opened before: a passing failure, tried again on the next job.
      if (this.persistent !== true) this.persistent = false;
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

  /// A database job, tried again once on a fresh connection when it fails: Safari closes the connection of a page
  /// that sat in the background, and a closed connection fails every request from then on.
  async job(work) {
    const db = await this.open();
    if (!db) return { db: null };
    try {
      return { db, value: await work(db) };
    } catch (first) {
      try { this.db?.close?.(); } catch { /* already closed */ }
      this.db = null;
      const again = await this.open();
      if (!again) throw first;
      return { db: again, value: await work(again) };
    }
  }

  /// Saves a recording. When the device's storage cannot take it (full, or blocked), it is kept in memory until
  /// the page closes and `kept` says so ('memory'), so a drive is never dropped without a word.
  async save(rec) {
    const write = (db) => {
      const tx = db.transaction(['meta', 'data'], 'readwrite');
      tx.objectStore('meta').put(RecordingStore.summary(rec));
      tx.objectStore('data').put(rec);
      return new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error ?? new Error('storage refused the recording')); });
    };
    try {
      const { db } = await this.job(write);
      if (db) { this.memory.delete(rec.id); this.kept = 'device'; return 'device'; }
    } catch (e) {
      this.lastError = e?.message ?? String(e);
    }
    this.memory.set(rec.id, structuredClone(rec));
    this.kept = 'memory';
    return 'memory';
  }

  async list() {
    const inMemory = [...this.memory.values()].map((r) => RecordingStore.summary(r));
    let stored = [];
    try { stored = (await this.job((db) => promised(db.transaction('meta').objectStore('meta').getAll()))).value ?? []; } catch (e) { this.lastError = e?.message ?? String(e); if (!inMemory.length) throw e; }
    const ids = new Set(inMemory.map((r) => r.id));
    return [...inMemory, ...stored.filter((r) => !ids.has(r.id))].sort((a, b) => b.startedAt - a.startedAt);
  }

  async load(id) {
    if (this.memory.has(id)) return this.memory.get(id);
    return (await this.job((db) => promised(db.transaction('data').objectStore('data').get(id)))).value ?? null;
  }

  async remove(id) {
    this.memory.delete(id);
    await this.job((db) => {
      const tx = db.transaction(['meta', 'data'], 'readwrite');
      tx.objectStore('meta').delete(id);
      tx.objectStore('data').delete(id);
      return new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error ?? new Error('storage refused')); });
    });
  }
}
