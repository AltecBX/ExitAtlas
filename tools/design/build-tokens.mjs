// Generates web/css/tokens.css and App/ExitAtlas/Design/Tokens.swift from design/tokens.json.
// Usage: node tools/design/build-tokens.mjs        (writes both files)
//        node tools/design/build-tokens.mjs --check (exits 1 when either file is out of date)
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const OUTPUTS = {
  css: path.join(ROOT, 'web/css/tokens.css'),
  swift: path.join(ROOT, 'App/ExitAtlas/Design/Tokens.swift'),
};
const BODY_PX = 17;

export function loadTokens() {
  return JSON.parse(readFileSync(path.join(ROOT, 'design/tokens.json'), 'utf8'));
}

function colorVars(tokens, mode, indent) {
  return Object.entries(tokens.color).map(([name, c]) => `${indent}--${name}: ${c[mode]};`).join('\n');
}

export function renderCSS(tokens) {
  const type = Object.entries(tokens.type).filter(([, v]) => typeof v === 'object')
    .map(([name, t]) => `  --type-${name}: ${+(t.px / BODY_PX).toFixed(4)}rem;`).join('\n');
  const space = Object.entries(tokens.space).map(([k, v]) => `  --space-${k}: ${v}px;`).join('\n');
  const radius = Object.entries(tokens.radius).map(([k, v]) => `  --radius-${k}: ${v}px;`).join('\n');
  return `/* Generated from design/tokens.json by tools/design/build-tokens.mjs. Do not edit by hand. */
@font-face {
  font-family: "Overpass";
  src: url("../fonts/overpass-var.woff2") format("woff2");
  font-weight: 100 900;
  font-display: swap;
}
:root {
${colorVars(tokens, 'light', '  ')}
${type}
${space}
${radius}
  --sign-font: "Overpass", "Highway Gothic", system-ui, sans-serif;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
${colorVars(tokens, 'dark', '    ')}
  }
}
:root[data-theme="dark"] {
${colorVars(tokens, 'dark', '  ')}
}
`;
}

function swiftName(name) {
  return name.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
}

function hex(c) {
  return `0x${c.replace('#', '').toUpperCase()}`;
}

export function renderSwift(tokens) {
  const colors = Object.entries(tokens.color)
    .map(([name, c]) => `    /// ${c.note}\n    static let ${swiftName(name)} = Color(light: ${hex(c.light)}, dark: ${hex(c.dark)})`).join('\n');
  const space = Object.entries(tokens.space).map(([k, v]) => `        static let ${k}: CGFloat = ${v}`).join('\n');
  const radius = Object.entries(tokens.radius).map(([k, v]) => `        static let ${k}: CGFloat = ${v}`).join('\n');
  return `// Generated from design/tokens.json by tools/design/build-tokens.mjs. Do not edit by hand.
import SwiftUI

enum Tokens {
${colors}

    enum Space {
${space}
    }

    enum Radius {
${radius}
    }
}
`;
}

/// WCAG 2 contrast ratio between two #RRGGBB colors.
export function contrast(a, b) {
  const lum = (h) => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const tokens = loadTokens();
  const out = { css: renderCSS(tokens), swift: renderSwift(tokens) };
  const check = process.argv.includes('--check');
  let stale = false;
  for (const [k, file] of Object.entries(OUTPUTS)) {
    let current = null;
    try { current = readFileSync(file, 'utf8'); } catch { /* missing */ }
    if (current === out[k]) continue;
    if (check) { console.error(`${path.relative(ROOT, file)} is out of date`); stale = true; } else { writeFileSync(file, out[k]); console.log(`wrote ${path.relative(ROOT, file)}`); }
  }
  if (stale) process.exit(1);
}
