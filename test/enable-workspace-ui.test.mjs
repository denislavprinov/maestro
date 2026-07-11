import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const html = readFileSync(fileURLToPath(new URL('../apps/enable/public/index.html', import.meta.url)), 'utf8');
const js = readFileSync(fileURLToPath(new URL('../apps/enable/public/app.js', import.meta.url)), 'utf8');

const IDS = ['target-seg', 'target-project-pane', 'target-workspace-pane', 'workspace-select'];

test('every workspace #id the JS addresses exists in index.html', () => {
  for (const id of IDS) assert.ok(html.includes(`id="${id}"`), `markup missing #${id}`);
});

test('target segmented control uses the .seg button[data-target] + hidden-radio idiom', () => {
  assert.ok(js.includes("'#target-seg'"), 'JS should query #target-seg');
  assert.ok(html.includes('data-target="project"'), 'missing data-target=project button');
  assert.ok(html.includes('data-target="workspace"'), 'missing data-target=workspace button');
  assert.ok(/<input type="radio" name="target" value="project"[^>]*hidden/.test(html), 'missing hidden project radio');
  assert.ok(/<input type="radio" name="target" value="workspace"[^>]*hidden/.test(html), 'missing hidden workspace radio');
});
