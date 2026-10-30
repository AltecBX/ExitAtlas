// iPhone Safari behavior that needs no browser: the screen wake lock (one request at a time, let go when the
// drive ends, never throws), the Navigation View camera (no redraws while parked), and the stylesheet rules
// that keep taps at 44 points and stop Safari's double tap zoom.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
// services.js reads document.baseURI when it loads.
globalThis.document ??= { baseURI: 'http://localhost/web/index.html', visibilityState: 'visible' };
const { ScreenWake } = await import('../js/app/services.js');
const { sameCamera } = await import('../js/app/navmap.js');

/// A browser's wake lock: each request answers when `answer()` is called (or refuses with `refuse`).
function fakeBrowser({ refuse = null } = {}) {
  const calls = [];
  const nav = {
    wakeLock: {
      request() {
        let settle;
        const p = new Promise((resolve, reject) => { settle = { resolve, reject }; });
        const lock = { released: false, listeners: {}, addEventListener(t, f) { this.listeners[t] = f; },
          release() { this.released = true; this.listeners.release?.(); return Promise.resolve(); } };
        calls.push({ answer: () => (refuse ? settle.reject(new Error(refuse)) : settle.resolve(lock)), lock });
        return p;
      },
    },
  };
  return { nav, doc: { visibilityState: 'visible' }, calls };
}

test('wake lock: one request at a time, and the lock is held', async () => {
  const b = fakeBrowser();
  const w = new ScreenWake(b);
  const first = w.request();
  w.request();
  w.request();
  assert.equal(b.calls.length, 1, 'requests while one is pending do not ask again');
  b.calls[0].answer();
  assert.equal(await first, true);
  assert.equal(w.active, true);
  await w.request();
  assert.equal(b.calls.length, 1, 'held: no new request');
});

test('wake lock: a drive that ends while the browser is answering does not keep the screen on', async () => {
  const b = fakeBrowser();
  const w = new ScreenWake(b);
  const p = w.request();
  w.release();
  b.calls[0].answer();
  assert.equal(await p, false);
  assert.equal(w.active, false);
  assert.equal(b.calls[0].lock.released, true, 'the late lock is let go at once');
});

test('wake lock: a refusal is reported, never thrown, and the next request tries again', async () => {
  const b = fakeBrowser({ refuse: 'NotAllowedError' });
  const w = new ScreenWake(b);
  let changes = 0;
  w.onChange = () => changes++;
  const p = w.request();
  b.calls[0].answer();
  assert.equal(await p, false);
  assert.equal(w.error, 'NotAllowedError');
  assert.ok(changes >= 1, 'the screen is told');
  w.request();
  assert.equal(b.calls.length, 2, 'asks again (a tap on the screen does this)');
});

test('wake lock: the browser letting go (page hidden) clears it, and a hidden page does not ask', async () => {
  const b = fakeBrowser();
  const w = new ScreenWake(b);
  const p = w.request();
  b.calls[0].answer();
  await p;
  b.calls[0].lock.release();
  assert.equal(w.active, false);
  assert.equal(w.wanted, true, 'still wanted: asked again when the page shows');
  b.doc.visibilityState = 'hidden';
  await w.request();
  assert.equal(b.calls.length, 1, 'no request while hidden');
});

test('wake lock: unsupported browsers resolve quietly', async () => {
  const w = new ScreenWake({ nav: {}, doc: { visibilityState: 'visible' } });
  assert.equal(w.supported, false);
  assert.equal(await w.request(), false);
  w.release();
});

test('map camera: parked (GPS jitter under a pixel) does not move the camera; driving does', () => {
  const pad = { top: 300, bottom: 200, left: 24, right: 24 };
  const at = (lat, lon, bearing = 10, zoom = 12.4) => ({ center: [lon, lat], bearing, pitch: 52, zoom, padding: { ...pad } });
  const a = at(40.95, -73.87);
  assert.equal(sameCamera(a, at(40.95 + 0.00003, -73.87 + 0.00003)), true, 'a few meters at zoom 12.4 is under a pixel');
  assert.equal(sameCamera(a, at(40.95 + 0.0003, -73.87)), false, '33 m is a few pixels');
  assert.equal(sameCamera(a, at(40.95, -73.87, 12)), false, 'a turn');
  assert.equal(sameCamera(at(40.95, -73.87, 359.8), at(40.95, -73.87, 0.1)), true, 'bearing wraps at north');
  assert.equal(sameCamera(a, at(40.95, -73.87, 10, 13.6)), false, 'zoom changes');
  assert.equal(sameCamera(a, { ...a, padding: { ...pad, bottom: 260 } }), false, 'the bottom panel changed size');
  assert.equal(sameCamera(null, a), false);
});

test('stylesheet: close buttons are 44 points, the map controls and profile button reach 44, no double tap zoom', () => {
  const css = readFileSync(path.join(here, '../css/app.css'), 'utf8');
  const rule = (sel) => css.match(new RegExp(`(^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`))?.[2] ?? '';
  assert.match(rule('.x'), /min-width: 44px/);
  assert.match(rule('.x'), /min-height: 44px/);
  assert.match(rule('.icon-btn::after'), /inset: -2px/, '40 + 2 + 2');
  assert.match(rule('.view-toggle button'), /width: 42px; height: 32px/);
  assert.match(rule('.view-toggle button::after'), /inset: -6px -1px/, '42 + 2 by 32 + 12');
  assert.match(css, /html \{[^}]*touch-action: manipulation/);
});
