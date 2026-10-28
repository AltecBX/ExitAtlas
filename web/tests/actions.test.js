// The web app's button actions are one object literal: a repeated name silently replaces the
// earlier handler. ("add-stop" was used twice, so "Add to trip" opened the planner's place search.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const main = readFileSync(path.join(here, '../js/app/main.js'), 'utf8');
const views = readFileSync(path.join(here, '../js/app/views.js'), 'utf8');

function actionNames() {
  const start = main.indexOf('const actions = {');
  assert.ok(start >= 0, 'actions object found');
  const body = main.slice(start, main.indexOf('\n};', start));
  return [...body.matchAll(/^ {2}'?([\w-]+)'?\s*\(/gm)].map((m) => m[1]);
}

test('every action name is defined once', () => {
  const names = actionNames();
  assert.ok(names.length > 30);
  const seen = new Set(), dupes = [];
  for (const n of names) { if (seen.has(n)) dupes.push(n); seen.add(n); }
  assert.deepEqual(dupes, []);
});

test('every data-act in the views has a handler', () => {
  const names = new Set(actionNames());
  const used = new Set([...views.matchAll(/data-act="([\w-]+)"/g)].map((m) => m[1]));
  const missing = [...used].filter((n) => !names.has(n));
  assert.deepEqual(missing, []);
});
