// Design tokens: generated files are in sync with design/tokens.json and text pairs keep their contrast.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadTokens, renderCSS, renderSwift, contrast, OUTPUTS } from '../../tools/design/build-tokens.mjs';

test('tokens.css and Tokens.swift match design/tokens.json', () => {
  const tokens = loadTokens();
  assert.equal(readFileSync(OUTPUTS.css, 'utf8'), renderCSS(tokens), 'run node tools/design/build-tokens.mjs');
  assert.equal(readFileSync(OUTPUTS.swift, 'utf8'), renderSwift(tokens), 'run node tools/design/build-tokens.mjs');
});

test('text and sign colors meet their contrast minimums in light and dark', () => {
  const tokens = loadTokens();
  const failures = [];
  for (const mode of ['light', 'dark']) {
    for (const p of tokens.contrast) {
      const ratio = contrast(tokens.color[p.fg][mode], tokens.color[p.bg][mode]);
      if (ratio < p.min) failures.push(`${mode}: ${p.fg} on ${p.bg} is ${ratio.toFixed(2)}, needs ${p.min}`);
    }
  }
  assert.deepEqual(failures, []);
});

test('contrast() matches the WCAG reference values', () => {
  assert.equal(contrast('#000000', '#FFFFFF').toFixed(2), '21.00');
  assert.equal(contrast('#777777', '#FFFFFF').toFixed(2), '4.48');
});

// Small colored text in the web stylesheet, checked on the surface it sits on in both themes: the "On route"
// pill on a chip (shown for the whole drive) and the recommended stop tag on a card. The sign greens are
// fills for white lettering, not text colors (dark sign green on a dark chip was 3.0:1).
test('web stylesheet: small status text meets 4.5:1 on its surface in light and dark', () => {
  const tokens = loadTokens();
  const css = readFileSync(new URL('../css/app.css', import.meta.url), 'utf8');
  const colorOf = (sel) => {
    const m = css.match(new RegExp(`(^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{[^}]*?(?:^|[ ;{])color: var\\(--([\\w-]+)\\)`));
    assert.ok(m, `${sel} sets a color token`);
    return m[2];
  };
  const failures = [];
  for (const [sel, bg] of [['.pill.ok', 'chip'], ['.rec-tag', 'card']]) {
    const fg = colorOf(sel);
    for (const mode of ['light', 'dark']) {
      const ratio = contrast(tokens.color[fg][mode], tokens.color[bg][mode]);
      if (ratio < 4.5) failures.push(`${mode}: ${sel} (${fg}) on ${bg} is ${ratio.toFixed(2)}`);
    }
  }
  assert.deepEqual(failures, []);
});
