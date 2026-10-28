// Travel statistics from the trip history (real GPS trips only): miles and trips per state, and totals.
// No achievements, badges or state collecting. Same rules as Sources/ExitAtlasCore/Tracking/TravelStats.swift.

/// trips: [{title, startedAt (epoch s), states:[{code, name, meters}], totalMeters}].
/// Returns {states: [{code, name, meters, trips, firstAt, lastAt}] most miles first, totalMeters, tripCount}.
export function travelStats(trips) {
  const byCode = new Map();
  let total = 0;
  for (const t of trips) {
    total += t.totalMeters ?? 0;
    for (const s of t.states ?? []) {
      if (!s.code || !(s.meters > 0)) continue;
      const e = byCode.get(s.code) ?? { code: s.code, name: s.name, meters: 0, trips: 0, firstAt: t.startedAt, lastAt: t.startedAt };
      e.meters += s.meters;
      e.trips += 1;
      e.firstAt = Math.min(e.firstAt, t.startedAt);
      e.lastAt = Math.max(e.lastAt, t.startedAt);
      byCode.set(s.code, e);
    }
  }
  const states = [...byCode.values()].sort((a, b) => b.meters - a.meters || a.code.localeCompare(b.code));
  return { states, totalMeters: total, tripCount: trips.length };
}
