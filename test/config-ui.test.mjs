// test/config-ui.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const html = readFileSync(fileURLToPath(new URL('../ui/public/index.html', import.meta.url)), 'utf8');
const appjs = readFileSync(fileURLToPath(new URL('../ui/public/app.js', import.meta.url)), 'utf8');

test('each agent step exposes model + effort selectors in markup', () => {
  for (const role of ['planner', 'refiner', 'implementer', 'reviewer']) {
    assert.ok(html.includes(`data-role="${role}"`), `missing step-config for ${role}`);
  }
  assert.ok(html.includes('step-model'), 'missing model select class');
  assert.ok(html.includes('step-effort'), 'missing effort select class');
});

test('app.js loads, renders, and saves per-step config', () => {
  assert.ok(appjs.includes('/api/config'), 'app.js does not use /api/config');
  assert.ok(appjs.includes('renderStepConfigs'), 'missing renderStepConfigs');
  assert.ok(appjs.includes('addModelFlow'), 'missing custom-model add flow');
});
