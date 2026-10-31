// Route choices name their main roads (approved by Jerry on Oct 31, after a Taconic State Parkway trip where the
// planner's two routes could not be told apart).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeVia, makeStep } from '../js/engine/route.js';

const MI = 1609.344;
const routeOf = (parts) => {
  let at = 0;
  const steps = parts.map(([name, miles]) => { const s = makeStep(at, miles * MI, 'continue', name); at += miles * MI; return s; });
  return { length: at, steps };
};

test('the longest roads, in driving order, numbered by number and named by name', () => {
  // The two real Yonkers to Lenox choices (OSRM, Oct 31), simplified.
  const fastest = routeOf([['Yonkers Avenue', 1.7], ['Hutchinson River Parkway', 8], ['I 684', 70.6], ['NY 22 State Highway 22', 27], ['Breezy Hill Road', 3], ['US 7; MA 23 State Road', 13]]);
  const taconic = routeOf([['Saw Mill River Road', 3.6], ['Sprain Brook Parkway', 12], ['Taconic State Parkway', 91], ['NY 22', 8], ['Lenox Road', 4]]);
  assert.equal(routeVia(fastest), 'via I-684, NY 22, US 7');
  assert.equal(routeVia(taconic), 'via Sprain Brook Pkwy, Taconic State Pkwy');
});

test('short roads are left out, and a route without names says nothing', () => {
  assert.equal(routeVia(routeOf([['Main Street', 0.5], ['I 95', 50]])), 'via I-95');
  assert.equal(routeVia(routeOf([['', 10]])), '');
  assert.equal(routeVia(null), '');
});
