// The driver's profile: shared fixtures (same expectations as ProfileTests.swift) and the web store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { normalizeProfile, migrateWebV1, defaultProfile, inOvernightWindow, vehicleId } from '../js/engine/profile.js';
import {
  loadProfile, writeProfile, settingsFromProfile, placesFromProfile, applyToProfile, exportProfile, importProfile, PROFILE_KEY,
} from '../js/app/profilestore.js';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../Tests/ExitAtlasCoreTests/Fixtures/profiles');
const fixture = (name) => JSON.parse(readFileSync(path.join(dir, `${name}.json`), 'utf8'));

/// localStorage stand-in. `full` makes every write fail like a full or blocked browser store.
function memoryStorage(initial = {}, { full = false } = {}) {
  const m = new Map(Object.entries(initial));
  return {
    map: m,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { if (full) { const e = new Error('full'); e.name = 'QuotaExceededError'; throw e; } m.set(k, String(v)); },
  };
}

test('shared fixtures: a valid profile is kept exactly, damaged fields fall back one by one', () => {
  const full = fixture('full');
  assert.deepEqual(normalizeProfile(full), { profile: full, problems: [] });
  const expected = fixture('damaged.expected');
  const r = normalizeProfile(fixture('damaged'));
  assert.deepEqual(r.profile, expected.profile);
  assert.deepEqual(r.problems, expected.problems);
  assert.deepEqual(normalizeProfile('nope').problems, ['profile']);
  assert.equal(vehicleId({ year: 2015, make: 'Toyota', model: 'Camry', version: '4 cyl 2.5 L, Automatic (S6)' }), '2015|toyota|camry|4-cyl-2.5-l-automatic-s6-');
});

test('M. the web version one keys migrate without loss and stay untouched', () => {
  const v1 = fixture('web_v1');
  assert.deepEqual(migrateWebV1(v1), fixture('web_v1.expected'));
  const storage = memoryStorage({
    'ea.settings': JSON.stringify(v1.settings), 'ea.places': JSON.stringify(v1.places),
    'ea.vehicles': JSON.stringify(v1.vehicles), 'ea.window': JSON.stringify(v1.window),
  });
  const before = new Map(storage.map);
  const r = loadProfile(storage);
  assert.equal(r.source, 'migrated');
  assert.equal(r.wrote.ok, true);
  for (const [k, v] of before) assert.equal(storage.getItem(k), v, `${k} left as it was`);
  // Second launch reads the migrated profile and writes nothing.
  const again = loadProfile(storage);
  assert.equal(again.source, 'stored');
  assert.equal(again.wrote, null);
  assert.deepEqual(again.profile.fuel.brands, ['Wawa', 'Shell']);
});

test('A, I. the vehicle and its MPG choice come back after closing and reopening', () => {
  const storage = memoryStorage();
  const first = loadProfile(storage);
  assert.equal(first.source, 'new');
  const camry = fixture('full').vehicles[0];
  const p = { ...first.profile, vehicles: [camry], defaultVehicleId: camry.id };
  assert.equal(writeProfile(storage, p).ok, true);
  const reopened = loadProfile(storage);
  const s = settingsFromProfile(reopened.profile);
  assert.equal(s.vehicle.model, 'Camry');
  assert.equal(s.mpgBasis, 'custom');
  assert.equal(s.customMpg, 33.5);
  assert.equal(reopened.wrote, null, 'a good profile is never rewritten at launch');
});

test('B. Shell first and a changed brand order survive new trips, updates and data refreshes', () => {
  const storage = memoryStorage();
  const fresh = loadProfile(storage).profile;
  assert.deepEqual(fresh.fuel.brands, ['Shell'], 'Shell is the starting favorite');
  let settings = settingsFromProfile(fresh);
  settings.favoriteBrands = ['Shell', 'Wawa'];
  writeProfile(storage, applyToProfile(fresh, settings, placesFromProfile(fresh), 25));
  // A trip starts and ends, and new data is loaded: these use their own keys.
  storage.setItem('ea.active', JSON.stringify({ trip: 1 }));
  storage.setItem('ea.dataManifest', JSON.stringify({ version: 2 }));
  storage.map.delete('ea.active');
  assert.deepEqual(loadProfile(storage).profile.fuel.brands, ['Shell', 'Wawa']);
  // The driver removes Shell: it stays removed (no reset to the default).
  const p = loadProfile(storage).profile;
  settings = settingsFromProfile(p);
  settings.favoriteBrands = ['Wawa'];
  writeProfile(storage, applyToProfile(p, settings, placesFromProfile(p), 25));
  assert.deepEqual(loadProfile(storage).profile.fuel.brands, ['Wawa']);
  settings.favoriteBrands = [];
  writeProfile(storage, applyToProfile(p, settings, placesFromProfile(p), 25));
  assert.deepEqual(loadProfile(storage).profile.fuel.brands, []);
});

test('C. Home and saved places are there after reopening', () => {
  const storage = memoryStorage();
  const p = loadProfile(storage).profile;
  const places = {
    home: { name: 'Home', coordinate: { lat: 40.7, lon: -74 } },
    saved: [{ name: 'Mom', coordinate: { lat: 33.7, lon: -84.4 } }, { name: 'Cabin', coordinate: { lat: 35.6, lon: -82.6 } }],
    recent: [{ name: 'Savannah', coordinate: { lat: 32.1, lon: -81.1 } }],
  };
  writeProfile(storage, applyToProfile(p, settingsFromProfile(p), places, 25));
  const back = placesFromProfile(loadProfile(storage).profile);
  assert.equal(back.home.name, 'Home');
  assert.deepEqual(back.saved.map((x) => x.name), ['Mom', 'Cabin']);
  assert.equal(back.recent[0].name, 'Savannah');
});

test('saved trip plans survive reopening and keep their order', () => {
  const storage = memoryStorage();
  writeProfile(storage, fixture('full'));
  const back = placesFromProfile(loadProfile(storage).profile);
  assert.deepEqual(back.plans.map((t) => t.name), ['Florida run', 'To Mom']);
  assert.equal(back.plans[0].from, null);
  assert.equal(back.plans[0].stops[0].coordinate.lat, 32.0809);
  const p = loadProfile(storage).profile;
  const again = applyToProfile(p, settingsFromProfile(p), back, 25);
  assert.deepEqual(again.places.plans, p.places.plans, 'writing the places back changes nothing');
});

test('L. a damaged profile keeps a copy, recovers from the previous one, and keeps valid fields', () => {
  // Unreadable JSON: the previous copy is used and the broken text is kept.
  const storage = memoryStorage();
  const good = { ...defaultProfile(), fuel: { ...defaultProfile().fuel, brands: ['Shell', 'Sheetz'] } };
  writeProfile(storage, good);
  writeProfile(storage, { ...good, driving: { ...good.driving, speedAlertOver: 9 } });
  storage.setItem(PROFILE_KEY, '{"kind": "exitatlas-profile", "fuel": {"brands": ["Sh');
  const r = loadProfile(storage);
  assert.equal(r.source, 'recovered');
  assert.deepEqual(r.profile.fuel.brands, ['Shell', 'Sheetz']);
  assert.match(JSON.parse(storage.getItem('ea.profile.corrupt')).text, /"Sh$/);
  // One bad field: only that field resets.
  const bad = { ...good, driving: { ...good.driving, theme: 'neon', speedAlertOver: 9 } };
  storage.setItem(PROFILE_KEY, JSON.stringify(bad));
  const r2 = loadProfile(storage);
  assert.deepEqual(r2.problems, ['driving.theme']);
  assert.equal(r2.profile.driving.theme, 'auto');
  assert.equal(r2.profile.driving.speedAlertOver, 9);
  assert.deepEqual(r2.profile.fuel.brands, ['Shell', 'Sheetz']);
});

test('a refused save is reported, never claimed', () => {
  const r = writeProfile(memoryStorage({}, { full: true }), defaultProfile());
  assert.deepEqual(r, { ok: false, error: 'browser storage is full' });
});

test('J, N. a new website version or data update does not write the profile; only the data key changes', () => {
  // The data loader writes one key of its own (services.js); nothing else.
  const services = readFileSync(path.resolve(dir, '../../../../web/js/app/services.js'), 'utf8');
  const dataCode = services.slice(services.indexOf('// MARK: Data'), services.indexOf('// MARK: Routing'));
  assert.ok(dataCode.length > 1000);
  const writes = [...dataCode.matchAll(/(?:localStorage|store)\.(?:setItem|set|remove)\(([^,)]+)/g)].map((m) => m[1].trim());
  assert.deepEqual(writes, ['LAST_GOOD_KEY']);
  assert.match(services, /const LAST_GOOD_KEY = 'ea\.dataManifest'/);
  const storage = memoryStorage();
  writeProfile(storage, defaultProfile());
  const stored = storage.getItem(PROFILE_KEY);
  loadProfile(storage);
  assert.equal(storage.getItem(PROFILE_KEY), stored);
});

test('S. export and import carry the profile between devices, never the API keys', () => {
  const full = fixture('full');
  const text = exportProfile(full);
  assert.ok(!/googleKey|nrelKey|proxyURL/.test(text));
  assert.deepEqual(importProfile(text).profile, full);
  assert.throws(() => importProfile('{"kind": "something-else"}'), /not an ExitAtlas profile/);
  assert.throws(() => importProfile('nope'), /not JSON/);
});

test('overnight window: local minutes, windows across midnight, manual override', () => {
  const p = defaultProfile();
  assert.equal(inOvernightWindow(p, 0), true);
  // The default window is midnight to 5 AM.
  assert.equal(inOvernightWindow(p, 299), true);
  assert.equal(inOvernightWindow(p, 300), false);
  p.overnight.start = '22:00';
  assert.equal(inOvernightWindow(p, 23 * 60), true);
  assert.equal(inOvernightWindow(p, 12 * 60), false);
  p.overnight.mode = 'on';
  assert.equal(inOvernightWindow(p, 12 * 60), true);
  p.overnight.mode = 'off';
  assert.equal(inOvernightWindow(p, 60), false);
});

test('schema 3: a profile saved with the old default overnight window gets midnight to 5 AM; nothing else moves', () => {
  const overnight = (schema, start, end) => normalizeProfile({ kind: 'exitatlas-profile', schema, overnight: { mode: 'auto', start, end } }).profile.overnight;
  assert.deepEqual(overnight(2, '00:00', '04:00'), { mode: 'auto', start: '00:00', end: '05:00' });
  assert.equal(overnight(undefined, '00:00', '04:00').end, '05:00', 'no schema: saved before schema 3');
  // A window the driver chose stays as it is.
  assert.equal(overnight(2, '23:00', '04:00').end, '04:00');
  assert.equal(overnight(2, '00:00', '03:00').end, '03:00');
  assert.equal(overnight(3, '00:00', '04:00').end, '04:00', 'set to 4 AM after the change');
  // A stored profile (Jerry's kind: vehicle, Shell first, Home): only the window's end changes, and the next save
  // writes schema 3, so a window set later is never moved again.
  const saved = { ...fixture('full'), schema: 2, overnight: { mode: 'auto', start: '00:00', end: '04:00' } };
  const storage = memoryStorage({ [PROFILE_KEY]: JSON.stringify(saved) });
  const r = loadProfile(storage);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.profile, { ...saved, schema: 3, overnight: { mode: 'auto', start: '00:00', end: '05:00' } });
  writeProfile(storage, { ...r.profile, overnight: { ...r.profile.overnight, end: '04:00' } });
  assert.equal(loadProfile(storage).profile.overnight.end, '04:00');
});

test('every web module is in the offline cache, so the app (and its profile code) loads without a connection', () => {
  const web = path.resolve(dir, '../../../../web');
  const sw = readFileSync(path.join(web, 'sw.js'), 'utf8');
  for (const sub of ['js/app', 'js/engine']) {
    for (const f of readdirSync(path.join(web, sub)).filter((n) => n.endsWith('.js'))) {
      assert.ok(sw.includes(`'${sub}/${f}'`), `${sub}/${f} missing from APP_FILES in sw.js`);
    }
  }
});
