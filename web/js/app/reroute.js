// Pacing for automatic reroutes, so a driver who keeps leaving each new route does not send a request to the
// routing server (OSRM demo server, light use only) every few seconds.

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
