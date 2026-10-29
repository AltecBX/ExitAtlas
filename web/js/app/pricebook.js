// Gas prices ExitAtlas can show (docs/17), each with its source and the time it was seen:
//   - the driver's own reports, kept on this device: they work without any server or account
//   - shared reports from other ExitAtlas drivers, through the owner's free server (infra/worker), when it
//     offers them and the driver turned them on in Settings
// Google Maps prices (app/prices.js) are separate: paid, off by default, looked up only when the driver
// asks, kept in memory and never saved or shared. Nothing here makes up a price or shows a regional
// average as one (engine/gasprices.js).
import { validateReport, addReport } from '../engine/gasprices.js';

export const OWN_SOURCE = Object.freeze({ id: 'own', name: 'You', kind: 'own' });
export const SHARED_SOURCE = Object.freeze({ id: 'community', name: 'ExitAtlas drivers', kind: 'community' });
/// Test data for the demo (?demo&prices): never saved or sent, and labeled wherever it shows.
export const SIMULATED_SOURCE = Object.freeze({ id: 'simulated', name: 'Simulated test data', kind: 'simulated' });
const KEY = 'ea.priceReports';
const INSTALL = 'ea.installId';
/// Shared reports are asked for again after this long, and after a failure not before this.
const SHARED_TTL = 5 * 60 * 1000;
const SHARED_RETRY = 2 * 60 * 1000;
const PER_REQUEST = 50;

export class PriceBook {
  /// store: {get, set} (app/services.js); getProxy: the proxy base URL when it offers shared reports, else
  /// null; sources: () => {own, shared}, the driver's switches.
  constructor({ store, getProxy = () => null, sources = () => ({ own: true, shared: false }), fetchImpl = (...a) => fetch(...a), now = () => Date.now() }) {
    this.store = store;
    this.getProxy = getProxy;
    this.sources = sources;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.shared = new Map(); // station id -> {at, records}
    this.sharedError = null; // {at, message} of the last failed lookup
    this.pending = new Set();
    /// SIMULATED records for the demo only (memory, never stored or shared).
    this.simulated = [];
    /// Changes whenever the records change (cache keys in main.js).
    this.version = 0;
  }

  /// The driver's own reports on this device, expired ones dropped.
  own() {
    const now = Math.floor(this.now() / 1000);
    const list = this.store.get(KEY, []);
    if (!Array.isArray(list)) return [];
    return list.filter((r) => r && typeof r.id === 'string' && validateReport(r, { now }).ok).map((r) => ({ ...r, source: OWN_SOURCE }));
  }

  /// Shared reports can be used: the proxy offers them and the driver turned them on.
  get sharedOn() { return Boolean(this.sources().shared && this.getProxy()); }

  /// 'off', 'unavailable' (the last lookup failed: never read as "no prices") or 'ok'.
  get sharedState() {
    if (!this.sharedOn) return 'off';
    return this.sharedError && this.now() - this.sharedError.at < SHARED_TTL ? 'unavailable' : 'ok';
  }

  /// Reports to consider for a station: the driver's own (when on) and shared ones (when on), without the
  /// shared copy of a report this device sent.
  records(stationId) {
    const own = this.sources().own === false ? [] : this.own().filter((r) => r.stationId === stationId);
    for (const r of this.simulated) if (r.stationId === stationId) own.push(r);
    if (!this.sharedOn) return own;
    const sent = new Set(this.own().map((r) => r.sharedId).filter(Boolean));
    const shared = (this.shared.get(stationId)?.records ?? []).filter((r) => !sent.has(r.id));
    return [...own, ...shared];
  }

  /// Saves a report on this device, and sends it to other drivers when `share` is set and the location
  /// check passed. input: {stationId, grade, price, payment, member, stationName, place}; benchmark: the
  /// regional average for the grade (EIA), when known, for the sanity check.
  /// Returns {ok, problems, record, duplicate, shared: null (not sent), 'sent', or why it was not}.
  async report(input, { share = false, near = false, benchmark = null } = {}) {
    const now = Math.floor(this.now() / 1000);
    const check = validateReport({ stationId: input.stationId, grade: input.grade, price: input.price, payment: input.payment ?? null, member: Boolean(input.member), reportedAt: now }, { now, benchmark });
    if (!check.ok) return { ok: false, problems: check.problems, record: null, shared: null };
    const record = {
      ...check.record, id: `own-${now}-${Math.random().toString(36).slice(2, 8)}`, reporter: 'me',
      stationName: typeof input.stationName === 'string' ? input.stationName.slice(0, 80) : null, place: typeof input.place === 'string' ? input.place.slice(0, 80) : null,
    };
    const list = addReport(this.own().map(strip), record, now);
    // The same price again within 30 minutes is the report already saved.
    if (!list.some((r) => r.id === record.id)) return { ok: true, problems: [], record: null, duplicate: true, shared: null };
    if (!this.store.set(KEY, list.map(strip))) return { ok: false, problems: ['storage'], record: null, shared: null };
    this.version++;
    let shared = null;
    if (share) {
      shared = near ? await this.send(record) : 'not sent: the location check did not place you at this station';
    }
    return { ok: true, problems: [], record, shared };
  }

  /// Deletes one of the driver's own reports (on this device; a shared copy expires on the server).
  remove(id) {
    const list = this.own().filter((r) => r.id !== id).map(strip);
    this.store.set(KEY, list);
    this.version++;
  }

  async send(record) {
    const base = this.getProxy();
    if (!base || !this.sources().shared) return null;
    try {
      const res = await this.fetchImpl(new URL('v1/price-reports', base), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stationId: record.stationId, grade: record.grade, price: record.price, payment: record.payment, member: record.member, install: this.installId(), near: true }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return `not sent: ${body?.error ?? `the server answered ${res.status}`}`;
      if (body?.id) {
        const list = this.own().map((r) => (r.id === record.id ? { ...r, sharedId: body.id } : r)).map(strip);
        this.store.set(KEY, list);
      }
      this.shared.delete(record.stationId);
      this.version++;
      return 'sent';
    } catch (e) {
      return `not sent: ${e.message}`;
    }
  }

  /// A random id for this install, made the first time a report is shared. The server keeps only a hash.
  installId() {
    let id = this.store.get(INSTALL, null);
    if (typeof id !== 'string' || id.length < 16) {
      const bytes = crypto.getRandomValues(new Uint8Array(12));
      id = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
      this.store.set(INSTALL, id);
    }
    return id;
  }

  /// Asks the server for shared reports at these stations (when on), at most every few minutes per station.
  /// Resolves true when something new arrived.
  async loadShared(stationIds) {
    const base = this.getProxy();
    if (!this.sharedOn || !base) return false;
    const t = this.now();
    if (this.sharedError && t - this.sharedError.at < SHARED_RETRY) return false;
    const due = [...new Set(stationIds)].filter((id) => id && !this.pending.has(id) && !(t - (this.shared.get(id)?.at ?? -Infinity) < SHARED_TTL));
    if (!due.length) return false;
    let changed = false;
    for (let i = 0; i < due.length; i += PER_REQUEST) {
      const ids = due.slice(i, i + PER_REQUEST);
      ids.forEach((id) => this.pending.add(id));
      try {
        const url = new URL('v1/price-reports', base);
        url.searchParams.set('stations', ids.join(','));
        const res = await this.fetchImpl(url);
        const body = await res.json().catch(() => null);
        if (!res.ok || !Array.isArray(body?.reports)) throw new Error(body?.error ?? `the server answered ${res.status}`);
        const now = Math.floor(this.now() / 1000);
        const by = new Map(ids.map((id) => [id, []]));
        for (const r of body.reports) {
          if (!by.has(r?.stationId) || typeof r.id !== 'string') continue;
          const check = validateReport(r, { now });
          if (check.ok) by.get(r.stationId).push({ ...check.record, id: r.id, reporter: typeof r.reporter === 'string' ? r.reporter : null, source: SHARED_SOURCE });
        }
        for (const [id, records] of by) this.shared.set(id, { at: this.now(), records });
        this.sharedError = null;
        changed = true;
      } catch (e) {
        this.sharedError = { at: this.now(), message: e.message };
      } finally {
        ids.forEach((id) => this.pending.delete(id));
      }
    }
    if (changed) this.version++;
    return changed;
  }
}

/// What is stored for an own report (the source is added back when read).
function strip(r) {
  const { source, ...rest } = r;
  return rest;
}

