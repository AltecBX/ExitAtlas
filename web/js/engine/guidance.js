// The next maneuver along the route, from the routing provider's own steps, for the Drive guidance banner.
// OSRM steps carry "type modifier" ("fork slight right", "off ramp right", "merge slight left", "arrive");
// MapKit steps carry Apple's own sentence, which is shown as given. Steps that only rename the road or say
// to continue are skipped, and so is a merge back onto the road already driven. Same rules as
// Sources/ExitAtlasCore/Route/Guidance.swift, tested on Tests/ExitAtlasCoreTests/Fixtures/guidance.
import { highwayLabel, signedDirection } from './route.js';

// Longest first, so "off ramp" is not read as a word "off".
const TYPES = ['exit roundabout', 'exit rotary', 'roundabout turn', 'end of road', 'notification', 'off ramp', 'on ramp',
  'new name', 'use lane', 'roundabout', 'continue', 'rotary', 'depart', 'arrive', 'merge', 'turn', 'fork'];
const SKIP = new Set(['depart', 'new name', 'continue', 'notification', 'use lane']);
const MODIFIERS = new Set(['', 'uturn', 'sharp right', 'right', 'slight right', 'straight', 'slight left', 'left', 'sharp left']);
/// How far past a ramp or fork to look for the road it leads to.
const LEADS_TO = 5000;
/// A bundled exit this close to an off ramp is the exit taken there.
const EXIT_MATCH = 600;

/// {type, modifier} for an OSRM style instruction ("fork slight right"), null for a sentence (MapKit's
/// "Turn right onto Main St" starts like one, so the modifier must be one of OSRM's).
export function parseInstruction(text) {
  const t = (text ?? '').trim().toLowerCase();
  for (const type of TYPES) {
    if (t !== type && !t.startsWith(`${type} `)) continue;
    const modifier = t.slice(type.length).trim();
    return MODIFIERS.has(modifier) ? { type, modifier } : null;
  }
  return null;
}

function sideOf(text) {
  if (/\buturn\b|u-turn/.test(text)) return 'uturn';
  if (/\bleft\b/.test(text)) return 'left';
  if (/\bright\b/.test(text)) return 'right';
  return 'straight';
}

const sameRef = (a, b) => Boolean(a && b && a.kind === b.kind && a.prefix === b.prefix && a.number === b.number);

/// "I-295 N" for a highway at a distance along the route. Named roads (turnpikes, parkways) are signed by
/// their own directions, which the shape of the route does not tell reliably, so they get none.
function roadLabel(route, ref, at) {
  if (ref.kind === 'named') return ref.number.replace(/^NJTP\s+/, '');
  return `${highwayLabel(ref)} ${signedDirection(ref, route.polyline, at)}`;
}

/// The highway driven just before step i (the last step before it that names one).
function previousRef(steps, i) {
  for (let j = i - 1; j >= 0; j--) if (steps[j].highways?.length) return steps[j].highways[0];
  return null;
}

/// The highway step i leads to: its own, else the first named one within LEADS_TO after it.
function leadsTo(steps, i) {
  const start = steps[i].startDistance;
  for (let j = i; j < steps.length && steps[j].startDistance - start <= LEADS_TO; j++) {
    if (steps[j].highways?.length) return { ref: steps[j].highways[0], at: steps[j].startDistance };
    if (j > i && parseInstruction(steps[j].instruction)?.type === 'arrive') break;
  }
  return null;
}

/// The next maneuver after `progress` (meters along the route), or null when none comes within `within` meters:
/// {at, distance, kind ('fork' | 'exit' | 'ramp' | 'merge' | 'turn' | 'roundabout' | 'arrive' | 'other'), side
/// ('left' | 'right' | 'straight' | 'uturn'), road ('I-295 N' or a street name, or null), exitLabel, text}.
/// exits: the plan's exits [{distanceAlongRoute, label}] to name the exit at an off ramp.
export function nextManeuver(route, progress, { within = Infinity, destinationName = null, exits = [] } = {}) {
  const steps = route?.steps ?? [];
  for (let i = 0; i < steps.length; i++) {
    const st = steps[i];
    if (st.startDistance <= progress) continue;
    const at = st.startDistance, distance = at - progress;
    if (distance > within) return null;
    const parsed = parseInstruction(st.instruction);
    if (!parsed) {
      const text = (st.instruction ?? '').trim();
      if (!text) continue;
      return { at, distance, kind: 'other', side: sideOf(text.toLowerCase()), road: null, exitLabel: null, text };
    }
    const { type, modifier } = parsed;
    if (SKIP.has(type)) continue;
    const side = sideOf(modifier);
    const before = previousRef(steps, i);
    const target = leadsTo(steps, i);
    const road = target ? roadLabel(route, target.ref, target.at + 1) : null;
    const staying = target && sameRef(target.ref, before);
    const street = (st.roadName ?? '').trim() || null;
    let kind, text, exitLabel = null, roadOut = road;
    switch (type) {
      case 'fork': {
        kind = 'fork';
        const keep = side === 'left' ? 'Keep left' : side === 'right' ? 'Keep right' : 'Continue straight';
        text = road ? `${keep} ${staying ? 'to stay on' : 'onto'} ${road}` : keep;
        break;
      }
      case 'off ramp': {
        kind = 'exit';
        const exit = exits.reduce((best, e) => {
          const d = Math.abs(e.distanceAlongRoute - at);
          return d <= EXIT_MATCH && (!best || d < best.d) ? { e, d } : best;
        }, null)?.e;
        exitLabel = exit?.label ?? null;
        const what = exitLabel ? `Take Exit ${exitLabel}` : `Take the exit on the ${side === 'left' ? 'left' : 'right'}`;
        text = road && !staying ? `${what} toward ${road}` : what;
        break;
      }
      case 'on ramp':
        kind = 'ramp';
        text = road ? `Take the ramp onto ${road}` : 'Take the ramp';
        break;
      case 'merge':
        if (!target || staying) continue;
        kind = 'merge';
        text = `Merge onto ${road}`;
        break;
      case 'turn':
      case 'end of road': {
        kind = 'turn';
        const turn = side === 'uturn' ? 'Make a U-turn' : side === 'straight' ? 'Continue straight' : `Turn ${side}`;
        const onto = target && target.at === at ? road : street;
        text = `${type === 'end of road' ? 'At the end of the road, ' + turn.toLowerCase() : turn}${onto ? ` onto ${onto}` : ''}`;
        roadOut = onto;
        break;
      }
      case 'roundabout':
      case 'rotary':
      case 'roundabout turn':
        kind = 'roundabout';
        text = 'Enter the roundabout';
        roadOut = null;
        break;
      case 'exit roundabout':
      case 'exit rotary':
        kind = 'roundabout';
        text = `Exit the roundabout${street ? ` onto ${street}` : ''}`;
        roadOut = street;
        break;
      case 'arrive':
        kind = 'arrive';
        text = `Arrive at ${destinationName ?? 'your destination'}${side === 'left' || side === 'right' ? `, on the ${side}` : ''}`;
        break;
      default:
        continue;
    }
    return { at, distance, kind, side, road: roadOut, exitLabel, text };
  }
  return null;
}
