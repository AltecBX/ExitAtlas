// The adaptive Drive screen: one adaptive card (the most relevant item) and a "Then" strip with the next
// two, over the fixed instruments, state line and next exit. Nothing is ever added as an extra card. Same rules as
// Sources/ExitAtlasCore/Trip/DashboardFocus.swift, tested on Tests/ExitAtlasCoreTests/Fixtures/dashboard.
import { METERS_PER_MILE as MILE } from './geo.js';

export const FOCUS_RULES = Object.freeze({
  /// A planned stop this close takes the focus (with its exit).
  stopWithin: 15 * MILE,
  /// A stretch without gas this close is a warning when the range may not cover it.
  gapWithin: 25 * MILE,
  /// The fuel stop this close takes the focus.
  fuelWithin: 30 * MILE,
  /// A rest area before the next exit and this close takes the focus.
  restAreaWithin: 10 * MILE,
  /// A serious road alert (closure, major crash, severe weather) this close takes the focus.
  seriousAlertWithin: 50 * MILE,
  /// Any other road alert this close takes the focus.
  alertWithin: 10 * MILE,
  /// A serious alert this close comes before everything, fuel below the reserve included.
  seriousAlertNow: 10 * MILE,
  /// The next state line this close takes the focus (miles to the line, exits left, the next state).
  borderWithin: 5 * MILE,
  /// Strip items farther than this are left out.
  stripWithin: 150 * MILE,
  stripSize: 2,
});

/// Picks the focus card and the strip.
///   signals: {
///     nextExit: {distance} | null,
///     restArea: {distance} | null,
///     gap: {startsIn, length} | null        (startsIn 0 when inside the stretch)
///     fuel: {reading: bool, range, reserve, stopAhead: meters to the recommended stop | null, low: bool} | null,
///     plannedStop: {distance} | null,
///     overnight: bool,
///     lastOpen: meters to the last stop listed open before a long overnight stretch | null,
///     alert: {distance, serious, id?} for the nearest road alert ahead (engine/roadintel.js) | null,
///     border: {distance} to the next state line | null,
///   }
/// Returns {focus: kind, strip: [kinds], why, rank, qualifying: [{kind, rank}], available: [kinds]} with kinds
/// 'fuel', 'alert', 'stop', 'gap', 'border', 'lastOpen', 'overnight', 'restArea', 'exit', 'fuelEntry' (no range
/// entered yet; strip only). `rank` orders the rules (0 is the most urgent); `qualifying` lists every rule that
/// holds, in order; `available` lists the kinds that have something to show.
export function dashboardFocus(signals, rules = FOCUS_RULES) {
  const s = signals;
  const fuel = s.fuel ?? null;
  const reading = Boolean(fuel?.reading);
  const fuelLow = reading && (fuel.low || fuel.range < fuel.reserve);
  // A gap matters when the range is unknown or would not carry past it with the reserve.
  const gapNear = s.gap && s.gap.startsIn <= rules.gapWithin;
  const gapRisk = gapNear && (!reading || fuel.range - fuel.reserve < s.gap.startsIn + s.gap.length);
  const fuelSoon = reading && fuel.stopAhead != null && fuel.stopAhead <= rules.fuelWithin;
  const restFirst = s.restArea && s.restArea.distance <= rules.restAreaWithin
    && (!s.nextExit || s.restArea.distance < s.nextExit.distance);

  const alert = s.alert ?? null;
  const alertNear = alert && alert.distance <= (alert.serious ? rules.seriousAlertWithin : rules.alertWithin);

  // Every rule in order; the first that holds takes the focus. A routine pick never hides a serious alert
  // just ahead, and fuel below the reserve comes before a serious alert farther away.
  const order = [
    ['alert', alertNear && alert.serious && alert.distance <= rules.seriousAlertNow, 'A serious road alert just ahead'],
    ['fuel', fuelLow, 'Fuel is below your reserve'],
    ['alert', alertNear && alert.serious, 'A serious road alert ahead'],
    ['stop', s.plannedStop && s.plannedStop.distance <= rules.stopWithin, 'Approaching your planned stop'],
    ['gap', gapRisk, 'A stretch without gas is coming up'],
    ['alert', alertNear, 'A road alert just ahead'],
    ['border', s.border && s.border.distance <= rules.borderWithin, 'Approaching the state line'],
    ['fuel', fuelSoon, 'Your fuel stop is coming up'],
    ['lastOpen', s.lastOpen != null && s.lastOpen <= rules.gapWithin, 'Last stop listed open before a long stretch'],
    ['overnight', s.overnight && (reading || s.restArea), 'Overnight: open stops and restrooms'],
    ['restArea', restFirst, 'Rest area before the next exit'],
    ['exit', s.nextExit, 'Next exit'],
    ['restArea', s.restArea, 'Next rest area'],
  ];
  const qualifying = [];
  order.forEach(([kind, holds, why], rank) => {
    if (holds && !qualifying.some((q) => q.kind === kind)) qualifying.push({ kind, rank, why });
  });
  const first = qualifying[0] ?? { kind: 'none', rank: order.length, why: 'Nothing ahead on this road' };

  const available = [];
  if (alert) available.push('alert');
  if (reading) available.push('fuel');
  if (s.plannedStop) available.push('stop');
  if (s.gap) available.push('gap');
  if (s.border) available.push('border');
  if (s.lastOpen != null) available.push('lastOpen');
  if (s.overnight && (reading || s.restArea)) available.push('overnight');
  if (s.restArea) available.push('restArea');
  if (s.nextExit) available.push('exit');
  available.push('none');

  return { focus: first.kind, strip: focusStrip(s, first.kind, rules), why: first.why, rank: first.rank, qualifying, available };
}

/// The strip under a focus card: the next most useful items, never the focus again.
export function focusStrip(signals, focus, rules = FOCUS_RULES) {
  const s = signals;
  const fuel = s.fuel ?? null;
  const reading = Boolean(fuel?.reading);
  const near = (d) => d != null && d <= rules.stripWithin;
  const candidates = [];
  if (reading && fuel.stopAhead != null && near(fuel.stopAhead)) candidates.push('fuel');
  if (!reading) candidates.push('fuelEntry');
  if (s.gap && near(s.gap.startsIn)) candidates.push('gap');
  if (s.alert && near(s.alert.distance)) candidates.push('alert');
  if (s.plannedStop && near(s.plannedStop.distance)) candidates.push('stop');
  if (s.restArea && near(s.restArea.distance)) candidates.push('restArea');
  if (s.nextExit) candidates.push('exit');
  const covered = new Set([focus, focus === 'overnight' ? 'fuel' : null]);
  return candidates.filter((k) => !covered.has(k)).slice(0, rules.stripSize);
}

export const FOCUS_STABILITY = Object.freeze({
  /// A card stays at least this long unless something more urgent qualifies.
  holdSeconds: 30,
  /// A new card must win this many readings in a row before it replaces the one shown.
  confirmReadings: 2,
  /// Rules at or above this rank (a serious alert just ahead, fuel below the reserve) replace the card at once.
  immediateRank: 1,
  /// An alert that left the route (expired, withdrawn, a feed hiccup) does not come back for this long.
  alertCooldownSeconds: 600,
});

/// Keeps the focus card steady between readings: no flicker at a threshold, no card replaced by a less urgent
/// one within `holdSeconds`, and alerts that disappear do not bounce back. Call `choose` once per position
/// reading (the same `t` twice returns the same answer). Same rules as DashboardFocus.Stabilizer in Swift.
export class FocusStabilizer {
  constructor(rules = FOCUS_RULES, stability = FOCUS_STABILITY) {
    this.rules = rules;
    this.stability = stability;
    this.reset();
  }

  reset() {
    this.shown = null;
    this.shownRank = Infinity;
    this.shownWhy = '';
    this.shownAt = 0;
    this.pending = null;
    this.pendingCount = 0;
    this.lastAlertId = null;
    this.goneAt = new Map();
    this.lastT = null;
    this.last = null;
  }

  /// signals as for dashboardFocus; t in seconds. Returns dashboardFocus's result with `held` when the card
  /// shown is kept over the raw pick.
  choose(signals, t) {
    if (this.last && t === this.lastT) return this.last;
    const st = this.stability;
    let s = signals;
    const id = s.alert?.id ?? null;
    if (this.lastAlertId != null && this.lastAlertId !== id) this.goneAt.set(this.lastAlertId, t);
    if (id != null && this.goneAt.has(id)) {
      if (t - this.goneAt.get(id) < st.alertCooldownSeconds) s = { ...s, alert: null };
      else this.goneAt.delete(id);
    }
    this.lastAlertId = s.alert ? id : null;

    const raw = dashboardFocus(s, this.rules);
    const out = this.decide(raw, s, t);
    this.lastT = t;
    this.last = out;
    return out;
  }

  decide(raw, s, t) {
    const st = this.stability;
    const show = () => {
      this.shown = raw.focus;
      this.shownRank = raw.rank;
      this.shownWhy = raw.why;
      this.shownAt = t;
      this.pending = null;
      this.pendingCount = 0;
      return { ...raw, held: false };
    };
    if (this.shown === null) return show();
    if (raw.focus === this.shown) {
      this.shownRank = raw.rank;
      this.shownWhy = raw.why;
      this.pending = null;
      this.pendingCount = 0;
      return { ...raw, held: false };
    }
    // The card shown has nothing left to show (passed, gone): replace it now.
    if (!raw.available.includes(this.shown)) return show();
    // Something more urgent than the card shown: at once for the top rules, else after it wins twice in a row.
    if (raw.rank <= st.immediateRank && raw.rank < this.shownRank) return show();
    if (this.pending === raw.focus) this.pendingCount += 1;
    else { this.pending = raw.focus; this.pendingCount = 1; }
    if (this.pendingCount >= st.confirmReadings) {
      if (raw.rank < this.shownRank) return show();
      // Less urgent: only once the card has been up for holdSeconds.
      if (t - this.shownAt >= st.holdSeconds) return show();
    }
    return { ...raw, focus: this.shown, why: this.shownWhy, strip: focusStrip(s, this.shown, this.rules), held: true };
  }
}
