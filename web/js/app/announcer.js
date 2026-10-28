// Voice announcements for state lines and exits, at most one message per snapshot.
//
// Announcements are keyed by things that survive a reroute: the state code and the odometer (driven
// total) where the state line is expected. Segment indexes restart at 0 on every new plan, so keying
// by index silently dropped the "Welcome to" and state line messages after a reroute.
import { METERS_PER_MILE as MILE } from '../engine/geo.js';
import { exitTitle } from '../engine/exits.js';
import { spokenMiles } from './format.js';

const BORDER_WARN = 5 * MILE;
const BORDER_MIN = 0.5 * MILE;
/// A state line warning counts as already given when one was given for the same state with an
/// expected crossing within this many meters on the odometer (route changes move it a little).
const SAME_BORDER = 3 * MILE;

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
  /// speaker: function(text); defaults to the browser's speech synthesis.
  constructor(speaker = null) {
    this.speaker = speaker;
    this.reset();
  }

  reset() {
    this.announcedExits = new Set();
    this.announcedBorders = []; // {state, odometer}
    this.lastState = null;
  }

  get supported() {
    return Boolean(this.speaker) || (typeof window !== 'undefined' && 'speechSynthesis' in window);
  }

  speak(text) {
    if (this.speaker) { this.speaker(text); return; }
    if (this.supported) browserSpeaker(text);
  }

  consider(s, settings) {
    const state = stateKey(s.current?.segment);
    if (!settings.voice || s.match.status !== 'onRoute') {
      if (state !== null) this.lastState = state;
      return;
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
    const ne = s.nextExit;
    if (settings.announceExits && ne && ne.distance <= MILE && !this.announcedExits.has(ne.exit.id)) {
      this.announcedExits.add(ne.exit.id);
      let text = `${exitTitle(ne.exit)} in ${spokenMiles(ne.distance)}`;
      if (ne.exit.name) text += `, ${ne.exit.name}`;
      this.speak(`${text}.`);
    }
  }
}
