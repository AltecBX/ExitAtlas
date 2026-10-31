// Pacing for automatic reroutes, so a driver who keeps leaving each new route does not send a request to the
// routing server (OSRM demo server, light use only) every few seconds. And which of OSRM's routes an automatic
// reroute takes, so a driver who keeps to the highway they are on is not sent off it at the next exit.
import { highwayLabel } from '../engine/route.js';

export const REROUTE_PACING = Object.freeze({
  /// Seconds at least between two automatic reroutes.
  spacing: 120,
  /// While the driver leaves each new route before following it, the spacing doubles up to this.
  maxSpacing: 600,
  /// A new route counts as followed once this many meters of it are driven.
  followed: 1609.344,
});

export class ReroutePacer {
  constructor(pacing = REROUTE_PACING) {
    this.pacing = pacing;
    this.reset();
  }

  reset() {
    this.lastAt = null;
    this.unfollowed = 0;
  }

  /// Seconds to wait after the last automatic reroute before the next one.
  get wait() {
    const p = this.pacing;
    return Math.min(p.maxSpacing, p.spacing * 2 ** Math.max(this.unfollowed - 1, 0));
  }

  /// May an automatic reroute start at time t (seconds)?
  allow(t) {
    return this.lastAt === null || t - this.lastAt >= this.wait;
  }

  /// An automatic reroute request is sent at time t.
  started(t) {
    this.lastAt = t;
    this.unfollowed += 1;
  }

  /// Each trip snapshot: driving a mile of the current route means it was followed.
  observe(snapshot) {
    if (snapshot?.match.status === 'onRoute' && snapshot.progress >= this.pacing.followed) this.unfollowed = 0;
  }
}

/// Which route an automatic reroute takes while the driver is on a highway. OSRM's fastest route can leave that
/// highway at the next exit to save a minute, and a driver who keeps to it is then off each new route at every
/// exit (the Taconic State Parkway to the Berkshires: each reroute said to get off). A route that stays on the
/// road the driver is on is taken instead when it stays on it at least `farther` meters longer and is slower
/// by no more than `fraction` of the fastest time or `seconds`, whichever is larger.
export const STAY_ON_ROAD = Object.freeze({ fraction: 0.1, seconds: 600, farther: 1609.344 });

/// Ramps and links without a name between two steps on the same road, up to this many meters, do not end it.
const RAMP_BRIDGE = 2000;

/// The names a route step goes by: its whole road name ("Taconic State Parkway", "I 684") and the highways in it
/// ("I-684", "NY-22", "New Jersey Turnpike"). A bare "Parkway" is no road of its own: every parkway has it.
function roadNames(step) {
  const names = new Set();
  const whole = (step?.roadName ?? '').trim();
  if (whole) names.add(whole);
  for (const ref of step?.highways ?? []) {
    if (ref.kind !== 'named') names.add(highwayLabel(ref));
    else if (ref.number.includes(' ')) names.add(ref.number); // by its full name, as OSRM names the step
  }
  return names;
}

/// The highway a route starts on (where OSRM placed the driver, along their course) as the names its first step
/// goes by, or null when that step is no highway (a street, a ramp).
export function startingRoad(route) {
  const first = route?.steps?.[0];
  return first?.highways?.length ? roadNames(first) : null;
}

/// Meters from the start of `route` that it stays on `road` (names from startingRoad).
export function metersOnRoad(route, road) {
  let end = 0, gap = 0;
  for (const step of route.steps) {
    const names = roadNames(step);
    if ([...names].some((n) => road.has(n))) { end = step.startDistance + step.length; gap = 0; continue; }
    if (!names.size && (gap += step.length) <= RAMP_BRIDGE) continue;
    break;
  }
  return end;
}

/// The route an automatic reroute takes from OSRM's answer (fastest first): the fastest, unless the driver is on
/// a highway and another route keeps them on it farther without being much slower (STAY_ON_ROAD), and then the
/// one of those that stays on it farthest. With one route (stops on the way: no alternatives) that route.
export function chooseReroute(routes, rule = STAY_ON_ROAD) {
  const fastest = routes[0] ?? null;
  const road = routes.length > 1 ? startingRoad(fastest) : null;
  if (!road) return fastest;
  const seconds = (r) => r.timeProfile.totalSeconds;
  const quickest = Math.min(...routes.map(seconds));
  const limit = quickest + Math.max(quickest * rule.fraction, rule.seconds);
  let best = fastest, stays = metersOnRoad(fastest, road);
  // Quickest first, so of two that stay on about as far the quicker is kept.
  for (const r of [...routes].sort((a, b) => seconds(a) - seconds(b))) {
    const m = metersOnRoad(r, road);
    if (seconds(r) <= limit && m >= stays + rule.farther) { best = r; stays = m; }
  }
  return best;
}
