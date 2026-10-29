// Live traffic in the trip engine (docs/16): traffic aware arrival times from provider travel times measured
// on the driver's own route, a stabilizer so one odd answer does not move every time on screen, slowdowns on
// the route ahead as Road Intelligence incidents, and when a faster route is worth offering. Provider
// agnostic: each provider converts its answers to these shapes. Same rules as
// Sources/ExitAtlasCore/Trip/Traffic.swift, tested on Tests/ExitAtlasCoreTests/Fixtures/traffic.
//
// A reading: {routeId, measuredAt (unix seconds), fromAlong (meters along the route where it was measured),
//   checkpoints: [{along, seconds}] (provider driving seconds from fromAlong, increasing), source: {id, name}}.
// Checkpoints are only ever times the provider computed along this route (for example the next state line,
// the next stop, the destination); nothing is spread from a whole route total.

export const TRAFFIC_RULES = Object.freeze({
  /// A reading older than this is stale: arrival times fall back to the driver's pace and say so.
  maxAge: 900,
  /// The driver may be this far behind where a reading was measured (GPS jitter) and still use it.
  behindTolerance: 300,
  /// A new reading that moves the arrival by no more than this is taken at once.
  driftSeconds: 120,
  /// A larger move must be seen again, in the same direction, within this time before it is shown.
  confirmWithin: 900,
  /// Slowdowns adding less than this (when the provider gives a delay) are not shown.
  minDelaySeconds: 60,
});

/// Provider seconds from the reading's start to `x`, interpolating between checkpoints by the route's
/// modeled time, or null beyond the last checkpoint.
function readingSeconds(reading, x, modelSeconds) {
  const pts = [{ along: reading.fromAlong, seconds: 0 }, ...reading.checkpoints];
  if (x <= pts[0].along) return 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if (x <= b.along) {
      const span = modelSeconds(a.along, b.along);
      const share = span > 0 ? modelSeconds(a.along, x) / span : (x - a.along) / Math.max(1, b.along - a.along);
      return a.seconds + (b.seconds - a.seconds) * Math.min(1, Math.max(0, share));
    }
  }
  return null;
}

/// Why a reading cannot be used now ('stale', 'other route', 'passed', 'behind', 'empty'), or null when it can.
export function readingProblem(reading, { routeId, progress, now }, rules = TRAFFIC_RULES) {
  if (!reading || !reading.checkpoints?.length) return 'empty';
  if (reading.routeId !== routeId) return 'other route';
  if (now - reading.measuredAt > rules.maxAge) return 'stale';
  if (progress < reading.fromAlong - rules.behindTolerance) return 'behind';
  if (progress >= reading.checkpoints[reading.checkpoints.length - 1].along) return 'passed';
  return null;
}

/// Driving seconds from `progress` to `target`: the provider's times where the reading covers the road, then
/// the driver's pace for the rest. The pace part starts where the reading ends, so the near term (where the
/// recent pace already reflects today's traffic) is never counted twice.
///   modelSeconds(a, b): the route's modeled seconds between two distances
///   paceSeconds(modelSeconds): the pace model's predicted seconds for that much modeled time from here
export function trafficSecondsTo(reading, progress, target, { modelSeconds, paceSeconds }) {
  const from = Math.max(progress, reading.fromAlong);
  const last = reading.checkpoints[reading.checkpoints.length - 1];
  const here = readingSeconds(reading, from, modelSeconds);
  if (target <= last.along) return Math.max(0, readingSeconds(reading, target, modelSeconds) - here);
  const covered = last.seconds - here;
  return covered + paceSeconds(modelSeconds(progress, target)) - paceSeconds(modelSeconds(progress, last.along));
}

/// What an arrival time is based on: 'traffic' (a usable reading covers the target), 'trafficThenPace' (a
/// reading covers part of the way), 'pace' (the driver's pace, no live traffic) or 'model' (routing road
/// speeds only: no live traffic and no pace yet).
export function etaBasis(reading, ok, target, paceKnown) {
  if (ok && reading) return target <= reading.checkpoints[reading.checkpoints.length - 1].along ? 'traffic' : 'trafficThenPace';
  return paceKnown ? 'pace' : 'model';
}

export const BASIS_LABELS = Object.freeze({
  traffic: 'With traffic',
  trafficThenPace: 'With traffic, then your pace',
  pace: 'Your pace, no traffic data',
  model: 'Road speeds, no traffic data',
});

/// Holds the reading shown on screen. A new reading that moves the arrival at its farthest checkpoint by more
/// than `driftSeconds` replaces the shown one only when a second reading confirms the move (same direction,
/// within `confirmWithin`); until then the shown reading stays while it is usable. With nothing usable shown,
/// a new reading is taken at once.
///   state: {shown, pending} (start with {shown: null, pending: null})
///   context: {routeId, progress, now, modelSeconds, paceSeconds}
/// Returns {state, reading (the one to use, or null), changed}.
export function stabilizeReading(state, incoming, context, rules = TRAFFIC_RULES) {
  const s = { shown: state?.shown ?? null, pending: state?.pending ?? null };
  const usable = (r) => r && readingProblem(r, context, rules) === null;
  if (!usable(s.shown)) s.shown = null;
  if (!incoming || !usable(incoming)) return { state: s, reading: s.shown, changed: false };
  if (!s.shown) return { state: { shown: incoming, pending: null }, reading: incoming, changed: true };
  // Compare where both agree: the arrival at the new reading's farthest checkpoint the shown one also covers.
  const target = Math.min(incoming.checkpoints[incoming.checkpoints.length - 1].along,
    s.shown.checkpoints[s.shown.checkpoints.length - 1].along);
  const p = context.progress;
  const before = context.now + trafficSecondsTo(s.shown, p, target, context);
  const after = context.now + trafficSecondsTo(incoming, p, target, context);
  const delta = after - before;
  if (Math.abs(delta) <= rules.driftSeconds) return { state: { shown: incoming, pending: null }, reading: incoming, changed: true };
  const pend = s.pending;
  if (pend && Math.sign(pend.delta) === Math.sign(delta) && context.now - pend.at <= rules.confirmWithin) {
    return { state: { shown: incoming, pending: null }, reading: incoming, changed: true };
  }
  return { state: { shown: s.shown, pending: { delta, at: context.now } }, reading: s.shown, changed: false };
}

/// Slowdown sections a provider measured on this route, as Road Intelligence incidents. A section:
///   {from, to (meters along the route), level: 'slow' | 'heavy' | 'stopped', delaySeconds (or null),
///    speedMph (or null)}. Sections behind `progress` or adding under a minute are dropped.
/// The geometry is the route itself ({type: 'route', routeId, from, to}): the provider measured these on the
/// driver's route and direction, so they need no position matching.
export function slowdownIncidents(sections, { routeId, progress, measuredAt, source }, rules = TRAFFIC_RULES) {
  const SEVERITY = { slow: 'moderate', heavy: 'major', stopped: 'severe' };
  const DESCRIPTION = { slow: 'Slow traffic', heavy: 'Heavy traffic', stopped: 'Stopped traffic' };
  const out = [];
  for (const s of sections) {
    if (!SEVERITY[s.level] || !(s.to > progress) || !(s.to > s.from)) continue;
    if (s.delaySeconds != null && s.delaySeconds < rules.minDelaySeconds) continue;
    out.push({
      id: `traffic:${source.id}:${routeId}:${Math.round(s.from)}`, category: 'congestion', description: DESCRIPTION[s.level],
      source, verification: 'measured', reportedAt: measuredAt, updatedAt: measuredAt, startsAt: null, endsAt: null,
      expiresAt: measuredAt + rules.maxAge, geometry: { type: 'route', routeId, from: s.from, to: s.to },
      road: null, direction: null, lanes: null, severity: SEVERITY[s.level],
      delaySeconds: s.delaySeconds ?? null, speedMph: s.speedMph ?? null,
    });
  }
  return out;
}

export const ALTERNATIVE_RULES = Object.freeze({
  /// The smallest saving worth an offer (the driver can raise it in Settings).
  minSavingSeconds: 600,
  /// ...and at least this share of the time left, so a long trip needs a real gain.
  minSavingShare: 0.05,
  /// An alternative more than this share longer in distance is not offered.
  maxExtraDistanceShare: 0.25,
  /// The saving must hold this many checks in a row...
  confirmations: 2,
  /// ...with no more than this between them.
  confirmWithin: 900,
  /// After "Not now", the same alternative is not offered again for this long unless it saves this much more.
  snoozeSeconds: 1800,
  snoozeExtraSeconds: 600,
});

/// Whether to offer a faster route. Both times must come from the same provider measurement with live traffic,
/// to the same point (the next stop or the destination); nothing is compared across sources.
///   current: {seconds, meters, closureAhead}
///   alternative: {id, seconds, meters, tolls (true | false | null), keepsStops, closureAhead, missesStop (name or null)}
///   prefs: {minSavingSeconds, avoidTolls}
///   state: {candidate: {id, seen, at}, snoozed: {id, until, saving}} (start with {})
/// Returns {state, offer: null | {id, savedSeconds, extraMeters, notes: [...]}, reason}.
export function adviseAlternative({ current, alternative, prefs = {}, state = {}, now }, rules = ALTERNATIVE_RULES) {
  const s = { candidate: state.candidate ?? null, snoozed: state.snoozed ?? null };
  const none = (reason) => ({ state: { ...s, candidate: null }, offer: null, reason });
  if (!current || !alternative) return none('no alternative');
  if (!alternative.keepsStops) return none('drops a planned stop');
  if (alternative.closureAhead) return none('a closure on the alternative');
  if (prefs.avoidTolls && alternative.tolls === true) return none('tolls');
  const saved = current.seconds - alternative.seconds;
  const threshold = Math.max(prefs.minSavingSeconds ?? rules.minSavingSeconds, rules.minSavingShare * current.seconds);
  if (saved < threshold) return none('saving below the threshold');
  const extra = alternative.meters - current.meters;
  if (extra > rules.maxExtraDistanceShare * current.meters) return none('too much farther');
  if (s.snoozed && s.snoozed.id === alternative.id && now < s.snoozed.until && saved < s.snoozed.saving + rules.snoozeExtraSeconds) {
    return { state: s, offer: null, reason: 'snoozed' };
  }
  const prev = s.candidate;
  const seen = prev && prev.id === alternative.id && now - prev.at <= rules.confirmWithin ? prev.seen + 1 : 1;
  const next = { ...s, candidate: { id: alternative.id, seen, at: now } };
  if (seen < rules.confirmations) return { state: next, offer: null, reason: 'waiting for a second check' };
  const MILE = 1609.344;
  const notes = [];
  const mi = Math.round(Math.abs(extra) / MILE);
  if (mi >= 1) notes.push(`${mi} mi ${extra > 0 ? 'longer' : 'shorter'}`);
  if (alternative.tolls === true) notes.push('Tolls listed');
  else if (alternative.tolls === false) notes.push('No tolls listed');
  if (current.closureAhead) notes.push('Avoids the closure ahead');
  if (alternative.missesStop) notes.push(`Your ${alternative.missesStop} is not on this route`);
  return { state: next, offer: { id: alternative.id, savedSeconds: saved, extraMeters: extra, notes }, reason: 'offer' };
}

/// "Not now": the same alternative is held back for a while.
export function snoozeAlternative(state, offer, now, rules = ALTERNATIVE_RULES) {
  return { candidate: null, snoozed: { id: offer.id, until: now + rules.snoozeSeconds, saving: offer.savedSeconds } };
}
