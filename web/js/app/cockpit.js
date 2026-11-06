// The cockpit: full screen live gauges for the 911 Turbo S (engine/cockpit.js has the rules and the gauges). It
// draws once per layout change and then only moves needles and numbers: needles ease toward the latest reading at
// the display's frame rate; readings are taken 10 times a second from the car connection (app/carlink.js) or, during
// playback, from the recording. A gauge without data shows why, never a number.
import { GAUGES, MODES, SWEEP, channelGauge, inputsOf, readGauge, needleAngle, zoneOf, gaugeDigits, updatePeaks, warmup, linkQuality, buildPlan } from '../engine/cockpit.js';
import { toUS } from '../engine/obdpids.js';
import { playbackAt } from '../engine/obdlive.js';
import { escapeHTML as h } from './format.js';

const STATUS_TEXT = { live: 'LIVE', stale: 'STALE', waiting: 'WAITING', unsupported: 'NOT ON THIS CAR', noAnswer: 'NO ANSWER',
  notProbed: 'PORSCHE DATA OFF', shared: 'NEEDS MODULE ADDRESS', playback: 'PLAYBACK' };
/// Short forms for small gauges (the full text is the chip's title).
const STATUS_SHORT = { waiting: 'WAIT', unsupported: 'N/A', noAnswer: 'NO ANS', notProbed: 'OFF', shared: 'N/A', playback: 'PLAY' };
export const THEMES = Object.freeze({ classic: 'Classic', chrono: 'Chrono', night: 'Night' });
const SIZES = ['S', 'M', 'L'];
const SPAN = { L: [2, 4], M: [1, 2], S: [1, 1] };   // columns, half rows

/// The cockpit's settings, kept per vehicle on this device.
export function cockpitDefaults() {
  return { mode: 'drive', theme: 'classic', redline: 7000, redlineSet: false, warmupF: 176, porsche: false, custom: [] };
}

const pt = (a, r) => { const t = (a * Math.PI) / 180; return [100 + r * Math.sin(t), 100 - r * Math.cos(t)]; };
const arc = (a0, a1, r) => { const [x0, y0] = pt(a0, r); const [x1, y1] = pt(a1, r); return `M${x0.toFixed(2)},${y0.toFixed(2)}A${r},${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)},${y1.toFixed(2)}`; };
const fmt = (v, d) => (Math.abs(v) >= 1000 && d === 0 ? Math.round(v).toLocaleString() : v.toFixed(d));

/// The dial face (static): track, zones, redline, ticks and numbers. Medium dials label every other mark when
/// there are many, and skip the minor ticks.
function dialFace(g, redline, size) {
  const { min, max } = g;
  const step = g.step ?? (max - min) / 6;
  const ang = (v) => needleAngle(v, min, max);
  const end = SWEEP / 2;
  let s = `<path class="ck-track" d="${arc(-end, end, 84)}"/>`;
  for (const [a, b, kind] of g.zones ?? []) s += `<path class="ck-zone ${kind}" d="${arc(ang(Math.max(a, min)), ang(Math.min(b, max)), 84)}"/>`;
  if (g.redline && redline != null && redline < max) s += `<path class="ck-zone red" d="${arc(ang(redline), end, 84)}"/>`;
  const n = Math.round((max - min) / step);
  const every = (g.labelEvery ?? 1) * (size !== 'L' && n > 6 ? 2 : 1);
  const minors = size === 'L' ? 5 : 1;
  for (let i = 0; i <= n * minors; i++) {
    const v = min + (i * step) / minors;
    if (v > max + 1e-9) break;
    const a = ang(v);
    const major = i % minors === 0;
    const k = i / minors;
    const labeled = major && k % every === 0;
    const [x0, y0] = pt(a, labeled ? 69 : major ? 73 : 76);
    const [x1, y1] = pt(a, 80);
    const hot = g.redline && redline != null && v >= redline;
    s += `<line class="ck-tick${major ? ' major' : ''}${hot ? ' hot' : ''}" x1="${x0.toFixed(2)}" y1="${y0.toFixed(2)}" x2="${x1.toFixed(2)}" y2="${y1.toFixed(2)}"/>`;
    if (labeled) {
      const [tx, ty] = pt(a, 56);
      const label = g.scale ? v / g.scale : v;
      s += `<text class="ck-num${hot ? ' hot' : ''}${size !== 'L' ? ' sm' : ''}" x="${tx.toFixed(1)}" y="${(ty + 4.5).toFixed(1)}">${Number(label.toFixed(2))}</text>`;
    }
  }
  return s;
}

/// One gauge's markup. Dynamic parts carry data-r (needle, value, status) for tick() to update.
function gaugeHTML(id, g, size, settings, editing) {
  const exp = g.porsche || g.src?.startsWith('22');
  const compact = g.kind === 'bar' || size === 'S';
  const tags = `${g.calculated ? '<span class="ck-tag calc" title="Calculated: ' + h(g.calculated) + '">CALC</span>' : ''}${exp ? `<span class="ck-tag exp" title="Experimental: Porsche data from community research">${compact ? 'EXP' : 'EXPERIMENTAL'}</span>` : ''}`;
  const edit = editing ? `<div class="ck-edit"><button data-act="ck-move" data-arg="${h(id)}:-1" aria-label="Move left">◀</button><button data-act="ck-size" data-arg="${h(id)}">${size}</button><button data-act="ck-move" data-arg="${h(id)}:1" aria-label="Move right">▶</button><button data-act="ck-remove" data-arg="${h(id)}" aria-label="Remove">✕</button></div>` : '';
  const span = `style="grid-column:span ${SPAN[size][0]};grid-row:span ${SPAN[size][1]}"`;
  const status = '<span class="ck-status" data-r="status">WAITING</span>';
  if (g.kind === 'bar' || size === 'S') {
    // Compact: name and state, the number, a meter with its zones.
    const meter = `<div class="ck-meter"><div class="ck-meter-fill" data-r="fill"></div>${(g.zones ?? []).map(([a, b, k]) => `<div class="ck-meter-zone ${k}" style="left:${(((Math.max(a, g.min) - g.min) / (g.max - g.min)) * 100).toFixed(1)}%;width:${(((Math.min(b, g.max) - Math.max(a, g.min)) / (g.max - g.min)) * 100).toFixed(1)}%"></div>`).join('')}</div>`;
    return `<div class="ck-gauge ck-compact size-${size} kind-${g.kind}" data-gauge="${h(id)}" ${span}>
      <div class="ck-srow"><span class="ck-label">${h(g.label)}</span></div>
      <div class="ck-srow ck-read"><span class="ck-val" data-r="value">–</span><span class="ck-unit">${h(g.unit)}</span>${g.dual && GAUGES[g.dual] ? `<span class="ck-target">target <span data-r="target">–</span></span>` : ''}<span class="ck-chips">${tags}${status}</span></div>${meter}${edit}</div>`;
  }
  if (g.kind === 'digit') {
    return `<div class="ck-gauge size-${size} kind-digit" data-gauge="${h(id)}" ${span}><div class="ck-label">${h(g.label)}</div>
      <div class="ck-digit"><span data-r="value">–</span></div><div class="ck-foot">${status}${tags}</div>${edit}</div>`;
  }
  const rest = `rotate(${-SWEEP / 2} 100 100)`;
  const dual = g.dual && GAUGES[g.dual];
  return `<div class="ck-gauge size-${size} kind-dial" data-gauge="${h(id)}" ${span}>
    <svg class="ck-dial" viewBox="0 0 200 200" aria-label="${h(g.label)}">${dialFace(g, settings.redline, size)}
      <text class="ck-dlabel" x="100" y="${size === 'L' ? 70 : 126}">${h(g.label)}</text>
      ${dual ? `<g class="ck-needle2" data-r="needle2" transform="${rest}"><path d="M98.8,100 L100,28 L101.2,100Z"/></g>` : ''}
      <g class="ck-needle" data-r="needle" transform="${rest}"><path d="M96.6,104 L99.1,21 L100.9,21 L103.4,104Z"/></g><circle class="ck-hub" cx="100" cy="100" r="7"/>
      <text class="ck-dval" x="100" y="${dual ? 147 : size === 'L' ? 150 : 154}" data-r="value">–</text>
      <text class="ck-dunit" x="100" y="${dual ? 160 : size === 'L' ? 166 : 169}">${h(g.unit)}</text>
      ${dual ? `<text class="ck-dtarget" x="100" y="172">target <tspan data-r="target">–</tspan></text>` : ''}</svg>
    <div class="ck-foot">${status}${tags}</div>${edit}</div>`;
}

export class Cockpit {
  constructor(app, { saveSettings }) {
    this.app = app;
    this.saveSettings = saveSettings;
    this.open = false;
    this.editing = false;
    this.panel = null;          // 'settings' | 'add' | null
    this.peaks = {};
    this.state = new Map();     // gauge id -> { shown, target, shown2, target2, refs }
    this.lastRead = 0;
  }

  get settings() { return this.app.cockpitSettings; }

  /// The gauges of the current mode: [id, gauge, size].
  gauges() {
    const s = this.settings;
    const list = s.mode === 'custom' ? s.custom : MODES[s.mode].gauges.map(([id, size]) => ({ id, size }));
    return list.map(({ id, size }) => {
      if (GAUGES[id]) return [id, GAUGES[id], size];
      const v = this.app.car.live.values.get(id);
      const ch = v?.channel ?? this.findChannel(id);
      return ch ? [id, channelGauge(ch, v), size] : null;
    }).filter(Boolean);
  }

  /// A channel by key among those the car offers (for a Custom gauge before its first reading).
  findChannel(key) {
    return this.app.carChannels?.().find((c) => c.key === key) ?? null;
  }

  show() {
    this.open = true;
    this.peaks = {};
    const el = document.getElementById('cockpit');
    el.hidden = false;
    document.documentElement.classList.add('cockpit-open');
    this.render();
    this.applyPlan();
    if (this.app.car.state === 'connected' && !this.app.car.live.on) this.app.car.startLive();
    this.app.wake?.request?.();
    const loop = (ts) => { if (!this.open) return; this.tick(ts); this.raf = requestAnimationFrame(loop); };
    this.raf = requestAnimationFrame(loop);
    this.onResize = () => this.layout();
    window.addEventListener('resize', this.onResize);
  }

  hide() {
    this.open = false;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.onResize);
    document.getElementById('cockpit').hidden = true;
    document.documentElement.classList.remove('cockpit-open');
    this.app.car.setPlan(null);
    if (!this.app.car.watching) this.app.car.stopLive();
    this.editing = false; this.panel = null;
  }

  /// Tells the scanner what to read for the gauges on screen.
  applyPlan() {
    const car = this.app.car;
    const gauges = this.gauges().map(([, g]) => g);
    if (this.panel === 'add' || (this.settings.mode === 'custom' && !gauges.length)) { car.setPlan(null); return; }
    car.setPlan(buildPlan(gauges, { supported: car.supported, porsche: this.settings.porsche, porscheResults: car.enhanced.results, porscheReqs: this.app.porscheReqs }));
  }

  render() {
    const el = document.getElementById('cockpit');
    if (!el) return;
    const s = this.settings;
    el.className = `cockpit theme-${s.theme}`;
    el.dataset.mode = s.mode;
    const modes = Object.entries(MODES).map(([k, m]) => `<button class="${s.mode === k ? 'on' : ''}" data-act="ck-mode" data-arg="${k}">${h(m.name)}</button>`).join('');
    const gauges = this.gauges();
    const grid = gauges.map(([id, g, size]) => gaugeHTML(id, g, size, s, this.editing)).join('')
      + (s.mode === 'custom' ? `<button class="ck-gauge ck-add size-M" data-act="ck-add" style="grid-column:span 1;grid-row:span 2">＋<span>Add gauge</span></button>` : '');
    el.innerHTML = `<header class="ck-bar">
        <button class="ck-btn" data-act="ck-close" aria-label="Close cockpit">✕</button>
        <nav class="ck-modes">${modes}</nav>
        <div class="ck-link" data-r="link"><i></i><span>–</span></div>
        <button class="ck-btn ck-rec${this.app.car.rec ? ' on' : ''}" data-act="ck-rec" data-testid="ck-rec">${this.app.car.rec ? '■ REC' : '● REC'}</button>
        ${s.mode === 'custom' ? `<button class="ck-btn${this.editing ? ' on' : ''}" data-act="ck-edit">${this.editing ? 'Done' : 'Edit'}</button>` : ''}
        <button class="ck-btn" data-act="ck-panel" data-arg="settings" aria-label="Cockpit settings">⋯</button>
      </header>
      <div class="ck-banner" data-r="banner" hidden></div>
      <main class="ck-grid" data-r="grid">${grid || '<p class="ck-empty">Tap Edit, then ＋, to add gauges from every sensor your car reports.</p>'}</main>
      <footer class="ck-peaks" data-r="peaks"></footer>
      ${this.panel ? this.panelHTML() : ''}`;
    this.state.clear();
    for (const gEl of el.querySelectorAll('[data-gauge]')) {
      const refs = {};
      for (const r of gEl.querySelectorAll('[data-r]')) refs[r.dataset.r] = r;
      this.state.set(gEl.dataset.gauge, { shown: null, target: null, shown2: null, target2: null, refs, el: gEl });
    }
    this.refs = {};
    for (const r of el.querySelectorAll(':scope > [data-r], header [data-r]')) this.refs[r.dataset.r] = r;
    this.layout();
    this.lastRead = 0;
  }

  /// Fits the gauges into the screen: for each column count, the largest cell that still fits once the browser has
  /// laid the grid out (large gauges 2 x 2 cells, medium 1 x 1, small 1 x half); the biggest wins.
  layout() {
    const grid = this.refs?.grid;
    if (!grid || !grid.children.length) return;
    const w = grid.clientWidth;
    const hgt = grid.clientHeight;
    const fits = (cols, u) => {
      grid.style.setProperty('--cols', cols);
      grid.style.setProperty('--u', `${u}px`);
      return grid.scrollHeight <= hgt + 1 && grid.scrollWidth <= w + 1;
    };
    let best = { u: 0, cols: 2 };
    for (let cols = 2; cols <= 8; cols++) {
      let lo = 60;
      let hi = Math.floor((w - 20 - (cols - 1) * 8) / cols);
      if (hi <= best.u || !fits(cols, lo)) continue;
      while (hi - lo > 2) { const mid = (lo + hi) >> 1; if (fits(cols, mid)) lo = mid; else hi = mid; }
      if (lo > best.u) best = { u: lo, cols };
    }
    if (!best.u) best = { u: 90, cols: Math.max(2, Math.floor(w / 100)) };
    grid.style.setProperty('--cols', best.cols);
    grid.style.setProperty('--u', `${best.u}px`);
  }

  panelHTML() {
    const s = this.settings;
    if (this.panel === 'add') {
      const named = Object.entries(GAUGES).filter(([id]) => !/Target$/.test(id)).map(([id, g]) => `<button data-act="ck-add-gauge" data-arg="${h(id)}">${h(g.label)}${g.calculated ? ' <small>calc</small>' : ''}${g.porsche ? ' <small>exp</small>' : ''}</button>`).join('');
      const chans = (this.app.carChannels?.() ?? []).filter((c) => !c.raw && !c.text).map((c) => {
        const v = this.app.car.live.values.get(c.key);
        const [val, unit] = v && typeof v.value === 'number' ? toUS(v.value, c.unit) : [null, toUS(1, c.unit)[1]];
        return `<button data-act="ck-add-gauge" data-arg="${h(c.key)}">${h(c.name)} <small>${val != null ? `${Number(val.toFixed(2))} ${h(unit)}` : h(unit)}${c.source?.startsWith('porsche') ? ' · exp' : ''}</small></button>`;
      }).join('');
      return `<div class="ck-panel"><div class="ck-panel-head"><b>Add a gauge</b><button class="ck-btn" data-act="ck-panel" data-arg="">Done</button></div>
        <div class="ck-sec">Cockpit gauges</div><div class="ck-pick">${named}</div>
        <div class="ck-sec">Every sensor your car reported (${(this.app.carChannels?.() ?? []).length})</div><div class="ck-pick">${chans || '<p>Connect the car to list its sensors.</p>'}</div></div>`;
    }
    const probe = this.app.car.probing;
    const results = this.app.car.enhanced.results;
    const okCount = [...results.values()].filter((x) => x === 'ok').length;
    return `<div class="ck-panel"><div class="ck-panel-head"><b>Cockpit settings</b><button class="ck-btn" data-act="ck-panel" data-arg="">Done</button></div>
      <div class="ck-sec">Theme</div><div class="ck-seg">${Object.entries(THEMES).map(([k, n]) => `<button class="${s.theme === k ? 'on' : ''}" data-act="ck-theme" data-arg="${k}">${n}</button>`).join('')}</div>
      <div class="ck-sec">Tachometer redline</div>
      <div class="ck-row"><input type="number" inputmode="numeric" min="3000" max="9900" step="100" value="${s.redline}" data-ck-input="redline" aria-label="Redline rpm"> rpm
        <small>${s.redlineSet ? 'Set by you.' : 'Default, not confirmed for your car: set it to where your tachometer turns red.'}</small></div>
      <div class="ck-sec">Engine warm up</div>
      <div class="ck-row">Cold below <input type="number" inputmode="numeric" min="100" max="250" step="1" value="${s.warmupF}" data-ck-input="warmupF" aria-label="Warm oil temperature"> °F oil
        <small>176 °F (80 °C) is a common rule of thumb; your owner's manual has Porsche's figure.</small></div>
      <div class="ck-sec">Porsche data (experimental)</div>
      <div class="ck-row"><button class="ck-btn${s.porsche ? ' on' : ''}" data-act="ck-porsche" data-testid="ck-porsche">${s.porsche ? '✓ On' : 'Off'}</button>
        <small>Manufacturer data (oil pressure, PDK temperature, knock, EGT) from community research (OBDb, CC BY-SA 4.0), not confirmed on a 2021 Turbo S. Read only.</small></div>
      <div class="ck-row"><button class="ck-btn" data-act="ck-probe" data-arg="cockpit"${probe ? ' disabled' : ''}>Probe cockpit sensors</button><button class="ck-btn" data-act="ck-probe" data-arg="all"${probe ? ' disabled' : ''}>Probe all ${this.app.porscheReqs?.size ?? 0}</button>
        <small>${probe ? `Probing ${probe.done} of ${probe.total}, ${probe.ok} answered…` : results.size ? `${okCount} of ${results.size} tried answered.` : 'Not probed yet.'}</small></div>
      <div class="ck-sec">Peaks</div><div class="ck-row"><button class="ck-btn" data-act="ck-peaks-reset">Reset peaks</button></div>
      <div class="ck-sec">Custom</div><div class="ck-row"><button class="ck-btn" data-act="ck-copy-mode">Copy ${h(MODES[s.mode].name)} to Custom</button></div></div>`;
  }

  /// The value source: live data, or the recording during playback.
  getter() {
    const pb = this.app.carUI.playback;
    if (pb) {
      return { now: pb.t, playback: true, get: (key) => { const sr = pb.series.get(key); const p = sr ? playbackAt(sr, pb.t) : null; return p ? { value: p.value, t: p.t, dt: null } : null; },
        unitOf: (key) => pb.rec.channels[key]?.unit };
    }
    const values = this.app.car.live.values;
    return { now: Date.now(), playback: false, get: (key) => values.get(key) ?? null, unitOf: (key) => values.get(key)?.channel?.unit };
  }

  /// Every frame: readings 10 times a second, needles eased toward them, numbers and states updated.
  tick(ts) {
    const dt = this.lastTs ? Math.min(100, ts - this.lastTs) : 16;
    this.lastTs = ts;
    if (ts - this.lastRead > 100) { this.lastRead = ts; this.read(); }
    const k = 1 - Math.exp(-dt / 110);
    for (const [id, st] of this.state) {
      const g = GAUGES[id] ?? st.g;
      if (!g || g.kind === 'digit') continue;
      if (st.target != null) {
        st.shown = st.shown == null ? st.target : st.shown + (st.target - st.shown) * k;
        if (st.refs.needle) st.refs.needle.setAttribute('transform', `rotate(${needleAngle(st.shown, g.min, g.max).toFixed(2)} 100 100)`);
        if (st.refs.fill) st.refs.fill.style.width = `${(Math.min(1, Math.max(0, (st.shown - g.min) / (g.max - g.min))) * 100).toFixed(1)}%`;
      } else if (st.shown != null) {
        st.shown = null;
        st.refs.needle?.setAttribute('transform', `rotate(${-SWEEP / 2} 100 100)`);
        if (st.refs.fill) st.refs.fill.style.width = '0%';
      }
      if (st.target2 != null && st.refs.needle2) {
        st.shown2 = st.shown2 == null ? st.target2 : st.shown2 + (st.target2 - st.shown2) * k;
        st.refs.needle2.setAttribute('transform', `rotate(${needleAngle(st.shown2, g.min, g.max).toFixed(2)} 100 100)`);
      }
    }
  }

  read() {
    const car = this.app.car;
    const src = this.getter();
    const ctx = { get: src.get, unitOf: src.unitOf, supported: src.playback ? null : car.supported, status: src.playback ? null : car.live.status,
      porscheResults: car.enhanced.results, porsche: src.playback || this.settings.porsche, now: src.now };
    const readings = {};
    for (const [id, g, size] of this.gauges()) {
      const st = this.state.get(id);
      if (!st) continue;
      st.g = g;
      const r = readGauge(g, ctx);
      const status = src.playback && r.status === 'live' ? 'playback' : r.status;
      readings[id] = r;
      st.target = r.value != null && (r.status === 'live' || r.status === 'stale') ? r.value : null;
      if (g.dual && GAUGES[g.dual]) {
        const t = readGauge(GAUGES[g.dual], ctx);
        st.target2 = t.value;
        if (st.refs.target) st.refs.target.textContent = t.value != null ? `${fmt(t.value, gaugeDigits(GAUGES[g.dual]))} ${GAUGES[g.dual].unit}` : STATUS_TEXT[t.status]?.toLowerCase() ?? '–';
      }
      const text = r.value == null ? '–' : g.text ? g.text(Math.round(r.value)) : fmt(r.value, gaugeDigits(g));
      if (st.refs.value && st.refs.value.textContent !== text) st.refs.value.textContent = text;
      const zone = zoneOf(r.value, [...(g.zones ?? []), ...this.alertZones(g)], g.redline ? this.settings.redline : null);
      st.el.dataset.zone = zone ?? '';
      st.el.dataset.status = status;
      const full = STATUS_TEXT[status] ?? status.toUpperCase();
      const label = st.el.classList.contains('ck-compact') ? STATUS_SHORT[status] ?? full : full;
      const age = r.status === 'stale' && r.age ? ` ${Math.round(r.age / 1000)} s` : '';
      if (st.refs.status && st.refs.status.textContent !== label + age) { st.refs.status.textContent = label + age; st.refs.status.title = full; }
      void size;
    }
    if (!src.playback) this.peaks = updatePeaks(this.peaks, { boost: readings.boost, rpm: readings.rpm, speed: readings.speed });
    this.readBars(car, src, readings);
  }

  /// The driver's own alert limits for a gauge's channel, as zones.
  alertZones(g) {
    const rule = !g.calc && this.app.car.prefs.alerts?.[g.src];
    if (!rule) return [];
    return [...(rule.high != null ? [[rule.high, Infinity, 'red']] : []), ...(rule.low != null ? [[-Infinity, rule.low, 'red']] : [])];
  }

  /// The link indicator, banner (playback, not connected, warm up, Porsche probe) and peaks.
  readBars(car, src, readings) {
    const live = car.live;
    const q = src.playback ? null : linkQuality({ latency: live.latency, requests: live.rate?.requests, timeouts: live.timeouts, answers: live.answers });
    const link = this.refs.link;
    if (link) {
      link.dataset.q = q ?? (car.state === 'connected' ? 'wait' : 'off');
      const t = src.playback ? 'Playback'
        : car.state !== 'connected' ? (car.state === 'disconnected' ? 'Reconnecting…' : 'Not connected')
          : live.rate ? `${live.rate.requests.toFixed(1)} req/s · ${Math.round(live.latency ?? 0)} ms · ${live.timeouts} dropped` : 'Starting…';
      if (link.lastChild.textContent !== t) link.lastChild.textContent = t;
    }
    const banner = this.refs.banner;
    const oil = readings.oilTemp ?? (car.live.values.get('015C') ? { value: toUS(car.live.values.get('015C').value, '°C')[0], status: 'live' } : null);
    const w = oil?.status === 'live' ? warmup(oil.value, this.settings.warmupF) : null;
    const msg = src.playback ? `Playback of a recording · ${Math.floor(src.now / 60000)}:${String(Math.floor(src.now / 1000) % 60).padStart(2, '0')}`
      : car.state !== 'connected' ? 'Not connected: gauges show no values until the car is connected (Settings, Car, Connect car).'
        : car.probing ? `Probing Porsche data: ${car.probing.done} of ${car.probing.total}, ${car.probing.ok} answered`
          : w?.cold ? `Engine warming up: oil ${Math.round(oil.value)} °F, ${Math.round(w.toGo)} °F below ${this.settings.warmupF} °F` : '';
    if (banner && banner.textContent !== msg) { banner.textContent = msg; banner.hidden = !msg; banner.dataset.kind = w?.cold && !src.playback && car.state === 'connected' ? 'cold' : ''; }
    const p = this.peaks;
    const peaks = this.refs.peaks;
    const txt = [p.boost && `Peak boost ${p.boost.value.toFixed(1)} psi`, p.rpm && `${Math.round(p.rpm.value).toLocaleString()} rpm`, p.speed && `${Math.round(p.speed.value)} mph`].filter(Boolean).join(' · ');
    if (peaks && peaks.textContent !== txt) peaks.textContent = txt;
  }
}

/// Custom layout edits (pure, so the order can be tested).
export function moveGauge(list, id, dir) {
  const i = list.findIndex((x) => x.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return list;
  const out = [...list];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}
export const nextSize = (size) => SIZES[(SIZES.indexOf(size) + 1) % SIZES.length];
export const gaugeInputs = inputsOf;
