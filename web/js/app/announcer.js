// Voice announcements for state lines, time zones, rest areas, gas gaps and exits, at most one
// message per snapshot.
//
// Announcements are keyed by things that survive a reroute: the state code and the odometer (driven
// total) where the state line is expected. Segment indexes restart at 0 on every new plan, so keying
// by index silently dropped the "Welcome to" and state line messages after a reroute.
import { METERS_PER_MILE as MILE } from '../engine/geo.js';
import { exitTitle } from '../engine/exits.js';
import { KIND_TITLES, restAreaTitle } from '../engine/restareas.js';
import { spokenMiles } from './format.js';
import { ALERT_KINDS } from '../engine/roadintel.js';

const BORDER_WARN = 5 * MILE;
const BORDER_MIN = 0.5 * MILE;
/// A state line warning counts as already given when one was given for the same state with an
/// expected crossing within this many meters on the odometer (route changes move it a little).
const SAME_BORDER = 3 * MILE;
const REST_WARN = 2.5 * MILE;
const REST_MIN = 0.4 * MILE;
const GAP_WARN = 6 * MILE;
/// Road alerts: serious ones (closures, major crashes, severe weather) are spoken from this far,
/// others from ALERT_WARN; never within ALERT_MIN, where it is too late to act on them.
const ALERT_SERIOUS_WARN = 10 * MILE;
const ALERT_WARN = 2 * MILE;
const ALERT_MIN = 0.3 * MILE;
/// An alert already spoken is not spoken again when a later answer gives the same event a new id (an NWS
/// update, or the duplicate from another feed kept this time): same kind within this distance on the odometer.
const SAME_ALERT = 1 * MILE;

/// "Central Time" for a zone ID, from the browser's own zone names.
export function zoneName(zoneID, at = new Date()) {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: zoneID, timeZoneName: 'long' })
      .formatToParts(at).find((p) => p.type === 'timeZoneName')?.value ?? '';
    return part.replace(/ (Standard|Daylight)/, '') || zoneID;
  } catch { return zoneID; }
}

/// Minutes the zone is ahead of UTC at a moment.
export function zoneOffsetMinutes(zoneID, at = new Date()) {
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: zoneID, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
    }).formatToParts(at).map((p) => [p.type, p.value]));
    const local = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
    return Math.round((local - Math.floor(at.getTime() / 60000) * 60000) / 60000);
  } catch { return null; }
}

/// "Clocks go back one hour." for a move from one zone to another, or "" when the offset is the same.
export function clockChange(fromID, toID, at = new Date()) {
  const a = zoneOffsetMinutes(fromID, at), b = zoneOffsetMinutes(toID, at);
  if (a === null || b === null || a === b) return '';
  const hours = Math.abs(b - a) / 60;
  const amount = hours === 1 ? 'one hour' : hours === 2 ? 'two hours' : `${hours} hours`;
  return `Clocks go ${b > a ? 'forward' : 'back'} ${amount}.`;
}

/// Spoken amenity list for a rest area: verified ones only.
function spokenAmenities(r) {
  if (r.kind === 'plaza') {
    const has = [r.gas.length ? 'gas' : null, r.food.length ? 'food' : null, r.ev.length ? 'charging' : null].filter(Boolean);
    if (has.length) return has.join(has.length === 2 ? ' and ' : ', ');
  }
  const a = r.amenities;
  if (a.toilets === false) return 'no restrooms';
  const words = [a.toilets ? 'restrooms' : null, a.pets ? 'pet area' : null, a.vending ? 'vending' : null].filter(Boolean);
  return words.join(', ');
}

function browserSpeaker(text) {
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'en-US';
  u.rate = 1.0;
  window.speechSynthesis.speak(u);
}

function stateKey(segment) {
  return segment?.code ?? segment?.displayName ?? null;
}

export class Announcer {
  /// speaker: function(text); defaults to the browser's speech synthesis. cancel: stops queued speech.
  constructor(speaker = null, { cancel = null } = {}) {
    this.speaker = speaker;
    this.cancel = cancel ?? (() => { if (typeof window !== 'undefined') window.speechSynthesis?.cancel(); });
    this.reset();
  }

  /// The Settings switch. On: says so, which in Safari also lets the announcements that follow play (speech
  /// must first start from a tap). Off: stops anything still queued, so nothing more is said.
  voiceSwitched(on) {
    if (on) this.speak('Voice on.');
    else this.cancel();
  }

  reset() {
    this.announcedExits = new Set();
    this.announcedBorders = []; // {state, odometer}
    this.announcedRest = new Set();
    this.announcedGaps = new Set();
    this.announcedOpen = new Set();
    this.announcedAlerts = new Set();
    this.spokenAlerts = []; // {category, odometer}
    this.lastState = null;
    this.lastZone = null;
  }

  get supported() {
    return Boolean(this.speaker) || (typeof window !== 'undefined' && 'speechSynthesis' in window);
  }

  speak(text) {
    if (this.speaker) { this.speaker(text); return; }
    if (this.supported) browserSpeaker(text);
  }

  /// ctx: {zoneID, gasGap} from the app: the time zone at the driver, and the next stretch without
  /// gas ({length, before:{distance, exit?|restArea?}}) when one starts ahead.
  consider(s, settings, ctx = {}) {
    const state = stateKey(s.current?.segment);
    const zone = ctx.zoneID ?? null;
    if (!settings.voice || s.match.status !== 'onRoute') {
      if (state !== null) this.lastState = state;
      if (zone !== null) this.lastZone = zone;
      return;
    }
    // Road alerts first: once each. A state line message waits for the next position, it is not lost.
    if (settings.alerts?.voice !== false) {
      for (const a of ctx.alerts ?? []) {
        if (a.notable === false) continue;
        const ahead = a.start - s.progress;
        if (ahead <= ALERT_MIN || ahead > (a.serious ? ALERT_SERIOUS_WARN : ALERT_WARN) || this.announcedAlerts.has(a.incident.id)) continue;
        this.announcedAlerts.add(a.incident.id);
        const odometer = (s.drivenTotal ?? s.progress) + ahead;
        if (this.spokenAlerts.some((x) => x.category === a.incident.category && Math.abs(x.odometer - odometer) <= SAME_ALERT)) continue;
        this.spokenAlerts.push({ category: a.incident.category, odometer });
        this.speak(alertWords(a, ahead));
        return;
      }
    }
    if (settings.announceStateLines && s.current) {
      const cur = s.current;
      if (this.lastState !== null && state !== null && state !== this.lastState) {
        this.lastState = state;
        let text = `Welcome to ${cur.segment.displayName}.`;
        if (s.next) text += ` ${spokenMiles(cur.remainingMeters)} of your route are in ${cur.segment.displayName}.`;
        this.speak(text);
        return;
      }
      if (state !== null) this.lastState = state;
      const toBorder = s.distanceToNextBorder;
      if (s.next && toBorder !== null && toBorder <= BORDER_WARN && toBorder > BORDER_MIN) {
        const next = stateKey(s.next.segment);
        const odometer = s.drivenTotal + toBorder;
        const given = this.announcedBorders.some((b) => b.state === next && Math.abs(b.odometer - odometer) <= SAME_BORDER);
        if (!given) {
          this.announcedBorders.push({ state: next, odometer });
          const n = cur.exitsRemaining;
          this.speak(`${s.next.segment.displayName} state line in ${spokenMiles(toBorder)}. ${n} ${n === 1 ? 'exit remains' : 'exits remain'} in ${cur.segment.displayName}.`);
          return;
        }
      }
    }
    // After the state line messages, so a state line that also changes the clock says both, in order.
    if (zone !== null && this.lastZone !== null && zone !== this.lastZone && settings.announceTimeZones !== false) {
      const change = clockChange(this.lastZone, zone, new Date(s.t * 1000));
      this.lastZone = zone;
      if (change) {
        this.speak(`Now on ${zoneName(zone, new Date(s.t * 1000))}. ${change}`);
        return;
      }
    }
    if (zone !== null) this.lastZone = zone;
    const gap = ctx.gasGap;
    if (settings.announceGasGaps !== false && gap?.before) {
      const ahead = gap.before.distance - s.progress;
      const key = gap.before.exit?.id ?? gap.before.restArea?.id;
      if (ahead > 0 && ahead <= GAP_WARN && key && !this.announcedGaps.has(key)) {
        this.announcedGaps.add(key);
        const where = gap.before.exit ? exitTitle(gap.before.exit) : restAreaTitle(gap.before.restArea);
        this.speak(`Last gas for ${spokenMiles(gap.length)} is ${where}, in ${spokenMiles(ahead)}.`);
        return;
      }
    }
    // Overnight: the last stop listed open before a long stretch, once per stop. Not when it is the same
    // exit as the last gas just announced.
    const lo = ctx.lastOpen;
    // Not when "listed open" rests on Google Maps hours: its terms forbid text to speech of its content.
    const fromGoogle = lo && (lo.evaluation?.hours.status === 'verified' || /google/i.test(lo.evaluation?.hours.source ?? ''));
    if (settings.announceGasGaps !== false && lo && !fromGoogle && lo.stop.ahead > 0 && lo.stop.ahead <= GAP_WARN && !this.announcedOpen.has(lo.stop.id)
        && !(lo.stop.exitId && gap?.before?.exit?.id === lo.stop.exitId)) {
      this.announcedOpen.add(lo.stop.id);
      const where = lo.stop.exit ? `${lo.stop.name} at ${exitTitle(lo.stop.exit)}` : lo.stop.name;
      this.speak(`Overnight, ${where} in ${spokenMiles(lo.stop.ahead)} is the last stop listed open for ${lo.openEnded ? 'at least ' : ''}${spokenMiles(lo.length)}.`);
      return;
    }
    const nr = s.nextRestArea;
    if (settings.announceRestAreas !== false && nr && nr.distance <= REST_WARN && nr.distance > REST_MIN
        && !this.announcedRest.has(nr.restArea.id)) {
      this.announcedRest.add(nr.restArea.id);
      const r = nr.restArea;
      const what = KIND_TITLES[r.kind] ?? 'Rest area';
      const extra = spokenAmenities(r);
      this.speak(`${what} in ${spokenMiles(nr.distance)}${r.side === 'both' ? ', serving both directions' : ''}${extra ? `. ${extra[0].toUpperCase()}${extra.slice(1)}` : ''}.`);
      return;
    }
    const ne = s.nextExit;
    if (settings.announceExits && ne && ne.distance <= MILE && !this.announcedExits.has(ne.exit.id)) {
      this.announcedExits.add(ne.exit.id);
      let text = `${exitTitle(ne.exit)} in ${spokenMiles(ne.distance)}`;
      if (ne.exit.name) text += `, ${ne.exit.name}`;
      this.speak(`${text}.`);
    }
  }
}

/// "Crash ahead, in 8 miles. 2 right lanes blocked." Weather says the warning's name; driver reports say so.
export function alertWords(a, ahead) {
  const i = a.incident;
  const label = i.category === 'weather' || i.category === 'flooding' ? `${i.description} on your route` : `${ALERT_KINDS[i.category].label} ahead`;
  let text = `${label}, in ${spokenMiles(ahead)}.`;
  if (i.lanes) text += ` ${i.lanes}.`;
  if (i.verification === 'community') text += ' Reported by drivers, not confirmed.';
  if (i.verification === 'simulated') text += ' Simulated test alert.';
  return text;
}
