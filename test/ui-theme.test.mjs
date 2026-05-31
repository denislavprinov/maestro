import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const css = readFileSync(
  fileURLToPath(new URL('../ui/public/style.css', import.meta.url)),
  'utf8'
);

// Pull a `--token: value;` out of the stylesheet. The regex requires a colon
// immediately after the exact token name, so `--bg` cannot match `--bg-elev:`
// (next char is `-`, not `:`) nor a `var(--bg)` use (next char is `)`). Each
// token is defined once in :root, so the first match is the declaration.
function tokenValue(name) {
  const m = css.match(new RegExp(`--${name}\\s*:\\s*([^;]+);`));
  assert.ok(m, `expected token --${name} to be defined`);
  return m[1].trim();
}

test('page surface is light, not the old dark background', () => {
  assert.notEqual(tokenValue('bg'), '#0e1116', '--bg still set to the dark value');
  // light page: pure white or a near-white gray (leading f keeps it near #fff)
  assert.match(tokenValue('bg'), /^#(fff(fff)?|f[0-9a-f]{5})$/i);
  assert.equal(tokenValue('bg-elev').toLowerCase(), '#ffffff', 'cards should be pure white');
});

test('log and viewer are no longer the darkest dark panel', () => {
  assert.ok(!css.includes('#0a0d12'), 'old dark log/viewer background still present');
});

test('log and viewer use the tinted code token', () => {
  // `.log {` / `.viewer {` only — `\s*\{` won't match `.log-card {` etc.
  assert.match(css, /\.log\s*\{[^}]*background:\s*var\(--bg-code\)/, '.log should use var(--bg-code)');
  assert.match(css, /\.viewer\s*\{[^}]*background:\s*var\(--bg-code\)/, '.viewer should use var(--bg-code)');
});

test('a tinted code surface token exists for log/viewer', () => {
  const code = tokenValue('bg-code').toLowerCase();
  assert.notEqual(code, '#ffffff', 'log/viewer must be tinted, not pure white');
});

test('accent and status colors are unchanged', () => {
  assert.equal(tokenValue('accent').toLowerCase(), '#4f9cf9');
  assert.equal(tokenValue('accent-dim').toLowerCase(), '#2b6fd1');
  assert.equal(tokenValue('good').toLowerCase(), '#3fb950');
  assert.equal(tokenValue('warn').toLowerCase(), '#d29922');
  assert.equal(tokenValue('bad').toLowerCase(), '#f85149');
  assert.equal(tokenValue('critical').toLowerCase(), '#f85149');
  assert.equal(tokenValue('major').toLowerCase(), '#db6d28');
  assert.equal(tokenValue('minor').toLowerCase(), '#d29922');
  assert.equal(tokenValue('suggestion').toLowerCase(), '#58a6ff');
});

test('no stray hard-coded dark button hover remains', () => {
  assert.ok(!css.includes('#232c38'), 'dark hover literal still present');
});

// Regression guard: the done-circle checkmark sits on the unchanged green
// (--good) fill. A dark glyph there is ~7.5:1; white would be ~2.5:1. Keep dark.
test('done-step checkmark stays high-contrast (not white) on the green circle', () => {
  const m = css.match(/\.step\.done \.num \{[^}]*color:\s*([^;]+);/);
  assert.ok(m, 'expected a color on .step.done .num');
  const c = m[1].trim().toLowerCase();
  assert.ok(c !== '#fff' && c !== '#ffffff', 'white checkmark on green is low-contrast; keep it dark');
});
