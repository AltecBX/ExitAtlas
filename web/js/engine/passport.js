// Road Trip Passport: states driven and achievements, from real GPS trips only (the trip history).
// Port target: Tracking/Passport.swift.
import { METERS_PER_MILE as MILE } from './geo.js';

const LOWER_48 = ['AL', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
  'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
  'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY'];
const ATLANTIC = new Set(['ME', 'NH', 'MA', 'RI', 'CT', 'NY', 'NJ', 'DE', 'MD', 'VA', 'NC', 'SC', 'GA', 'FL']);
const PACIFIC = new Set(['CA', 'OR', 'WA']);

/// The 50 states and DC, for the passport grid.
export const STATE_CODES = [...LOWER_48, 'AK', 'HI', 'DC'].sort();

/// trips: [{title, startedAt (epoch s), states:[{code, name, meters}], totalMeters}].
/// Returns {states: Map code -> {code, name, meters, trips, firstAt, lastAt}, totalMeters, tripCount, achievements}.
export function passport(trips) {
  const states = new Map();
  let total = 0;
  for (const t of trips) {
    total += t.totalMeters ?? 0;
    for (const s of t.states ?? []) {
      if (!s.code || !(s.meters > 0)) continue;
      const e = states.get(s.code) ?? { code: s.code, name: s.name, meters: 0, trips: 0, firstAt: t.startedAt, lastAt: t.startedAt };
      e.meters += s.meters;
      e.trips += 1;
      e.firstAt = Math.min(e.firstAt, t.startedAt);
      e.lastAt = Math.max(e.lastAt, t.startedAt);
      states.set(s.code, e);
    }
  }
  const codes = [...states.keys()];
  const longest = trips.reduce((m, t) => Math.max(m, t.totalMeters ?? 0), 0);
  const most = trips.reduce((m, t) => Math.max(m, (t.states ?? []).filter((s) => s.code && s.meters > 0).length), 0);
  const tier = (id, title, have, need, unit) => ({
    id, title, detail: `${Math.min(have, need).toLocaleString('en-US')} of ${need.toLocaleString('en-US')} ${unit}`,
    earned: have >= need, progress: Math.min(1, need > 0 ? have / need : 0),
  });
  const miles = Math.floor(total / MILE);
  const achievements = [
    tier('first-trip', 'First trip', trips.length, 1, 'trip'),
    tier('states-5', 'Five states', codes.length, 5, 'states'),
    tier('states-10', 'Ten states', codes.length, 10, 'states'),
    tier('states-25', 'Half the country', codes.length, 25, 'states'),
    tier('lower-48', 'All lower 48', codes.filter((c) => LOWER_48.includes(c)).length, 48, 'states'),
    tier('miles-1000', '1,000 miles', miles, 1000, 'miles'),
    tier('miles-10000', '10,000 miles', miles, 10000, 'miles'),
    tier('long-haul', 'Long haul: 500 miles in one trip', Math.floor(longest / MILE), 500, 'miles'),
    tier('border-hopper', 'Border hopper: 5 states in one trip', most, 5, 'states'),
    {
      id: 'coast-to-coast', title: 'Coast to coast', detail: 'An Atlantic state and a Pacific state',
      earned: codes.some((c) => ATLANTIC.has(c)) && codes.some((c) => PACIFIC.has(c)),
      progress: (codes.some((c) => ATLANTIC.has(c)) ? 0.5 : 0) + (codes.some((c) => PACIFIC.has(c)) ? 0.5 : 0),
    },
  ];
  return { states, totalMeters: total, tripCount: trips.length, achievements };
}
