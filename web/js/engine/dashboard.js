// The adaptive Drive screen: a fixed set of cards (instruments, state progress, one focus card, a one
// line "Then" strip, destination) where the most relevant item takes the focus card and the next two
// sit in the strip. Nothing is ever added as an extra card. Same rules as
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
///   }
/// Returns {focus: kind, strip: [kinds], why} with kinds 'fuel', 'stop', 'gap', 'lastOpen', 'overnight', 'restArea',
/// 'exit', 'fuelEntry' (no range entered yet; strip only).
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

  let focus, why;
  if (fuelLow) { focus = 'fuel'; why = 'Fuel is below your reserve'; }
  else if (s.plannedStop && s.plannedStop.distance <= rules.stopWithin) { focus = 'stop'; why = 'Approaching your planned stop'; }
  else if (gapRisk) { focus = 'gap'; why = 'A stretch without gas is coming up'; }
  else if (fuelSoon) { focus = 'fuel'; why = 'Your fuel stop is coming up'; }
  else if (s.lastOpen != null && s.lastOpen <= rules.gapWithin) { focus = 'lastOpen'; why = 'Last stop listed open before a long stretch'; }
  else if (s.overnight && (reading || s.restArea)) { focus = 'overnight'; why = 'Overnight: open stops and restrooms'; }
  else if (restFirst) { focus = 'restArea'; why = 'Rest area before the next exit'; }
  else if (s.nextExit) { focus = 'exit'; why = 'Next exit'; }
  else if (s.restArea) { focus = 'restArea'; why = 'Next rest area'; }
  else { focus = 'none'; why = 'Nothing ahead on this road'; }

  // The strip: the next most useful items, never the focus again.
  const near = (d) => d != null && d <= rules.stripWithin;
  const candidates = [];
  if (reading && fuel.stopAhead != null && near(fuel.stopAhead)) candidates.push('fuel');
  if (!reading) candidates.push('fuelEntry');
  if (s.gap && near(s.gap.startsIn)) candidates.push('gap');
  if (s.plannedStop && near(s.plannedStop.distance)) candidates.push('stop');
  if (s.restArea && near(s.restArea.distance)) candidates.push('restArea');
  if (s.nextExit) candidates.push('exit');
  const covered = new Set([focus, focus === 'overnight' ? 'fuel' : null]);
  const strip = candidates.filter((k) => !covered.has(k)).slice(0, rules.stripSize);
  return { focus, strip, why };
}
